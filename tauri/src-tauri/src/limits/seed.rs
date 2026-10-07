//! 全新安裝時要查哪些額度（上游 src/electron/initialLimitProviderSeed.js 與 limitProviders.js
//! `limitProvidersForDetectedClients`）。
//!
//! 預設是全部支援的 provider；沒裝 Codex 的電腦就會一直掛著一張「未登入」的卡片。所以第一次啟動時
//! 只留下這台電腦上偵測得到的工具：
//!
//! - 只在**設定檔還不存在**時做（壞掉的檔案也算存在，上游用 `existsSync`）：升級時少了欄位不代表使用者
//!   沒選過，改掉既有安裝的有效預設值是錯的。`TOKEN_MONITOR_LIMIT_PROVIDERS` 有設定（即使是空字串）也不做，
//!   與上游同一個條件。
//! - 只看**來源目錄**是否存在（collector/roots.rs；上游 clientHealth 的 `source.state === 'detected'`），
//!   不看用量：來源消失後，由用量推出的狀態仍可能是 active。
//! - 只看有追蹤的工具；工具 id 就是 provider id（上游 `LIMIT_PROVIDER_BY_CLIENT` 的例外都不是公司支援的工具）。
//!   順序照 `SUPPORTED_LIMIT_PROVIDERS`。
//! - 一個都沒偵測到時用 `codex`，額度分頁才不會空著、讓人找不到。
//! - 只做一次、只有 GUI 做（上游只有 Electron 做；`tm-agent` 與上游 agent 一樣照設定、環境變數與旗標）。
//!
//! 時機與上游不同：上游等第一筆 record（clientHealth 由那次掃描產生）才決定，再重新設定 limits；我們的
//! 偵測就是那張 roots.rs 表、不需要掃描結果，所以在 runtime 啟動前決定——不必先探測沒裝的 provider，
//! 也不必重啟 runtime。使用者在那之前還沒有機會改設定，所以同樣不會蓋掉使用者的選擇。

use std::path::Path;

use crate::error::AppResult;
use crate::settings::{Settings, SUPPORTED_LIMIT_PROVIDERS};

/// 上游 agent 與 Electron 的預設值來源；有設定就代表有人明確選過。
pub const LIMIT_PROVIDERS_ENV: &str = "TOKEN_MONITOR_LIMIT_PROVIDERS";

/// 上游 `limitProviderForClient`：工具對應的額度 provider，沒有額度的工具是 `None`。
pub fn limit_provider_for_client(client: &str) -> Option<&'static str> {
    let id = client.trim().to_lowercase();
    SUPPORTED_LIMIT_PROVIDERS.iter().copied().find(|p| *p == id)
}

/// 上游 `limitProvidersForDetectedClients`：追蹤中、來源目錄存在的工具對應的 provider，依 provider 順序。
pub fn limit_providers_for_detected_clients(
    clients: &[String],
    detected: impl Fn(&str) -> bool,
) -> Vec<String> {
    let found: Vec<&str> = clients
        .iter()
        .filter(|c| detected(c))
        .filter_map(|c| limit_provider_for_client(c))
        .collect();
    SUPPORTED_LIMIT_PROVIDERS
        .iter()
        .filter(|p| found.contains(p))
        .map(|p| p.to_string())
        .collect()
}

/// 上游 `applyInitialLimitProviderSeed` 寫進設定的值：沒偵測到任何工具時是 `codex`。
pub fn initial_limit_providers(clients: &[String], detected: impl Fn(&str) -> bool) -> Vec<String> {
    let providers = limit_providers_for_detected_clients(clients, detected);
    if providers.is_empty() {
        vec!["codex".to_string()]
    } else {
        providers
    }
}

/// 上游 `initialLimitProvidersPending = !settingsFileExisted && env === undefined`。
pub fn seed_pending(
    settings_file_existed: bool,
    env_limit_providers: Option<&std::ffi::OsStr>,
) -> bool {
    !settings_file_existed && env_limit_providers.is_none()
}

