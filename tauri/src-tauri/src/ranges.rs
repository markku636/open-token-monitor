//! 本星期／最近 7 日／最近 30 日（上游 renderer fixedPeriodRanges.js）：由每日歷史推出的期間。
//!
//! tokscale 只給 today / month / allTime，其他範圍都從 history 的每日列加總：範圍兩端都含、以裝置
//! 本地的日期鍵計算，沒有用量的日子補 0；今天那一列換成即時的 today（即時數字不小於 history 裡的
//! 那一列時才換，上游 `dailyWithLiveToday`）。推出的期間只有工具與模型的拆分與 token 組成，沒有
//! session、專案與速率計數（上游 `derivePeriod`）。
//!
//! 全公司的範圍（`company_ranges`，上游 `fixedPeriodSnapshotFromDevices`）逐台推：每台裝置用自己的
//! 每日歷史、自己即時的 today 與自己的日期鍵算出範圍，總數是各台的範圍列逐日相加
//! （`mergeSelectedDaily`）。

use std::borrow::Cow;
use std::collections::HashMap;

use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::hub::stream::HubStats;
use crate::usage::history::day_key_add_days;
use crate::wire::period::{add_cost, add_count};
use crate::wire::{CountMap, DeviceRecord, Period};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeName {
    Week,
    Last7,
    Last30,
}

impl RangeName {
    pub fn parse(s: &str) -> Option<RangeName> {
        match s {
            "week" => Some(RangeName::Week),
            "last7" => Some(RangeName::Last7),
            "last30" => Some(RangeName::Last30),
            _ => None,
        }
    }
}

/// 範圍的起訖日（含）。`week_start`：一週從星期幾開始（0 = 星期日，前端依地區設定決定，上游預設星期一）。
pub fn range_bounds(name: RangeName, today_key: &str, week_start: u32) -> Option<(String, String)> {
    let today = chrono::NaiveDate::parse_from_str(today_key, "%Y-%m-%d").ok()?;
    let back = match name {
        RangeName::Last7 => 6,
        RangeName::Last30 => 29,
        RangeName::Week => {
            use chrono::Datelike;
            let weekday = today.weekday().num_days_from_sunday();
            ((weekday + 7 - week_start % 7) % 7) as i64
        }
    };
    Some((day_key_add_days(today_key, -back)?, today_key.to_string()))
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RangeSummary {
    pub active_days: i64,
    /// 從範圍最後一天往回連續有用量的天數。
    pub current_streak: i64,
    pub active_time_ms: i64,
    pub peak_day_tokens: i64,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct Part {
    tokens: f64,
    cost: f64,
    cache_read: f64,
    cache_write: f64,
    output: f64,
    unclassified: f64,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct Row {
    date: String,
    tokens: f64,
    cost: f64,
    cache_read: f64,
    cache_write: f64,
    output: f64,
    unclassified: f64,
    components_available: bool,
    active_time_ms: f64,
    per_client: IndexMap<String, Part>,
    per_model: IndexMap<String, Part>,
}

impl Row {
    /// 範圍裡沒有列的日子（上游 `dailyForRange` 補的 0 列，組成算可用）。
    fn empty(date: &str) -> Row {
        Row {
            date: date.to_string(),
            components_available: true,
            ..Row::default()
        }
    }
}

fn num(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .unwrap_or(0.0)
}

/// 上游 `unclassifiedTokensFor`：有 `unclassifiedTokens` 就用它；沒有時，組成可用就是 0，否則整列都算未分類。
fn unclassified_for(obj: &Map<String, Value>, components_available: bool) -> f64 {
    match obj.get("unclassifiedTokens") {
        Some(v) => num(Some(v)).max(0.0),
        None if components_available => 0.0,
        None => num(obj.get("tokens")).max(0.0),
    }
}

fn part_from(obj: &Map<String, Value>) -> Part {
    let available = obj.get("tokenComponentsAvailable").and_then(Value::as_bool) == Some(true);
    Part {
        tokens: num(obj.get("tokens")),
        cost: num(obj.get("cost")),
        cache_read: num(obj.get("cacheReadTokens")),
        cache_write: num(obj.get("cacheWriteTokens")),
        output: num(obj.get("outputTokens")),
        unclassified: unclassified_for(obj, available),
    }
}

fn parts_from(v: Option<&Value>) -> IndexMap<String, Part> {
    v.and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| Some((k.clone(), part_from(v.as_object()?))))
                .collect()
        })
        .unwrap_or_default()
}

fn row_from(v: &Value) -> Option<Row> {
    let o = v.as_object()?;
    let date = o.get("date")?.as_str()?.get(..10)?.to_string();
    let available = o.get("tokenComponentsAvailable").and_then(Value::as_bool) == Some(true);
    Some(Row {
        date,
        tokens: num(o.get("tokens")),
        cost: num(o.get("cost")),
        cache_read: num(o.get("cacheReadTokens")),
        cache_write: num(o.get("cacheWriteTokens")),
        output: num(o.get("outputTokens")),
        unclassified: unclassified_for(o, available),
        components_available: available,
        active_time_ms: num(o.get("activeTimeMs")),
        per_client: parts_from(o.get("perClient")),
        per_model: parts_from(o.get("perModel")),
    })
}

/// history 的每日列 → 以日期為鍵（同一天有兩列時後者為準，同上游 `dailyForRange` 的 Map）。
fn rows_by_date(daily: &[Value]) -> IndexMap<String, Row> {
    daily
        .iter()
        .filter_map(row_from)
        .map(|r| (r.date.clone(), r))
        .collect()
}

/// 上游 `liveComponentValues`：依序夾住快取讀取、快取寫入、輸出；組成精確時未分類是 0。
fn live_part(total: i64, cr: i64, cw: i64, out: i64, uncl: i64, cost: f64, exact: bool) -> Part {
    let total = total.max(0) as f64;
    let cache_read = total.min(cr.max(0) as f64);
    let cache_write = (total - cache_read).min(cw.max(0) as f64);
    let output = (total - cache_read - cache_write).min(out.max(0) as f64);
    let remainder = (total - cache_read - cache_write - output).max(0.0);
    Part {
        tokens: total,
        cost,
        cache_read,
        cache_write,
        output,
        unclassified: if exact {
            0.0
        } else {
            remainder.min(uncl.max(0) as f64)
        },
    }
}

fn get(map: &CountMap, key: &str) -> i64 {
    map.get(key).copied().unwrap_or(0)
}

