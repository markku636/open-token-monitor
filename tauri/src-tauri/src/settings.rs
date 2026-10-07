//! 使用者設定（`<config_dir>/settings.json`）。
//!
//! - 每個欄位都有預設值（`#[serde(default)]`），舊檔少欄位不會壞；未知鍵以 `extra` 原樣保留，
//!   讓新版加的欄位在降版後仍不會被舊版刪掉。
//! - **secret 永不寫入此檔**：內建於 binary（baked），輪替用的覆寫存在 OS 認證管理員（secrets.rs）。
//! - `validate()` 把所有值收斂到 hub 與 tokscale 接受的集合；UI 與 CLI 寫入前都要過它。

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};
use crate::store;
use crate::usage::client_name::normalize_client_name;

pub const SETTINGS_FILE: &str = "settings.json";
pub const SETTINGS_VERSION: u32 = 1;

/// 公司支援的 AI 工具（2026-09-23 定案）。全部預設追蹤。
///
/// - Claude Code、Codex、OpenCode、Hermes Agent、GitHub Copilot：tokscale 直接讀本機紀錄。
/// - Cursor IDE / Cursor CLI：用量來自 Cursor 帳號層級的匯出，要先 `tokscale cursor sync`
///   把資料拉進 cache（collector/self_sync.rs），所以 IDE 與 CLI 都算得到。
/// - Antigravity：IDE 的用量要先 `tokscale antigravity sync`；Antigravity CLI 的對話 tokscale 直接讀。
///
/// 每個 id 都必須是 `normalize_client_name` 的不動點（client_name.rs 有測試）。
/// 其他 tokscale 支援的工具（上游 clientCatalog.js）要加回來時，加在這裡並補上 collector/roots.rs。
pub const SUPPORTED_CLIENTS: &[&str] = &[
    "claude",
    "codex",
    "opencode",
    "hermes",
    "cursor",
    "antigravity",
    "copilot",
];

/// 新增 provider 時維持上游 `LIMIT_PROVIDER_CATALOG`（shared/limitProviders.js）的相對順序：
/// `view_prefs::migrate_home_limit_provider_order` 拿它當「預設順序」比較。
pub const SUPPORTED_LIMIT_PROVIDERS: &[&str] = &["claude", "codex", "cursor", "copilot"];

/// hub 只接受這幾個上傳間隔（src/shared/syncUploadInterval.js）；其他值會被當成 0（即時）。
pub const SYNC_UPLOAD_INTERVAL_OPTIONS: &[u64] = &[0, 600_000, 1_200_000, 1_800_000];
/// 大量裝置同時上線時 hub 負載較重，預設 10 分鐘上傳一次。
pub const DEFAULT_SYNC_UPLOAD_INTERVAL_MS: u64 = 600_000;
pub const LIMITS_REFRESH_OPTIONS: &[u64] = &[60_000, 120_000, 300_000, 900_000, 1_800_000];
/// 上游 collector.js `HISTORY_INTERVAL_VALUES` / `DEFAULT_HISTORY_INTERVAL_MS`。
pub const HISTORY_INTERVAL_OPTIONS: &[u64] = &[300_000, 600_000, 900_000, 1_800_000, 3_600_000];
pub const DEFAULT_HISTORY_INTERVAL_MS: u64 = 900_000;
/// 上游 main.js `ZOOM_LIMITS`。
pub const ZOOM_MIN: f64 = 0.7;
pub const ZOOM_MAX: f64 = 1.6;
/// 上游 main.js 的服務狀態檢查間隔選項（0 = 手動）。
pub const SERVICE_STATUS_REFRESH_OPTIONS: &[u64] =
    &[0, 60_000, 120_000, 300_000, 900_000, 1_800_000];
/// 上游 app.js 的自動匯出頻率選項。
pub const EXPORT_INTERVAL_OPTIONS: &[u64] =
    &[30_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000];
/// 上游 collector.js 的 watchDebounceMs 預設值。
pub const DEFAULT_WATCH_DEBOUNCE_MS: u64 = 1_500;

