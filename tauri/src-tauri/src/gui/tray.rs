//! 系統匣：左鍵切換 widget，右鍵選單；tooltip 顯示今日用量與最接近上限的額度。
//!
//! 圖示有兩種（設定 `trayContent`）：`icon` 是 app 圖示；`bars` 把最接近上限的工具畫成兩條額度長條
//! （tray_bars.rs，上游的 bars 模式）。長條的墨色跟著 Windows 工作列的淺色／深色，每分鐘檢查一次。
//! 圖示只在內容真的變了才換，避免每幾秒一次的用量更新都重畫。

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

use super::i18n::tr;
use super::state::AppState;
use super::tray_bars::{pick_sessions, pick_worst, render_bars, BarsSelection};
use super::{updater, window};
use crate::settings::WindowMode;
use crate::update::UpdateState;
use crate::wire::WindowKind;

pub const TRAY_ID: &str = "main";
/// 前端事件：從 tray 開啟某個分頁（payload = 分頁 id）。
pub const EVT_OPEN_TAB: &str = "open-tab";

/// 「檢查更新」項目：下載好新版後改成「重新啟動以更新（vX）」。
static UPDATE_ITEM: OnceLock<MenuItem<Wry>> = OnceLock::new();

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
    refresh(app);
}

/// 設定改變後同步勾選狀態（設定頁與 tray 兩邊都能改）。
pub fn sync_checks(settings: &crate::settings::Settings) {
    for (item, mode) in MODE_ITEMS.get().into_iter().flatten() {
        let _ = item.set_checked(*mode == settings.window_mode);
    }
    for (item, id) in CONTENT_ITEMS.get().into_iter().flatten() {
        let _ = item.set_checked(*id == settings.tray_content);
    }
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

fn apply_patch(app: &AppHandle, key: &str, value: &str) {
    let app = app.clone();
    let mut patch = serde_json::Map::new();
    patch.insert(key.into(), serde_json::Value::String(value.into()));
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
            &settings_item,
            &logs,
            &update,
            &sep2,
            &quit,
        ],
    )?;

    for (i, source) in [
        (toggle, "顯示／隱藏"),
        (rescan, "立即重新掃描"),
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
    let _ = UPDATE_ITEM.set(update);
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
            match id {
                "toggle" => window::toggle_main(app),
                "rescan" => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(rt) = app.state::<AppState>().runtime.lock().await.as_ref() {
                            rt.request_rescan();
                        }
                    });
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
