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

/// 全公司的本星期／最近 7、30 日。hub 有 `/api/custom/device-daily` 時逐台推（上游
/// `fixedPeriodSnapshotFromDevices`，總數是各台相加，附逐台清單）；舊的 hub 退回 `/api/history` 的
/// 合併版加上全公司即時的今日（沒有逐台清單）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CompanyRange {
    Ready(Box<crate::ranges::CompanyRangeView>),
    /// 沒有設定 hub 或還沒連上。
    Loading,
    Error {
        message: String,
    },
}

type Cache<R> = std::sync::Mutex<Option<(String, i64, R)>>;

/// 同一個 hub 網址、還沒過期的快取結果（過期時間依結果而定）。
fn cached<R: Clone>(slot: &Cache<R>, url: &str, now: i64, ttl: fn(&R) -> i64) -> Option<R> {
    slot.lock()
        .unwrap()
        .as_ref()
        .filter(|(u, at, r)| u == url && now - at < ttl(r))
        .map(|(_, _, r)| r.clone())
}

/// hub 的 `/api/history` 快取：成功 60 秒、失敗 30 秒（失敗時也不要每次本機更新就再打一次 hub）。
type HubHistoryResult = Result<std::sync::Arc<serde_json::Value>, String>;
static HUB_HISTORY: Cache<HubHistoryResult> = std::sync::Mutex::new(None);
/// 同一時間只送一個請求：同時打開的畫面等同一份結果。
static HUB_HISTORY_FETCH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const HUB_HISTORY_TTL_MS: i64 = 60_000;
const HUB_HISTORY_ERROR_TTL_MS: i64 = 30_000;

fn hub_history_ttl(r: &HubHistoryResult) -> i64 {
    if r.is_ok() {
        HUB_HISTORY_TTL_MS
    } else {
        HUB_HISTORY_ERROR_TTL_MS
    }
}

/// hub 的 `/api/custom/device-daily`：`Supported` = 有可用每日歷史的裝置（ranges.rs `DeviceHistory`）；
/// `Unsupported` = 舊的公司 hub 或上游 hub（403 / 404）。
#[derive(Debug, Clone)]
enum DeviceDailyFetch {
    Supported(std::sync::Arc<std::collections::HashMap<String, crate::ranges::DeviceHistory>>),
    Unsupported,
}
type DeviceDailyResult = Result<DeviceDailyFetch, String>;
static HUB_DEVICE_DAILY: Cache<DeviceDailyResult> = std::sync::Mutex::new(None);
static HUB_DEVICE_DAILY_FETCH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// 不支援的 hub 過 10 分鐘再問一次：hub 升級後不必重開 widget，平常也不會每分鐘多一個 404。
const HUB_DEVICE_DAILY_UNSUPPORTED_TTL_MS: i64 = 600_000;

/// 成功 60 秒（hub 本身每個串流時間窗才重算一次；上游在清單對不上時的 3 × 4 秒重試因此沒有意義，
/// 不移植）、失敗 30 秒、不支援 10 分鐘。
fn device_daily_ttl(r: &DeviceDailyResult) -> i64 {
    match r {
        Ok(DeviceDailyFetch::Supported(_)) => HUB_HISTORY_TTL_MS,
        Ok(DeviceDailyFetch::Unsupported) => HUB_DEVICE_DAILY_UNSUPPORTED_TTL_MS,
        Err(_) => HUB_HISTORY_ERROR_TTL_MS,
    }
}

fn hub_client(
    url: &str,
    secret: Option<String>,
) -> Result<crate::hub::HubClient, crate::error::AppError> {
    crate::hub::HubClient::new(url, secret)
        .map_err(|e| crate::error::AppError::InvalidArgument(e.message()))
}

async fn hub_history(
    url: &str,
    secret: Option<String>,
) -> Result<HubHistoryResult, crate::error::AppError> {
    let _guard = HUB_HISTORY_FETCH.lock().await;
    let started = chrono::Utc::now().timestamp_millis();
    if let Some(r) = cached(&HUB_HISTORY, url, started, hub_history_ttl) {
        return Ok(r);
    }
    let r = hub_client(url, secret)?
        .get_history()
        .await
        .map(std::sync::Arc::new)
        .map_err(|e| e.message());
    *HUB_HISTORY.lock().unwrap() = Some((url.to_string(), started, r.clone()));
    Ok(r)
}

async fn hub_device_daily(
    url: &str,
    secret: Option<String>,
) -> Result<DeviceDailyResult, crate::error::AppError> {
    let _guard = HUB_DEVICE_DAILY_FETCH.lock().await;
    let started = chrono::Utc::now().timestamp_millis();
    if let Some(r) = cached(&HUB_DEVICE_DAILY, url, started, device_daily_ttl) {
        return Ok(r);
    }
    let r = match hub_client(url, secret)?.get_device_daily().await {
        Ok(Some(payload)) => Ok(DeviceDailyFetch::Supported(std::sync::Arc::new(
            payload.histories(),
        ))),
        Ok(None) => Ok(DeviceDailyFetch::Unsupported),
        Err(e) => Err(e.message()),
    };
    *HUB_DEVICE_DAILY.lock().unwrap() = Some((url.to_string(), started, r.clone()));
    Ok(r)
}