const MAX_CUSTOM_SCAN_PATHS_PER_CLIENT: usize = 16;
const MAX_CUSTOM_SCAN_PATH_LENGTH: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum WindowMode {
    #[default]
    Floating,
    Normal,
    Desktop,
    /// 只在系統匣：按 tray 圖示時在圖示旁彈出，失去焦點就收起來（上游的 tray presentation）。
    Tray,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub version: u32,
    /// 裝置在 hub 上的身分（首次啟動產生，見 identity.rs）。
    pub device_id: String,
    /// 空字串 = 用內建的公司 hub；非空 = 覆寫（金鑰輪替或測試環境）。
    pub hub_url: String,
    /// 使用者的公司信箱，隨上傳送給 hub（`ownerEmail`），讓 hub 自動把這台裝置歸給對應的員工。
    /// 空字串 = 不回報；不像 email 的值由 validate() 清掉。
    pub owner_email: String,
    pub sync_upload_interval_ms: u64,
    pub tracked_clients: Vec<String>,
    /// client → 額外的掃描目錄（`TOKSCALE_EXTRA_DIRS`）。
    pub custom_scan_paths: IndexMap<String, Vec<String>>,
    pub all_time_since: String,
    pub projects_enabled: bool,
    /// 定時 tick 的間隔（錨點有效時只掃 today，否則 today → month → allTime）。
    pub collection_interval_ms: u64,
    pub tokscale_timeout_ms: u64,
    /// 監看來源目錄，有變動就在 3–5 秒內更新（上游 `TOKEN_MONITOR_WATCH`）。
    pub watch_enabled: bool,
    /// 檔案事件的尾端防抖（毫秒）。
    pub watch_debounce_ms: u64,
    /// client 刪掉舊紀錄後仍保留那些 session 的用量（上游 `sessionUsageArchiveEnabled`，預設開）。
    pub session_usage_archive_enabled: bool,
    /// 上傳每天的用量歷史（hub 的熱力圖與日表）。上游 `historyEnabled`。
    pub history_enabled: bool,
    /// history 的 graph 掃描間隔；換日與手動重掃時不等間隔。
    pub history_interval_ms: u64,
    pub limits_enabled: bool,
    pub limit_providers: Vec<String>,
    pub limits_refresh_ms: u64,
    /// `auto` | `zh-TW` | `en`
    pub language: String,
    /// `system` | `dark` | `light`（色彩模式，Tauri 專有；system 跟著 Windows 的應用程式模式）。
    /// 只在 `theme_colors` 沒有覆寫 `bg` 時決定明暗；有背景覆寫時由前端依背景亮度決定（上游規則）。
    pub theme: String,
    /// 動態效果：`system`（跟隨 Windows「動畫效果」）| `on`（一律減少）| `off`（一律播放）。
    /// 上游 `reduceMotion`（src/electron/motionPreference.js）；只影響畫面，不上傳。
    pub reduce_motion: String,
    /// 介面配色覆寫（上游 `themeColors`，themePresets.js）：`accent` / `bg` / `text` / `muted` → 小寫
    /// `#rrggbb`。空 = 內建配色。寬鬆解析：型別錯了只當成空的，不讓整個 settings.json 被當成壞檔。
    #[serde(deserialize_with = "de_color_map")]
    pub theme_colors: IndexMap<String, String>,
    /// 廠商色覆寫（上游 `vendorColors`）：廠商 id → 小寫 `#rrggbb`。未知的 id 照上游保留，
    /// 前端只採用品牌表裡有的 id（上游 renderer 同樣）。
    #[serde(deserialize_with = "de_color_map")]
    pub vendor_colors: IndexMap<String, String>,
    pub automatic_app_updates: bool,
    /// 使用者按了「忽略此版本」的版本：不再提示、也不自動下載，直到有更新的版本或手動檢查（上游 `appUpdate.dismissedVersion`）。
    pub app_update_dismissed_version: String,
    /// widget 底欄顯示即時 token 速率（上游 `showLiveTokenRate`，預設關）。
    pub show_live_token_rate: bool,
    /// 速率顯示 tok/s（`speed`）或 tok/min（`burn`）；點速率可切換（上游 `tokenRateMode`）。
    pub token_rate_mode: String,
    /// 清單前面畫工具／廠商圖示；關閉時改回色點（上游 `showToolIcons`，main.js defaultSettings 預設開）。
    pub show_tool_icons: bool,
    /// 標題旁的狀態點（上游 `showLiveDot`，預設開）。header 還沒照這三個鍵呈現，先照上游預設存下，
    /// settings.json 與 Electron 版互通。
    pub show_live_dot: bool,
    /// 標題只顯示 Σ（上游 `titleIconOnly`，defaultSettings 是 true；patch 的 fallback false 只在值為空時才用到）。
    pub title_icon_only: bool,
    /// 交換重新掃描與設定按鈕的位置（上游 `settingsInTitlebar`，renderer defaultAppearance 預設關；
    /// 鍵名是上游舊版「設定鈕放標題列」遺留的）。
    pub settings_in_titlebar: bool,
    /// 成本的顯示幣別（`USD` / `TWD` / `HKD` / `CNY`，上游 `currency`）。
    pub currency: String,
    /// 手動匯率（1 USD = ?），有值的幣別不用抓到的匯率（上游 `currencyRates`）。
    pub currency_rates: IndexMap<String, f64>,
    /// 自動把用量匯出成 CSV / JSON 到 `exportDir`（上游 `exportAutoEnabled`，預設關）。
    pub export_auto_enabled: bool,
    pub export_dir: String,
    /// 自動匯出的間隔；資料沒變時不重寫（上游 `exportIntervalMs`）。
    pub export_interval_ms: u64,
    /// 服務狀態（「狀態」視圖）顯示時多久檢查一次；0 = 只在按重新整理時（上游 `serviceStatusRefreshMs`）。
    pub service_status_refresh_ms: u64,
    /// 模型別名：記錄中的模型 id → 顯示時合併成的 id（上游 `modelAliases`；只影響畫面，不改上傳與匯出）。
    pub model_aliases: IndexMap<String, String>,
    /// 自動合併同一模型的不同寫法：`off` | `duplicates` | `prefix`（上游 `modelAliasGrouping`）。
    pub model_alias_grouping: String,
    pub window_mode: WindowMode,
    /// floating 模式時，widget 拖到工作列上仍保持在它上面（Windows；上游預設關，實驗性）。
    pub keep_above_taskbar: bool,
    /// floating 模式時，失去焦點就縮成螢幕邊緣的小把手（上游 `floatingBubbleEnabled`，預設關）。
    pub floating_bubble_enabled: bool,
    /// 螢幕邊緣的額度條（上游 `edgeDockEnabled`，預設關）。
    pub edge_dock_enabled: bool,
    /// `right` | `left`
    pub edge_dock_side: String,
    /// 額度條的垂直位置（0.1–0.9，工作區高度的比例；上游 `EDGE_DOCK_DEFAULT_OFFSET` = 0.3）。
    pub edge_dock_offset: f64,
    /// 40–100（%）
    pub opacity: u8,
    /// 系統匣圖示：`icon`（app 圖示）| `bars`（最接近上限的工具的兩條長條，上游 `bars`）|
    /// `barsSessions`（每個工具一條 5 小時長條，上游 `barsAllSessions`）。
    pub tray_content: String,
    /// widget 背後的 acrylic 玻璃（上游 `systemGlass`，預設開）。
    pub system_glass: bool,
    /// 內容縮放 0.7–1.6（上游 `zoomFactor`；Ctrl + = / - / 0）。
    pub zoom_factor: f64,
    /// 全域顯示／隱藏快捷鍵，例如 `CommandOrControl+Shift+T`；空字串 = 關閉（上游 `windowToggleShortcut`）。
    pub window_toggle_shortcut: String,
    pub autostart: bool,
    /// widget 視圖的切換順序（上游 `viewDisplayOrder`）：空字串 = 預設順序，否則是
    /// `view_prefs::VIEW_IDS` 的完整排列。
    #[serde(deserialize_with = "crate::view_prefs::de_csv")]
    pub view_display_order: String,
    /// 隱藏的視圖（上游 `hiddenViews`，預設 `status`）；全部隱藏時收斂成空字串。
    #[serde(deserialize_with = "crate::view_prefs::de_csv")]
    pub hidden_views: String,
    /// 主頁模組的順序（上游 `homeModuleOrder`），永遠是完整的排列。
    #[serde(deserialize_with = "crate::view_prefs::de_csv")]
    pub home_module_order: String,
    /// 主頁隱藏的模組（上游 `hiddenHomeModules`，預設 `tool,device`）。
    #[serde(deserialize_with = "crate::view_prefs::de_csv")]
    pub hidden_home_modules: String,
    /// 主頁額度剩餘不多時上色（上游 `showHomeLimitBars`，預設關）。
    pub show_home_limit_bars: bool,
    /// 同一 provider 有多個帳號時在帳號名前加 provider 名稱（上游 `showHomeLimitProviderNames`）。
    pub show_home_limit_provider_names: bool,
    /// 主頁額度的 provider 順序（上游 `homeLimitProviderOrder`）：空字串 = 剩餘最少優先。
    #[serde(deserialize_with = "crate::view_prefs::de_csv")]
    pub home_limit_provider_order: String,
    /// 主頁額度不顯示的 provider（上游 `hiddenHomeLimitProviders`）。
    #[serde(deserialize_with = "crate::view_prefs::de_csv")]
    pub hidden_home_limit_providers: String,
    /// 主頁額度最多顯示幾個帳號，1–12（上游 `homeLimitAccountCount`，預設 3）。
    #[serde(deserialize_with = "crate::view_prefs::de_account_count")]
    pub home_limit_account_count: u32,
    /// 主頁活動的活躍天數：`all`（history summary）| `year`（近 12 個月；上游 `homeActiveDaysWindow`）。
    #[serde(deserialize_with = "crate::view_prefs::de_csv")]
    pub home_active_days_window: String,
    /// 熱力圖依 `tokens` 或 `cost` 上色（上游 `heatmapMetric`，預設 `cost`）。
    #[serde(deserialize_with = "crate::view_prefs::de_csv")]
    pub heatmap_metric: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            version: SETTINGS_VERSION,
            device_id: String::new(),
            hub_url: String::new(),
            owner_email: String::new(),
            sync_upload_interval_ms: DEFAULT_SYNC_UPLOAD_INTERVAL_MS,
            tracked_clients: SUPPORTED_CLIENTS.iter().map(|s| s.to_string()).collect(),
            custom_scan_paths: IndexMap::new(),
            all_time_since: "2024-01-01".into(),
            projects_enabled: true,
            collection_interval_ms: 300_000,
            tokscale_timeout_ms: 120_000,
            watch_enabled: true,
            watch_debounce_ms: DEFAULT_WATCH_DEBOUNCE_MS,
            session_usage_archive_enabled: true,
            history_enabled: true,
            history_interval_ms: DEFAULT_HISTORY_INTERVAL_MS,
            limits_enabled: true,
            limit_providers: SUPPORTED_LIMIT_PROVIDERS
                .iter()
                .map(|s| s.to_string())
                .collect(),
            limits_refresh_ms: 300_000,
            language: "auto".into(),
            theme: "system".into(),
            reduce_motion: "system".into(),
            theme_colors: IndexMap::new(),
            vendor_colors: IndexMap::new(),
            automatic_app_updates: true,
            app_update_dismissed_version: String::new(),
            show_live_token_rate: false,
            token_rate_mode: "speed".into(),
            show_tool_icons: true,
            show_live_dot: true,
            title_icon_only: true,
            settings_in_titlebar: false,
            currency: "USD".into(),
            currency_rates: IndexMap::new(),
            export_auto_enabled: false,
            export_dir: String::new(),
            export_interval_ms: 60_000,
            service_status_refresh_ms: 60_000,
            model_aliases: IndexMap::new(),
            model_alias_grouping: "off".into(),
            window_mode: WindowMode::Floating,
            keep_above_taskbar: false,
            floating_bubble_enabled: false,
            edge_dock_enabled: false,
            edge_dock_side: "right".into(),
            edge_dock_offset: 0.3,
            opacity: 92,
            tray_content: "icon".into(),
            system_glass: true,
            zoom_factor: 1.0,
            window_toggle_shortcut: String::new(),
            autostart: true,
            // 以下是上游 main.js `defaultSettings()` 的預設值（:519-584）。
            view_display_order: String::new(),
            hidden_views: crate::view_prefs::DEFAULT_HIDDEN_VIEWS.into(),
            home_module_order: crate::view_prefs::DEFAULT_HOME_MODULE_ORDER.into(),
            hidden_home_modules: crate::view_prefs::DEFAULT_HIDDEN_HOME_MODULES.into(),
            show_home_limit_bars: false,
            show_home_limit_provider_names: false,
            home_limit_provider_order: String::new(),
            hidden_home_limit_providers: String::new(),
            home_limit_account_count: crate::view_prefs::HOME_LIMIT_ACCOUNT_COUNT_DEFAULT,
            home_active_days_window: "all".into(),
            heatmap_metric: "cost".into(),
            extra: Map::new(),
        }
    }
}

