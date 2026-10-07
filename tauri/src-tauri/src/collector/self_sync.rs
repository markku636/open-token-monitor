//! 掃描前的自我同步：Cursor 與 Antigravity 的用量要先由 tokscale 拉進它自己的 cache，
//! 之後的掃描才讀得到（上游 collector.js 的 `maybeSyncCursor` / `maybeSyncAntigravity`）。
//!
//! - 每個工具最多每 5 分鐘同步一次（上游 `SYNC_MIN_INTERVAL_MS`）；嘗試時就記時間，失敗也等下一輪，
//!   不會每個 tick 都重打 Cursor 的 API。
//! - 節流狀態是整個程序共用的（上游刻意用 module scope）：設定改變而重建 runtime 時，
//!   不會因為換了一個新的收集器就立刻再同步一次。
//! - 這兩個 cache 是 tokscale 自己寫的，M2 的 watcher 絕不能監看它們（會自我觸發無限重掃）。

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::{antigravity, cursor};
use crate::error::AppError;
use crate::tokscale::spawn::{parse_json_output, run_detailed, SpawnOptions};
use crate::tokscale::Scanner;
use crate::wire::time::iso_millis;

pub const SYNC_MIN_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// 上游 `CURSOR_EXPLICIT_SYNC_TIMEOUT_MS`：Cursor 的匯出 API 偶爾很慢。
const CURSOR_SYNC_TIMEOUT_MS: u64 = 150_000;
const ANTIGRAVITY_SYNC_TIMEOUT_MS: u64 = 30_000;

#[derive(Debug, Default)]
pub struct Throttle {
    last: Mutex<HashMap<&'static str, Instant>>,
}

impl Throttle {
    pub fn claim(&self, kind: &'static str, interval: Duration, now: Instant) -> bool {
        let mut last = self.last.lock().unwrap();
        if let Some(prev) = last.get(kind) {
            if now.saturating_duration_since(*prev) < interval {
                return false;
            }
        }
        last.insert(kind, now);
        true
    }
}

fn throttle() -> &'static Throttle {
    static THROTTLE: OnceLock<Throttle> = OnceLock::new();
    THROTTLE.get_or_init(Throttle::default)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SyncState {
    /// 同步完成；`rows` 是 Cursor 回報的筆數（Antigravity 不回報）。
    #[serde(rename_all = "camelCase")]
    Synced { rows: Option<u64> },
    /// Cursor 沒有可用的登入（桌面版沒登入，也沒有手動加入的帳號）。
    NotSignedIn,
    /// 本機沒有這個工具的資料，不需要同步。
    NoData,
    #[serde(rename_all = "camelCase")]
    Failed { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub client: String,
    #[serde(flatten)]
    pub state: SyncState,
    pub at: String,
}

fn report(client: &str, state: SyncState) -> SyncReport {
    SyncReport {
        client: client.into(),
        state,
        at: iso_millis(chrono::Utc::now()),
    }
}

async fn sync_cursor(scanner: &Scanner, home: &Path, cancel: &CancellationToken) -> SyncState {
    let home_owned = home.to_path_buf();
    // rusqlite 是同步 IO：放到 blocking 執行緒，不卡 tokio。
    let discovered = tokio::task::spawn_blocking(move || cursor::discover(&home_owned))
        .await
        .unwrap_or_else(|e| Err(AppError::Internal(e.to_string())));
    match &discovered {
        Ok(cursor::DiscoverOutcome::Imported { changed: true, .. }) => {
            tracing::info!("imported the Cursor desktop account into tokscale")
        }
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, "Cursor desktop discovery failed"),
    }
    if matches!(discovered, Ok(cursor::DiscoverOutcome::NotSignedIn))
        && cursor::saved_account_count(&cursor::credentials_path(home)) == 0
    {
        return SyncState::NotSignedIn;
    }
    let opts = SpawnOptions {
        timeout_ms: CURSOR_SYNC_TIMEOUT_MS,
        extra_dirs: None,
    };
    let args = ["cursor", "sync", "--json"].map(String::from);
    let (result, _) = run_detailed(&scanner.bin, &args, &opts, cancel).await;
    let parsed = result
        .and_then(|out| parse_json_output(&out))
        .and_then(|json| cursor::parse_sync_result(&json));
    match parsed {
        Ok(r) if r.not_authenticated => SyncState::NotSignedIn,
        Ok(r) => SyncState::Synced { rows: Some(r.rows) },
        Err(e) => SyncState::Failed {
            message: e.message(),
        },
    }
}