/// 上游 `rowFromLivePeriod`：即時的 today 期間轉成一天的歷史列（保留原列的活躍時間）。
fn row_from_live(p: &Period, date: &str, previous: Option<&Row>) -> Row {
    let exact = p.capabilities.token_components;
    let mut per_client = IndexMap::new();
    for key in p.clients.keys().chain(p.client_costs.keys()) {
        if per_client.contains_key(key) {
            continue;
        }
        per_client.insert(
            key.clone(),
            live_part(
                get(&p.clients, key),
                get(&p.client_cache_reads, key),
                get(&p.client_cache_writes, key),
                get(&p.client_outputs, key),
                get(&p.client_unclassified_tokens, key),
                p.client_costs.get(key).copied().unwrap_or(0.0),
                exact,
            ),
        );
    }
    let mut per_model = IndexMap::new();
    for key in p.models.keys().chain(p.model_costs.keys()) {
        if per_model.contains_key(key) {
            continue;
        }
        per_model.insert(
            key.clone(),
            live_part(
                get(&p.models, key),
                get(&p.model_cache_reads, key),
                get(&p.model_cache_writes, key),
                get(&p.model_outputs, key),
                get(&p.model_unclassified_tokens, key),
                p.model_costs.get(key).copied().unwrap_or(0.0),
                exact,
            ),
        );
    }
    let total = live_part(
        p.total_tokens,
        p.cache_read_tokens,
        p.cache_write_tokens,
        p.output_tokens,
        p.unclassified_tokens,
        p.cost_usd,
        exact,
    );
    Row {
        date: date.to_string(),
        tokens: p.total_tokens as f64,
        cost: p.cost_usd,
        cache_read: total.cache_read,
        cache_write: total.cache_write,
        output: total.output,
        unclassified: total.unclassified,
        components_available: exact,
        active_time_ms: previous.map(|r| r.active_time_ms).unwrap_or(0.0),
        per_client,
        per_model,
    }
}

fn round6(v: f64) -> f64 {
    (v * 1e6).round() / 1e6
}

/// 上游 `dailyForRange`（含 `dailyWithLiveToday`）：`[start, end]` 的每一天，沒有列的日子補 0。
/// `live` 是 `live_key` 那天即時的 today，數字不小於 history 那一列時才取代它；`None` 不插即時列。
fn fill_range(
    by_date: &IndexMap<String, Row>,
    live_key: &str,
    live: Option<&Period>,
    start: &str,
    end: &str,
) -> Vec<Row> {
    let previous = by_date.get(live_key);
    let live = live
        .map(|p| row_from_live(p, live_key, previous))
        .filter(|row| previous.is_none_or(|prev| row.tokens >= prev.tokens));
    let mut rows: Vec<Row> = Vec::new();
    let mut date = start.to_string();
    while date.as_str() <= end {
        rows.push(match &live {
            Some(row) if date == live_key => row.clone(),
            _ => by_date
                .get(&date)
                .cloned()
                .unwrap_or_else(|| Row::empty(&date)),
        });
        match day_key_add_days(&date, 1) {
            Some(next) => date = next,
            None => break,
        }
    }
    rows
}

/// 上游 `addDailyAttribution` / `derivePeriod`：工具的 `antigravity-cli` 併進 `antigravity`（模型不併）。
fn fold_client(client: &str) -> &str {
    if client == "antigravity-cli" {
        "antigravity"
    } else {
        client
    }
}

fn add_part(into: &mut IndexMap<String, Part>, key: &str, v: &Part) {
    let e = into.entry(key.to_string()).or_default();
    e.tokens += v.tokens;
    e.cost += v.cost;
    e.cache_read += v.cache_read;
    e.cache_write += v.cache_write;
    e.output += v.output;
    e.unclassified += v.unclassified;
}

/// 上游 `derivePeriod` 的加總：token 四捨五入、成本取到小數 6 位；只有工具與模型的拆分與 token 組成。
fn period_from_rows(rows: &[Row]) -> Period {
    let mut p = Period::default();
    p.capabilities.token_components = rows.iter().all(|r| r.components_available);
    p.capabilities.throughput = false;
    let (mut total, mut cost, mut cr, mut cw, mut out, mut uncl) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    let mut clients: IndexMap<String, Part> = IndexMap::new();
    let mut models: IndexMap<String, Part> = IndexMap::new();
    for r in rows {
        total += r.tokens;
        cost += r.cost;
        cr += r.cache_read;
        cw += r.cache_write;
        out += r.output;
        uncl += r.unclassified;
        for (client, v) in &r.per_client {
            add_part(&mut clients, fold_client(client), v);
        }
        for (model, v) in &r.per_model {
            add_part(&mut models, model, v);
        }
    }
    let int = |v: f64| v.round().max(0.0) as i64;
    p.total_tokens = int(total);
    p.cost_usd = round6(cost);
    p.cache_read_tokens = int(cr);
    p.cache_write_tokens = int(cw);
    p.output_tokens = int(out);
    p.unclassified_tokens = int(uncl);
    for (k, v) in &clients {
        add_count(&mut p.clients, k, int(v.tokens));
        add_cost(&mut p.client_costs, k, round6(v.cost));
        add_count(&mut p.client_cache_reads, k, int(v.cache_read));
        add_count(&mut p.client_cache_writes, k, int(v.cache_write));
        add_count(&mut p.client_outputs, k, int(v.output));
        add_count(&mut p.client_unclassified_tokens, k, int(v.unclassified));
    }
    for (k, v) in &models {
        add_count(&mut p.models, k, int(v.tokens));
        add_cost(&mut p.model_costs, k, round6(v.cost));
        add_count(&mut p.model_cache_reads, k, int(v.cache_read));
        add_count(&mut p.model_cache_writes, k, int(v.cache_write));
        add_count(&mut p.model_outputs, k, int(v.output));
        add_count(&mut p.model_unclassified_tokens, k, int(v.unclassified));
    }
    p
}

/// 上游 `summaryForDaily`。
fn summary_for_rows(rows: &[Row]) -> RangeSummary {
    let streak = rows.iter().rev().take_while(|r| r.tokens > 0.0).count();
    RangeSummary {
        active_days: rows.iter().filter(|r| r.tokens > 0.0).count() as i64,
        current_streak: streak as i64,
        active_time_ms: rows.iter().map(|r| r.active_time_ms).sum::<f64>().round() as i64,
        peak_day_tokens: rows.iter().fold(0.0_f64, |m, r| m.max(r.tokens)).round() as i64,
    }
}

/// history + 即時的 today → 範圍 `[start, end]` 的期間與摘要（上游 `dailyForRange` + `derivePeriod` +
/// `summaryForDaily`）。history 不是物件時回 `None`。
pub fn derive_range(
    history: &Value,
    today_key: &str,
    today: &Period,
    start: &str,
    end: &str,
) -> Option<(Period, RangeSummary)> {
    let daily = history.get("daily")?.as_array()?;
    let rows = fill_range(&rows_by_date(daily), today_key, Some(today), start, end);
    Some((period_from_rows(&rows), summary_for_rows(&rows)))
}