fn is_absolute_path(dir: &str) -> bool {
    let b = dir.as_bytes();
    let drive = b.len() >= 3
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && (b[2] == b'\\' || b[2] == b'/');
    let unc = dir.starts_with("\\\\") && dir.len() > 2;
    if cfg!(windows) {
        drive || unc
    } else {
        dir.starts_with('/')
    }
}

impl Settings {
    /// 把所有值收斂到合法集合。回傳調整過的欄位名稱（給 log 用）。
    pub fn validate(&mut self) -> Vec<&'static str> {
        let mut changed = Vec::new();
        self.version = SETTINGS_VERSION;
        self.device_id = self.device_id.trim().to_string();
        let hub = self.hub_url.trim().trim_end_matches('/').to_string();
        if hub != self.hub_url {
            self.hub_url = hub;
            changed.push("hubUrl");
        }
        let owner_email = normalize_owner_email(&self.owner_email);
        if owner_email != self.owner_email {
            self.owner_email = owner_email;
            changed.push("ownerEmail");
        }
        if !SYNC_UPLOAD_INTERVAL_OPTIONS.contains(&self.sync_upload_interval_ms) {
            self.sync_upload_interval_ms = DEFAULT_SYNC_UPLOAD_INTERVAL_MS;
            changed.push("syncUploadIntervalMs");
        }
        let mut clients: Vec<String> = Vec::new();
        for c in &self.tracked_clients {
            if let Some(id) = normalize_client_name(c) {
                if SUPPORTED_CLIENTS.contains(&id.as_str()) && !clients.contains(&id) {
                    clients.push(id);
                }
            }
        }
        if clients != self.tracked_clients {
            self.tracked_clients = clients;
            changed.push("trackedClients");
        }
        let mut providers: Vec<String> = Vec::new();
        for p in &self.limit_providers {
            let id = p.trim().to_lowercase();
            if SUPPORTED_LIMIT_PROVIDERS.contains(&id.as_str()) && !providers.contains(&id) {
                providers.push(id);
            }
        }
        if providers != self.limit_providers {
            self.limit_providers = providers;
            changed.push("limitProviders");
        }
        if !HISTORY_INTERVAL_OPTIONS.contains(&self.history_interval_ms) {
            self.history_interval_ms = DEFAULT_HISTORY_INTERVAL_MS;
            changed.push("historyIntervalMs");
        }
        if !LIMITS_REFRESH_OPTIONS.contains(&self.limits_refresh_ms) {
            self.limits_refresh_ms = 300_000;
            changed.push("limitsRefreshMs");
        }
        let interval = self.collection_interval_ms.clamp(60_000, 3_600_000);
        if interval != self.collection_interval_ms {
            self.collection_interval_ms = interval;
            changed.push("collectionIntervalMs");
        }
        let timeout = self.tokscale_timeout_ms.clamp(10_000, 600_000);
        if timeout != self.tokscale_timeout_ms {
            self.tokscale_timeout_ms = timeout;
            changed.push("tokscaleTimeoutMs");
        }
        let debounce = self.watch_debounce_ms.clamp(250, 10_000);
        if debounce != self.watch_debounce_ms {
            self.watch_debounce_ms = debounce;
            changed.push("watchDebounceMs");
        }
        if chrono::NaiveDate::parse_from_str(self.all_time_since.trim(), "%Y-%m-%d").is_err() {
            self.all_time_since = "2024-01-01".into();
            changed.push("allTimeSince");
        }
        let opacity = self.opacity.clamp(40, 100);
        if opacity != self.opacity {
            self.opacity = opacity;
            changed.push("opacity");
        }
        let zoom = clamp_zoom(self.zoom_factor);
        if zoom != self.zoom_factor {
            self.zoom_factor = zoom;
            changed.push("zoomFactor");
        }
        let shortcut = normalize_window_toggle_shortcut(&self.window_toggle_shortcut);
        if shortcut != self.window_toggle_shortcut {
            self.window_toggle_shortcut = shortcut;
            changed.push("windowToggleShortcut");
        }
        if !matches!(self.language.as_str(), "auto" | "zh-TW" | "en") {
            self.language = "auto".into();
            changed.push("language");
        }
        if !matches!(self.edge_dock_side.as_str(), "right" | "left") {
            self.edge_dock_side = "right".into();
            changed.push("edgeDockSide");
        }
        let offset = if self.edge_dock_offset.is_finite() {
            self.edge_dock_offset.clamp(0.1, 0.9)
        } else {
            0.3
        };
        if offset != self.edge_dock_offset {
            self.edge_dock_offset = offset;
            changed.push("edgeDockOffset");
        }
        if !matches!(self.tray_content.as_str(), "icon" | "bars" | "barsSessions") {
            self.tray_content = "icon".into();
            changed.push("trayContent");
        }
        let code = self.currency.trim().to_uppercase();
        let code = if crate::currency::is_supported(&code) {
            code
        } else {
            "USD".to_string()
        };
        if code != self.currency {
            self.currency = code;
            changed.push("currency");
        }
        // 上游 normalizeCurrencyOverrides：只留支援的非 USD 幣別、> 0 的值。
        let rates: IndexMap<String, f64> = self
            .currency_rates
            .iter()
            .map(|(k, v)| (k.trim().to_uppercase(), *v))
            .filter(|(k, v)| {
                k != "USD" && crate::currency::is_supported(k) && v.is_finite() && *v > 0.0
            })
            .collect();
        if rates != self.currency_rates {
            self.currency_rates = rates;
            changed.push("currencyRates");
        }
        let aliases = normalize_model_aliases(&self.model_aliases);
        if aliases != self.model_aliases {
            self.model_aliases = aliases;
            changed.push("modelAliases");
        }
        if !matches!(
            self.model_alias_grouping.as_str(),
            "off" | "duplicates" | "prefix"
        ) {
            self.model_alias_grouping = "off".into();
            changed.push("modelAliasGrouping");
        }
        if !SERVICE_STATUS_REFRESH_OPTIONS.contains(&self.service_status_refresh_ms) {
            self.service_status_refresh_ms = 60_000;
            changed.push("serviceStatusRefreshMs");
        }
        if !EXPORT_INTERVAL_OPTIONS.contains(&self.export_interval_ms) {
            self.export_interval_ms = 60_000;
            changed.push("exportIntervalMs");
        }
        let export_dir = self.export_dir.trim().to_string();
        if export_dir != self.export_dir {
            self.export_dir = export_dir;
            changed.push("exportDir");
        }
        if !matches!(self.token_rate_mode.as_str(), "speed" | "burn") {
            self.token_rate_mode = "speed".into();
            changed.push("tokenRateMode");
        }
        if !matches!(self.theme.as_str(), "system" | "dark" | "light") {
            self.theme = "system".into();
            changed.push("theme");
        }
        // 上游 motionPreference.js `normalize`：去掉前後空白、大小寫要相符，其他值一律回到 system
        //（不是保留目前的值）。
        let reduce_motion = self.reduce_motion.trim();
        let reduce_motion = if matches!(reduce_motion, "system" | "on" | "off") {
            reduce_motion
        } else {
            "system"
        };
        if reduce_motion != self.reduce_motion {
            self.reduce_motion = reduce_motion.to_string();
            changed.push("reduceMotion");
        }
        let theme_colors = normalize_theme_colors(&self.theme_colors);
        if theme_colors != self.theme_colors {
            self.theme_colors = theme_colors;
            changed.push("themeColors");
        }
        let vendor_colors = normalize_vendor_colors(&self.vendor_colors);
        if vendor_colors != self.vendor_colors {
            self.vendor_colors = vendor_colors;
            changed.push("vendorColors");
        }
        let paths = normalize_custom_scan_paths(&self.custom_scan_paths);
        if paths != self.custom_scan_paths {
            self.custom_scan_paths = paths;
            changed.push("customScanPaths");
        }
        changed.extend(crate::view_prefs::normalize(self));
        changed
    }

    /// 讀設定；不存在回預設值（`created = true`）。壞掉的檔案改名保留後用預設值，
    /// 讓員工的 widget 仍能啟動（IT 事後可以從 `.corrupt` 檔找原因）。
    pub fn load_in(dir: &std::path::Path) -> AppResult<(Settings, bool)> {
        match store::read_json_in::<Settings>(dir, SETTINGS_FILE) {
            Ok(Some(mut s)) => {
                s.validate();
                Ok((s, false))
            }
            Ok(None) => Ok((Settings::default(), true)),
            Err(e) => {
                tracing::warn!(error = %e, "settings.json is unreadable; starting from defaults");
                let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
                let _ = std::fs::rename(
                    dir.join(SETTINGS_FILE),
                    dir.join(format!("{SETTINGS_FILE}.corrupt-{stamp}")),
                );
                Ok((Settings::default(), true))
            }
        }
    }

    pub fn save_in(&self, dir: &std::path::Path) -> AppResult<()> {
        store::write_json_in(dir, SETTINGS_FILE, self)
    }

    /// GUI 與 tm-agent 共用的啟動流程：讀設定、第一次啟動時依 D9 規則指派 deviceId 並寫回。
    pub fn load_or_init(dir: &std::path::Path) -> AppResult<Settings> {
        let (mut settings, created) = Settings::load_in(dir)?;
        if settings.device_id.is_empty() {
            let (id, how) = crate::identity::initial_device_id();
            tracing::info!(device_id = %id, how, "assigned device id");
            settings.device_id = id;
            settings.save_in(dir)?;
        } else if created {
            settings.save_in(dir)?;
        }
        Ok(settings)
    }

    /// 以 JSON patch（前端送來的部分欄位）更新，驗證後回傳新設定。未知或型別錯誤的欄位回錯。
    pub fn patched(&self, patch: &Map<String, Value>) -> AppResult<Settings> {
        const READ_ONLY: &[&str] = &["version", "deviceId"];
        // 視圖設定裡上游「無效就保留目前的值」的欄位先濾掉（view_prefs::sanitize_patch）。
        let mut patch = patch.clone();
        crate::view_prefs::sanitize_patch(&mut patch);
        let mut merged =
            serde_json::to_value(self).map_err(|e| AppError::Internal(e.to_string()))?;
        let obj = merged
            .as_object_mut()
            .expect("settings serialize to an object");
        for (key, value) in &patch {
            if READ_ONLY.contains(&key.as_str()) {
                return Err(AppError::Settings(format!("{key} 不可修改")));
            }
            obj.insert(key.clone(), value.clone());
        }
        let mut next: Settings =
            serde_json::from_value(merged).map_err(|e| AppError::Settings(e.to_string()))?;
        next.validate();
        Ok(next)
    }
}

