//! widget 的視圖與主頁偏好（上游 main.js 的 `migrateViewDisplayOrder`、`normalizeHiddenViews`、
//! `normalizeHomeModuleOrder`、`migrateHomeLimitProviderOrder`、`normalizeHiddenLimitProviders`、
//! `normalizeHomeLimitAccountCount`、`normalizeHeatmapMetric`、`normalizeHomeActiveDaysWindow`，
//! 與 renderer 的 viewDisplayPreferences.js / homeModulePreferences.js）。
//!
//! 純函式、不依賴 Tauri。`settings.rs` 的 `validate()` 在讀檔與每次修改後呼叫 [`normalize`]，
//! 前端 `src/viewPrefs.ts` 用同一套規則（`src/homeViews.compat.test.ts` 與上游 JS 比對）。
//!
//! 大小寫與上游完全一致：id 一律轉小寫比對；`year` / `tokens` 這類列舉值只去空白、不轉小寫。

use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};

use crate::settings::{Settings, SUPPORTED_LIMIT_PROVIDERS};

/// Tauri widget 的視圖，依上游 `DEFAULT_VIEW_LIST` 的順序（main.js:437）。上游另外的
/// model / project / session 視圖在這裡是「本機」視圖裡的拆分，所以不列。
pub const VIEW_IDS: &[&str] = &["home", "tool", "status", "device", "limits", "trends"];
/// 上游 `defaultViewDisplayPreferences().hiddenViews`：狀態視圖預設隱藏。
pub const DEFAULT_HIDDEN_VIEWS: &str = "status";
/// 上游 `DEFAULT_HOME_MODULE_LIST`（main.js:438）。
pub const HOME_MODULE_IDS: &[&str] = &["limits", "tool", "device", "model", "trends"];
/// 上游 homeModulePreferences.js `DEFAULT_HOME_MODULE_ORDER`。
pub const DEFAULT_HOME_MODULE_ORDER: &str = "limits,tool,device,model,trends";
/// 上游 `defaultHomeModulePreferences().hiddenHomeModules`。
pub const DEFAULT_HIDDEN_HOME_MODULES: &str = "tool,device";
/// 上游 main.js:475 `HOME_LIMIT_ACCOUNT_COUNT_DEFAULT` / `HOME_LIMIT_ACCOUNT_COUNT_MAX`。
pub const HOME_LIMIT_ACCOUNT_COUNT_DEFAULT: u32 = 3;
pub const HOME_LIMIT_ACCOUNT_COUNT_MAX: u32 = 12;

/// 上游 `csvItems` + `normalizeId`：逗號分隔、去空白、轉小寫，略過空項。
fn items(v: &str) -> impl Iterator<Item = String> + '_ {
    v.split(',')
        .map(|item| item.trim().to_lowercase())
        .filter(|item| !item.is_empty())
}

/// 上游 `normalizeViewDisplayOrder`：已知 id 依第一次出現的順序、去重，缺的已知 id 依清單順序補在後面。
pub fn normalize_order(v: &str, known: &[&str]) -> Vec<String> {
    let mut order: Vec<String> = Vec::with_capacity(known.len());
    for id in items(v) {
        if known.contains(&id.as_str()) && !order.contains(&id) {
            order.push(id);
        }
    }
    for id in known {
        if !order.iter().any(|o| o == id) {
            order.push((*id).to_string());
        }
    }
    order
}

/// 上游 `normalizeHiddenViews` / `normalizeHiddenHomeModules`：已知 id 依輸入順序去重；全部都隱藏時
/// 回空字串（全部重新顯示），不讓畫面變成空的。
pub fn normalize_hidden(v: &str, known: &[&str]) -> String {
    let mut hidden: Vec<String> = Vec::new();
    for id in items(v) {
        if known.contains(&id.as_str()) && !hidden.contains(&id) {
            hidden.push(id);
        }
    }
    if hidden.len() >= known.len() {
        String::new()
    } else {
        hidden.join(",")
    }
}