/// 決定並寫回設定。寫不進去就還原成原本的值（上游同樣還原），回傳錯誤。
pub fn apply_initial_seed(
    settings: &mut Settings,
    dir: &Path,
    detected: impl Fn(&str) -> bool,
) -> AppResult<()> {
    let previous = std::mem::replace(
        &mut settings.limit_providers,
        initial_limit_providers(&settings.tracked_clients, detected),
    );
    if let Err(e) = settings.save_in(dir) {
        settings.limit_providers = previous;
        return Err(e);
    }
    Ok(())
}

/// GUI 啟動時呼叫（`settings_file_existed` 要在讀設定**之前**量）。做了回傳 true。
pub fn seed_on_first_run(settings: &mut Settings, dir: &Path, settings_file_existed: bool) -> bool {
    if !seed_pending(
        settings_file_existed,
        std::env::var_os(LIMIT_PROVIDERS_ENV).as_deref(),
    ) {
        return false;
    }
    let home = dirs::home_dir().unwrap_or_default();
    match apply_initial_seed(settings, dir, |client| {
        crate::collector::roots::client_present(client, &home)
    }) {
        Ok(()) => {
            tracing::info!(providers = %settings.limit_providers.join(","), "seeded limit providers from detected tools");
            true
        }
        Err(e) => {
            tracing::warn!(error = %e, "could not save the initial limit providers; keeping the defaults");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clients(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn only_detected_tracked_clients_with_a_limits_side_are_seeded() {
        let tracked = clients(&["copilot", "opencode", "claude", "hermes", "cursor"]);
        let detected = |c: &str| matches!(c, "copilot" | "claude" | "opencode" | "codex");
        // codex 偵測得到但沒追蹤；opencode 沒有額度；順序照 provider 清單。
        assert_eq!(
            limit_providers_for_detected_clients(&tracked, detected),
            vec!["claude", "copilot"]
        );
    }

    #[test]
    fn a_machine_without_any_tool_still_gets_the_limits_view() {
        let tracked = clients(crate::settings::SUPPORTED_CLIENTS);
        assert_eq!(initial_limit_providers(&tracked, |_| false), vec!["codex"]);
        assert_eq!(
            initial_limit_providers(&tracked, |c| c == "cursor"),
            vec!["cursor"]
        );
    }

    #[test]
    fn client_ids_map_to_their_own_provider() {
        assert_eq!(limit_provider_for_client(" Claude "), Some("claude"));
        assert_eq!(limit_provider_for_client("antigravity"), None);
        assert_eq!(limit_provider_for_client(""), None);
    }

    #[test]
    fn only_a_fresh_install_without_the_env_override_is_seeded() {
        assert!(seed_pending(false, None));
        assert!(
            !seed_pending(true, None),
            "an upgrade keeps its effective defaults"
        );
        assert!(
            !seed_pending(false, Some(std::ffi::OsStr::new(""))),
            "an explicit env value, even empty, is a choice"
        );
    }

    #[test]
    fn the_seed_is_written_back() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = Settings::default();
        apply_initial_seed(&mut settings, dir.path(), |c| c == "claude").unwrap();
        assert_eq!(settings.limit_providers, vec!["claude"]);
        let (saved, created) = Settings::load_in(dir.path()).unwrap();
        assert!(!created);
        assert_eq!(saved.limit_providers, vec!["claude"]);
    }

    #[test]
    fn a_failed_save_keeps_the_previous_providers() {
        let dir = tempfile::tempdir().unwrap();
        // 設定目錄其實是個檔案：寫不進去。
        let blocked = dir.path().join("not-a-dir");
        std::fs::write(&blocked, b"").unwrap();
        let mut settings = Settings::default();
        let before = settings.limit_providers.clone();
        assert!(apply_initial_seed(&mut settings, &blocked, |c| c == "claude").is_err());
        assert_eq!(settings.limit_providers, before);
    }
}
