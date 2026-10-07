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

/// hub 上列出核准版本的頁面（`/downloads/releases`；本 repo 根目錄的 hub 目前沒有提供）。
/// 版本說明連結開這頁，錨點是 `v<版本>`，對應頁面上每個版本的 `<section id="v…">`。
pub const RELEASES_PAGE_PATH: &str = "downloads/releases";

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

/// 版本說明連結：`<生效的 hub>/downloads/releases#v<版本>`（上游 appUpdater.js 的 `htmlUrl` 指向 GitHub
/// release，這裡改指到 hub 的版本頁）。hub 位置的規則與
/// `feed_url` 相同（子路徑保留、只接受 http 與 https）；不知道版本（例如更新出錯）時不帶錨點，頁面上仍有
/// 每個核准版本的下載連結。
pub fn release_page_url(hub_url: Option<&str>, version: Option<&str>) -> Option<Url> {
    let hub = hub_url.map(str::trim).filter(|s| !s.is_empty())?;
    let base = Url::parse(&format!("{}/", hub.trim_end_matches('/'))).ok()?;
    if !matches!(base.scheme(), "https" | "http") {
        return None;
    }
    let mut url = base.join(RELEASES_PAGE_PATH).ok()?;
    if let Some(v) = version.map(str::trim).filter(|v| is_release_version(v)) {
        url.set_fragment(Some(&format!("v{v}")));
    }
    Some(url)
}

/// 與 scripts/make-latest-json.mjs 的 `SEMVER` 同一組字元（數字開頭，只有英數、點與連字號）：
/// 擋掉會讓錨點變形或對不到 `<section id>` 的值（`v` 前綴、空白、`#`）。
fn is_release_version(v: &str) -> bool {
    v.len() <= 64
        && v.as_bytes().first().is_some_and(u8::is_ascii_digit)
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
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

    /// 狀態所指的版本（有新版、下載中、已下載、安裝中）；版本頁的錨點用它。
    pub fn version(&self) -> Option<&str> {
        match self {
            UpdateState::Available { version, .. }
            | UpdateState::Downloading { version, .. }
            | UpdateState::Ready { version, .. }
            | UpdateState::Installing { version } => Some(version),
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
    fn release_page_is_on_the_effective_hub_with_a_version_anchor() {
        let page = |hub: Option<&str>, v: Option<&str>| release_page_url(hub, v).map(String::from);
        assert_eq!(
            page(Some("https://tokens.example.internal/"), Some("0.2.0")).as_deref(),
            Some("https://tokens.example.internal/downloads/releases#v0.2.0")
        );
        // 子路徑的 hub。
        assert_eq!(
            page(Some("https://proxy.example/tm"), None).as_deref(),
            Some("https://proxy.example/tm/downloads/releases")
        );
        assert_eq!(
            page(Some(" https://h/ "), Some("0.61.0-corp.2")).as_deref(),
            Some("https://h/downloads/releases#v0.61.0-corp.2")
        );
    }

    #[test]
    fn odd_versions_drop_the_anchor_and_bad_hubs_have_no_page() {
        for v in [
            "",
            "  ",
            "v0.2.0",
            "0.2.0 <x>",
            "0.2.0#x",
            "0.2.0+build",
            "../0.2.0",
        ] {
            assert_eq!(
                release_page_url(Some("https://h"), Some(v)).map(String::from),
                Some("https://h/downloads/releases".to_string()),
                "{v:?}"
            );
        }
        let long = format!("1.{}", "0".repeat(70));
        assert_eq!(
            release_page_url(Some("https://h"), Some(&long))
                .and_then(|u| u.fragment().map(str::to_string)),
            None
        );
        for hub in [
            None,
            Some(""),
            Some("   "),
            Some("ftp://h"),
            Some("not a url"),
        ] {
            assert_eq!(release_page_url(hub, Some("0.2.0")), None, "{hub:?}");
        }
    }

    #[test]
    fn state_version_is_known_while_an_update_is_in_hand() {
        let ready = UpdateState::Ready {
            version: "0.2.0".into(),
            notes: None,
            date: None,
        };
        assert_eq!(ready.version(), Some("0.2.0"));
        let downloading = UpdateState::Downloading {
            version: "0.3.0".into(),
            received: 0,
            total: None,
        };
        assert_eq!(downloading.version(), Some("0.3.0"));
        assert_eq!(UpdateState::Idle.version(), None);
        assert_eq!(
            UpdateState::Error {
                message: "x".into(),
                retry_at: None
            }
            .version(),
            None
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