/// 上游 `migrateViewDisplayOrder`（main.js:2119）：一個已知 id 都沒有 → 空字串（預設順序）；
/// 否則存完整的排列。
pub fn migrate_view_display_order(v: &str) -> String {
    if !items(v).any(|id| VIEW_IDS.contains(&id.as_str())) {
        return String::new();
    }
    normalize_order(v, VIEW_IDS).join(",")
}

/// 上游 `normalizeHomeModuleOrder(...).join(',')`：空字串用預設順序，永遠存完整的排列。
pub fn normalize_home_module_order(v: &str) -> String {
    let raw = if v.is_empty() {
        DEFAULT_HOME_MODULE_ORDER
    } else {
        v
    };
    normalize_order(raw, HOME_MODULE_IDS).join(",")
}

/// 上游 shared/limits/collector.js `parseLimitProviders`：支援的 provider id、去重、不補缺的。
pub fn parse_limit_providers(v: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in items(v) {
        if SUPPORTED_LIMIT_PROVIDERS.contains(&id.as_str()) && !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// 上游 `migrateHomeLimitProviderOrder`（main.js:2067）：與預設（支援清單的順序）相同時存空字串，
/// 主頁額度才維持「剩餘最少優先」的排序。
///
/// `SUPPORTED_LIMIT_PROVIDERS` 必須維持上游 `LIMIT_PROVIDER_CATALOG` 的相對順序，這裡的比較才與上游一致。
pub fn migrate_home_limit_provider_order(v: &str) -> String {
    if v.is_empty() {
        return String::new();
    }
    let normalized = parse_limit_providers(v).join(",");
    if normalized.is_empty() || normalized == SUPPORTED_LIMIT_PROVIDERS.join(",") {
        String::new()
    } else {
        normalized
    }
}

/// 上游 `normalizeHiddenLimitProviders`（main.js:2075）：沒有「全部隱藏就重設」。
pub fn normalize_hidden_home_limit_providers(v: &str) -> String {
    parse_limit_providers(v).join(",")
}

/// 上游 `normalizeHomeLimitAccountCount`：截去小數、夾在 1–12，不是數字時回 3。
pub fn clamp_account_count(n: Option<f64>) -> u32 {
    match n.map(f64::trunc) {
        Some(v) if v.is_finite() => v.clamp(1.0, HOME_LIMIT_ACCOUNT_COUNT_MAX as f64) as u32,
        _ => HOME_LIMIT_ACCOUNT_COUNT_DEFAULT,
    }
}

/// 上游 `normalizeHomeActiveDaysWindow(value, fallback)`（main.js:701）。
pub fn normalize_home_active_days_window(v: &str, fallback: &str) -> &'static str {
    match v.trim() {
        "year" => "year",
        "all" => "all",
        _ if fallback == "year" => "year",
        _ => "all",
    }
}

/// 上游 `normalizeHeatmapMetric(value, fallback)`（main.js:695）。
pub fn normalize_heatmap_metric(v: &str, fallback: &str) -> &'static str {
    match v.trim() {
        "tokens" => "tokens",
        "cost" => "cost",
        _ if fallback == "tokens" => "tokens",
        _ => "cost",
    }
}

fn apply(field: &mut String, next: String, key: &'static str, changed: &mut Vec<&'static str>) {
    if *field != next {
        *field = next;
        changed.push(key);
    }
}

