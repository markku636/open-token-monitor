//! 系統匣：左鍵切換 widget，右鍵選單；tooltip 顯示今日用量與最接近上限的額度。
//!
//! 圖示有兩種（設定 `trayContent`）：`icon` 是 app 圖示；`bars` 把最接近上限的工具畫成兩條額度長條
//! （tray_bars.rs，上游的 bars 模式）。長條的墨色跟著 Windows 工作列的淺色／深色，每分鐘檢查一次。
//! 圖示只在內容真的變了才換，避免每幾秒一次的用量更新都重畫。
//!
//! `showTrayIcon` 關閉時不建 tray；建過之後關掉只是隱藏（`set_visible`），選單與下面這些
//! `OnceLock` 只建一次。
//!
//! 從選單重新掃描時（上游 main.js `refreshFromTray`）：項目變成「正在重新掃描…」並停用，
//! 那次 manual tick 結束才恢復；失敗時跳出系統通知（notify.rs，上游 `showTrayRefreshError`）。

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::Value;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

use super::i18n::tr;
use super::state::AppState;
use super::tray_bars::{pick_sessions, pick_worst, render_bars, BarsSelection};
use super::{updater, window};
use crate::device::runtime::TickReason;
use crate::settings::{Settings, WindowMode};
use crate::update::UpdateState;
use crate::wire::WindowKind;

pub const TRAY_ID: &str = "main";
/// 前端事件：從 tray 開啟某個分頁（payload = 分頁 id）。
pub const EVT_OPEN_TAB: &str = "open-tab";

/// 「檢查更新」項目：下載好新版後改成「重新啟動以更新（vX）」。
static UPDATE_ITEM: OnceLock<MenuItem<Wry>> = OnceLock::new();
/// 「立即重新掃描」：tray 發起的掃描進行中時改字並停用（`RESCAN`）。
static RESCAN_ITEM: OnceLock<MenuItem<Wry>> = OnceLock::new();