/// 逐台推出全公司的範圍。`only` 給定時只推那一台（點開裝置的明細）。今天的鍵、各台的日期與
/// 全公司視圖取自同一個時間點。
fn derive_company_ranges(
    hub_stats: &crate::hub::stream::HubStats,
    record: Option<&crate::wire::DeviceRecord>,
    histories: &std::collections::HashMap<String, crate::ranges::DeviceHistory>,
    name: crate::ranges::RangeName,
    week_start: u32,
    now: chrono::DateTime<chrono::Local>,
    only: Option<&str>,
) -> crate::ranges::CompanyRanges {
    let local_history = record.and_then(crate::ranges::local_device_history);
    let mut sources =
        crate::ranges::company_range_sources(hub_stats, record, histories, local_history.as_ref());
    if let Some(id) = only {
        sources.retain(|s| s.device_id == id);
    }
    crate::ranges::company_ranges(
        &sources,
        name,
        week_start,
        &crate::collector::local_today_key(now),
        now.timestamp_millis(),
    )
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
    match hub_device_daily(&url, hub.secret.clone()).await? {
        Err(message) => Ok(CompanyRange::Error { message }),
        Ok(DeviceDailyFetch::Supported(histories)) => {
            let now = chrono::Local::now();
            let record = state.record.read().unwrap().clone();
            let company = crate::display::compose_company(
                &hub_stats,
                record.as_deref(),
                now.timestamp_millis(),
            );
            let ranges = derive_company_ranges(
                &hub_stats,
                record.as_deref(),
                &histories,
                name,
                week_start,
                now,
                None,
            );
            Ok(CompanyRange::Ready(Box::new(
                crate::ranges::CompanyRangeView::from_ranges(&ranges, &company),
            )))
        }
        Ok(DeviceDailyFetch::Unsupported) => {
            let history = match hub_history(&url, hub.secret.clone()).await? {
                Ok(h) => h,
                Err(message) => return Ok(CompanyRange::Error { message }),
            };
            // 今天的鍵與全公司的即時今日取自同一個時間點：快取的 CompanyStats 只在 hub 有新快照或
            // 本機有新 record 時重算，剛過午夜時它的 today 可能還是昨天的，會和 history 裡的昨天重複計算。
            let now = chrono::Local::now();
            let record = state.record.read().unwrap().clone();
            let company = crate::display::compose_company(
                &hub_stats,
                record.as_deref(),
                now.timestamp_millis(),
            );
            let today_key = crate::collector::local_today_key(now);
            Ok(
                match crate::ranges::company_range(
                    &history,
                    &today_key,
                    &company.periods.today,
                    name,
                    week_start,
                ) {
                    Some(view) => CompanyRange::Ready(Box::new(crate::ranges::CompanyRangeView {
                        view,
                        devices: None,
                    })),
                    None => CompanyRange::Error {
                        message: "hub history has no daily rows".into(),
                    },
                },
            )
        }
    }
}

/// 全公司範圍點開一台裝置：那台推出的範圍依工具拆分（沒有模型，上游 derivePeriod 同樣沒有）。
/// hub 不支援逐台歷史、裝置不在清單裡或沒有可用的每日歷史時回 `None`。
#[tauri::command]
pub async fn company_range_device(
    state: State<'_, AppState>,
    device_id: String,
    range: String,
    week_start: u32,
) -> Result<Option<crate::display::DeviceDetail>, crate::error::AppError> {
    let Some(name) = crate::ranges::RangeName::parse(&range) else {
        return Err(crate::error::AppError::InvalidArgument(range));
    };
    let settings = state.settings();
    let hub = crate::settings::resolve_hub(&settings, None, None);
    let (Some(url), Some(hub_stats)) = (hub.url.clone(), state.hub_stats.read().unwrap().clone())
    else {
        return Ok(None);
    };
    let Ok(DeviceDailyFetch::Supported(histories)) =
        hub_device_daily(&url, hub.secret.clone()).await?
    else {
        return Ok(None);
    };
    let now = chrono::Local::now();
    let record = state.record.read().unwrap().clone();
    let ranges = derive_company_ranges(
        &hub_stats,
        record.as_deref(),
        &histories,
        name,
        week_start,
        now,
        Some(&device_id),
    );
    Ok(ranges
        .devices
        .iter()
        .find(|d| d.status == crate::ranges::DeviceRangeStatus::Ready)
        .and_then(|d| {
            crate::display::range_device_detail(
                &hub_stats,
                record.as_deref(),
                &d.device_id,
                &d.period,
                now.timestamp_millis(),
            )
        }))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_daily_answers_are_kept_by_kind() {
        let supported: DeviceDailyResult = Ok(DeviceDailyFetch::Supported(Default::default()));
        assert_eq!(device_daily_ttl(&supported), 60_000);
        assert_eq!(
            device_daily_ttl(&Ok(DeviceDailyFetch::Unsupported)),
            600_000
        );
        assert_eq!(device_daily_ttl(&Err("offline".into())), 30_000);
        assert_eq!(hub_history_ttl(&Ok(Default::default())), 60_000);
        assert_eq!(hub_history_ttl(&Err("offline".into())), 30_000);
    }

    #[test]
    fn a_cached_answer_belongs_to_its_hub_and_expires() {
        let slot: Cache<DeviceDailyResult> = std::sync::Mutex::new(Some((
            "https://hub".into(),
            1_000,
            Ok(DeviceDailyFetch::Unsupported),
        )));
        assert!(cached(&slot, "https://hub", 1_000 + 599_999, device_daily_ttl).is_some());
        assert!(cached(&slot, "https://hub", 1_000 + 600_000, device_daily_ttl).is_none());
        assert!(cached(&slot, "https://other", 1_001, device_daily_ttl).is_none());
    }
}
