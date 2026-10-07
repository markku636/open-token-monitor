//! 自動更新的核心規則（不依賴 Tauri）：feed 位置、檢查排程、狀態。
//!
//! 實際的檢查、下載、驗章與安裝由 `gui/updater.rs` 透過 `tauri-plugin-updater` 執行；
//! 這裡只放能在 `--no-default-features` 下單元測試的部分。
//!
//! feed 是公司 hub 的 `/updates/latest.json`（monorepo 根目錄 overlay 的 `hub/releases.js`
//! 提供）。安裝檔以 minisign 驗章，公鑰在打包時由 build-installer.ps1 以 `--config`
//! 寫進 `plugins.updater.pubkey`：repo 裡的 tauri.conf.json 只有空字串，所以沒有公鑰的
//! 建置（`tauri dev`、本機模式安裝檔）一律停用更新。

use std::time::Duration;

use serde::Serialize;
use url::Url;

/// hub 上的 Tauri updater feed 路徑（對應 overlay `hub/releases.js` 的 `/updates/`）。
pub const FEED_PATH: &str = "updates/latest.json";

/// 啟動後第一次檢查的延遲範圍：大量裝置同時開機時錯開，別在同一分鐘打 hub。
pub const FIRST_CHECK_MIN: Duration = Duration::from_secs(30);
pub const FIRST_CHECK_MAX: Duration = Duration::from_secs(120);
/// 之後每小時一次，±5 分鐘抖動。
pub const CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);
pub const CHECK_JITTER: Duration = Duration::from_secs(5 * 60);
/// 檢查或下載失敗後多久重試。
pub const RETRY_AFTER: Duration = Duration::from_secs(15 * 60);

/// 為什麼這個建置不做自動更新。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DisabledReason {
    /// 沒有內建公司 secret 的建置（`tauri dev`、本機模式安裝檔）。
    DevBuild,
    /// 打包時沒有提供簽章公鑰（`-NoUpdater`）。
    NoPublicKey,
    /// 沒有 hub 位置可以取 feed。
    NoHub,
    /// hub 位置不是合法的網址。
    InvalidHub,
    /// debug build：updater 會拿 target\debug 的執行檔當安裝位置。
    DebugBuild,
}

/// 決定 feed 網址；不能更新時回傳原因。
///
/// feed 跟著「目前生效」的 hub 走（設定頁的覆寫 → 內建值），IT 搬 hub 時不必重發安裝檔。
/// 覆寫只是換下載位置，安裝檔仍要通過內建公鑰的驗章，所以不會因此被換成別人的程式。
pub fn feed_url(
    corp_build: bool,
    debug_build: bool,
    pubkey: &str,
    hub_url: Option<&str>,
) -> Result<Url, DisabledReason> {
    if !corp_build {
        return Err(DisabledReason::DevBuild);
    }
    if debug_build {
        return Err(DisabledReason::DebugBuild);
    }
    if pubkey.trim().is_empty() {
        return Err(DisabledReason::NoPublicKey);
    }
    let hub = hub_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or(DisabledReason::NoHub)?;
    let base = Url::parse(&format!("{}/", hub.trim_end_matches('/')))
        .map_err(|_| DisabledReason::InvalidHub)?;
    if !matches!(base.scheme(), "https" | "http") {
        return Err(DisabledReason::InvalidHub);
    }
    base.join(FEED_PATH).map_err(|_| DisabledReason::InvalidHub)
}

/// `seed` 均勻落在 `[min, max]`。`seed` 由呼叫端給（uuid v4 的隨機位元），測試可重現。
fn spread(seed: u128, min: Duration, max: Duration) -> Duration {
    let span = max.saturating_sub(min).as_millis().max(1);
    min + Duration::from_millis((seed % (span + 1)) as u64)
}

pub fn first_check_delay(seed: u128) -> Duration {
    spread(seed, FIRST_CHECK_MIN, FIRST_CHECK_MAX)
}

pub fn next_check_delay(seed: u128) -> Duration {
    spread(
        seed,
        CHECK_INTERVAL.saturating_sub(CHECK_JITTER),
        CHECK_INTERVAL + CHECK_JITTER,
    )
}

