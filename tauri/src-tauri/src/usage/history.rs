//! 用量歷史：`tokscale graph` 的輸出 → hub 的 `history`（上游 src/shared/history.js 的
//! `parseGraphResult` + `normalizeHistory`）。純函式，不做 I/O。
//!
//! 三層：
//! - `daily`：以 `todayKey` 結尾的 370 天，每天含 perClient / perModel 與強度（0–4）。
//! - `monthly`：**全部**月份（不受 370 天限制），lifetime 總數才不會縮水。
//! - `summary`：總數、連續天數、最常用的模型與 tokscale 的 timeMetrics。
//!
//! hub 收到 `history` 會**整份取代**舊的，所以每次都要送完整的三層。

use indexmap::IndexMap;
use serde_json::{Map, Value};

use super::js::{as_number, first_truthy_string, to_js_string, truthy};

/// 上游 `DEFAULT_CAP_DAYS`。
pub const HISTORY_CAP_DAYS: i64 = 370;

/// 上游 `TOKSCALE_CLIENT_ALIASES`：刻意只收 tokscale 的原始 id 別名，不做產品名稱推測。
const CLIENT_ALIASES: &[(&str, &str)] = &[
    ("antigravity-cli", "antigravity"),
    ("micode", "mimo"),
    ("micode-desktop", "mimo"),
    ("omp", "pi"),
    ("kilocode", "kilo"),
    ("devin-cli", "devin"),
    ("devin-desktop", "devin"),
];

/// tokscale 把這幾個工具的 reasoning 放在獨立的欄位；history 與 usage.js 一樣把它算進 output。
const DISJOINT_REASONING_CLIENTS: &[&str] = &["reasonix", "codex", "droid", "dsh"];

const REASONIX_CLIENT: &str = "reasonix";

/// 上游 `normalizeTokscaleClientName`。
pub fn normalize_tokscale_client_name(value: Option<&Value>) -> Option<String> {
    let raw = match value {
        Some(v) if truthy(v) => to_js_string(v).trim().to_lowercase(),
        _ => String::new(),
    };
    if raw.is_empty() {
        return None;
    }
    Some(
        CLIENT_ALIASES
            .iter()
            .find(|(from, _)| *from == raw)
            .map(|(_, to)| to.to_string())
            .unwrap_or(raw),
    )
}

fn has_disjoint_reasoning(client: &str) -> bool {
    DISJOINT_REASONING_CLIENTS.contains(&client.trim().to_lowercase().as_str())
}

fn num(v: Option<&Value>) -> f64 {
    v.map(as_number).unwrap_or(0.0)
}

/// JS 的 `a ?? b`：`a` 不存在或是 null 時取 `b`。
fn nullish<'a>(obj: Option<&'a Map<String, Value>>, a: &str, b: &str) -> Option<&'a Value> {
    let obj = obj?;
    match obj.get(a) {
        Some(Value::Null) | None => obj.get(b),
        some => some,
    }
}

/// 上游的 `typeof x === 'object'`（陣列也算，但取不到任何鍵）。
fn as_object_like(v: Option<&Value>) -> Option<&Map<String, Value>> {
    static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
    match v {
        Some(Value::Object(m)) => Some(m),
        Some(Value::Array(_)) => Some(EMPTY.get_or_init(Map::new)),
        _ => None,
    }
}

fn sum_tokens(breakdown: Option<&Value>, client: &str) -> f64 {
    let Some(b) = as_object_like(breakdown) else {
        return 0.0;
    };
    num(b.get("input"))
        + num(b.get("output"))
        + num(b.get("cacheRead"))
        + num(b.get("cacheWrite"))
        + if has_disjoint_reasoning(client) {
            num(b.get("reasoning"))
        } else {
            0.0
        }
}

fn sum_output_tokens(breakdown: Option<&Value>, client: &str) -> f64 {
    let Some(b) = as_object_like(breakdown) else {
        return 0.0;
    };
    num(b.get("output"))
        + if has_disjoint_reasoning(client) {
            num(b.get("reasoning"))
        } else {
            0.0
        }
}

