//! 本星期／最近 7 日／最近 30 日（上游 renderer fixedPeriodRanges.js）：由每日歷史推出的期間。
//!
//! tokscale 只給 today / month / allTime，其他範圍都從 history 的每日列加總：範圍兩端都含、以裝置
//! 本地的日期鍵計算，沒有用量的日子補 0；今天那一列換成即時的 today（即時數字不小於 history 裡的
//! 那一列時才換，上游 `dailyWithLiveToday`）。推出的期間只有工具與模型的拆分與 token 組成，沒有
//! session、專案與速率計數（上游 `derivePeriod`）。

use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::usage::history::day_key_add_days;
use crate::wire::period::{add_cost, add_count};
use crate::wire::{CountMap, Period};

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
    let mut by_date: IndexMap<String, Row> = daily
        .iter()
        .filter_map(row_from)
        .map(|r| (r.date.clone(), r))
        .collect();
    let live = row_from_live(today, today_key, by_date.get(today_key));
    match by_date.get(today_key) {
        Some(prev) if live.tokens < prev.tokens => {}
        _ => {
            by_date.insert(today_key.to_string(), live);
        }
    }

    let mut rows: Vec<Row> = Vec::new();
    let mut date = start.to_string();
    while date.as_str() <= end {
        rows.push(by_date.get(&date).cloned().unwrap_or(Row {
            date: date.clone(),
            components_available: true,
            ..Row::default()
        }));
        match day_key_add_days(&date, 1) {
            Some(next) => date = next,
            None => break,
        }
    }

    let mut p = Period::default();
    p.capabilities.token_components = rows.iter().all(|r| r.components_available);
    p.capabilities.throughput = false;
    let (mut total, mut cost, mut cr, mut cw, mut out, mut uncl) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    let mut clients: IndexMap<String, Part> = IndexMap::new();
    let mut models: IndexMap<String, Part> = IndexMap::new();
    let add = |into: &mut IndexMap<String, Part>, key: &str, v: &Part| {
        let e = into.entry(key.to_string()).or_default();
        e.tokens += v.tokens;
        e.cost += v.cost;
        e.cache_read += v.cache_read;
        e.cache_write += v.cache_write;
        e.output += v.output;
        e.unclassified += v.unclassified;
    };
    for r in &rows {
        total += r.tokens;
        cost += r.cost;
        cr += r.cache_read;
        cw += r.cache_write;
        out += r.output;
        uncl += r.unclassified;
        for (client, v) in &r.per_client {
            let key = if client == "antigravity-cli" {
                "antigravity"
            } else {
                client.as_str()
            };
            add(&mut clients, key, v);
        }
        for (model, v) in &r.per_model {
            add(&mut models, model, v);
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

    let mut streak = 0;
    for r in rows.iter().rev() {
        if r.tokens > 0.0 {
            streak += 1;
        } else {
            break;
        }
    }
    let summary = RangeSummary {
        active_days: rows.iter().filter(|r| r.tokens > 0.0).count() as i64,
        current_streak: streak,
        active_time_ms: rows.iter().map(|r| r.active_time_ms).sum::<f64>().round() as i64,
        peak_day_tokens: rows.iter().fold(0.0_f64, |m, r| m.max(r.tokens)).round() as i64,
    };
    Some((p, summary))
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
}