/// widget 要的範圍資料：總數、工具與模型的明細、摘要。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RangeView {
    pub start: String,
    pub end: String,
    pub totals: crate::display::PeriodTotals,
    pub detail: crate::detail::PeriodDetail,
    pub summary: RangeSummary,
}

/// `loading`：還沒有 history（第一次掃描還沒完成，或掃描失敗）；`disabled`：history 關閉。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum RangeResult {
    Ready(Box<RangeView>),
    Loading,
    Disabled,
}

/// 本機 record → 範圍。範圍名稱不對時回 `None`。
pub fn range_result(
    record: &crate::wire::DeviceRecord,
    name: RangeName,
    week_start: u32,
) -> Option<RangeResult> {
    let today_key = &record.period_windows.today.key;
    let history = match record.history.as_deref() {
        None => return Some(RangeResult::Loading),
        Some(Value::Null) => return Some(RangeResult::Disabled),
        Some(h) => h,
    };
    let (start, end) = range_bounds(name, today_key, week_start)?;
    let Some((period, summary)) = derive_range(history, today_key, &record.today, &start, &end)
    else {
        return Some(RangeResult::Loading);
    };
    Some(RangeResult::Ready(Box::new(RangeView {
        start,
        end,
        totals: (&period).into(),
        detail: crate::detail::period_detail(&period),
        summary,
    })))
}

/// 全公司的範圍：hub 合併好的每日歷史 + 全公司即時的今日（`CompanyTotals` 沒有 token 組成）。
/// hub 不提供逐台的每日歷史（`/api/custom/device-daily`）時的退路。
pub fn company_range(
    history: &Value,
    today_key: &str,
    today: &crate::display::CompanyTotals,
    name: RangeName,
    week_start: u32,
) -> Option<RangeView> {
    let live = Period {
        capabilities: crate::wire::Capabilities {
            token_components: false,
            throughput: false,
        },
        total_tokens: today.total_tokens,
        cost_usd: today.cost_usd,
        clients: today.clients.clone(),
        client_costs: today.client_costs.clone(),
        models: today.models.clone(),
        model_costs: today.model_costs.clone(),
        ..Period::default()
    };
    let (start, end) = range_bounds(name, today_key, week_start)?;
    let (period, summary) = derive_range(history, today_key, &live, &start, &end)?;
    Some(RangeView {
        start,
        end,
        totals: (&period).into(),
        detail: crate::detail::period_detail(&period),
        summary,
    })
}

// ---- 全公司：逐台裝置（上游 fixedPeriodSnapshotFromDevices）---------------------------

/// 一台裝置的每日歷史，以日期為鍵。hub 的來源只有最近 32 天（`/api/custom/device-daily`）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DeviceHistory {
    by_date: IndexMap<String, Row>,
    /// 整份每日歷史有沒有任何用量：上游 `sourceParticipatesInUsage` 看完整的每日列，所以 hub 另外給。
    pub has_usage: bool,
}

impl DeviceHistory {
    /// 完整的每日列（本機 record 的 `history.daily`）。
    pub fn from_daily(daily: &[Value]) -> Self {
        DeviceHistory {
            by_date: rows_by_date(daily),
            has_usage: daily
                .iter()
                .any(|r| num(r.get("tokens")) > 0.0 || num(r.get("cost")) > 0.0),
        }
    }

    /// hub 只送最近 32 天的列；整份歷史有沒有用量是 hub 的 `historyHasUsage`。
    pub fn from_window(daily: &[Value], history_has_usage: bool) -> Self {
        let mut history = Self::from_daily(daily);
        history.has_usage |= history_has_usage;
        history
    }
}

/// 本機 record 的每日歷史；`history` 是 `null`（關閉）或這筆沒帶時回 `None`。
pub fn local_device_history(record: &DeviceRecord) -> Option<DeviceHistory> {
    let history = record.history.as_deref().filter(|h| !h.is_null())?;
    let daily = history
        .get("daily")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    Some(DeviceHistory::from_daily(daily))
}

/// 上游 `normalizeDateKey`：前 10 個字元是存在的日期（YYYY-MM-DD）才算。
fn normalize_date_key(value: &str) -> Option<String> {
    let key: String = value.chars().take(10).collect();
    let shaped = key.len() == 10
        && key.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 => b == b'-',
            _ => b.is_ascii_digit(),
        });
    let date = chrono::NaiveDate::parse_from_str(&key, "%Y-%m-%d").ok()?;
    (shaped && date.format("%Y-%m-%d").to_string() == key).then_some(key)
}

/// 時區與 UTC 最多差這麼多（UTC−12 到 UTC+14）；`endsAt` 推出更大的時差代表資料不對。
const MAX_UTC_OFFSET_MS: i64 = 14 * 60 * 60 * 1000;

/// 上游 `deviceDayState`：`(current, snapshot)` = 裝置現在是哪一天、它最新的 today 期間屬於哪一天。
/// 日還沒過完兩者都是 `key`。日已過期時上游以 `periodWindows.timeZone`（IANA）算現在的日期；我們
/// 不帶時區資料庫，改由 `endsAt` 推出裝置的時差（`key` 隔天的 00:00 UTC − `endsAt`）再換算。
/// 固定時差的時區（例如 Asia/Taipei）與上游完全相同；有日光節約的時區，若那之後切換過時差，只在
/// 午夜前後的那一小時可能差一天。`key` 或 `endsAt` 不合法時回 `None`。
pub fn device_day_state(key: &str, ends_at: &str, now_ms: i64) -> Option<(String, String)> {
    let key = normalize_date_key(key)?;
    let ends = chrono::DateTime::parse_from_rfc3339(ends_at)
        .ok()?
        .timestamp_millis();
    if now_ms < ends {
        return Some((key.clone(), key));
    }
    let next_midnight = chrono::NaiveDate::parse_from_str(&key, "%Y-%m-%d")
        .ok()?
        .succ_opt()?
        .and_hms_opt(0, 0, 0)?
        .and_utc()
        .timestamp_millis();
    let offset = next_midnight - ends;
    if offset.abs() > MAX_UTC_OFFSET_MS {
        return None;
    }
    let current = chrono::DateTime::from_timestamp_millis(now_ms.checked_add(offset)?)?
        .format("%Y-%m-%d")
        .to_string();
    Some((current, key))
}