/// 把 11 個視圖／主頁設定收斂到上游的合法值，回傳調整過的鍵（camelCase）。讀檔時的退路與上游的
/// merge 路徑相同（無效的 `homeActiveDaysWindow` → `all`、`heatmapMetric` → `cost`）；修改時的
/// 「無效值保留目前的值」由 [`sanitize_patch`] 先處理。
pub fn normalize(s: &mut Settings) -> Vec<&'static str> {
    let mut changed = Vec::new();
    let next = migrate_view_display_order(&s.view_display_order);
    apply(
        &mut s.view_display_order,
        next,
        "viewDisplayOrder",
        &mut changed,
    );
    let next = normalize_hidden(&s.hidden_views, VIEW_IDS);
    apply(&mut s.hidden_views, next, "hiddenViews", &mut changed);
    let next = normalize_home_module_order(&s.home_module_order);
    apply(
        &mut s.home_module_order,
        next,
        "homeModuleOrder",
        &mut changed,
    );
    let next = normalize_hidden(&s.hidden_home_modules, HOME_MODULE_IDS);
    apply(
        &mut s.hidden_home_modules,
        next,
        "hiddenHomeModules",
        &mut changed,
    );
    let next = migrate_home_limit_provider_order(&s.home_limit_provider_order);
    apply(
        &mut s.home_limit_provider_order,
        next,
        "homeLimitProviderOrder",
        &mut changed,
    );
    let next = normalize_hidden_home_limit_providers(&s.hidden_home_limit_providers);
    apply(
        &mut s.hidden_home_limit_providers,
        next,
        "hiddenHomeLimitProviders",
        &mut changed,
    );
    let count = clamp_account_count(Some(f64::from(s.home_limit_account_count)));
    if count != s.home_limit_account_count {
        s.home_limit_account_count = count;
        changed.push("homeLimitAccountCount");
    }
    let next = normalize_home_active_days_window(&s.home_active_days_window, "all").to_string();
    apply(
        &mut s.home_active_days_window,
        next,
        "homeActiveDaysWindow",
        &mut changed,
    );
    let next = normalize_heatmap_metric(&s.heatmap_metric, "cost").to_string();
    apply(&mut s.heatmap_metric, next, "heatmapMetric", &mut changed);
    changed
}

/// 修改前先濾掉上游會「保留目前的值」的欄位（main.js:7316-7317 的 `normalize*(patch.x, settings.x)`
/// 與 :7392 的 `patch.homeLimitAccountCount ?? settings.homeLimitAccountCount`）：
/// 不合法的 `heatmapMetric` / `homeActiveDaysWindow`，以及 null 的帳號數與兩個主頁開關。
pub fn sanitize_patch(patch: &mut Map<String, Value>) {
    let allowed = |value: &Value, options: &[&str]| {
        value.as_str().is_some_and(|v| options.contains(&v.trim()))
    };
    if patch
        .get("heatmapMetric")
        .is_some_and(|v| !allowed(v, &["tokens", "cost"]))
    {
        patch.remove("heatmapMetric");
    }
    if patch
        .get("homeActiveDaysWindow")
        .is_some_and(|v| !allowed(v, &["all", "year"]))
    {
        patch.remove("homeActiveDaysWindow");
    }
    for key in [
        "homeLimitAccountCount",
        "showHomeLimitBars",
        "showHomeLimitProviderNames",
    ] {
        if patch.get(key).is_some_and(Value::is_null) {
            patch.remove(key);
        }
    }
}

/// CSV 設定的寬鬆讀法：字串原樣、陣列（上游也接受）以逗號接起字串與數字項目，其他型別當空字串。
/// 這幾個鍵寫壞時只回到預設值，不會讓整個 settings.json 讀不進來（那會改名成 `.corrupt-*` 並重設所有設定）。
/// `heatmapMetric`、`homeActiveDaysWindow` 也用它，錯的型別經 [`normalize`] 回到預設值。
pub fn de_csv<'de, D>(d: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Value::deserialize(d)? {
        Value::String(s) => s,
        Value::Array(items) => items
            .iter()
            .filter_map(|item| match item {
                Value::String(s) => Some(s.clone()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => String::new(),
    })
}

