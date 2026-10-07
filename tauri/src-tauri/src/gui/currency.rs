//! 幣別換算的 GUI 端（邏輯在 crate::currency）：啟動時讀快取、之後在背景每 6 小時更新匯率，設定的
//! 幣別或手動匯率改變時重算；前端事件 `currency-updated`（`CurrencyView`）。webview 不連網，匯率一律
//! 在 Rust 抓。

use std::sync::{OnceLock, RwLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use super::state::AppState;
use crate::currency::{self, CurrencyView, RateCache};

pub const EVT_CURRENCY: &str = "currency-updated";
const REFRESH_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// 啟動後等一下再抓：不跟第一次掃描、hub 連線搶在同一刻。
const FIRST_FETCH_DELAY: Duration = Duration::from_secs(20);

static CACHE: OnceLock<RwLock<Option<RateCache>>> = OnceLock::new();
static WAKE: OnceLock<Notify> = OnceLock::new();

fn cache() -> &'static RwLock<Option<RateCache>> {
    CACHE.get_or_init(|| RwLock::new(currency::load_cache(&crate::store::config_dir())))
}

fn wake() -> &'static Notify {
    WAKE.get_or_init(Notify::new)
}

pub fn current_view(app: &AppHandle) -> CurrencyView {
    let settings = app.state::<AppState>().settings();
    currency::view(
        &settings.currency,
        &settings.currency_rates,
        cache().read().unwrap().as_ref(),
    )
}

fn emit(app: &AppHandle) {
    let _ = app.emit(EVT_CURRENCY, current_view(app));
    // tray 的今日成本也跟著換算。
    super::tray::refresh(app);
}

/// 背景更新：快取過期才抓（USD 不需要匯率，選別的幣別時才抓）。
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let http = reqwest::Client::builder()
            .user_agent(format!(
                "token-monitor-tauri/{}",
                crate::baked::AGENT_VERSION
            ))
            .connect_timeout(Duration::from_secs(8))
            .build()
            .unwrap_or_default();
        tokio::select! {
            _ = tokio::time::sleep(FIRST_FETCH_DELAY) => {}
            _ = wake().notified() => {}
        }
        loop {
            let wanted = app.state::<AppState>().settings().currency != "USD";
            let stale = currency::is_stale(cache().read().unwrap().as_ref(), chrono::Utc::now());
            if wanted && stale {
                match currency::fetch(&http).await {
                    Ok(fresh) => {
                        currency::save_cache(&crate::store::config_dir(), &fresh);
                        *cache().write().unwrap() = Some(fresh);
                        emit(&app);
                    }
                    // 公司網路常擋外連：安靜地用快取或內建匯率。
                    Err(e) => tracing::info!(error = %e, "exchange rates unavailable"),
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(REFRESH_EVERY) => {}
                _ = wake().notified() => {}
            }
        }
    });
}

/// 設定的幣別或手動匯率改了：立刻重算畫面，需要的話馬上去抓匯率。
pub fn on_settings_changed(app: &AppHandle) {
    emit(app);
    wake().notify_one();
}

/// 成本（USD）換成設定的幣別後的文字（tray 等 Rust 端的顯示用；格式與前端 fmtUsd 相同）。
pub fn format_cost(app: &AppHandle, usd: f64) -> String {
    let v = current_view(app);
    currency::format_amount(&v.symbol, v.rate, usd)
}

#[tauri::command]
pub fn currency_get(app: AppHandle) -> CurrencyView {
    current_view(&app)
}