/// 上游 `mergeSelectedDaily`：各台裝置的範圍列逐日相加，依日期排序。
fn merge_rows(per_device: &[Vec<Row>]) -> Vec<Row> {
    let mut by_date: IndexMap<String, Row> = IndexMap::new();
    for rows in per_device {
        for r in rows {
            let t = by_date
                .entry(r.date.clone())
                .or_insert_with(|| Row::empty(&r.date));
            t.tokens += r.tokens;
            t.cost += r.cost;
            t.active_time_ms += r.active_time_ms;
            t.cache_read += r.cache_read;
            t.cache_write += r.cache_write;
            t.output += r.output;
            t.unclassified += r.unclassified;
            t.components_available &= r.components_available;
            for (client, v) in &r.per_client {
                add_part(&mut t.per_client, fold_client(client), v);
            }
            for (model, v) in &r.per_model {
                add_part(&mut t.per_model, model, v);
            }
        }
    }
    let mut merged: Vec<Row> = by_date.into_values().collect();
    merged.sort_by(|a, b| a.date.cmp(&b.date));
    merged
}

/// 一台裝置推範圍要的東西（上游 `joinDeviceHistorySources` 合併後的 source）。
#[derive(Debug, Clone)]
pub struct DeviceRangeSource<'a> {
    pub device_id: &'a str,
    /// 裝置最新的 today 期間，原樣不因過期歸零：過期時它落在自己的那一天（`device_day_state` 的 snapshot）。
    pub today: Cow<'a, Period>,
    /// today / month / allTime 任一有 token 或成本（上游 `sourceParticipatesInUsage` 的前半）。
    pub live_usage: bool,
    pub today_key: Option<&'a str>,
    pub today_ends_at: Option<&'a str>,
    /// 沒有可用的每日歷史時是 `None`。
    pub history: Option<&'a DeviceHistory>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeviceRangeStatus {
    Ready,
    /// 沒有可用的每日歷史（不論即時數字是不是 0），或有用量但日期鍵不合法：不計入總數。上游在這種
    /// 情況整個範圍都不顯示。
    Unavailable,
}

/// 一台裝置的範圍：`Unavailable` 時起訖日是空字串、期間是空的。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRange {
    pub device_id: String,
    pub status: DeviceRangeStatus,
    pub start: String,
    pub end: String,
    pub period: Period,
}

impl DeviceRange {
    fn unavailable(device_id: &str) -> Self {
        DeviceRange {
            device_id: device_id.to_string(),
            status: DeviceRangeStatus::Unavailable,
            start: String::new(),
            end: String::new(),
            period: Period::default(),
        }
    }
}

/// 全公司的範圍：總數是 `Ready` 裝置的範圍列逐日相加，起訖日是它們的聯集。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyRanges {
    pub start: String,
    pub end: String,
    pub period: Period,
    pub summary: RangeSummary,
    /// 有參與用量或沒有可用每日歷史的裝置，依 deviceId 排序。
    pub devices: Vec<DeviceRange>,
}

/// 一台裝置的範圍 `(start, end, rows)`（上游 `fixedPeriodSnapshot` 以那台的 `deviceDayState`）：
/// 範圍到它現在的那一天，它最新的 today 落在自己那一天。沒有歷史或日期鍵不合法時回 `None`。
fn device_rows(
    source: &DeviceRangeSource,
    name: RangeName,
    week_start: u32,
    now_ms: i64,
) -> Option<(String, String, Vec<Row>)> {
    let history = source.history?;
    let (current, snapshot) = device_day_state(source.today_key?, source.today_ends_at?, now_ms)?;
    let (start, end) = range_bounds(name, &current, week_start)?;
    let rows = fill_range(
        &history.by_date,
        &snapshot,
        Some(source.today.as_ref()),
        &start,
        &end,
    );
    Some((start, end, rows))
}

/// 上游 `fixedPeriodSnapshotFromDevices`：每台裝置以自己的日期鍵、每日歷史與即時的 today 推出範圍，
/// 總數是各台逐日相加。每日歷史可用、整份與即時都沒有用量的裝置不列。
///
/// 與上游的差異：上游只要有一台沒有可用的每日歷史，整個範圍就不顯示；裝置一多幾乎永遠會有這樣的
/// 一台，所以這裡把它標成 `Unavailable`、不計入總數，其他裝置照算（v1 的決定，畫面會註明台數）。
/// 沒有任何 `Ready` 裝置時，是觀看者自己的範圍（`viewer_today_key`）的零。
pub fn company_ranges(
    sources: &[DeviceRangeSource],
    name: RangeName,
    week_start: u32,
    viewer_today_key: &str,
    now_ms: i64,
) -> CompanyRanges {
    // 上游 `joinDeviceHistorySources` 以 JavaScript 的 `.sort()` 排 deviceId（UTF-16 碼元序）；
    // deviceId 都是 ASCII，位元組序相同。
    let mut order: Vec<&DeviceRangeSource> =
        sources.iter().filter(|s| !s.device_id.is_empty()).collect();
    order.sort_by(|a, b| a.device_id.cmp(b.device_id));

    let mut devices = Vec::new();
    let mut ready_rows: Vec<Vec<Row>> = Vec::new();
    for source in order {
        // 上游先要每台都有歷史才判斷誰參與（fixedPeriodRanges.js 的註解：today / month / allTime 都是
        // 0 的裝置仍可能在範圍內有保留的用量，例如 allTimeSince 把那幾天排除時，缺的紀錄不能變成
        // 無聲的 0）。所以沒有歷史的裝置不論即時數字都標出來、算進底下的台數；只有歷史可用又整份
        // 沒有用量的裝置才能確定不參與。
        let Some(history) = source.history else {
            devices.push(DeviceRange::unavailable(source.device_id));
            continue;
        };
        if !(source.live_usage || history.has_usage) {
            continue;
        }
        match device_rows(source, name, week_start, now_ms) {
            Some((start, end, rows)) => {
                devices.push(DeviceRange {
                    device_id: source.device_id.to_string(),
                    status: DeviceRangeStatus::Ready,
                    start,
                    end,
                    period: period_from_rows(&rows),
                });
                ready_rows.push(rows);
            }
            None => devices.push(DeviceRange::unavailable(source.device_id)),
        }
    }

    let ready = devices
        .iter()
        .filter(|d| d.status == DeviceRangeStatus::Ready);
    let bounds = ready
        .clone()
        .map(|d| d.start.as_str())
        .min()
        .zip(ready.map(|d| d.end.as_str()).max())
        .map(|(start, end)| (start.to_string(), end.to_string()));
    let Some((start, end)) = bounds else {
        let (start, end) = range_bounds(name, viewer_today_key, week_start).unwrap_or_default();
        let rows = if start.is_empty() {
            Vec::new()
        } else {
            fill_range(&IndexMap::new(), "", None, &start, &end)
        };
        return CompanyRanges {
            period: period_from_rows(&rows),
            summary: summary_for_rows(&rows),
            start,
            end,
            devices,
        };
    };
    let merged = merge_rows(&ready_rows);
    let by_date: IndexMap<String, Row> =
        merged.iter().map(|r| (r.date.clone(), r.clone())).collect();
    CompanyRanges {
        period: period_from_rows(&fill_range(&by_date, "", None, &start, &end)),
        // 上游 `summaryForDaily(daily)` 用合併後的列，不是補滿聯集範圍後的列。
        summary: summary_for_rows(&merged),
        start,
        end,
        devices,
    }
}