async fn sync_antigravity(scanner: &Scanner, home: &Path, cancel: &CancellationToken) -> SyncState {
    let opts = SpawnOptions {
        timeout_ms: ANTIGRAVITY_SYNC_TIMEOUT_MS,
        extra_dirs: None,
    };
    let args = ["antigravity", "sync"].map(String::from);
    let (result, killed) = run_detailed(&scanner.bin, &args, &opts, cancel).await;
    if let Some(k) = killed {
        let now = chrono::Utc::now().timestamp_millis();
        if antigravity::remove_owned_lock(
            &antigravity::sync_lock_path(home),
            k.pid,
            k.started_at_ms,
            now,
        ) {
            tracing::info!("removed the antigravity sync.lock left by our terminated sync");
        }
    }
    match result {
        Ok(_) => SyncState::Synced { rows: None },
        Err(e) => SyncState::Failed {
            message: e.message(),
        },
    }
}

/// 對追蹤中的 Cursor / Antigravity 各做一次（節流允許時）同步，回傳這次實際做了什麼。
/// `force` = 手動重掃：不看 5 分鐘的節流（上游 `forceSelfSync`），但仍記下這次的時間。
pub async fn run(
    scanner: &Scanner,
    clients: &[String],
    force: bool,
    cancel: &CancellationToken,
) -> Vec<SyncReport> {
    let home = dirs::home_dir().unwrap_or_default();
    let interval = if force {
        Duration::ZERO
    } else {
        SYNC_MIN_INTERVAL
    };
    let mut reports = Vec::new();
    let tracked = |c: &str| clients.iter().any(|x| x == c);
    if tracked("cursor") && throttle().claim("cursor", interval, Instant::now()) {
        let state = sync_cursor(scanner, &home, cancel).await;
        if let SyncState::Failed { message } = &state {
            tracing::warn!("cursor sync failed: {message}");
        }
        reports.push(report("cursor", state));
    }
    if tracked("antigravity") {
        if !antigravity::data_present(&home) {
            reports.push(report("antigravity", SyncState::NoData));
        } else if throttle().claim("antigravity", interval, Instant::now()) {
            let state = sync_antigravity(scanner, &home, cancel).await;
            if let SyncState::Failed { message } = &state {
                tracing::warn!("antigravity sync failed: {message}");
            }
            reports.push(report("antigravity", state));
        }
    }
    reports
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn throttle_allows_once_per_interval() {
        let t = Throttle::default();
        let start = Instant::now();
        assert!(t.claim("cursor", SYNC_MIN_INTERVAL, start));
        assert!(!t.claim("cursor", SYNC_MIN_INTERVAL, start + Duration::from_secs(60)));
        assert!(
            t.claim("antigravity", SYNC_MIN_INTERVAL, start),
            "kinds are independent"
        );
        assert!(t.claim("cursor", SYNC_MIN_INTERVAL, start + SYNC_MIN_INTERVAL));
    }

    #[test]
    fn report_serializes_flat() {
        let r = SyncReport {
            client: "cursor".into(),
            state: SyncState::Synced { rows: Some(3) },
            at: "2026-09-23T00:00:00.000Z".into(),
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            serde_json::json!({ "client": "cursor", "state": "synced", "rows": 3, "at": "2026-09-23T00:00:00.000Z" })
        );
    }
}