/// 邊緣額度條子選單（上游 tray.js 的 Edge Dock 快速控制）：顯示勾選、顯示方式、左右。
/// 額度條關著時也能先選好方式與邊，打開時就照使用者要的樣子出現（上游同樣）。
struct DockItems {
    show: CheckMenuItem<Wry>,
    modes: Vec<(CheckMenuItem<Wry>, &'static str)>,
    sides: Vec<(CheckMenuItem<Wry>, &'static str)>,
}
static DOCK_ITEMS: OnceLock<DockItems> = OnceLock::new();
const DOCK_MODES: &[(&str, &str)] = &[("autoHide", "自動隱藏"), ("always", "永遠顯示")];
const DOCK_SIDES: &[(&str, &str)] = &[("left", "左側"), ("right", "右側")];

/// 有文字的選單項目與它們的繁中原文（換語言時重設文字）。
enum Labeled {
    Item(MenuItem<Wry>),
    Check(CheckMenuItem<Wry>),
    Sub(Submenu<Wry>),
}

static TEXTS: OnceLock<Vec<(Labeled, &'static str)>> = OnceLock::new();
static MODE_ITEMS: OnceLock<Vec<(CheckMenuItem<Wry>, WindowMode)>> = OnceLock::new();
static CONTENT_ITEMS: OnceLock<Vec<(CheckMenuItem<Wry>, &'static str)>> = OnceLock::new();

const TABS: &[(&str, &str)] = &[
    ("local", "本機"),
    ("company", "全公司"),
    ("limits", "額度"),
    ("trends", "趨勢"),
];
const MODES: &[(WindowMode, &str, &str)] = &[
    (WindowMode::Floating, "floating", "浮動"),
    (WindowMode::Normal, "normal", "標準"),
    (WindowMode::Desktop, "desktop", "桌面"),
    (WindowMode::Tray, "tray", "系統匣"),
];
const CONTENTS: &[(&str, &str)] = &[
    ("icon", "圖示"),
    ("bars", "額度長條"),
    ("barsSessions", "各工具 5 小時"),
];

fn update_item_text(state: &UpdateState) -> (String, bool) {
    match state {
        UpdateState::Disabled { .. } => (tr("自動更新未啟用", &[]), false),
        UpdateState::Checking => (tr("正在檢查更新…", &[]), false),
        UpdateState::Downloading { version, .. } => {
            (tr("正在下載 v{v}…", &[("v", version)]), false)
        }
        UpdateState::Available { version, .. } => (tr("下載更新（v{v}）", &[("v", version)]), true),
        UpdateState::Ready { version, .. } => {
            (tr("重新啟動以更新（v{v}）", &[("v", version)]), true)
        }
        UpdateState::Installing { version } => (tr("正在安裝 v{v}…", &[("v", version)]), false),
        _ => (tr("檢查更新", &[]), true),
    }
}

pub fn set_update_item(state: &UpdateState) {
    if let Some(item) = UPDATE_ITEM.get() {
        let (text, enabled) = update_item_text(state);
        let _ = item.set_text(text);
        let _ = item.set_enabled(enabled);
    }
}

/// 前端換了語言：重設所有選單文字與 tooltip。
pub fn retitle(app: &AppHandle) {
    for (item, source) in TEXTS.get().into_iter().flatten() {
        let text = tr(source, &[]);
        let _ = match item {
            Labeled::Item(i) => i.set_text(text),
            Labeled::Check(i) => i.set_text(text),
            Labeled::Sub(i) => i.set_text(text),
        };
    }
    set_update_item(&updater::current_state(app));
    set_rescan_item();
    refresh(app);
}

/// 設定改變後同步勾選狀態（設定頁與 tray 兩邊都能改）。
pub fn sync_checks(settings: &Settings) {
    for (item, mode) in MODE_ITEMS.get().into_iter().flatten() {
        let _ = item.set_checked(*mode == settings.window_mode);
    }
    for (item, id) in CONTENT_ITEMS.get().into_iter().flatten() {
        let _ = item.set_checked(*id == settings.tray_content);
    }
    if let Some(dock) = DOCK_ITEMS.get() {
        let _ = dock.show.set_checked(settings.edge_dock_enabled);
        for (item, id) in &dock.modes {
            let _ = item.set_checked(*id == settings.edge_dock_mode);
        }
        for (item, id) in &dock.sides {
            let _ = item.set_checked(*id == settings.edge_dock_side);
        }
    }
}

/// 設定 `showTrayIcon` 改變：第一次打開才建 tray，之後只切換顯示（上游 ensureTray / destroyTray）。
pub fn sync_visibility(app: &AppHandle, settings: &Settings) {
    match app.tray_by_id(TRAY_ID) {
        Some(tray) => {
            if let Err(e) = tray.set_visible(settings.show_tray_icon) {
                tracing::warn!(error = %e, "failed to change tray icon visibility");
            }
        }
        None if settings.show_tray_icon => {
            if let Err(e) = build(app) {
                tracing::warn!(error = %e, "failed to create the tray icon");
            }
        }
        None => {}
    }
}

/// tray 發起的重新掃描走到哪（上游 `trayRefreshInFlight`）。只看 manual tick：請求後的第一個
/// manual tick 開始才算數，那次結束（成功或失敗）才回到閒置——請求當下正在跑的那次不算。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum RescanState {
    #[default]
    Idle,
    Requested,
    Running,
}

impl RescanState {
    fn manual(reason: &str) -> bool {
        reason == TickReason::Manual.as_str()
    }

    /// 選單按下：已經在跑就不再送（上游 `if (trayRefreshInFlight) return`）。
    fn request(&mut self) -> bool {
        if *self != RescanState::Idle {
            return false;
        }
        *self = RescanState::Requested;
        true
    }

    fn started(&mut self, reason: &str) {
        if *self == RescanState::Requested && Self::manual(reason) {
            *self = RescanState::Running;
        }
    }

    /// 那次 manual tick 結束時回傳 true（呼叫端依結果通知）。
    fn finished(&mut self, reason: &str) -> bool {
        if *self == RescanState::Running && Self::manual(reason) {
            *self = RescanState::Idle;
            return true;
        }
        false
    }
}

static RESCAN: Mutex<RescanState> = Mutex::new(RescanState::Idle);

fn set_rescan_item() {
    if let Some(item) = RESCAN_ITEM.get() {
        let busy = *RESCAN.lock().unwrap() != RescanState::Idle;
        let _ = item.set_text(tr(
            if busy {
                "正在重新掃描…"
            } else {
                "立即重新掃描"
            },
            &[],
        ));
        let _ = item.set_enabled(!busy);
    }
}

fn rescan_failed(app: &AppHandle, error: &str) {
    tracing::warn!(error, "tray rescan failed");
    // 找 tray 的視窗要到主執行緒走一趟；另開工作，回報 tick 結束的收集迴圈不必等它。
    let (app, title, body) = (app.clone(), tr("重新掃描失敗", &[]), error.to_string());
    tauri::async_runtime::spawn_blocking(move || super::notify::error(&app, &title, &body));
}

fn rescan_from_tray(app: &AppHandle) {
    if !RESCAN.lock().unwrap().request() {
        return;
    }
    set_rescan_item();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let requested = match state.runtime.lock().await.as_ref() {
            Some(rt) => {
                rt.request_rescan();
                true
            }
            None => false,
        };
        if !requested {
            // 收集程序沒有在跑（例如找不到 tokscale）：上游的 fetchStats 會直接失敗。
            *RESCAN.lock().unwrap() = RescanState::Idle;
            set_rescan_item();
            let error = state
                .status
                .read()
                .unwrap()
                .fatal
                .clone()
                .unwrap_or_else(|| tr("收集程序沒有在執行", &[]));
            rescan_failed(&app, &error);
        }
    });
}

/// bridge.rs：runtime 開始一次 tick。
pub fn on_tick_started(reason: &str) {
    RESCAN.lock().unwrap().started(reason);
}

/// bridge.rs：runtime 的 tick 結束；`error` = 失敗原因。tray 發起的那次失敗時通知使用者。
pub fn on_tick_finished(app: &AppHandle, reason: &str, error: Option<&str>) {
    if !RESCAN.lock().unwrap().finished(reason) {
        return;
    }
    set_rescan_item();
    if let Some(error) = error {
        rescan_failed(app, error);
    }
}

/// runtime 重建（設定改變）時放掉進行中的請求：舊 runtime 的那次 tick 可能不會回報結束。
pub fn reset_rescan() {
    *RESCAN.lock().unwrap() = RescanState::Idle;
    set_rescan_item();
}

fn fmt_tokens(n: i64) -> String {
    let f = n as f64;
    if f >= 1e9 {
        format!("{:.2}B", f / 1e9)
    } else if f >= 1e6 {
        format!("{:.2}M", f / 1e6)
    } else if f >= 1e3 {
        format!("{:.1}K", f / 1e3)
    } else {
        n.to_string()
    }
}

fn kind_label(kind: WindowKind) -> String {
    tr(
        match kind {
            WindowKind::Session => "5 小時",
            WindowKind::Daily => "每日",
            WindowKind::Weekly => "每週",
            WindowKind::Billing => "帳單",
        },
        &[],
    )
}

fn provider_label(id: &str) -> &str {
    match id {
        "claude" => "Claude",
        "codex" => "Codex",
        other => other,
    }
}

/// tooltip 的額度那一行：「Claude 已用：5 小時 34% · 每週 76%」。
fn limits_line(sel: &BarsSelection) -> String {
    let mut parts = vec![format!(
        "{} {:.0}%",
        kind_label(sel.primary_kind),
        sel.primary_used
    )];
    if let (Some(kind), Some(used)) = (sel.secondary_kind, sel.secondary_used) {
        parts.push(format!("{} {used:.0}%", kind_label(kind)));
    }
    tr(
        "{name} 已用：{parts}",
        &[
            ("name", provider_label(&sel.provider)),
            ("parts", &parts.join(" · ")),
        ],
    )
}

#[cfg(windows)]
fn taskbar_is_dark() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    winreg::RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .and_then(|k| k.get_value::<u32, _>("SystemUsesLightTheme"))
        .map(|light| light == 0)
        // 沒有這個值的 Windows 10 早期版本工作列是深色。
        .unwrap_or(true)
}