fn slim_has_usage(p: &crate::hub::stream::SlimPeriod) -> bool {
    p.total_tokens > 0.0 || p.cost_usd > 0.0
}

fn period_has_usage(p: &Period) -> bool {
    p.total_tokens > 0 || p.cost_usd > 0.0
}

/// 全公司範圍的裝置清單與 `compose_company` 相同：hub 快照去掉本機那一列，再加上本機最新的 record
/// （上游 `joinDeviceHistorySources` 以 stats.devices 為即時來源）。只在 `/api/custom/device-daily`
/// 出現、串流裡沒有的裝置不列；串流有、它沒有的裝置沒有歷史。
///
/// 本機那台的歷史照上游 `devicesWithLocalHistory`：record 帶了 history 就用它（`null` = 關閉），
/// 沒帶時沿用 hub 上的那份；兩者都要 record 的 `historyAvailable`。
pub fn company_range_sources<'a>(
    hub: &'a HubStats,
    local: Option<&'a DeviceRecord>,
    hub_histories: &'a HashMap<String, DeviceHistory>,
    local_history: Option<&'a DeviceHistory>,
) -> Vec<DeviceRangeSource<'a>> {
    let local_id = local.map(|r| r.device_id.as_str());
    let mut sources: Vec<DeviceRangeSource<'a>> = hub
        .devices
        .iter()
        .filter(|d| Some(d.device_id.as_str()) != local_id)
        .map(|d| {
            let window = d.period_windows.as_ref().and_then(|w| w.today.as_ref());
            DeviceRangeSource {
                device_id: &d.device_id,
                today: Cow::Owned(crate::display::slim_to_period(&d.periods.today)),
                live_usage: [&d.periods.today, &d.periods.month, &d.periods.all_time]
                    .into_iter()
                    .any(slim_has_usage),
                today_key: window.and_then(|w| w.key.as_deref()),
                today_ends_at: window.and_then(|w| w.ends_at.as_deref()),
                history: hub_histories.get(&d.device_id),
            }
        })
        .collect();
    if let Some(r) = local {
        let history = match r.history.as_deref() {
            Some(Value::Null) => None,
            Some(_) => local_history,
            None => hub_histories.get(&r.device_id),
        }
        .filter(|_| r.history_available);
        sources.push(DeviceRangeSource {
            device_id: &r.device_id,
            today: Cow::Borrowed(&r.today),
            live_usage: [&r.today, &r.month, &r.all_time]
                .into_iter()
                .any(period_has_usage),
            today_key: Some(&r.period_windows.today.key),
            today_ends_at: Some(&r.period_windows.today.ends_at),
            history,
        });
    }
    sources
}

/// 全公司範圍的畫面：總數與明細，加上逐台的清單（`None` = hub 不提供逐台的每日歷史，總數來自
/// `/api/history` 的合併版）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompanyRangeView {
    #[serde(flatten)]
    pub view: RangeView,
    pub devices: Option<Vec<crate::display::RangeDeviceRow>>,
}