/// 隨機種子：uuid v4 的 122 個隨機位元，不為這一件事多拉一個 rand。
pub fn random_seed() -> u128 {
    uuid::Uuid::new_v4().as_u128()
}

/// 給前端與 tray 的更新狀態（事件 `update-state`）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum UpdateState {
    Disabled {
        reason: DisabledReason,
    },
    Idle,
    Checking,
    #[serde(rename_all = "camelCase")]
    UpToDate {
        checked_at: String,
    },
    /// 有新版但還沒下載（`automaticAppUpdates` 關閉時停在這裡）。
    #[serde(rename_all = "camelCase")]
    Available {
        version: String,
        notes: Option<String>,
        date: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Downloading {
        version: String,
        received: u64,
        total: Option<u64>,
    },
    /// 已下載並驗章，等使用者按「重新啟動以更新」。
    #[serde(rename_all = "camelCase")]
    Ready {
        version: String,
        notes: Option<String>,
        date: Option<String>,
    },
    Installing {
        version: String,
    },
    #[serde(rename_all = "camelCase")]
    Error {
        message: String,
        retry_at: Option<String>,
    },
}

impl UpdateState {
    /// 目前手上有沒有下載好、可以安裝的版本。
    pub fn ready_version(&self) -> Option<&str> {
        match self {
            UpdateState::Ready { version, .. } => Some(version),
            _ => None,
        }
    }

    /// 忙碌中（檢查、下載、安裝）時不接受新的檢查。
    pub fn is_busy(&self) -> bool {
        matches!(
            self,
            UpdateState::Checking
                | UpdateState::Downloading { .. }
                | UpdateState::Installing { .. }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feed_follows_the_effective_hub() {
        let url = feed_url(true, false, "pk", Some("https://tokens.example.internal/")).unwrap();
        assert_eq!(
            url.as_str(),
            "https://tokens.example.internal/updates/latest.json"
        );
        // hub 掛在子路徑時 feed 也在子路徑底下（反向代理常見）。
        let url = feed_url(true, false, "pk", Some("https://proxy.example/tm")).unwrap();
        assert_eq!(url.as_str(), "https://proxy.example/tm/updates/latest.json");
    }

    #[test]
    fn builds_without_a_key_or_hub_never_update() {
        assert_eq!(
            feed_url(false, false, "pk", Some("https://h")),
            Err(DisabledReason::DevBuild)
        );
        assert_eq!(
            feed_url(true, true, "pk", Some("https://h")),
            Err(DisabledReason::DebugBuild)
        );
        assert_eq!(
            feed_url(true, false, "  ", Some("https://h")),
            Err(DisabledReason::NoPublicKey)
        );
        assert_eq!(
            feed_url(true, false, "pk", None),
            Err(DisabledReason::NoHub)
        );
        assert_eq!(
            feed_url(true, false, "pk", Some("ftp://h")),
            Err(DisabledReason::InvalidHub)
        );
    }

    #[test]
    fn delays_stay_inside_their_windows() {
        for seed in [
            0u128,
            1,
            89_999,
            90_000,
            90_001,
            u128::MAX,
            123_456_789_012_345,
        ] {
            let first = first_check_delay(seed);
            assert!(
                first >= FIRST_CHECK_MIN && first <= FIRST_CHECK_MAX,
                "{first:?}"
            );
            let next = next_check_delay(seed);
            assert!(next >= Duration::from_secs(55 * 60), "{next:?}");
            assert!(next <= Duration::from_secs(65 * 60), "{next:?}");
        }
    }

    #[test]
    fn state_serializes_with_a_tag() {
        let v = serde_json::to_value(UpdateState::Downloading {
            version: "0.2.0".into(),
            received: 10,
            total: Some(20),
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({"state":"downloading","version":"0.2.0","received":10,"total":20})
        );
        let v = serde_json::to_value(UpdateState::Disabled {
            reason: DisabledReason::NoPublicKey,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({"state":"disabled","reason":"noPublicKey"})
        );
    }
}