/// 上游 `clampZoom`：兩位小數、夾在 0.7–1.6，無效值回到 1。
pub fn clamp_zoom(value: f64) -> f64 {
    if !value.is_finite() {
        return 1.0;
    }
    ((value * 100.0).round() / 100.0).clamp(ZOOM_MIN, ZOOM_MAX)
}

const SHORTCUT_MODIFIERS: &[(&str, &str)] = &[
    ("cmdorctrl", "CommandOrControl"),
    ("cmdorcontrol", "CommandOrControl"),
    ("commandorcontrol", "CommandOrControl"),
    ("command", "Command"),
    ("cmd", "Command"),
    ("ctrl", "Control"),
    ("control", "Control"),
    ("alt", "Alt"),
    ("option", "Alt"),
    ("shift", "Shift"),
    ("super", "Super"),
    ("meta", "Super"),
];
const SHORTCUT_MODIFIER_ORDER: &[&str] = &[
    "CommandOrControl",
    "Command",
    "Control",
    "Alt",
    "Shift",
    "Super",
];

fn normalize_shortcut_key(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let upper = raw.to_uppercase();
    if upper.len() == 1 && upper.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Some(upper);
    }
    if let Some(n) = upper.strip_prefix('F').and_then(|n| n.parse::<u8>().ok()) {
        if (1..=24).contains(&n) && upper == format!("F{n}") {
            return Some(upper);
        }
    }
    match raw.to_lowercase().as_str() {
        "space" => Some("Space".into()),
        "tab" => Some("Tab".into()),
        "enter" | "return" => Some("Enter".into()),
        _ if raw == " " => Some("Space".into()),
        _ => None,
    }
}