#[cfg(not(windows))]
fn taskbar_is_dark() -> bool {
    false
}

/// 畫上去的內容：長條的兩個百分比（四捨五入；`None` = app 圖示）與墨色。
type IconKey = (Option<(i64, Option<i64>)>, bool);

/// 上一次畫上去的圖示，沒變就不重畫。
static LAST_ICON: Mutex<Option<IconKey>> = Mutex::new(None);

/// 依目前的用量、額度與設定更新 tooltip 與圖示。
pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let state = app.state::<AppState>();
    let (selection, sessions) = state
        .limits
        .read()
        .unwrap()
        .as_ref()
        .map(|v| (pick_worst(&v.summary), pick_sessions(&v.summary)))
        .unwrap_or((None, None));
    let mut tooltip = String::from("Token Monitor");
    if let Some(local) = state.local.read().unwrap().as_ref() {
        tooltip.push('\n');
        tooltip.push_str(&tr(
            "今日 {n} tokens · {c}",
            &[
                ("n", &fmt_tokens(local.periods.today.total_tokens)),
                // 設定的幣別（上游的 tray 文字也換算）。
                (
                    "c",
                    &super::currency::format_cost(app, local.periods.today.cost_usd),
                ),
            ],
        ));
    }
    if let Some(sel) = &selection {
        tooltip.push('\n');
        tooltip.push_str(&limits_line(sel));
    }
    let _ = tray.set_tooltip(Some(tooltip));

    let content = state.settings().tray_content;
    let drawn = match content.as_str() {
        "bars" => selection,
        "barsSessions" => sessions,
        _ => None,
    };
    let dark = drawn.is_some() && taskbar_is_dark();
    let key = (
        drawn.as_ref().map(|s| {
            (
                s.primary_used.round() as i64,
                s.secondary_used.map(|v| v.round() as i64),
            )
        }),
        dark,
    );
    let mut last = LAST_ICON.lock().unwrap();
    if last.as_ref() == Some(&key) {
        return;
    }
    *last = Some(key);
    let icon = match drawn {
        Some(sel) => Some(Image::new_owned(render_bars(&sel, 32, dark), 32, 32)),
        None => app.default_window_icon().cloned(),
    };
    if let Err(e) = tray.set_icon(icon) {
        tracing::warn!(error = %e, "failed to update tray icon");
    }
}

