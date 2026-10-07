//! 給前端的瘦身 DTO。完整的 record（含每個 session）留在 Rust；前端只拿畫面需要的彙總，
//! IPC 才不會每 3–5 秒搬上百 KB。
//!
//! `CompanyStats`（全公司分頁）= hub 串流的快照 + 本機疊加，鏡射上游
//! src/electron/syncDisplayStats.js `composeLocalSyncStats` 與 usage.js `aggregateDevices`：
//! hub 上自己那一列換成本機最新的 record（自己的數字每幾秒就動，不必等下次上傳），
//! 期間總和只加未過期的裝置，stale 以本機時鐘重算。

use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;

use crate::hub::stream::{HubDevice, HubStats, SlimPeriod};
use crate::wire::{ClientStatus, CostMap, CountMap, DeviceRecord, Period, PeriodWindows};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PeriodTotals {
    pub total_tokens: i64,
    pub cost_usd: f64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub unclassified_tokens: i64,
    pub session_count: usize,
    pub clients: CountMap,
    pub client_costs: CostMap,
    pub models: CountMap,
    pub model_costs: CostMap,
    /// token 速率用的計數（上游 tokenRatePresentation.js）：有生成時間的回覆的 token、輸出與時間加總。
    pub timed_tokens: i64,
    pub timed_output_tokens: i64,
    pub timed_duration_ms: i64,
    /// 計數是否可信（聚合來源或推出的範圍沒有速率）。
    pub throughput: bool,
}