/// 上游 windowShortcut.js `normalizeWindowToggleShortcut`：修飾鍵照固定順序、至少一個主要修飾鍵
///（Shift 單獨不算），不合法就是空字串（關閉）。
pub fn normalize_window_toggle_shortcut(value: &str) -> String {
    let parts: Vec<&str> = value
        .split('+')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() < 2 {
        return String::new();
    }
    let Some(key) = normalize_shortcut_key(parts[parts.len() - 1]) else {
        return String::new();
    };
    let named: Vec<&str> = parts[..parts.len() - 1]
        .iter()
        .filter_map(|p| {
            let lower = p.to_lowercase();
            SHORTCUT_MODIFIERS
                .iter()
                .find(|(alias, _)| *alias == lower)
                .map(|(_, m)| *m)
        })
        .collect();
    let modifiers: Vec<&str> = SHORTCUT_MODIFIER_ORDER
        .iter()
        .copied()
        .filter(|m| named.contains(m))
        .collect();
    if !modifiers.iter().any(|m| *m != "Shift") {
        return String::new();
    }
    let mut out: Vec<String> = modifiers.iter().map(|m| m.to_string()).collect();
    out.push(key);
    out.join("+")
}

/// 上游 modelAliases.js 的 `matchKey`：小寫、. _ 空白換成 -、合併連續的 -、去頭尾 -。
fn alias_match_key(model: &str) -> String {
    let lowered = model.trim().to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    for ch in lowered.chars() {
        let c = if matches!(ch, '.' | '_') || ch.is_whitespace() {
            '-'
        } else {
            ch
        };
        if c == '-' && out.ends_with('-') {
            continue;
        }
        out.push(c);
    }
    out.trim_matches('-').to_string()
}

/// 上游 `normalizeModelAliases`：兩邊 trim 後 1–256 字、比對鍵不同，同一個別名只留第一個，最多 4096 組。
fn normalize_model_aliases(value: &IndexMap<String, String>) -> IndexMap<String, String> {
    let mut out = IndexMap::new();
    let mut seen = std::collections::HashSet::new();
    for (source, target) in value {
        let alias = source.trim();
        let canonical = target.trim();
        if alias.is_empty()
            || canonical.is_empty()
            || alias.chars().count() > 256
            || canonical.chars().count() > 256
            || alias_match_key(alias) == alias_match_key(canonical)
            || !seen.insert(alias_match_key(alias))
        {
            continue;
        }
        out.insert(alias.to_string(), canonical.to_string());
        if out.len() == 4096 {
            break;
        }
    }
    out
}

fn normalize_custom_scan_paths(
    value: &IndexMap<String, Vec<String>>,
) -> IndexMap<String, Vec<String>> {
    let mut out: IndexMap<String, Vec<String>> = IndexMap::new();
    for (client, dirs) in value {
        let Some(id) = normalize_client_name(client) else {
            continue;
        };
        if !SUPPORTED_CLIENTS.contains(&id.as_str()) {
            continue;
        }
        let entry = out.entry(id).or_default();
        for dir in dirs {
            let d = dir.trim();
            // TOKSCALE_EXTRA_DIRS 以逗號分隔、沒有跳脫語法，含逗號或換行的路徑會被拆成別的來源。
            if d.is_empty()
                || d.len() > MAX_CUSTOM_SCAN_PATH_LENGTH
                || !is_absolute_path(d)
                || d.contains([',', '\0', '\r', '\n'])
            {
                continue;
            }
            let dup = entry.iter().any(|e| {
                if cfg!(windows) {
                    e.eq_ignore_ascii_case(d)
                } else {
                    e == d
                }
            });
            if !dup && entry.len() < MAX_CUSTOM_SCAN_PATHS_PER_CLIENT {
                entry.push(d.to_string());
            }
        }
    }
    out.retain(|_, dirs| !dirs.is_empty());
    out
}

/// 可自訂的介面色（上游 themePresets.js `INTERFACE_COLOR_KEYS`；順序是 TM1 主題代碼格式的一部分）。
pub const THEME_COLOR_KEYS: &[&str] = &["accent", "bg", "text", "muted"];

/// 上游 themePresets.js `normalizeHex`：去頭尾空白後必須剛好是 `#` 加 6 個十六進位字元，回傳小寫；
/// `#abc` 簡寫與少了 `#` 都不接受。
pub fn normalize_hex(value: &str) -> Option<String> {
    let v = value.trim();
    let digits = v.strip_prefix('#')?;
    (digits.len() == 6 && digits.bytes().all(|b| b.is_ascii_hexdigit())).then(|| v.to_lowercase())
}

/// 上游 `normalizeOverrides(themeColors, INTERFACE_COLOR_KEYS)`：只留四個鍵與合法的色碼。
/// 與預設值相同的值不拿掉（貼上的主題代碼存的是完整的四色，上游同樣保留）。
fn normalize_theme_colors(value: &IndexMap<String, String>) -> IndexMap<String, String> {
    value
        .iter()
        .filter(|(k, _)| THEME_COLOR_KEYS.contains(&k.as_str()))
        .filter_map(|(k, v)| normalize_hex(v).map(|hex| (k.clone(), hex)))
        .collect()
}