/// 整數值輸出成 JSON 整數（與 JS `JSON.stringify` 相同），其餘照浮點數。
pub(crate) fn jnum(f: f64) -> Value {
    if f.is_finite() && f == f.trunc() && f.abs() < 9_007_199_254_740_992.0 {
        Value::from(f as i64)
    } else {
        serde_json::Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or(Value::from(0))
    }
}

/// 每天、每個 client 或 model 的 token 組成。`None` = 上游沒有設這個鍵（> 0 才設）。
#[derive(Debug, Clone, Default, PartialEq)]
struct Parts {
    cache_read: Option<f64>,
    cache_write: Option<f64>,
    output: Option<f64>,
}

impl Parts {
    fn add(&mut self, cache_read: f64, cache_write: f64, output: f64) {
        if cache_read > 0.0 {
            self.cache_read = Some(self.cache_read.unwrap_or(0.0) + cache_read);
        }
        if cache_write > 0.0 {
            self.cache_write = Some(self.cache_write.unwrap_or(0.0) + cache_write);
        }
        if output > 0.0 {
            self.output = Some(self.output.unwrap_or(0.0) + output);
        }
    }

    fn write(&self, obj: &mut Map<String, Value>) {
        for (key, v) in [
            ("cacheReadTokens", self.cache_read),
            ("cacheWriteTokens", self.cache_write),
            ("outputTokens", self.output),
        ] {
            if let Some(v) = v {
                obj.insert(key.into(), jnum(v));
            }
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
struct ClientDay {
    tokens: f64,
    cost: f64,
    messages: f64,
    unclassified: f64,
    parts: Parts,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct ModelDay {
    tokens: f64,
    cost: f64,
    unclassified: f64,
    parts: Parts,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct TimeMetrics {
    total_active_time_ms: f64,
    longest_continuous_ms: f64,
    max_concurrent_sessions: f64,
    session_count: f64,
}

impl TimeMetrics {
    fn parse(v: Option<&Value>) -> Option<TimeMetrics> {
        let m = as_object_like(v);
        let m = m?;
        let pick = |a: &str, b: &str| num(nullish(Some(m), a, b));
        Some(TimeMetrics {
            total_active_time_ms: pick("totalActiveTimeMs", "total_active_time_ms"),
            longest_continuous_ms: pick("longestContinuousMs", "longest_continuous_ms"),
            max_concurrent_sessions: pick("maxConcurrentSessions", "max_concurrent_sessions"),
            session_count: pick("sessionCount", "session_count"),
        })
    }

    fn to_value(self) -> Value {
        let mut o = Map::new();
        o.insert("totalActiveTimeMs".into(), jnum(self.total_active_time_ms));
        o.insert(
            "longestContinuousMs".into(),
            jnum(self.longest_continuous_ms),
        );
        o.insert(
            "maxConcurrentSessions".into(),
            jnum(self.max_concurrent_sessions),
        );
        o.insert("sessionCount".into(), jnum(self.session_count));
        Value::Object(o)
    }
}

/// `parseGraphResult` 的一天。
#[derive(Debug, Clone, Default, PartialEq)]
struct Day {
    date: String,
    tokens: f64,
    cost: f64,
    messages: f64,
    cache_read: f64,
    cache_write: f64,
    output: f64,
    unclassified: f64,
    components_available: bool,
    active_time_ms: f64,
    per_client: IndexMap<String, ClientDay>,
    per_model: IndexMap<String, ModelDay>,
}

impl Day {
    fn to_value(&self, intensities: Option<(u8, u8)>) -> Value {
        let mut o = Map::new();
        o.insert("date".into(), Value::String(self.date.clone()));
        o.insert("tokens".into(), jnum(self.tokens));
        o.insert("cost".into(), jnum(self.cost));
        o.insert("messages".into(), jnum(self.messages));
        o.insert("cacheReadTokens".into(), jnum(self.cache_read));
        o.insert("cacheWriteTokens".into(), jnum(self.cache_write));
        o.insert("outputTokens".into(), jnum(self.output));
        o.insert("unclassifiedTokens".into(), jnum(self.unclassified));
        o.insert(
            "tokenComponentsAvailable".into(),
            Value::Bool(self.components_available),
        );
        o.insert("activeTimeMs".into(), jnum(self.active_time_ms));
        let clients: Map<String, Value> = self
            .per_client
            .iter()
            .map(|(k, c)| {
                let mut e = Map::new();
                e.insert("tokens".into(), jnum(c.tokens));
                e.insert("cost".into(), jnum(c.cost));
                e.insert("messages".into(), jnum(c.messages));
                e.insert("unclassifiedTokens".into(), jnum(c.unclassified));
                c.parts.write(&mut e);
                (k.clone(), Value::Object(e))
            })
            .collect();
        o.insert("perClient".into(), Value::Object(clients));
        let models: Map<String, Value> = self
            .per_model
            .iter()
            .map(|(k, m)| {
                let mut e = Map::new();
                e.insert("tokens".into(), jnum(m.tokens));
                e.insert("cost".into(), jnum(m.cost));
                e.insert("unclassifiedTokens".into(), jnum(m.unclassified));
                m.parts.write(&mut e);
                (k.clone(), Value::Object(e))
            })
            .collect();
        o.insert("perModel".into(), Value::Object(models));
        if let Some((token, cost)) = intensities {
            o.insert("tokenIntensity".into(), Value::from(token));
            o.insert("costIntensity".into(), Value::from(cost));
            o.insert("intensity".into(), Value::from(cost));
        }
        Value::Object(o)
    }
}

/// `parseGraphResult` 的輸出。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Graph {
    days: Vec<Day>,
    time_metrics: Option<TimeMetrics>,
}

struct ComponentValues {
    cache_read: f64,
    cache_write: f64,
    output: f64,
    unclassified: f64,
}

/// 上游 `componentValues`。
fn component_values(
    value: Option<&Map<String, Value>>,
    total: f64,
    exact: bool,
) -> Option<ComponentValues> {
    let get = |k: &str| num(value.and_then(|v| v.get(k)));
    let cache_read = get("cacheReadTokens").max(0.0);
    let cache_write = get("cacheWriteTokens").max(0.0);
    let output = get("outputTokens").max(0.0);
    if cache_read + cache_write + output > total {
        return None;
    }
    let remainder = total - cache_read - cache_write - output;
    let explicit = match value.and_then(|v| v.get("unclassifiedTokens")) {
        Some(Value::Null) | None => None,
        Some(v) => Some(as_number(v)),
    };
    let unclassified = remainder.min(
        explicit
            .unwrap_or(if exact { 0.0 } else { remainder })
            .max(0.0),
    );
    Some(ComponentValues {
        cache_read,
        cache_write,
        output,
        unclassified,
    })
}

/// 上游 `applyComponentSummary`：tokscale 對這天另外給了權威的 token 組成時，取代逐列累加的值。
fn apply_component_summary(day: &mut Day, summary: Option<&Value>) {
    let Some(summary) = as_object_like(summary) else {
        return;
    };
    let exact = summary.get("tokenComponentsAvailable") == Some(&Value::Bool(true));
    let Some(totals) = component_values(Some(summary), day.tokens, exact) else {
        return;
    };
    let section = |name: &str, key: &str| {
        as_object_like(summary.get(name)).and_then(|m| as_object_like(m.get(key)))
    };
    let mut clients = Vec::new();
    for (key, c) in &day.per_client {
        match component_values(section("perClient", key), c.tokens, exact) {
            Some(v) => clients.push(v),
            None => return,
        }
    }
    let mut models = Vec::new();
    for (key, m) in &day.per_model {
        match component_values(section("perModel", key), m.tokens, exact) {
            Some(v) => models.push(v),
            None => return,
        }
    }
    day.cache_read = totals.cache_read;
    day.cache_write = totals.cache_write;
    day.output = totals.output;
    day.unclassified = totals.unclassified;
    let mut available = day.unclassified == 0.0;
    for (c, v) in day.per_client.values_mut().zip(clients) {
        c.parts = Parts {
            cache_read: Some(v.cache_read),
            cache_write: Some(v.cache_write),
            output: Some(v.output),
        };
        c.unclassified = v.unclassified;
        available = available && c.unclassified == 0.0;
    }
    for (m, v) in day.per_model.values_mut().zip(models) {
        m.parts = Parts {
            cache_read: Some(v.cache_read),
            cache_write: Some(v.cache_write),
            output: Some(v.output),
        };
        m.unclassified = v.unclassified;
        available = available && m.unclassified == 0.0;
    }
    day.components_available = available;
}

/// 上游 `parseGraphResult`：每天的總數一定等於 perClient 與 perModel 各自的加總。
pub fn parse_graph_result(raw: &Value) -> Graph {
    let rows = raw
        .get("contributions")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut days = Vec::new();
    for row in rows {
        let Some(row_obj) = as_object_like(Some(row)) else {
            continue;
        };
        let date: String = first_truthy_string(row_obj, &["date"])
            .chars()
            .take(10)
            .collect();
        if date.is_empty() {
            continue;
        }
        let mut day = Day {
            date,
            components_available: true,
            ..Day::default()
        };
        let client_rows = row_obj
            .get("clients")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        for c in client_rows {
            let Some(c) = as_object_like(Some(c)) else {
                continue;
            };
            let client =
                normalize_tokscale_client_name(c.get("client")).unwrap_or_else(|| "unknown".into());
            let model = {
                let m = first_truthy_string(c, &["modelId", "model", "model_id"]);
                if m.is_empty() {
                    "unknown".to_string()
                } else {
                    m
                }
            };
            let tokens_obj = c.get("tokens");
            let tokens_map = as_object_like(tokens_obj);
            let t = sum_tokens(tokens_obj, &client);
            let cst = num(c.get("cost"));
            let cache_read = num(nullish(tokens_map, "cacheRead", "cache_read"));
            let cache_write = num(nullish(tokens_map, "cacheWrite", "cache_write"));
            let output = sum_output_tokens(tokens_obj, &client);
            let components_available =
                c.get("tokenComponentsAvailable") != Some(&Value::Bool(false));
            let explicit_unclassified =
                c.contains_key("unclassifiedTokens") || c.contains_key("unclassified_tokens");
            let unclassified = t.min(
                if explicit_unclassified {
                    num(nullish(
                        Some(c),
                        "unclassifiedTokens",
                        "unclassified_tokens",
                    ))
                } else if t > 0.0 && !components_available {
                    t
                } else {
                    0.0
                }
                .max(0.0),
            );
            // Reasonix 的 messages 是 provider 的請求數，不是使用者的回合數。
            let msg = if client.trim() == REASONIX_CLIENT {
                0.0
            } else {
                num(c.get("messages"))
            };
            day.tokens += t;
            day.cost += cst;
            day.messages += msg;
            day.cache_read += cache_read;
            day.cache_write += cache_write;
            day.output += output;
            day.unclassified += unclassified;
            day.components_available = day.components_available
                && (t == 0.0 || (components_available && unclassified == 0.0));
            let pc = day.per_client.entry(client).or_default();
            pc.tokens += t;
            pc.cost += cst;
            pc.messages += msg;
            pc.parts.add(cache_read, cache_write, output);
            pc.unclassified += unclassified;
            let pm = day.per_model.entry(model).or_default();
            pm.tokens += t;
            pm.cost += cst;
            pm.parts.add(cache_read, cache_write, output);
            pm.unclassified += unclassified;
        }
        apply_component_summary(&mut day, row_obj.get("tokenComponentSummary"));
        day.active_time_ms = num(nullish(Some(row_obj), "activeTimeMs", "active_time_ms"));
        days.push(day);
    }
    let time_metrics = TimeMetrics::parse(match raw.get("timeMetrics") {
        Some(Value::Null) | None => raw.get("time_metrics"),
        some => some,
    });
    Graph { days, time_metrics }
}

fn intensity_bucket(value: f64, max: f64) -> u8 {
    if max <= 0.0 {
        return 0;
    }
    let ratio = value / max;
    if ratio >= 0.75 {
        4
    } else if ratio >= 0.5 {
        3
    } else if ratio >= 0.25 {
        2
    } else if ratio > 0.0 {
        1
    } else {
        0
    }
}

/// 上游 `dayKeyAddDays`（UTC 日曆運算）。
pub fn day_key_add_days(key: &str, delta: i64) -> Option<String> {
    let date = chrono::NaiveDate::parse_from_str(key.get(..10)?, "%Y-%m-%d").ok()?;
    Some(
        (date + chrono::Duration::days(delta))
            .format("%Y-%m-%d")
            .to_string(),
    )
}

/// 上游 `computeStreaks`：有 token 的日子才算；current 從 `todayKey` 往回數（今天沒用就是 0）。
fn compute_streaks(days: &[&Day], today_key: &str) -> (u64, u64) {
    let active: std::collections::BTreeSet<&str> = days
        .iter()
        .filter(|d| d.tokens > 0.0)
        .map(|d| d.date.get(..10).unwrap_or(&d.date))
        .collect();
    let mut current = 0;
    let mut cursor = today_key.get(..10).unwrap_or(today_key).to_string();
    while active.contains(cursor.as_str()) {
        current += 1;
        match day_key_add_days(&cursor, -1) {
            Some(prev) => cursor = prev,
            None => break,
        }
    }
    let (mut longest, mut run) = (0, 0);
    let mut prev: Option<&str> = None;
    for key in &active {
        let consecutive = prev.and_then(|p| day_key_add_days(p, 1)).as_deref() == Some(*key);
        run = if consecutive { run + 1 } else { 1 };
        longest = longest.max(run);
        prev = Some(key);
    }
    (current, longest)
}

/// `normalizeHistory` 的結果。`None` = graph 裡一天都沒有（上游不送這個欄位）。
pub fn normalize_history(graph: &Graph, today_key: &str) -> Option<Value> {
    let today_key: String = today_key.chars().take(10).collect();
    let mut full: Vec<&Day> = graph.days.iter().collect();
    full.sort_by(|a, b| a.date.cmp(&b.date));

    let start_key = day_key_add_days(&today_key, -(HISTORY_CAP_DAYS - 1)).unwrap_or_default();
    let daily_days: Vec<&Day> = full
        .iter()
        .copied()
        .filter(|d| {
            let key = d.date.get(..10).unwrap_or(&d.date);
            key >= start_key.as_str() && key <= today_key.as_str()
        })
        .collect();
    let max_tokens = daily_days.iter().fold(0.0_f64, |m, d| m.max(d.tokens));
    let max_cost = daily_days.iter().fold(0.0_f64, |m, d| m.max(d.cost));
    let daily: Vec<Value> = daily_days
        .iter()
        .map(|d| {
            d.to_value(Some((
                intensity_bucket(d.tokens, max_tokens),
                intensity_bucket(d.cost, max_cost),
            )))
        })
        .collect();

    let monthly = monthly_rollup(&full);
    if daily.is_empty() && monthly.is_empty() {
        return None;
    }

    let total_tokens: f64 = full.iter().fold(0.0, |s, d| s + d.tokens);
    let total_cost: f64 = full.iter().fold(0.0, |s, d| s + d.cost);
    let messages: f64 = full.iter().fold(0.0, |s, d| s + d.messages);
    let active_days = full.iter().filter(|d| d.tokens > 0.0).count();
    let peak = full.iter().fold(0.0_f64, |m, d| m.max(d.tokens));
    let (current, longest) = compute_streaks(&full, &today_key);
    let active_time_ms = match graph.time_metrics {
        Some(tm) => tm.total_active_time_ms,
        None => full.iter().fold(0.0, |s, d| s + d.active_time_ms),
    };

    let mut summary = Map::new();
    summary.insert("totalTokens".into(), jnum(total_tokens));
    summary.insert("totalCost".into(), jnum(total_cost));
    summary.insert("activeDays".into(), Value::from(active_days as u64));
    summary.insert("currentStreak".into(), Value::from(current));
    summary.insert("longestStreak".into(), Value::from(longest));
    summary.insert("peakDayTokens".into(), jnum(peak));
    summary.insert("favoriteModel".into(), Value::String(favorite_model(&full)));
    summary.insert("messages".into(), jnum(messages));
    summary.insert("activeTimeMs".into(), jnum(active_time_ms));
    if let Some(tm) = graph.time_metrics {
        summary.insert("timeMetrics".into(), tm.to_value());
    }

    let mut out = Map::new();
    out.insert("daily".into(), Value::Array(daily));
    out.insert("monthly".into(), Value::Array(monthly));
    out.insert("summary".into(), Value::Object(summary));
    Some(Value::Object(out))
}

/// 上游 `favoriteModelOf`：token 最多的模型，平手取先出現的。
fn favorite_model(days: &[&Day]) -> String {
    let mut totals: IndexMap<&str, f64> = IndexMap::new();
    for d in days {
        for (model, m) in &d.per_model {
            *totals.entry(model.as_str()).or_insert(0.0) += m.tokens;
        }
    }
    let mut best = "";
    let mut best_tokens = -1.0;
    for (model, t) in totals {
        if t > best_tokens {
            best = model;
            best_tokens = t;
        }
    }
    best.to_string()
}

/// 上游 `monthlyRollup`（只帶 tokens / cost / messages，不帶 token 組成）。
fn monthly_rollup(days: &[&Day]) -> Vec<Value> {
    struct Month {
        tokens: f64,
        cost: f64,
        active_time_ms: f64,
        clients: IndexMap<String, (f64, f64, f64)>,
        models: IndexMap<String, (f64, f64)>,
    }
    let mut by_month: IndexMap<String, Month> = IndexMap::new();
    for d in days {
        let Some(month) = d.date.get(..7).filter(|m| m.chars().count() == 7) else {
            continue;
        };
        let m = by_month.entry(month.to_string()).or_insert_with(|| Month {
            tokens: 0.0,
            cost: 0.0,
            active_time_ms: 0.0,
            clients: IndexMap::new(),
            models: IndexMap::new(),
        });
        m.tokens += d.tokens;
        m.cost += d.cost;
        m.active_time_ms += d.active_time_ms;
        for (client, c) in &d.per_client {
            let key = normalize_tokscale_client_name(Some(&Value::String(client.clone())))
                .unwrap_or_else(|| client.clone());
            let e = m.clients.entry(key).or_insert((0.0, 0.0, 0.0));
            e.0 += c.tokens;
            e.1 += c.cost;
            e.2 += c.messages;
        }
        for (model, v) in &d.per_model {
            let e = m.models.entry(model.clone()).or_insert((0.0, 0.0));
            e.0 += v.tokens;
            e.1 += v.cost;
        }
    }
    let mut months: Vec<(String, Month)> = by_month.into_iter().collect();
    months.sort_by(|a, b| a.0.cmp(&b.0));
    months
        .into_iter()
        .map(|(month, m)| {
            let mut o = Map::new();
            o.insert("month".into(), Value::String(month));
            o.insert("tokens".into(), jnum(m.tokens));
            o.insert("cost".into(), jnum(m.cost));
            o.insert("activeTimeMs".into(), jnum(m.active_time_ms));
            let clients: Map<String, Value> = m
                .clients
                .into_iter()
                .map(|(k, (t, c, msg))| {
                    let mut e = Map::new();
                    e.insert("tokens".into(), jnum(t));
                    e.insert("cost".into(), jnum(c));
                    e.insert("messages".into(), jnum(msg));
                    (k, Value::Object(e))
                })
                .collect();
            o.insert("perClient".into(), Value::Object(clients));
            let models: Map<String, Value> = m
                .models
                .into_iter()
                .map(|(k, (t, c))| {
                    let mut e = Map::new();
                    e.insert("tokens".into(), jnum(t));
                    e.insert("cost".into(), jnum(c));
                    (k, Value::Object(e))
                })
                .collect();
            o.insert("perModel".into(), Value::Object(models));
            Value::Object(o)
        })
        .collect()
}

/// graph JSON → hub 的 `history`（`None` = 沒有任何一天，不送）。
pub fn history_from_graph(raw: &Value, today_key: &str) -> Option<Value> {
    normalize_history(&parse_graph_result(raw), today_key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 上游 tests/shared/history.test.js 的 SAMPLE。
    fn sample() -> Value {
        json!({
            "contributions": [{
                "date": "2026-06-06",
                "clients": [
                    { "client": "claude", "modelId": "claude-opus-4-7",
                      "tokens": { "input": 10, "output": 5, "cacheRead": 10, "cacheWrite": 5, "reasoning": 99 },
                      "cost": 1.5, "messages": 3 },
                    { "client": "codex", "modelId": "gpt-5",
                      "tokens": { "input": 4, "output": 2, "cacheRead": 0, "cacheWrite": 0, "reasoning": 4 },
                      "cost": 0.5, "messages": 1 }
                ],
                "activeTimeMs": 1000
            }]
        })
    }

    #[test]
    fn day_totals_follow_client_reasoning_rules() {
        let h = history_from_graph(&sample(), "2026-06-06").unwrap();
        let day = &h["daily"][0];
        assert_eq!(
            day["tokens"], 40,
            "claude 30 without reasoning + codex 10 with it"
        );
        assert_eq!(day["perClient"]["claude"]["tokens"], 30);
        assert_eq!(day["perClient"]["codex"]["outputTokens"], 6);
        assert!(day["perClient"]["codex"].get("cacheReadTokens").is_none());
        assert_eq!(day["cost"], 2.0);
        assert_eq!(day["tokenComponentsAvailable"], true);
        assert_eq!(day["intensity"], 4);
        assert_eq!(h["summary"]["currentStreak"], 1);
        assert_eq!(h["summary"]["favoriteModel"], "claude-opus-4-7");
        assert_eq!(h["monthly"][0]["month"], "2026-06");
        assert_eq!(h["monthly"][0]["perClient"]["codex"]["messages"], 1);
    }

    #[test]
    fn daily_tier_is_capped_but_lifetime_is_not() {
        let row = |date: &str| json!({ "date": date, "clients": [{ "client": "claude", "modelId": "m", "tokens": { "input": 1 } }] });
        let graph =
            json!({ "contributions": [row("2024-01-01"), row("2026-09-23"), row("2026-09-24")] });
        let h = history_from_graph(&graph, "2026-09-24").unwrap();
        assert_eq!(h["daily"].as_array().unwrap().len(), 2);
        assert_eq!(h["monthly"].as_array().unwrap().len(), 2);
        assert_eq!(h["summary"]["totalTokens"], 3);
        assert_eq!(h["summary"]["currentStreak"], 2);
        assert_eq!(h["summary"]["longestStreak"], 2);
    }

    #[test]
    fn aliases_unknowns_and_reasonix_messages() {
        let graph = json!({ "contributions": [{ "date": "2026-09-24", "clients": [
            { "client": "Antigravity-CLI", "model": "g", "tokens": { "input": 2 }, "messages": 1 },
            { "tokens": { "input": 1 }, "messages": 1 },
            { "client": "reasonix", "modelId": "r", "tokens": { "input": 1 }, "messages": 9 }
        ] }] });
        let h = history_from_graph(&graph, "2026-09-24").unwrap();
        let clients = h["daily"][0]["perClient"].as_object().unwrap();
        assert_eq!(
            clients.keys().collect::<Vec<_>>(),
            ["antigravity", "unknown", "reasonix"]
        );
        assert_eq!(h["daily"][0]["perModel"]["unknown"]["tokens"], 1);
        assert_eq!(h["daily"][0]["messages"], 2);
    }

    #[test]
    fn empty_graph_is_not_a_history() {
        assert!(history_from_graph(&json!({ "contributions": [] }), "2026-09-24").is_none());
        assert!(history_from_graph(&json!({}), "2026-09-24").is_none());
    }

    #[test]
    fn component_summary_overrides_accumulated_parts() {
        let graph = json!({ "contributions": [{ "date": "2026-09-24",
            "clients": [{ "client": "claude", "modelId": "m", "tokens": { "input": 10, "output": 10 }, "tokenComponentsAvailable": false }],
            "tokenComponentSummary": { "tokenComponentsAvailable": true, "outputTokens": 10, "cacheReadTokens": 0, "cacheWriteTokens": 0,
                "perClient": { "claude": { "outputTokens": 10 } }, "perModel": { "m": { "outputTokens": 10 } } } }] });
        let h = history_from_graph(&graph, "2026-09-24").unwrap();
        let day = &h["daily"][0];
        assert_eq!(day["unclassifiedTokens"], 0);
        assert_eq!(day["tokenComponentsAvailable"], true);
        assert_eq!(day["perClient"]["claude"]["cacheReadTokens"], 0);
    }
}