/// `homeLimitAccountCount` 的寬鬆讀法，對應上游 `Math.trunc(Number(value))`：數字、數字字串
/// （空字串 = 0）、布林（1 / 0）、null（0）；其他型別回預設值 3。
pub fn de_account_count<'de, D>(d: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let n = match Value::deserialize(d)? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            let s = s.trim();
            if s.is_empty() {
                Some(0.0)
            } else {
                s.parse::<f64>().ok()
            }
        }
        Value::Bool(b) => Some(if b { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        _ => None,
    };
    Ok(clamp_account_count(n))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn view_display_order_keeps_a_full_permutation_or_nothing() {
        assert_eq!(migrate_view_display_order(""), "");
        assert_eq!(migrate_view_display_order("bogus,model"), "");
        assert_eq!(
            migrate_view_display_order(" Trends ,HOME,trends"),
            "trends,home,tool,status,device,limits"
        );
    }

    #[test]
    fn hidden_views_dedupe_and_reset_when_everything_is_hidden() {
        assert_eq!(normalize_hidden("status,STATUS,x", VIEW_IDS), "status");
        assert_eq!(
            normalize_hidden("home,tool,status,device,limits,trends", VIEW_IDS),
            ""
        );
        assert_eq!(normalize_hidden("trends,status", VIEW_IDS), "trends,status");
    }

    #[test]
    fn home_module_order_is_always_complete() {
        assert_eq!(normalize_home_module_order(""), DEFAULT_HOME_MODULE_ORDER);
        assert_eq!(
            normalize_home_module_order(" , "),
            DEFAULT_HOME_MODULE_ORDER
        );
        assert_eq!(
            normalize_home_module_order("model,limits"),
            "model,limits,tool,device,trends"
        );
        assert_eq!(
            normalize_hidden("limits,tool,device,model,trends", HOME_MODULE_IDS),
            ""
        );
        assert_eq!(
            normalize_hidden("device,tool,device", HOME_MODULE_IDS),
            "device,tool"
        );
    }

    #[test]
    fn home_limit_provider_order_matches_upstream_migration() {
        assert_eq!(
            migrate_home_limit_provider_order("claude,codex,cursor,copilot"),
            "",
            "equal to the default order"
        );
        assert_eq!(migrate_home_limit_provider_order("codex"), "codex");
        assert_eq!(migrate_home_limit_provider_order("bogus"), "");
        assert_eq!(
            normalize_hidden_home_limit_providers("claude,codex,cursor,copilot"),
            "claude,codex,cursor,copilot",
            "no all-hidden reset"
        );
        assert_eq!(
            normalize_hidden_home_limit_providers("Kimi, CODEX"),
            "codex"
        );
    }

    #[test]
    fn enum_values_are_trimmed_but_case_sensitive() {
        assert_eq!(normalize_home_active_days_window("YEAR", "all"), "all");
        assert_eq!(normalize_home_active_days_window(" year ", "all"), "year");
        assert_eq!(normalize_home_active_days_window("x", "year"), "year");
        assert_eq!(normalize_heatmap_metric("Tokens", "cost"), "cost");
        assert_eq!(normalize_heatmap_metric("x", "tokens"), "tokens");
    }

    #[test]
    fn account_count_is_truncated_and_clamped() {
        assert_eq!(clamp_account_count(Some(0.0)), 1);
        assert_eq!(clamp_account_count(Some(13.0)), 12);
        assert_eq!(clamp_account_count(Some(2.9)), 2);
        assert_eq!(clamp_account_count(Some(f64::NAN)), 3);
        assert_eq!(clamp_account_count(None), 3);
    }

    #[test]
    fn sanitize_patch_keeps_the_current_value_for_invalid_enums() {
        let mut patch = Map::new();
        patch.insert("heatmapMetric".into(), json!("bogus"));
        patch.insert("homeActiveDaysWindow".into(), json!(" year "));
        patch.insert("homeLimitAccountCount".into(), Value::Null);
        patch.insert("hiddenViews".into(), json!("status"));
        sanitize_patch(&mut patch);
        assert!(!patch.contains_key("heatmapMetric"));
        assert_eq!(patch["homeActiveDaysWindow"], json!(" year "));
        assert!(!patch.contains_key("homeLimitAccountCount"));
        assert_eq!(patch["hiddenViews"], json!("status"));
    }
}