/// 上游 main.js `migrateVendorColors`（載入與每次 patch 都跑）：`kilocode` → `kilo`、`micode` → `mimo`
///（新 id 已有值時不覆蓋，舊 id 一律刪掉；`xiaomi` 是模型廠商那一軸，保留自己的覆寫）。
/// 上游在 main 不驗證色碼、交給 renderer 忽略壞值；這裡照 validate() 的慣例直接清掉壞值與空鍵，
/// 畫面上的結果相同。未知的廠商 id 照上游保留（新版加的廠商降版後不會被刪）。
fn normalize_vendor_colors(value: &IndexMap<String, String>) -> IndexMap<String, String> {
    let mut colors = value.clone();
    for (new_id, old_id) in [("kilo", "kilocode"), ("mimo", "micode")] {
        if let Some(old) = colors.shift_remove(old_id) {
            colors.entry(new_id.to_string()).or_insert(old);
        }
    }
    colors
        .iter()
        .filter(|(k, _)| !k.trim().is_empty())
        .filter_map(|(k, v)| normalize_hex(v).map(|hex| (k.clone(), hex)))
        .collect()
}

/// `themeColors` / `vendorColors` 的寬鬆解析：物件只留字串值（依原順序），其他型別當成空的。
/// 手改壞一個值不該讓 `load_in` 把整份 settings.json 改名成 `.corrupt-*`。
fn de_color_map<'de, D>(deserializer: D) -> Result<IndexMap<String, String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(match Value::deserialize(deserializer)? {
        Value::Object(map) => map
            .into_iter()
            .filter_map(|(k, v)| match v {
                Value::String(s) => Some((k, s)),
                _ => None,
            })
            .collect(),
        _ => IndexMap::new(),
    })
}

/// hub 設定的來源，給診斷畫面與 `tm-agent doctor` 顯示。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ValueSource {
    Cli,
    Env,
    Settings,
    Keyring,
    Baked,
    None,
}

#[derive(Debug, Clone)]
pub struct HubResolution {
    pub url: Option<String>,
    pub url_source: ValueSource,
    pub secret: Option<String>,
    pub secret_source: ValueSource,
}

impl HubResolution {
    /// 遮罩後的 secret：只露最後 4 碼，給 UI 與診斷。
    pub fn secret_masked(&self) -> Option<String> {
        self.secret.as_deref().map(mask_secret)
    }
}

pub fn mask_secret(secret: &str) -> String {
    let chars: Vec<char> = secret.chars().collect();
    let tail: String = chars[chars.len().saturating_sub(4)..].iter().collect();
    format!("••••{tail}")
}

/// 公司信箱：去空白、轉小寫；不像 email 的值回傳空字串。規則與 hub 的
/// overlay `hub/ingestGuard.js` 的 `normalizeOwnerEmail` 相同（hub 對不合法的值也是直接略過）。
pub fn normalize_owner_email(value: &str) -> String {
    let email = value.trim().to_lowercase();
    let valid = email.len() <= 254
        && !email.chars().any(char::is_whitespace)
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && !domain.contains('@')
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
        });
    if valid {
        email
    } else {
        String::new()
    }
}

/// 上傳帶的公司信箱：環境變數 `TOKEN_MONITOR_OWNER_EMAIL`（IT 派送時可以直接給）優先，其次是設定頁。
/// tm-agent 的 `--owner-email` 由 clap 先併進 settings，所以不再經過這裡。
pub fn resolve_owner_email(settings: &Settings) -> String {
    std::env::var("TOKEN_MONITOR_OWNER_EMAIL")
        .ok()
        .map(|v| normalize_owner_email(&v))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| settings.owner_email.clone())
}