impl From<&Period> for PeriodTotals {
    fn from(p: &Period) -> Self {
        PeriodTotals {
            total_tokens: p.total_tokens,
            cost_usd: p.cost_usd,
            output_tokens: p.output_tokens,
            cache_read_tokens: p.cache_read_tokens,
            cache_write_tokens: p.cache_write_tokens,
            unclassified_tokens: p.unclassified_tokens,
            session_count: p.sessions.len(),
            clients: p.clients.clone(),
            client_costs: p.client_costs.clone(),
            models: p.models.clone(),
            model_costs: p.model_costs.clone(),
            timed_tokens: p.timed_tokens,
            timed_output_tokens: p.timed_output_tokens,
            timed_duration_ms: p.timed_duration_ms,
            throughput: p.capabilities.throughput,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalPeriods {
    pub today: PeriodTotals,
    pub month: PeriodTotals,
    pub all_time: PeriodTotals,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalStats {
    pub device_id: String,
    pub hostname: String,
    pub updated_at: String,
    pub periods: LocalPeriods,
    pub period_windows: PeriodWindows,
    pub tracked_clients: Vec<String>,
    pub client_status: IndexMap<String, ClientStatus>,
    /// 近 30 天的每日用量（widget 的長條圖）；還沒掃過 history 或 history 關閉時為 `None`。
    pub history: Option<HistoryPreview>,
}

/// widget 顯示的天數。
pub const HISTORY_PREVIEW_DAYS: i64 = 30;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayPoint {
    pub date: String,
    pub tokens: i64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPreview {
    /// 以今天結尾、連續的 30 天（沒有用量的日子補 0）。
    pub daily: Vec<DayPoint>,
    pub current_streak: u64,
    pub longest_streak: u64,
    pub active_days: u64,
    pub peak_day_tokens: i64,
    pub favorite_model: String,
}

/// history（graph 掃描的結果）→ widget 預覽。今天那一格改用即時的 today 期間：graph 最多每
/// 15 分鐘掃一次，今天的數字不該比上方的大字落後。
pub fn history_preview(history: &Value, today_key: &str, today: &Period) -> Option<HistoryPreview> {
    let rows = history.get("daily")?.as_array()?;
    let by_date: std::collections::HashMap<&str, &Value> = rows
        .iter()
        .filter_map(|r| Some((r.get("date")?.as_str()?, r)))
        .collect();
    let mut daily = Vec::with_capacity(HISTORY_PREVIEW_DAYS as usize);
    for back in (0..HISTORY_PREVIEW_DAYS).rev() {
        let Some(date) = crate::usage::history::day_key_add_days(today_key, -back) else {
            continue;
        };
        let point = if back == 0 {
            DayPoint {
                date,
                tokens: today.total_tokens,
                cost_usd: today.cost_usd,
            }
        } else {
            let row = by_date.get(date.as_str());
            let num = |k: &str| {
                row.and_then(|r| r.get(k))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
            };
            DayPoint {
                tokens: num("tokens").round() as i64,
                cost_usd: num("cost"),
                date,
            }
        };
        daily.push(point);
    }
    let summary = history.get("summary");
    let int = |k: &str| {
        summary
            .and_then(|s| s.get(k))
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
    };
    Some(HistoryPreview {
        daily,
        current_streak: int("currentStreak") as u64,
        longest_streak: int("longestStreak") as u64,
        active_days: int("activeDays") as u64,
        peak_day_tokens: int("peakDayTokens").round() as i64,
        favorite_model: summary
            .and_then(|s| s.get("favoriteModel"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

impl From<&DeviceRecord> for LocalStats {
    fn from(r: &DeviceRecord) -> Self {
        LocalStats {
            device_id: r.device_id.clone(),
            hostname: r.hostname.clone(),
            updated_at: r.updated_at.clone(),
            periods: LocalPeriods {
                today: (&r.today).into(),
                month: (&r.month).into(),
                all_time: (&r.all_time).into(),
            },
            period_windows: r.period_windows.clone(),
            tracked_clients: r.tracked_clients.clone(),
            client_status: r.client_status.clone(),
            history: r
                .history
                .as_deref()
                .filter(|h| h.is_object())
                .and_then(|h| history_preview(h, &r.period_windows.today.key, &r.today)),
        }
    }
}

// ---- 全公司 ------------------------------------------------------------------

/// 一個期間的全公司彙總（工具與模型拆分；不含 session 明細）。
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompanyTotals {
    pub total_tokens: i64,
    pub cost_usd: f64,
    pub clients: CountMap,
    pub client_costs: CostMap,
    pub models: CountMap,
    pub model_costs: CostMap,
}

impl CompanyTotals {
    fn add(&mut self, p: &SlimPeriod) {
        self.total_tokens += p.total_tokens.round() as i64;
        self.cost_usd += p.cost_usd;
        for (k, v) in &p.clients {
            *self.clients.entry(k.clone()).or_insert(0) += v.round() as i64;
        }
        for (k, v) in &p.client_costs {
            *self.client_costs.entry(k.clone()).or_insert(0.0) += v;
        }
        for (k, v) in &p.models {
            *self.models.entry(k.clone()).or_insert(0) += v.round() as i64;
        }
        for (k, v) in &p.model_costs {
            *self.model_costs.entry(k.clone()).or_insert(0.0) += v;
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompanyPeriods {
    pub today: CompanyTotals,
    pub month: CompanyTotals,
    pub all_time: CompanyTotals,
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Brief {
    pub total_tokens: i64,
    pub cost_usd: f64,
}

/// 裝置清單的一列（每台約 300 bytes，數百台時整份 IPC 仍在 100 KB 左右）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRow {
    pub device_id: String,
    pub hostname: String,
    pub platform: String,
    pub os_name: Option<String>,
    pub agent_runtime: String,
    pub agent_version: String,
    pub is_local: bool,
    pub stale: bool,
    pub age_ms: Option<i64>,
    pub today: Brief,
    pub month: Brief,
    pub all_time: Brief,
    /// 本月用最多 token 的工具（清單上的小標籤）。
    pub top_client: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompanyStats {
    /// hub 產生這份快照的時間。
    pub hub_updated_at: Option<String>,
    pub stale_after_ms: Option<i64>,
    pub device_count: usize,
    pub online_count: usize,
    pub periods: CompanyPeriods,
    /// 依今日 token 由多到少；本機一定在內。
    pub devices: Vec<DeviceRow>,
}

fn timestamp_ms(s: Option<&str>) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s?)
        .ok()
        .map(|d| d.timestamp_millis())
}

/// 上游 usage.js `isPeriodExpired`：有 `endsAt` 就看它，否則以最後更新的 UTC 日／月判斷。
fn period_expired(device: &HubDevice, period: &str, now_ms: i64) -> bool {
    if period == "allTime" {
        return false;
    }
    let windows = device.period_windows.as_ref();
    let ends_at = match period {
        "today" => windows.and_then(|w| w.today.as_ref()),
        _ => windows.and_then(|w| w.month.as_ref()),
    }
    .and_then(|w| w.ends_at.as_deref());
    if let Some(end) = timestamp_ms(ends_at).filter(|ms| *ms > 0) {
        return now_ms >= end;
    }
    let recorded = device
        .received_at
        .as_deref()
        .or(device.updated_at.as_deref());
    let (Some(recorded), Some(now)) = (
        timestamp_ms(recorded).and_then(chrono::DateTime::from_timestamp_millis),
        chrono::DateTime::from_timestamp_millis(now_ms),
    ) else {
        return false;
    };
    let fmt = if period == "today" {
        "%Y-%m-%d"
    } else {
        "%Y-%m"
    };
    recorded.format(fmt).to_string() != now.format(fmt).to_string()
}

/// 上游 syncUploadInterval.js `staleAfterMsForSyncUpload`：`max(base, 2 × interval)`，base 為 0 時不判 stale。
fn stale_after_for(interval_ms: Option<f64>, base: f64) -> f64 {
    if !(base.is_finite() && base > 0.0) {
        return 0.0;
    }
    let interval = interval_ms
        .filter(|v| crate::settings::SYNC_UPLOAD_INTERVAL_OPTIONS.contains(&(*v as u64)))
        .unwrap_or(0.0);
    if interval > 0.0 {
        base.max(interval * 2.0)
    } else {
        base
    }
}

fn slim_from_period(p: &Period) -> SlimPeriod {
    SlimPeriod {
        total_tokens: p.total_tokens as f64,
        cost_usd: p.cost_usd,
        clients: p
            .clients
            .iter()
            .map(|(k, v)| (k.clone(), *v as f64))
            .collect(),
        client_costs: p.client_costs.clone(),
        models: p
            .models
            .iter()
            .map(|(k, v)| (k.clone(), *v as f64))
            .collect(),
        model_costs: p.model_costs.clone(),
        client_models: p
            .client_models
            .iter()
            .map(|(c, m)| {
                (
                    c.clone(),
                    m.iter().map(|(k, v)| (k.clone(), *v as f64)).collect(),
                )
            })
            .collect(),
    }
}

/// 本機 record 轉成 hub 那一列的形狀（剛收到、不 stale）。
fn local_as_hub_device(r: &DeviceRecord, now_iso: &str) -> HubDevice {
    use crate::hub::stream::{SlimPeriodWindows, SlimPeriods, WindowEnd};
    HubDevice {
        device_id: r.device_id.clone(),
        hostname: r.hostname.clone(),
        platform: r.platform.clone(),
        os_name: (!r.os_name.is_empty()).then(|| r.os_name.clone()),
        os_version: (!r.os_version.is_empty()).then(|| r.os_version.clone()),
        agent_version: r.agent_version.clone(),
        agent_runtime: r.agent_runtime.clone(),
        updated_at: Some(r.updated_at.clone()),
        received_at: Some(now_iso.to_string()),
        age_ms: Some(0.0),
        stale: false,
        sync_upload_interval_ms: Some(r.sync_upload_interval_ms as f64),
        period_windows: Some(SlimPeriodWindows {
            today: Some(WindowEnd {
                ends_at: Some(r.period_windows.today.ends_at.clone()),
            }),
            month: Some(WindowEnd {
                ends_at: Some(r.period_windows.month.ends_at.clone()),
            }),
        }),
        periods: SlimPeriods {
            today: slim_from_period(&r.today),
            month: slim_from_period(&r.month),
            all_time: slim_from_period(&r.all_time),
        },
    }
}

fn top_key(map: &IndexMap<String, f64>) -> Option<String> {
    map.iter()
        .filter(|(_, v)| **v > 0.0)
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(k, _)| k.clone())
}

/// hub 快照 + 本機 record → 全公司視圖（上游 `composeLocalSyncStats`）。
pub fn compose_company(hub: &HubStats, local: Option<&DeviceRecord>, now_ms: i64) -> CompanyStats {
    let now_iso = chrono::DateTime::from_timestamp_millis(now_ms)
        .map(crate::wire::time::iso_millis)
        .unwrap_or_default();
    let base_stale = hub.stale_after_ms.unwrap_or(0.0);
    let local_id = local.map(|r| r.device_id.as_str());
    let mut devices: Vec<(HubDevice, bool)> = hub
        .devices
        .iter()
        .filter(|d| Some(d.device_id.as_str()) != local_id)
        .map(|d| (d.clone(), false))
        .collect();
    if let Some(r) = local {
        devices.push((local_as_hub_device(r, &now_iso), true));
    }

    let mut periods = CompanyPeriods::default();
    let mut rows = Vec::with_capacity(devices.len());
    let mut online = 0;
    for (device, is_local) in &devices {
        // 其他裝置的 age / stale 以本機時鐘重算（hub 快照可能是一分鐘前的）；
        // hub 沒給 staleAfterMs 時沿用它自己算的 stale（上游同樣的分支）。
        let received = timestamp_ms(
            device
                .received_at
                .as_deref()
                .or(device.updated_at.as_deref()),
        );
        let age_ms = if *is_local {
            Some(0)
        } else {
            received.map(|r| now_ms - r)
        };
        let stale = if *is_local {
            false
        } else if base_stale > 0.0 {
            let limit = stale_after_for(device.sync_upload_interval_ms, base_stale);
            matches!(age_ms, Some(age) if limit > 0.0 && age as f64 > limit)
        } else {
            device.stale
        };
        if !stale {
            online += 1;
        }
        let brief = |name: &str, p: &SlimPeriod| {
            if period_expired(device, name, now_ms) {
                Brief::default()
            } else {
                Brief {
                    total_tokens: p.total_tokens.round() as i64,
                    cost_usd: p.cost_usd,
                }
            }
        };
        if !period_expired(device, "today", now_ms) {
            periods.today.add(&device.periods.today);
        }
        if !period_expired(device, "month", now_ms) {
            periods.month.add(&device.periods.month);
        }
        periods.all_time.add(&device.periods.all_time);
        rows.push(DeviceRow {
            device_id: device.device_id.clone(),
            hostname: device.hostname.clone(),
            platform: device.platform.clone(),
            os_name: device.os_name.clone(),
            agent_runtime: device.agent_runtime.clone(),
            agent_version: device.agent_version.clone(),
            is_local: *is_local,
            stale,
            age_ms,
            today: brief("today", &device.periods.today),
            month: brief("month", &device.periods.month),
            all_time: brief("allTime", &device.periods.all_time),
            top_client: top_key(&device.periods.month.clients)
                .or_else(|| top_key(&device.periods.all_time.clients)),
        });
    }
    rows.sort_by(|a, b| {
        b.today
            .total_tokens
            .cmp(&a.today.total_tokens)
            .then(b.month.total_tokens.cmp(&a.month.total_tokens))
            .then(a.hostname.cmp(&b.hostname))
    });
    CompanyStats {
        hub_updated_at: hub.updated_at.clone(),
        stale_after_ms: hub.stale_after_ms.map(|v| v as i64),
        device_count: rows.len(),
        online_count: online,
        periods,
        devices: rows,
    }
}

// ---- 全公司：一台裝置的明細 ------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceTool {
    /// client id；總量大於各工具加總的餘數是 `__unattributed`。
    pub key: String,
    pub tokens: i64,
    /// 占這台裝置這段期間的百分比。
    pub percent: f64,
    /// 這個工具的模型（token 由多到少）。
    pub models: Vec<(String, i64)>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDetail {
    pub device_id: String,
    pub platform: String,
    pub os_name: Option<String>,
    pub os_version: Option<String>,
    pub agent_runtime: String,
    pub agent_version: String,
    /// hub 收到這台最後一筆的時間（本機是現在）。
    pub received_at: Option<String>,
    pub is_local: bool,
    pub total_tokens: i64,
    pub tools: Vec<DeviceTool>,
}

fn positive_entries(map: &IndexMap<String, f64>) -> Vec<(String, f64)> {
    map.iter()
        .map(|(k, v)| (k.clone(), v.max(0.0)))
        .filter(|(_, v)| *v > 0.0)
        .collect()
}

/// 上游 deviceBreakdown.js `deviceBreakdownForPeriod`：依工具分組（餘數成為未分類），每個工具下列模型；
/// 不含成本。期間已過期（例如昨天關機的電腦的 today）時是空的，與清單上的數字一致。
pub fn device_detail(
    hub: &HubStats,
    local: Option<&DeviceRecord>,
    device_id: &str,
    period: &str,
    now_ms: i64,
) -> Option<DeviceDetail> {
    let now_iso = chrono::DateTime::from_timestamp_millis(now_ms)
        .map(crate::wire::time::iso_millis)
        .unwrap_or_default();
    let (device, is_local) = match local.filter(|r| r.device_id == device_id) {
        Some(r) => (local_as_hub_device(r, &now_iso), true),
        None => (
            hub.devices
                .iter()
                .find(|d| d.device_id == device_id)?
                .clone(),
            false,
        ),
    };
    let empty = SlimPeriod::default();
    let p = match period {
        _ if period_expired(&device, period, now_ms) => &empty,
        "today" => &device.periods.today,
        "month" => &device.periods.month,
        "allTime" => &device.periods.all_time,
        _ => return None,
    };
    let total = p.total_tokens.max(0.0);
    let mut entries = positive_entries(&p.clients);
    let attributed: f64 = entries.iter().map(|(_, v)| v).sum();
    if total - attributed > 0.0 {
        entries.push((crate::detail::UNATTRIBUTED.to_string(), total - attributed));
    }
    let mut tools: Vec<DeviceTool> = entries
        .into_iter()
        .map(|(client, value)| {
            let mut models: Vec<(String, i64)> = p
                .client_models
                .get(&client)
                .map(positive_entries)
                .unwrap_or_default()
                .into_iter()
                .map(|(k, v)| (k, v.round() as i64))
                .collect();
            models.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            DeviceTool {
                percent: if total > 0.0 {
                    value / total * 100.0
                } else {
                    0.0
                },
                tokens: value.round() as i64,
                key: client,
                models,
            }
        })
        .collect();
    tools.sort_by(|a, b| b.tokens.cmp(&a.tokens).then_with(|| a.key.cmp(&b.key)));
    Some(DeviceDetail {
        device_id: device.device_id,
        platform: device.platform,
        os_name: device.os_name,
        os_version: device.os_version,
        agent_runtime: device.agent_runtime,
        agent_version: device.agent_version,
        received_at: device.received_at.or(device.updated_at),
        is_local,
        total_tokens: total.round() as i64,
        tools,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::stream::{SlimPeriodWindows, SlimPeriods, WindowEnd};

    const NOW: &str = "2026-09-24T03:00:00.000Z";

    fn now_ms() -> i64 {
        timestamp_ms(Some(NOW)).unwrap()
    }

    fn device(id: &str, today: f64, received: &str, today_ends: &str) -> HubDevice {
        HubDevice {
            device_id: id.into(),
            hostname: id.to_uppercase(),
            received_at: Some(received.into()),
            sync_upload_interval_ms: Some(600_000.0),
            period_windows: Some(SlimPeriodWindows {
                today: Some(WindowEnd {
                    ends_at: Some(today_ends.into()),
                }),
                month: Some(WindowEnd {
                    ends_at: Some("2026-09-30T16:00:00.000Z".into()),
                }),
            }),
            periods: SlimPeriods {
                today: SlimPeriod {
                    total_tokens: today,
                    cost_usd: today / 1000.0,
                    clients: [("claude".to_string(), today)].into_iter().collect(),
                    ..SlimPeriod::default()
                },
                month: SlimPeriod {
                    total_tokens: today * 10.0,
                    clients: [("codex".to_string(), today * 10.0)].into_iter().collect(),
                    ..SlimPeriod::default()
                },
                all_time: SlimPeriod {
                    total_tokens: today * 100.0,
                    ..SlimPeriod::default()
                },
            },
            ..HubDevice::default()
        }
    }

    fn hub(devices: Vec<HubDevice>) -> HubStats {
        HubStats {
            updated_at: Some("2026-09-24T02:59:00.000Z".into()),
            stale_after_ms: Some(600_000.0),
            devices,
        }
    }

    #[test]
    fn expired_today_counts_for_month_and_all_time_only() {
        let stats = compose_company(
            &hub(vec![
                device(
                    "a",
                    100.0,
                    "2026-09-24T02:58:00.000Z",
                    "2026-09-24T16:00:00.000Z",
                ),
                // 昨天關機的電腦：today 已過期。
                device(
                    "b",
                    50.0,
                    "2026-09-23T10:00:00.000Z",
                    "2026-09-23T16:00:00.000Z",
                ),
            ]),
            None,
            now_ms(),
        );
        assert_eq!(stats.periods.today.total_tokens, 100);
        assert_eq!(stats.periods.month.total_tokens, 1_500);
        assert_eq!(stats.periods.all_time.total_tokens, 15_000);
        let b = stats.devices.iter().find(|d| d.device_id == "b").unwrap();
        assert_eq!(b.today.total_tokens, 0);
        assert!(b.stale, "17 hours without an upload");
        assert_eq!(stats.online_count, 1);
        assert_eq!(stats.devices[0].device_id, "a", "sorted by today's tokens");
        assert_eq!(stats.devices[0].top_client.as_deref(), Some("codex"));
    }

    #[test]
    fn stale_uses_twice_the_upload_interval() {
        // 上傳間隔 10 分鐘：門檻 max(10 分, 20 分) = 20 分；15 分鐘前上傳的不算 stale。
        let stats = compose_company(
            &hub(vec![device(
                "a",
                1.0,
                "2026-09-24T02:45:00.000Z",
                "2026-09-24T16:00:00.000Z",
            )]),
            None,
            now_ms(),
        );
        assert!(!stats.devices[0].stale);
        assert_eq!(stats.devices[0].age_ms, Some(15 * 60 * 1000));
    }

    #[test]
    fn device_detail_groups_tools_with_their_models() {
        let mut a = device(
            "a",
            100.0,
            "2026-09-24T02:58:00.000Z",
            "2026-09-24T16:00:00.000Z",
        );
        a.periods.today.clients.insert("codex".into(), 30.0);
        a.periods.today.total_tokens = 150.0;
        a.periods.today.client_models.insert(
            "claude".into(),
            [("m2".to_string(), 40.0), ("m1".to_string(), 60.0)]
                .into_iter()
                .collect(),
        );
        let stats = hub(vec![a]);
        let d = device_detail(&stats, None, "a", "today", now_ms()).unwrap();
        let tools: Vec<(&str, i64)> = d.tools.iter().map(|t| (t.key.as_str(), t.tokens)).collect();
        assert_eq!(
            tools,
            [("claude", 100), ("codex", 30), ("__unattributed", 20)]
        );
        assert_eq!(
            d.tools[0].models,
            [("m1".to_string(), 60), ("m2".to_string(), 40)]
        );
        assert!((d.tools[0].percent - 66.666).abs() < 0.01);
        assert!(device_detail(&stats, None, "ghost", "today", now_ms()).is_none());
        // 昨天關機的電腦：today 已過期，明細是空的。
        let old = hub(vec![device(
            "b",
            50.0,
            "2026-09-23T10:00:00.000Z",
            "2026-09-23T16:00:00.000Z",
        )]);
        assert!(device_detail(&old, None, "b", "today", now_ms())
            .unwrap()
            .tools
            .is_empty());
    }

    #[test]
    fn the_local_record_replaces_our_own_hub_row() {
        let envelope = crate::wire::Envelope {
            device_id: "me".into(),
            hostname: "MY-PC".into(),
            ..crate::wire::Envelope::default()
        };
        let mut usage = crate::wire::UsageSummary::default();
        usage.today.total_tokens = 999;
        usage.today.clients.insert("claude".into(), 999);
        usage.period_windows.today.ends_at = "2026-09-24T16:00:00.000Z".into();
        usage.period_windows.month.ends_at = "2026-09-30T16:00:00.000Z".into();
        let record = DeviceRecord::compose(&envelope, &usage, 600_000, None, None);
        let stats = compose_company(
            &hub(vec![
                device(
                    "me",
                    5.0,
                    "2026-09-24T02:00:00.000Z",
                    "2026-09-24T16:00:00.000Z",
                ),
                device(
                    "a",
                    100.0,
                    "2026-09-24T02:58:00.000Z",
                    "2026-09-24T16:00:00.000Z",
                ),
            ]),
            Some(&record),
            now_ms(),
        );
        assert_eq!(
            stats.device_count, 2,
            "our hub row is replaced, not duplicated"
        );
        assert_eq!(stats.periods.today.total_tokens, 1_099);
        assert_eq!(stats.periods.today.clients["claude"], 1_099);
        let me = stats.devices.iter().find(|d| d.is_local).unwrap();
        assert_eq!(me.today.total_tokens, 999);
        assert!(!me.stale);
        assert_eq!(stats.devices[0].device_id, "me");
    }
}
