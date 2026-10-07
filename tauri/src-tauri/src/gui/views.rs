//! 明細畫面（工具／模型／專案／session、全公司的單台裝置）、趨勢與範圍的指令：前端打開畫面時才要，資料由 detail.rs、
//! trends.rs、ranges.rs、display.rs 從最新的本機 record 與 hub 快照算出。找不到時回 `None`。

use tauri::State;

use super::state::AppState;
use crate::detail::{self, PeriodDetail, SessionPage};

#[tauri::command]
pub fn usage_detail(state: State<'_, AppState>, period: String) -> Option<PeriodDetail> {
    let record = state.record.read().unwrap().clone()?;
    detail::record_period(&record, &period).map(detail::period_detail)
}

#[tauri::command]
pub fn usage_sessions(
    state: State<'_, AppState>,
    period: String,
    page: usize,
) -> Option<SessionPage> {
    let record = state.record.read().unwrap().clone()?;
    detail::record_period(&record, &period).map(|p| detail::session_page(p, page))
}

#[tauri::command]
pub fn trends_get(state: State<'_, AppState>) -> Option<crate::trends::TrendsView> {
    let record = state.record.read().unwrap().clone()?;
    let history = record.history.as_deref()?;
    crate::trends::trends_view(history, &record.period_windows.today.key, &record.today)
}

/// 本星期／最近 7 日／最近 30 日（由每日歷史推出）。`week_start` 由前端依地區設定決定（0 = 星期日）。
#[tauri::command]
pub fn range_get(
    state: State<'_, AppState>,
    range: String,
    week_start: u32,
) -> Option<crate::ranges::RangeResult> {
    let record = state.record.read().unwrap().clone()?;
    crate::ranges::range_result(
        &record,
        crate::ranges::RangeName::parse(&range)?,
        week_start,
    )
}

/// 全公司分頁點開一台裝置：依工具與模型拆分（hub 快照；本機那台用最新的本機 record）。
#[tauri::command]
pub fn company_device(
    state: State<'_, AppState>,
    device_id: String,
    period: String,
) -> Option<crate::display::DeviceDetail> {
    let hub = state.hub_stats.read().unwrap().clone()?;
    let record = state.record.read().unwrap().clone();
    crate::display::device_detail(
        &hub,
        record.as_deref(),
        &device_id,
        &period,
        chrono::Utc::now().timestamp_millis(),
    )
}

/// 儀表板的趨勢圖：每日依工具與模型的 token。
#[tauri::command]
pub fn history_series_get(state: State<'_, AppState>) -> Option<Vec<crate::trends::SeriesDay>> {
    let record = state.record.read().unwrap().clone()?;
    let history = record.history.as_deref()?;
    crate::trends::history_series(history, &record.period_windows.today.key, &record.today)
}

/// 全公司的本星期／最近 7、30 日：hub 的 `/api/history`（快取 60 秒）加上全公司即時的今日。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CompanyRange {
    Ready(Box<crate::ranges::RangeView>),
    /// 沒有設定 hub 或還沒連上。
    Loading,
    Error {
        message: String,
    },
}

/// hub 的 `/api/history` 快取：成功 60 秒、失敗 30 秒（失敗時也不要每次本機更新就再打一次 hub）。
type HubHistoryResult = Result<std::sync::Arc<serde_json::Value>, String>;
static HUB_HISTORY: std::sync::Mutex<Option<(String, i64, HubHistoryResult)>> =
    std::sync::Mutex::new(None);
/// 同一時間只送一個請求：同時打開的畫面等同一份結果。
static HUB_HISTORY_FETCH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const HUB_HISTORY_TTL_MS: i64 = 60_000;
const HUB_HISTORY_ERROR_TTL_MS: i64 = 30_000;

fn cached_hub_history(url: &str, now: i64) -> Option<HubHistoryResult> {
    HUB_HISTORY
        .lock()
        .unwrap()
        .as_ref()
        .filter(|(u, at, r)| {
            let ttl = if r.is_ok() {
                HUB_HISTORY_TTL_MS
            } else {
                HUB_HISTORY_ERROR_TTL_MS
            };
            u == url && now - at < ttl
        })
        .map(|(_, _, r)| r.clone())
}

#[tauri::command]
pub async fn company_range_get(
    state: State<'_, AppState>,
    range: String,
    week_start: u32,
) -> Result<CompanyRange, crate::error::AppError> {
    let Some(name) = crate::ranges::RangeName::parse(&range) else {
        return Err(crate::error::AppError::InvalidArgument(range));
    };
    let settings = state.settings();
    let hub = crate::settings::resolve_hub(&settings, None, None);
    let (Some(url), Some(hub_stats)) = (hub.url.clone(), state.hub_stats.read().unwrap().clone())
    else {
        return Ok(CompanyRange::Loading);
    };
    let fetched = {
        let _guard = HUB_HISTORY_FETCH.lock().await;
        let started = chrono::Utc::now().timestamp_millis();
        match cached_hub_history(&url, started) {
            Some(r) => r,
            None => {
                let client = crate::hub::HubClient::new(&url, hub.secret.clone())
                    .map_err(|e| crate::error::AppError::InvalidArgument(e.message()))?;
                let r = client
                    .get_history()
                    .await
                    .map(std::sync::Arc::new)
                    .map_err(|e| e.message());
                *HUB_HISTORY.lock().unwrap() = Some((url, started, r.clone()));
                r
            }
        }
    };
    let history = match fetched {
        Ok(h) => h,
        Err(message) => return Ok(CompanyRange::Error { message }),
    };
    // 今天的鍵與全公司的即時今日取自同一個時間點：快取的 CompanyStats 只在 hub 有新快照或本機有新
    // record 時重算，剛過午夜時它的 today 可能還是昨天的，會和 history 裡的昨天重複計算。
    let now = chrono::Local::now();
    let record = state.record.read().unwrap().clone();
    let company =
        crate::display::compose_company(&hub_stats, record.as_deref(), now.timestamp_millis());
    let today_key = crate::collector::local_today_key(now);
    Ok(
        match crate::ranges::company_range(
            &history,
            &today_key,
            &company.periods.today,
            name,
            week_start,
        ) {
            Some(v) => CompanyRange::Ready(Box::new(v)),
            None => CompanyRange::Error {
                message: "hub history has no daily rows".into(),
            },
        },
    )
}

/// session 的逐回合明細：讀那個 session 自己的紀錄（Claude / Codex 的 jsonl、OpenCode 的資料庫，只讀）。
/// 讀檔在 blocking 執行緒；只接受支援的工具，session id 由 session_detail 檢查不能跳出紀錄資料夾。
#[tauri::command]
pub async fn session_detail_get(
    client: String,
    session_id: String,
    period: String,
    session_cost: f64,
) -> Result<crate::session_detail::SessionDetail, crate::error::AppError> {
    if !crate::session_detail::DETAIL_CLIENTS.contains(&client.as_str()) {
        return Err(crate::error::AppError::InvalidArgument(client));
    }
    // 前端的「全部」對應上游的 total（不過濾）。
    let period = if period == "allTime" {
        "total".to_string()
    } else {
        period
    };
    let home = dirs::home_dir().unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        crate::session_detail::read_session_detail(
            &client,
            &session_id,
            &period,
            session_cost,
            &home,
            chrono::Local::now(),
        )
    })
    .await
    .map_err(|e| crate::error::AppError::Internal(e.to_string()))
}