fn apply_patch(app: &AppHandle, key: &str, value: impl Into<Value>) {
    let app = app.clone();
    let mut patch = serde_json::Map::new();
    patch.insert(key.into(), value.into());
    tauri::async_runtime::spawn(async move {
        if let Err(e) = super::commands::apply_settings_patch(&app, patch).await {
            tracing::warn!(error = %e, "tray settings change failed");
        }
    });
}

fn on_update_clicked(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match updater::current_state(&app) {
            UpdateState::Ready { .. } => {
                let _ = updater::install(&app).await;
            }
            UpdateState::Available { .. } => {
                updater::download(&app).await;
            }
            _ => {
                updater::check_now(&app).await;
            }
        }
    });
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let settings = app.state::<AppState>().settings();
    let mut texts: Vec<(Labeled, &'static str)> = Vec::new();
    let item = |id: &str, source: &'static str| {
        MenuItem::with_id(app, id, tr(source, &[]), true, None::<&str>)
    };

    let toggle = item("toggle", "顯示／隱藏")?;
    let rescan = item("rescan", "立即重新掃描")?;
    let settings_item = item("settings", "設定…")?;
    let dashboard = item("dashboard", "用量儀表板…")?;
    let logs = item("logs", "開啟日誌資料夾")?;
    let quit = item("quit", "結束 Token Monitor")?;

    let tab_items = TABS
        .iter()
        .map(|(id, source)| {
            MenuItem::with_id(
                app,
                format!("tab:{id}"),
                tr(source, &[]),
                true,
                None::<&str>,
            )
            .map(|i| (i, *source))
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let open = Submenu::with_items(
        app,
        tr("開啟", &[]),
        true,
        &tab_items
            .iter()
            .map(|(i, _)| i as &dyn tauri::menu::IsMenuItem<Wry>)
            .collect::<Vec<_>>(),
    )?;

    let mode_items = MODES
        .iter()
        .map(|(mode, id, source)| {
            CheckMenuItem::with_id(
                app,
                format!("mode:{id}"),
                tr(source, &[]),
                true,
                *mode == settings.window_mode,
                None::<&str>,
            )
            .map(|i| (i, *mode, *source))
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let mode_menu = Submenu::with_items(
        app,
        tr("視窗模式", &[]),
        true,
        &mode_items
            .iter()
            .map(|(i, _, _)| i as &dyn tauri::menu::IsMenuItem<Wry>)
            .collect::<Vec<_>>(),
    )?;

    let content_items = CONTENTS
        .iter()
        .map(|(id, source)| {
            CheckMenuItem::with_id(
                app,
                format!("tray:{id}"),
                tr(source, &[]),
                true,
                *id == settings.tray_content,
                None::<&str>,
            )
            .map(|i| (i, *id, *source))
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let content_menu = Submenu::with_items(
        app,
        tr("系統匣顯示", &[]),
        true,
        &content_items
            .iter()
            .map(|(i, _, _)| i as &dyn tauri::menu::IsMenuItem<Wry>)
            .collect::<Vec<_>>(),
    )?;

    let check = |id: String, source: &'static str, checked: bool| {
        CheckMenuItem::with_id(app, id, tr(source, &[]), true, checked, None::<&str>)
    };
    let dock_show = check(
        "dock:show".into(),
        "顯示邊緣額度條",
        settings.edge_dock_enabled,
    )?;
    let dock_modes = DOCK_MODES
        .iter()
        .map(|(id, source)| {
            check(
                format!("dockMode:{id}"),
                source,
                *id == settings.edge_dock_mode,
            )
            .map(|i| (i, *id, *source))
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let dock_sides = DOCK_SIDES
        .iter()
        .map(|(id, source)| {
            check(
                format!("dockSide:{id}"),
                source,
                *id == settings.edge_dock_side,
            )
            .map(|i| (i, *id, *source))
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let dock_sep = PredefinedMenuItem::separator(app)?;
    let dock_sep2 = PredefinedMenuItem::separator(app)?;
    let mut dock_entries: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = vec![&dock_show, &dock_sep];
    dock_entries.extend(
        dock_modes
            .iter()
            .map(|(i, _, _)| i as &dyn tauri::menu::IsMenuItem<Wry>),
    );
    dock_entries.push(&dock_sep2);
    dock_entries.extend(
        dock_sides
            .iter()
            .map(|(i, _, _)| i as &dyn tauri::menu::IsMenuItem<Wry>),
    );
    let dock_menu = Submenu::with_items(app, tr("邊緣額度條", &[]), true, &dock_entries)?;

    let (update_text, update_enabled) = update_item_text(&updater::current_state(app));
    let update = MenuItem::with_id(app, "update", update_text, update_enabled, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &toggle,
            &open,
            &dashboard,
            &rescan,
            &sep,
            &mode_menu,
            &content_menu,
            &dock_menu,
            &settings_item,
            &logs,
            &update,
            &sep2,
            &quit,
        ],
    )?;

    for (i, source) in [
        (toggle, "顯示／隱藏"),
        (settings_item, "設定…"),
        (dashboard, "用量儀表板…"),
        (logs, "開啟日誌資料夾"),
        (quit, "結束 Token Monitor"),
    ] {
        texts.push((Labeled::Item(i), source));
    }
    for (i, source) in tab_items {
        texts.push((Labeled::Item(i), source));
    }
    texts.push((Labeled::Sub(open), "開啟"));
    texts.push((Labeled::Sub(mode_menu), "視窗模式"));
    texts.push((Labeled::Sub(content_menu), "系統匣顯示"));
    let _ = MODE_ITEMS.set(
        mode_items
            .iter()
            .map(|(i, mode, _)| (i.clone(), *mode))
            .collect(),
    );
    let _ = CONTENT_ITEMS.set(
        content_items
            .iter()
            .map(|(i, id, _)| (i.clone(), *id))
            .collect(),
    );
    for (i, _, source) in mode_items {
        texts.push((Labeled::Check(i), source));
    }
    for (i, _, source) in content_items {
        texts.push((Labeled::Check(i), source));
    }
    texts.push((Labeled::Sub(dock_menu), "邊緣額度條"));
    texts.push((Labeled::Check(dock_show.clone()), "顯示邊緣額度條"));
    for (i, _, source) in dock_modes.iter().chain(dock_sides.iter()) {
        texts.push((Labeled::Check(i.clone()), source));
    }
    let _ = DOCK_ITEMS.set(DockItems {
        show: dock_show,
        modes: dock_modes.into_iter().map(|(i, id, _)| (i, id)).collect(),
        sides: dock_sides.into_iter().map(|(i, id, _)| (i, id)).collect(),
    });
    let _ = UPDATE_ITEM.set(update);
    let _ = RESCAN_ITEM.set(rescan);
    set_rescan_item();
    let _ = TEXTS.set(texts);

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Token Monitor")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            if let Some(tab) = id.strip_prefix("tab:") {
                window::show_main(app);
                let _ = app.emit(EVT_OPEN_TAB, tab);
                return;
            }
            if let Some(mode) = id.strip_prefix("mode:") {
                apply_patch(app, "windowMode", mode);
                return;
            }
            if let Some(content) = id.strip_prefix("tray:") {
                apply_patch(app, "trayContent", content);
                return;
            }
            if let Some(mode) = id.strip_prefix("dockMode:") {
                apply_patch(app, "edgeDockMode", mode);
                return;
            }
            if let Some(side) = id.strip_prefix("dockSide:") {
                apply_patch(app, "edgeDockSide", side);
                return;
            }
            match id {
                "toggle" => window::toggle_main(app),
                "rescan" => rescan_from_tray(app),
                "dock:show" => {
                    let enabled = app.state::<AppState>().settings().edge_dock_enabled;
                    apply_patch(app, "edgeDockEnabled", !enabled);
                }
                "settings" => {
                    let _ = window::open_settings(app);
                }
                "dashboard" => {
                    let _ = window::open_dashboard(app);
                }
                "logs" => super::commands::open_log_dir(app),
                "update" => on_update_clicked(app),
                "quit" => super::quit(app),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                let app = tray.app_handle();
                let scale = window::main_window(app)
                    .and_then(|w| w.scale_factor().ok())
                    .unwrap_or(1.0);
                window::set_tray_anchor(
                    rect.position.to_physical(scale),
                    rect.size.to_physical(scale),
                );
                window::toggle_main(app);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;

    // 使用者切換 Windows 的淺色／深色時，長條的墨色要跟著換。
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            refresh(&handle);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::RescanState;

    #[test]
    fn a_tray_rescan_waits_for_its_own_manual_tick() {
        let mut s = RescanState::default();
        assert!(s.request());
        assert!(!s.request(), "already in flight");
        // 請求當下正在跑的 tick（或 watch tick）結束不算。
        assert!(!s.finished("manual"));
        s.started("watch");
        assert!(!s.finished("watch"));
        s.started("manual");
        assert_eq!(s, RescanState::Running);
        assert!(!s.finished("interval"));
        assert!(s.finished("manual"));
        assert_eq!(s, RescanState::Idle);
        assert!(!s.finished("manual"), "reported once");
    }

    #[test]
    fn manual_ticks_do_nothing_without_a_tray_request() {
        let mut s = RescanState::default();
        s.started("manual");
        assert!(!s.finished("manual"));
        assert_eq!(s, RescanState::Idle);
    }
}