impl CompanyRangeView {
    /// 逐台推出的範圍 → 畫面；清單的名稱與狀態取自全公司視圖（`compose_company`）。
    pub fn from_ranges(ranges: &CompanyRanges, company: &crate::display::CompanyStats) -> Self {
        CompanyRangeView {
            view: RangeView {
                start: ranges.start.clone(),
                end: ranges.end.clone(),
                totals: (&ranges.period).into(),
                detail: crate::detail::period_detail(&ranges.period),
                summary: ranges.summary,
            },
            devices: Some(crate::display::range_device_rows(&ranges.devices, company)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bounds_are_inclusive_calendar_days() {
        // 2026-09-24 是星期四。
        assert_eq!(
            range_bounds(RangeName::Last7, "2026-09-24", 1),
            Some(("2026-09-18".into(), "2026-09-24".into()))
        );
        assert_eq!(
            range_bounds(RangeName::Last30, "2026-09-24", 1).unwrap().0,
            "2026-08-26"
        );
        assert_eq!(
            range_bounds(RangeName::Week, "2026-09-24", 1).unwrap().0,
            "2026-09-21",
            "Monday start"
        );
        assert_eq!(
            range_bounds(RangeName::Week, "2026-09-24", 0).unwrap().0,
            "2026-09-20",
            "Sunday start"
        );
        assert_eq!(
            range_bounds(RangeName::Week, "2026-09-21", 1).unwrap().0,
            "2026-09-21",
            "the week starts today"
        );
        assert_eq!(range_bounds(RangeName::Week, "bad", 1), None);
    }

    fn history() -> Value {
        json!({ "daily": [
            { "date": "2026-09-17", "tokens": 1000, "cost": 9.0, "tokenComponentsAvailable": true,
              "perClient": { "claude": { "tokens": 1000, "cost": 9.0, "unclassifiedTokens": 0 } },
              "perModel": { "m1": { "tokens": 1000, "cost": 9.0, "unclassifiedTokens": 0 } } },
            { "date": "2026-09-20", "tokens": 100, "cost": 1.0, "cacheReadTokens": 60, "outputTokens": 10,
              "unclassifiedTokens": 0, "tokenComponentsAvailable": true, "activeTimeMs": 60000,
              "perClient": {
                "claude": { "tokens": 70, "cost": 0.7, "cacheReadTokens": 60, "unclassifiedTokens": 0 },
                "antigravity-cli": { "tokens": 30, "cost": 0.3, "outputTokens": 10, "unclassifiedTokens": 0 } },
              "perModel": { "m1": { "tokens": 100, "cost": 1.0, "unclassifiedTokens": 0 } } },
            { "date": "2026-09-24", "tokens": 5, "cost": 0.05, "activeTimeMs": 30000, "tokenComponentsAvailable": true,
              "perClient": { "codex": { "tokens": 5, "cost": 0.05, "unclassifiedTokens": 0 } }, "perModel": {} }
        ], "monthly": [], "summary": {} })
    }

    fn live_today(tokens: i64) -> Period {
        let mut p = Period {
            total_tokens: tokens,
            cost_usd: 0.5,
            output_tokens: 20,
            ..Period::default()
        };
        p.clients.insert("codex".into(), tokens);
        p.client_costs.insert("codex".into(), 0.5);
        p.client_outputs.insert("codex".into(), 20);
        p.models.insert("gpt".into(), tokens);
        p.model_costs.insert("gpt".into(), 0.5);
        p
    }

    #[test]
    fn a_range_sums_history_and_the_live_today() {
        let (p, s) = derive_range(
            &history(),
            "2026-09-24",
            &live_today(50),
            "2026-09-18",
            "2026-09-24",
        )
        .unwrap();
        assert_eq!(p.total_tokens, 150, "09-17 is outside; today is live");
        assert_eq!(p.cost_usd, 1.5);
        assert_eq!(p.clients["claude"], 70);
        assert_eq!(
            p.clients["antigravity"], 30,
            "antigravity-cli folds into antigravity"
        );
        assert_eq!(p.clients["codex"], 50);
        assert_eq!(p.client_outputs["codex"], 20);
        assert_eq!(p.client_cache_reads["claude"], 60);
        assert_eq!(p.models["gpt"], 50);
        assert_eq!(p.cache_read_tokens, 60);
        assert_eq!(p.output_tokens, 30);
        assert!(p.sessions.is_empty() && p.projects.is_empty());
        assert_eq!(
            s,
            RangeSummary {
                active_days: 2,
                current_streak: 1,
                active_time_ms: 90_000,
                peak_day_tokens: 100
            }
        );
    }

    #[test]
    fn company_ranges_use_the_live_company_today() {
        let mut today = crate::display::CompanyTotals {
            total_tokens: 500,
            cost_usd: 5.0,
            ..crate::display::CompanyTotals::default()
        };
        today.clients.insert("codex".into(), 500);
        let v = company_range(&history(), "2026-09-24", &today, RangeName::Last7, 1).unwrap();
        assert_eq!(v.totals.total_tokens, 600);
        assert_eq!(v.totals.clients["codex"], 500);
        assert_eq!(v.start, "2026-09-18");
    }

    #[test]
    fn a_smaller_live_today_keeps_the_history_row() {
        let (p, _) = derive_range(
            &history(),
            "2026-09-24",
            &live_today(1),
            "2026-09-24",
            "2026-09-24",
        )
        .unwrap();
        assert_eq!(p.total_tokens, 5);
        assert!(derive_range(&Value::Null, "2026-09-24", &live_today(1), "a", "b").is_none());
    }

    // ---- 逐台裝置 ----

    fn ms(iso: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(iso)
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn a_device_day_is_its_own_until_the_window_ends() {
        // 台北的 09-24 在 09-24T16:00Z 結束。
        let taipei = "2026-09-24T16:00:00.000Z";
        assert_eq!(
            device_day_state("2026-09-24", taipei, ms("2026-09-24T15:59:59.999Z")),
            Some(("2026-09-24".into(), "2026-09-24".into()))
        );
        // 過期：時差 +8 小時，現在是台北的哪一天。
        assert_eq!(
            device_day_state("2026-09-24", taipei, ms("2026-09-24T16:00:00.000Z")),
            Some(("2026-09-25".into(), "2026-09-24".into()))
        );
        assert_eq!(
            device_day_state("2026-09-24", taipei, ms("2026-09-26T15:59:00.000Z")),
            Some(("2026-09-26".into(), "2026-09-24".into())),
            "offline for two days"
        );
        // 紐約的冬天（UTC−5）：01-10 在 01-11T05:00Z 結束。
        let new_york = "2026-01-11T05:00:00.000Z";
        assert_eq!(
            device_day_state("2026-01-10", new_york, ms("2026-01-12T04:59:00.000Z")),
            Some(("2026-01-11".into(), "2026-01-10".into()))
        );
        assert_eq!(
            device_day_state("2026-01-10", new_york, ms("2026-01-12T05:00:00.000Z")),
            Some(("2026-01-12".into(), "2026-01-10".into()))
        );
        // 上游 normalizeDateKey 只看前 10 個字元。
        assert_eq!(
            device_day_state("2026-09-24T00:00:00", taipei, ms("2026-09-24T01:00:00Z")),
            Some(("2026-09-24".into(), "2026-09-24".into()))
        );
    }

    #[test]
    fn a_bad_day_key_or_end_gives_no_day() {
        let now = ms("2026-09-25T00:00:00Z");
        for (key, ends) in [
            ("", "2026-09-24T16:00:00.000Z"),
            ("2026-02-30", "2026-03-01T16:00:00.000Z"),
            ("20260924", "2026-09-24T16:00:00.000Z"),
            ("2026-09-24", ""),
            ("2026-09-24", "tomorrow"),
        ] {
            assert_eq!(device_day_state(key, ends, now), None, "{key} {ends}");
        }
        // 過期後才換算時差：推出的時差超過 14 小時代表 endsAt 不對，不猜。
        let later = ms("2026-09-27T00:00:00Z");
        assert_eq!(
            device_day_state("2026-09-24", "2026-09-26T00:00:00.000Z", later),
            None
        );
        assert_eq!(
            device_day_state("2026-09-24", "2026-09-24T10:00:00.000Z", later),
            Some(("2026-09-27".into(), "2026-09-24".into())),
            "UTC+14 is still a real offset"
        );
    }

    fn day(date: &str, tokens: f64, client: &str) -> Value {
        json!({ "date": date, "tokens": tokens, "cost": tokens / 1000.0, "activeTimeMs": 1000,
                "perClient": { client: { "tokens": tokens, "cost": tokens / 1000.0 } },
                "perModel": { "m1": { "tokens": tokens, "cost": tokens / 1000.0 } } })
    }

    fn live(tokens: i64, client: &str) -> Period {
        let mut p = Period {
            capabilities: crate::wire::Capabilities {
                token_components: false,
                throughput: false,
            },
            total_tokens: tokens,
            cost_usd: tokens as f64 / 1000.0,
            ..Period::default()
        };
        p.clients.insert(client.into(), tokens);
        p.client_costs.insert(client.into(), tokens as f64 / 1000.0);
        p.models.insert("m1".into(), tokens);
        p.model_costs.insert("m1".into(), tokens as f64 / 1000.0);
        p
    }

    struct Fixture {
        id: &'static str,
        today: Period,
        key: &'static str,
        ends: &'static str,
        history: Option<DeviceHistory>,
        live_usage: bool,
    }

    fn fixture(
        id: &'static str,
        today: i64,
        key: &'static str,
        ends: &'static str,
        daily: Option<Vec<Value>>,
    ) -> Fixture {
        Fixture {
            id,
            today: live(today, "claude"),
            key,
            ends,
            live_usage: today > 0,
            history: daily.map(|d| DeviceHistory::from_daily(&d)),
        }
    }

    fn sources(fixtures: &[Fixture]) -> Vec<DeviceRangeSource<'_>> {
        fixtures
            .iter()
            .map(|f| DeviceRangeSource {
                device_id: f.id,
                today: Cow::Borrowed(&f.today),
                live_usage: f.live_usage,
                today_key: Some(f.key),
                today_ends_at: Some(f.ends),
                history: f.history.as_ref(),
            })
            .collect()
    }

    // 觀看者的現在：台北 09-24 11:00。
    const NOW: &str = "2026-09-24T03:00:00.000Z";
    const TAIPEI_END: &str = "2026-09-24T16:00:00.000Z";

    #[test]
    fn the_company_range_is_the_sum_of_each_device_over_the_union_of_their_ranges() {
        let fixtures = [
            // 台北，今天的即時數字比 history 那一列大：換成即時的。
            fixture(
                "b",
                300,
                "2026-09-24",
                TAIPEI_END,
                Some(vec![
                    day("2026-09-20", 100.0, "claude"),
                    day("2026-09-24", 200.0, "claude"),
                ]),
            ),
            // 紐約（UTC−4，夏令時間）：它的今天還是 09-23，範圍晚一天結束。
            fixture(
                "a",
                40,
                "2026-09-23",
                "2026-09-24T04:00:00.000Z",
                Some(vec![
                    day("2026-09-17", 7.0, "codex"),
                    day("2026-09-23", 50.0, "antigravity-cli"),
                ]),
            ),
        ];
        let r = company_ranges(
            &sources(&fixtures),
            RangeName::Last7,
            1,
            "2026-09-24",
            ms(NOW),
        );
        let ids: Vec<(&str, DeviceRangeStatus)> = r
            .devices
            .iter()
            .map(|d| (d.device_id.as_str(), d.status))
            .collect();
        assert_eq!(
            ids,
            [
                ("a", DeviceRangeStatus::Ready),
                ("b", DeviceRangeStatus::Ready)
            ],
            "ordered by deviceId"
        );
        let a = &r.devices[0];
        assert_eq!(
            (a.start.as_str(), a.end.as_str()),
            ("2026-09-17", "2026-09-23")
        );
        // a 的今天（09-23）即時 40 < history 50：保留 history 那一列。
        assert_eq!(a.period.total_tokens, 57);
        assert_eq!(
            a.period.clients["antigravity"], 50,
            "antigravity-cli is folded"
        );
        assert!(!a.period.clients.contains_key("antigravity-cli"));
        let b = &r.devices[1];
        assert_eq!(
            (b.start.as_str(), b.end.as_str()),
            ("2026-09-18", "2026-09-24")
        );
        assert_eq!(b.period.total_tokens, 400, "09-20 history + the live 300");
        assert_eq!(
            (r.start.as_str(), r.end.as_str()),
            ("2026-09-17", "2026-09-24")
        );
        assert_eq!(r.period.total_tokens, 457);
        assert_eq!(r.period.clients["claude"], 400);
        assert_eq!(r.period.clients["codex"], 7);
        assert_eq!(r.period.clients["antigravity"], 50);
        assert_eq!(r.period.models["m1"], 457);
        assert!((r.period.cost_usd - 0.457).abs() < 1e-9);
        assert_eq!(
            r.summary,
            RangeSummary {
                active_days: 4,
                current_streak: 2,
                active_time_ms: 4000,
                peak_day_tokens: 300
            }
        );
    }

    #[test]
    fn an_expired_today_lands_on_its_own_day_and_the_range_ends_today() {
        // 三天前關機：它最後的 today（09-21）仍算在 09-21，範圍到台北的今天（09-24）。
        let fixtures = [fixture(
            "c",
            70,
            "2026-09-21",
            "2026-09-21T16:00:00.000Z",
            Some(vec![day("2026-09-19", 10.0, "claude")]),
        )];
        let r = company_ranges(
            &sources(&fixtures),
            RangeName::Last7,
            1,
            "2026-09-24",
            ms(NOW),
        );
        let c = &r.devices[0];
        assert_eq!(
            (c.start.as_str(), c.end.as_str()),
            ("2026-09-18", "2026-09-24")
        );
        assert_eq!(c.period.total_tokens, 80);
        assert_eq!(r.summary.current_streak, 0, "nothing since the 21st");
    }

    #[test]
    fn the_summary_comes_from_the_merged_rows_not_the_refilled_union() {
        // 一台的日期鍵在兩週後（時鐘不對）：兩台的範圍不相連，合併列在 09-24 之後直接跳到 10-04。
        let b_days: Vec<Value> = (4..=9)
            .map(|d| day(&format!("2026-10-{d:02}"), 1.0, "claude"))
            .collect();
        let fixtures = [
            fixture("a", 5, "2026-09-24", TAIPEI_END, Some(vec![])),
            fixture(
                "b",
                9,
                "2026-10-10",
                "2026-10-10T16:00:00.000Z",
                Some(b_days),
            ),
        ];
        let r = company_ranges(
            &sources(&fixtures),
            RangeName::Last7,
            1,
            "2026-09-24",
            ms(NOW),
        );
        assert_eq!(
            (r.start.as_str(), r.end.as_str()),
            ("2026-09-18", "2026-10-10")
        );
        assert_eq!(
            r.period.total_tokens, 20,
            "the period is summed over the refilled union"
        );
        assert_eq!(r.summary.active_days, 8);
        // b 的 7 天加上 a 的 09-24：合併列之間沒有補 0 的空白，所以連續 8 天（補滿聯集範圍的話是 7）。
        assert_eq!(r.summary.current_streak, 8);
    }

    #[test]
    fn idle_devices_with_history_are_left_out_and_devices_without_history_are_marked() {
        let mut idle = fixture(
            "idle",
            0,
            "2026-09-24",
            TAIPEI_END,
            Some(vec![day("2026-09-20", 0.0, "claude")]),
        );
        idle.live_usage = false;
        let mut old = fixture("old-history", 0, "2026-09-24", TAIPEI_END, Some(vec![]));
        // 只有 32 天以前才有用量：hub 送的列是空的，但 historyHasUsage 讓它參與。
        old.history = Some(DeviceHistory::from_window(&[], true));
        old.live_usage = false;
        // 即時全是 0、又沒有歷史（例如 allTimeSince 把前幾天的用量排除）：不能確定它沒用量，照樣標出來。
        let mut quiet = fixture("quiet-no-history", 0, "2026-09-24", TAIPEI_END, None);
        quiet.live_usage = false;
        let fixtures = [
            idle,
            old,
            quiet,
            fixture("no-history", 500, "2026-09-24", TAIPEI_END, None),
            fixture("ok", 20, "2026-09-24", TAIPEI_END, Some(vec![])),
            fixture("bad-key", 20, "2026-13-01", TAIPEI_END, Some(vec![])),
        ];
        let r = company_ranges(
            &sources(&fixtures),
            RangeName::Week,
            1,
            "2026-09-24",
            ms(NOW),
        );
        let ids: Vec<(&str, DeviceRangeStatus)> = r
            .devices
            .iter()
            .map(|d| (d.device_id.as_str(), d.status))
            .collect();
        assert_eq!(
            ids,
            [
                ("bad-key", DeviceRangeStatus::Unavailable),
                ("no-history", DeviceRangeStatus::Unavailable),
                ("ok", DeviceRangeStatus::Ready),
                ("old-history", DeviceRangeStatus::Ready),
                ("quiet-no-history", DeviceRangeStatus::Unavailable),
            ]
        );
        assert_eq!(
            r.period.total_tokens, 20,
            "the device without history is not counted"
        );
        assert_eq!(r.devices[3].period.total_tokens, 0);
        assert_eq!(
            (r.start.as_str(), r.end.as_str()),
            ("2026-09-21", "2026-09-24")
        );
        assert!(r.devices[0].start.is_empty());
    }

    #[test]
    fn no_ready_device_gives_zero_over_the_viewers_own_range() {
        let fixtures = [fixture("no-history", 500, "2026-09-24", TAIPEI_END, None)];
        for list in [&fixtures[..], &[]] {
            let r = company_ranges(&sources(list), RangeName::Last30, 1, "2026-09-24", ms(NOW));
            assert_eq!(
                (r.start.as_str(), r.end.as_str()),
                ("2026-08-26", "2026-09-24")
            );
            assert_eq!(r.period.total_tokens, 0);
            assert!(r.period.clients.is_empty());
            assert_eq!(r.summary, RangeSummary::default());
        }
    }

    fn stream_device(id: &str, today: f64, key: &str, ends: &str) -> crate::hub::stream::HubDevice {
        use crate::hub::stream::{
            HubDevice, SlimPeriod, SlimPeriodWindows, SlimPeriods, WindowEnd,
        };
        HubDevice {
            device_id: id.into(),
            hostname: id.to_uppercase(),
            period_windows: Some(SlimPeriodWindows {
                today: Some(WindowEnd {
                    ends_at: Some(ends.into()),
                    key: Some(key.into()),
                }),
                ..SlimPeriodWindows::default()
            }),
            periods: SlimPeriods {
                today: SlimPeriod {
                    total_tokens: today,
                    cost_usd: today / 1000.0,
                    clients: [("claude".to_string(), today)].into_iter().collect(),
                    ..SlimPeriod::default()
                },
                ..SlimPeriods::default()
            },
            ..HubDevice::default()
        }
    }

    fn local_record(history: Option<Value>, history_available: bool) -> DeviceRecord {
        let envelope = crate::wire::Envelope {
            device_id: "me".into(),
            hostname: "MY-PC".into(),
            ..crate::wire::Envelope::default()
        };
        let mut usage = crate::wire::UsageSummary {
            history_available,
            ..crate::wire::UsageSummary::default()
        };
        usage.today.total_tokens = 30;
        usage.today.clients.insert("codex".into(), 30);
        usage.period_windows.today.key = "2026-09-24".into();
        usage.period_windows.today.ends_at = TAIPEI_END.into();
        let history = history.map(std::sync::Arc::new);
        DeviceRecord::compose(&envelope, &usage, 600_000, history.as_ref(), None)
    }

    fn hub_history(rows: Vec<Value>) -> DeviceHistory {
        DeviceHistory::from_window(&rows, false)
    }

    #[test]
    fn sources_follow_the_stream_inventory_with_the_local_record_on_top() {
        let hub = HubStats {
            devices: vec![
                stream_device("me", 5.0, "2026-09-24", TAIPEI_END),
                stream_device("x", 100.0, "2026-09-24", TAIPEI_END),
                stream_device("missing", 50.0, "2026-09-24", TAIPEI_END),
            ],
            ..HubStats::default()
        };
        let histories: HashMap<String, DeviceHistory> = [
            (
                "me".to_string(),
                hub_history(vec![day("2026-09-22", 1000.0, "claude")]),
            ),
            (
                "x".to_string(),
                hub_history(vec![day("2026-09-22", 7.0, "claude")]),
            ),
            (
                "payload-only".to_string(),
                hub_history(vec![day("2026-09-22", 9.0, "claude")]),
            ),
        ]
        .into_iter()
        .collect();

        // record 帶了 history：用本機的。
        let record = local_record(
            Some(json!({ "daily": [day("2026-09-23", 2.0, "codex")] })),
            true,
        );
        let local = local_device_history(&record);
        let list = company_range_sources(&hub, Some(&record), &histories, local.as_ref());
        let ids: Vec<&str> = list.iter().map(|s| s.device_id).collect();
        assert_eq!(
            ids,
            ["x", "missing", "me"],
            "our hub row is replaced; payload-only devices are ignored"
        );
        assert_eq!(list[0].today.total_tokens, 100);
        assert_eq!(list[0].today_key, Some("2026-09-24"));
        assert!(list[0].live_usage);
        assert!(
            list[1].history.is_none(),
            "in the stream but not in the payload"
        );
        let r = company_ranges(&list, RangeName::Last7, 1, "2026-09-24", ms(NOW));
        let me = r.devices.iter().find(|d| d.device_id == "me").unwrap();
        assert_eq!(
            me.period.total_tokens, 32,
            "the local history and the local today"
        );
        assert_eq!(
            r.devices
                .iter()
                .find(|d| d.device_id == "missing")
                .unwrap()
                .status,
            DeviceRangeStatus::Unavailable
        );

        // record 沒帶 history：沿用 hub 上的那份。
        let record = local_record(None, true);
        let list = company_range_sources(&hub, Some(&record), &histories, None);
        let r = company_ranges(&list, RangeName::Last7, 1, "2026-09-24", ms(NOW));
        let me = r.devices.iter().find(|d| d.device_id == "me").unwrap();
        assert_eq!(me.period.total_tokens, 1030);

        // history 關閉（null），或 record 說沒有可用的歷史：沒有歷史。
        for record in [
            local_record(Some(Value::Null), true),
            local_record(None, false),
        ] {
            let local = local_device_history(&record);
            assert!(local.is_none());
            let list = company_range_sources(&hub, Some(&record), &histories, local.as_ref());
            let r = company_ranges(&list, RangeName::Last7, 1, "2026-09-24", ms(NOW));
            let me = r.devices.iter().find(|d| d.device_id == "me").unwrap();
            assert_eq!(me.status, DeviceRangeStatus::Unavailable);
        }
    }

    #[test]
    fn device_history_counts_usage_in_the_whole_history() {
        let h =
            DeviceHistory::from_daily(&[json!({ "date": "2025-01-01", "tokens": 0, "cost": 0.5 })]);
        assert!(h.has_usage, "cost alone counts");
        assert!(
            !DeviceHistory::from_daily(&[json!({ "date": "2025-01-01", "tokens": 0 })]).has_usage
        );
        assert!(DeviceHistory::from_window(&[], true).has_usage);
        assert!(!DeviceHistory::from_window(&[], false).has_usage);
    }
}