/// hub 網址與 secret 的解析順序：CLI → 環境變數 → 設定檔／認證管理員 → 內建值。
pub fn resolve_hub(
    settings: &Settings,
    cli_url: Option<&str>,
    cli_secret: Option<&str>,
) -> HubResolution {
    let env_url = std::env::var("TOKEN_MONITOR_HUB_URL").ok();
    let env_secret = std::env::var("TOKEN_MONITOR_SECRET").ok();
    let clean = |v: &str| v.trim().trim_end_matches('/').to_string();
    let (url, url_source) = if let Some(v) = cli_url.map(clean).filter(|v| !v.is_empty()) {
        (Some(v), ValueSource::Cli)
    } else if let Some(v) = env_url.as_deref().map(clean).filter(|v| !v.is_empty()) {
        (Some(v), ValueSource::Env)
    } else if !settings.hub_url.trim().is_empty() {
        (Some(clean(&settings.hub_url)), ValueSource::Settings)
    } else if let Some(v) = crate::baked::hub_url() {
        (Some(v.to_string()), ValueSource::Baked)
    } else {
        (None, ValueSource::None)
    };
    let (secret, secret_source) =
        if let Some(v) = cli_secret.map(str::trim).filter(|v| !v.is_empty()) {
            (Some(v.to_string()), ValueSource::Cli)
        } else if let Some(v) = env_secret
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            (Some(v.to_string()), ValueSource::Env)
        } else if let Some(v) = crate::secrets::override_secret() {
            (Some(v), ValueSource::Keyring)
        } else if let Some(v) = crate::baked::client_secret() {
            (Some(v.to_string()), ValueSource::Baked)
        } else {
            (None, ValueSource::None)
        };
    HubResolution {
        url,
        url_source,
        secret,
        secret_source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_aliases_are_normalized_like_upstream() {
        assert_eq!(alias_match_key(" Claude_Opus.5 "), "claude-opus-5");
        let mut s = Settings::default();
        s.model_aliases.insert(" gpt-5-cc ".into(), "gpt-5".into());
        s.model_aliases.insert("GPT_5_CC".into(), "other".into());
        s.model_aliases.insert("same".into(), "SAME".into());
        s.model_alias_grouping = "weird".into();
        s.validate();
        assert_eq!(s.model_aliases.len(), 1);
        assert_eq!(s.model_aliases["gpt-5-cc"], "gpt-5");
        assert_eq!(s.model_alias_grouping, "off");
    }

    #[test]
    fn window_toggle_shortcuts_follow_upstream_rules() {
        assert_eq!(
            normalize_window_toggle_shortcut("shift + ctrl + t"),
            "Control+Shift+T"
        );
        assert_eq!(
            normalize_window_toggle_shortcut("CmdOrCtrl+Alt+f12"),
            "CommandOrControl+Alt+F12"
        );
        assert_eq!(
            normalize_window_toggle_shortcut("Shift+T"),
            "",
            "Shift alone is not enough"
        );
        assert_eq!(normalize_window_toggle_shortcut("T"), "");
        assert_eq!(normalize_window_toggle_shortcut("Ctrl+F25"), "");
        assert_eq!(normalize_window_toggle_shortcut("Alt+space"), "Alt+Space");
        assert_eq!(normalize_window_toggle_shortcut(""), "");
    }

    #[test]
    fn zoom_is_clamped_like_upstream() {
        assert_eq!(clamp_zoom(1.234), 1.23);
        assert_eq!(clamp_zoom(0.1), 0.7);
        assert_eq!(clamp_zoom(9.0), 1.6);
        assert_eq!(clamp_zoom(f64::NAN), 1.0);
    }
    use serde_json::json;

    #[test]
    fn owner_email_is_lower_cased_and_a_malformed_one_dropped() {
        assert_eq!(
            normalize_owner_email(" Jane.Doe@Initech.EXAMPLE "),
            "jane.doe@initech.example"
        );
        for bad in [
            "jane.doe", "a b@c.d", "@c.d", "a@c", "a@.c", "a@c.", "a@b@c.d", "",
        ] {
            assert_eq!(normalize_owner_email(bad), "", "{bad:?}");
        }
        assert_eq!(
            normalize_owner_email(&format!("{}@x.test", "a".repeat(250))),
            "",
            "longer than an address can be"
        );
        let mut s = Settings {
            owner_email: "Someone@Example.test ".into(),
            ..Settings::default()
        };
        assert!(s.validate().contains(&"ownerEmail"));
        assert_eq!(s.owner_email, "someone@example.test");
        s.owner_email = "not an email".into();
        s.validate();
        assert_eq!(s.owner_email, "", "the hub would ignore it anyway");
    }

    #[test]
    fn validate_clamps_to_hub_accepted_values() {
        let mut s = Settings {
            sync_upload_interval_ms: 123,
            tracked_clients: vec![
                "Claude Code".into(),
                "claude".into(),
                "proma".into(),
                "micode".into(),
                "GitHub Copilot".into(),
                "antigravity-cli".into(),
            ],
            limit_providers: vec!["claude".into(), "kimi".into()],
            hub_url: " https://hub.example/ ".into(),
            opacity: 5,
            ..Settings::default()
        };
        s.validate();
        assert_eq!(s.sync_upload_interval_ms, 600_000);
        // 不在公司支援清單的工具（proma、MiMo）被拿掉；別名收斂到正式 id。
        assert_eq!(s.tracked_clients, vec!["claude", "copilot", "antigravity"]);
        assert_eq!(s.limit_providers, vec!["claude"]);
        assert_eq!(s.hub_url, "https://hub.example");
        assert_eq!(s.opacity, 40);
    }

    #[test]
    fn keeps_unknown_keys_and_fills_defaults() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            r#"{"deviceId":"abc","futureKey":{"x":1},"syncUploadIntervalMs":0}"#,
        )
        .unwrap();
        let (s, created) = Settings::load_in(dir.path()).unwrap();
        assert!(!created);
        assert_eq!(s.device_id, "abc");
        assert_eq!(s.sync_upload_interval_ms, 0);
        assert_eq!(s.tracked_clients.len(), SUPPORTED_CLIENTS.len());
        s.save_in(dir.path()).unwrap();
        let raw: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join(SETTINGS_FILE)).unwrap())
                .unwrap();
        assert_eq!(raw["futureKey"], json!({ "x": 1 }));
        assert!(raw.get("secret").is_none());
    }

    #[test]
    fn widget_chrome_keys_use_upstream_names_and_defaults() {
        // 上游 main.js defaultSettings：showLiveDot / showToolIcons / titleIconOnly 預設 true；
        // settingsInTitlebar 只在 renderer defaultAppearance，預設 false。舊檔沒有這些鍵時補預設值。
        let s: Settings = serde_json::from_str(r#"{"deviceId":"abc"}"#).unwrap();
        assert!(s.show_tool_icons && s.show_live_dot && s.title_icon_only);
        assert!(!s.settings_in_titlebar);
        let raw = serde_json::to_value(&s).unwrap();
        assert_eq!(raw["showToolIcons"], json!(true));
        assert_eq!(raw["showLiveDot"], json!(true));
        assert_eq!(raw["titleIconOnly"], json!(true));
        assert_eq!(raw["settingsInTitlebar"], json!(false));
        assert!(s.extra.is_empty());

        // Electron 版寫的值原樣讀進來、存回去，不會落進 extra。
        let s: Settings = serde_json::from_str(
            r#"{"showToolIcons":false,"showLiveDot":false,"titleIconOnly":false,"settingsInTitlebar":true}"#,
        )
        .unwrap();
        assert!(!s.show_tool_icons && !s.show_live_dot && !s.title_icon_only);
        assert!(s.settings_in_titlebar);
        assert!(s.extra.is_empty());

        let mut patch = Map::new();
        patch.insert("showToolIcons".into(), json!(false));
        let next = Settings::default().patched(&patch).unwrap();
        assert!(!next.show_tool_icons);
        // 型別錯誤的 patch 回錯（與其他 bool 設定相同），不會存成字串。
        patch.insert("showToolIcons".into(), json!("off"));
        assert!(Settings::default().patched(&patch).is_err());
    }

    #[test]
    fn corrupt_file_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(SETTINGS_FILE), "{not json").unwrap();
        let (_, created) = Settings::load_in(dir.path()).unwrap();
        assert!(created);
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names
            .iter()
            .any(|n| n.starts_with("settings.json.corrupt-")));
    }

    #[test]
    fn patch_rejects_device_id_and_bad_types() {
        let s = Settings::default();
        let mut patch = Map::new();
        patch.insert("deviceId".into(), json!("x"));
        assert!(s.patched(&patch).is_err());
        let mut patch = Map::new();
        patch.insert("opacity".into(), json!("high"));
        assert!(s.patched(&patch).is_err());
        let mut patch = Map::new();
        patch.insert("syncUploadIntervalMs".into(), json!(1_200_000));
        assert_eq!(
            s.patched(&patch).unwrap().sync_upload_interval_ms,
            1_200_000
        );
    }

    fn color_map(v: Value) -> IndexMap<String, String> {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn theme_colors_are_normalized_like_upstream() {
        assert_eq!(normalize_hex(" #AbCdEf "), Some("#abcdef".into()));
        for bad in ["#abc", "abcdef", "#abcdeg", "#abcdef0", "", "#"] {
            assert_eq!(normalize_hex(bad), None, "{bad:?}");
        }
        let mut s = Settings {
            theme_colors: color_map(json!({
                "accent": "#AABBCC", "bg": " #303438 ", "text": "bad", "bogus": "#ffffff"
            })),
            ..Settings::default()
        };
        assert!(s.validate().contains(&"themeColors"));
        assert_eq!(
            s.theme_colors,
            color_map(json!({ "accent": "#aabbcc", "bg": "#303438" }))
        );
        // 與預設值相同的完整四色（貼上的 TM1 代碼）原樣保留，不被當成「沒覆寫」拿掉。
        let full = color_map(json!({
            "accent": "#b7ead4", "bg": "#303438", "text": "#eef5fb", "muted": "#a3adbb"
        }));
        s.theme_colors = full.clone();
        assert!(!s.validate().contains(&"themeColors"));
        assert_eq!(s.theme_colors, full);
    }

    #[test]
    fn vendor_colors_migrate_renamed_ids() {
        let normalized = |v: Value| normalize_vendor_colors(&color_map(v));
        assert_eq!(
            normalized(json!({ "kilocode": "#F8F676" })),
            color_map(json!({ "kilo": "#f8f676" }))
        );
        assert_eq!(
            normalized(json!({ "kilo": "#111111", "kilocode": "#222222" })),
            color_map(json!({ "kilo": "#111111" }))
        );
        assert_eq!(
            normalized(json!({ "micode": "#000000" })),
            color_map(json!({ "mimo": "#000000" }))
        );
        // xiaomi 是模型廠商那一軸，與 MiMo 工具各自保留。
        assert_eq!(
            normalized(json!({ "xiaomi": "#123456", "micode": "#abcdef" })),
            color_map(json!({ "xiaomi": "#123456", "mimo": "#abcdef" }))
        );
        assert_eq!(
            normalized(
                json!({ "futurevendor": "#010203", "claude": "red", "": "#000000", "  ": "#000000" })
            ),
            color_map(json!({ "futurevendor": "#010203" }))
        );
        let mut s = Settings {
            vendor_colors: color_map(json!({ "kilocode": "#F8F676" })),
            ..Settings::default()
        };
        assert!(s.validate().contains(&"vendorColors"));
    }

    #[test]
    fn malformed_color_maps_do_not_corrupt_settings() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            r##"{"deviceId":"x","themeColors":"oops","vendorColors":{"claude":5,"codex":"#49A3B0"}}"##,
        )
        .unwrap();
        let (s, created) = Settings::load_in(dir.path()).unwrap();
        assert!(!created);
        assert!(s.theme_colors.is_empty());
        assert_eq!(s.vendor_colors, color_map(json!({ "codex": "#49a3b0" })));
        let corrupt = std::fs::read_dir(dir.path()).unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".corrupt-")
        });
        assert!(!corrupt);
    }

    #[test]
    fn color_patch_replaces_the_whole_map() {
        let s = Settings {
            theme_colors: color_map(json!({ "accent": "#111111", "bg": "#222222" })),
            ..Settings::default()
        };
        let mut patch = Map::new();
        patch.insert("themeColors".into(), json!({ "muted": "#333333" }));
        assert_eq!(
            s.patched(&patch).unwrap().theme_colors,
            color_map(json!({ "muted": "#333333" }))
        );
    }

    #[test]
    fn color_maps_default_to_empty_objects() {
        let raw = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(raw["themeColors"], json!({}));
        assert_eq!(raw["vendorColors"], json!({}));
    }

    #[test]
    fn view_prefs_default_like_upstream() {
        let mut s = Settings::default();
        assert_eq!(s.view_display_order, "");
        assert_eq!(s.hidden_views, "status");
        assert_eq!(s.home_module_order, "limits,tool,device,model,trends");
        assert_eq!(s.hidden_home_modules, "tool,device");
        assert!(!s.show_home_limit_bars);
        assert!(!s.show_home_limit_provider_names);
        assert_eq!(s.home_limit_provider_order, "");
        assert_eq!(s.hidden_home_limit_providers, "");
        assert_eq!(s.home_limit_account_count, 3);
        assert_eq!(s.home_active_days_window, "all");
        assert_eq!(s.heatmap_metric, "cost");
        assert!(s.validate().is_empty(), "defaults are already normalized");
    }

    fn load_json(raw: &str) -> Settings {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(SETTINGS_FILE), raw).unwrap();
        let (s, created) = Settings::load_in(dir.path()).unwrap();
        assert!(!created, "{raw} must not be treated as corrupt");
        s
    }

    #[test]
    fn view_prefs_load_leniently_like_upstream() {
        for (raw, want) in [
            ("0", 1),
            ("13", 12),
            ("2.9", 2),
            (r#""5""#, 5),
            (r#""x""#, 3),
            ("null", 1),
        ] {
            let s = load_json(&format!(r#"{{"homeLimitAccountCount":{raw}}}"#));
            assert_eq!(s.home_limit_account_count, want, "{raw}");
        }
        assert_eq!(load_json("{}").home_limit_account_count, 3);
        let s = load_json(
            r#"{"homeActiveDaysWindow":"YEAR","heatmapMetric":"Tokens","hiddenViews":5,"homeModuleOrder":{}}"#,
        );
        assert_eq!(s.home_active_days_window, "all", "case-sensitive");
        assert_eq!(s.heatmap_metric, "cost");
        assert_eq!(s.hidden_views, "");
        assert_eq!(s.home_module_order, "limits,tool,device,model,trends");
        let s =
            load_json(r#"{"homeActiveDaysWindow":" year ","viewDisplayOrder":["trends","home"]}"#);
        assert_eq!(s.home_active_days_window, "year");
        assert_eq!(
            s.view_display_order,
            "trends,home,tool,status,device,limits"
        );
    }

    #[test]
    fn view_prefs_patch_keeps_current_values_for_invalid_enums() {
        let s = Settings {
            heatmap_metric: "tokens".into(),
            home_active_days_window: "year".into(),
            ..Settings::default()
        };
        let mut patch = Map::new();
        patch.insert("heatmapMetric".into(), json!("bogus"));
        patch.insert("homeActiveDaysWindow".into(), json!("x"));
        patch.insert("hiddenViews".into(), json!(["status", "trends"]));
        let next = s.patched(&patch).unwrap();
        assert_eq!(next.heatmap_metric, "tokens");
        assert_eq!(next.home_active_days_window, "year");
        assert_eq!(next.hidden_views, "status,trends");
        let mut patch = Map::new();
        patch.insert("heatmapMetric".into(), json!(" cost "));
        patch.insert("homeLimitAccountCount".into(), json!(40));
        let next = s.patched(&patch).unwrap();
        assert_eq!(next.heatmap_metric, "cost");
        assert_eq!(next.home_limit_account_count, 12);
    }

    #[test]
    fn reduce_motion_defaults_to_system_and_normalizes() {
        assert_eq!(Settings::default().reduce_motion, "system");
        for (input, want) in [
            ("system", "system"),
            ("on", "on"),
            ("off", "off"),
            (" on ", "on"),
            ("ON", "system"),
            ("sideways", "system"),
            ("", "system"),
        ] {
            let mut s = Settings {
                reduce_motion: input.into(),
                ..Settings::default()
            };
            let changed = s.validate();
            assert_eq!(s.reduce_motion, want, "{input:?}");
            assert_eq!(
                changed.contains(&"reduceMotion"),
                input != want,
                "{input:?}"
            );
        }
    }

    #[test]
    fn reduce_motion_serializes_camel_case() {
        assert_eq!(
            serde_json::to_value(Settings::default()).unwrap()["reduceMotion"],
            "system"
        );
        assert_eq!(load_json(r#"{"reduceMotion":"off"}"#).reduce_motion, "off");
        assert_eq!(load_json("{}").reduce_motion, "system");
        let s = Settings::default();
        let mut patch = Map::new();
        patch.insert("reduceMotion".into(), json!("on"));
        assert_eq!(s.patched(&patch).unwrap().reduce_motion, "on");
        // 上游修改時不合法的值同樣回到 system（motionPreference.normalize 的 fallback），不保留目前的值。
        let s = Settings {
            reduce_motion: "off".into(),
            ..Settings::default()
        };
        let mut patch = Map::new();
        patch.insert("reduceMotion".into(), json!("bogus"));
        assert_eq!(s.patched(&patch).unwrap().reduce_motion, "system");
    }

    #[test]
    fn masks_secret() {
        assert_eq!(mask_secret("abcdefgh1234"), "••••1234");
        assert_eq!(mask_secret("ab"), "••••ab");
    }
}
