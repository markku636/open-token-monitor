//! daily history archive（上游 src/shared/dailyHistoryArchive.js）：client 刪掉舊紀錄後，history 的
//! 日子不跟著消失。
//!
//! hub 每次收到 history 都**整份取代**；tokscale graph 讀不到被刪掉的 transcript，那些日子就會從
//! 上傳的 history 裡消失，hub 的熱力圖跟著少一塊。archive 以「日期 × (client, 模型)」記住每一筆
//! 觀測，同一格只在 token（其次 messages）不變少時才換成新的；之後的 graph 以 archive 重建。
//!
//! - 與上游相同，只在 session usage archive 開啟時啟用（agent.js `dailyHistoryArchiveEnabled`）。
//! - 沒移植：即時的今日列（`liveDays`：今天 = max(graph, 即時 today)）與 Cursor 成本對帳。
//! - 觀測的 token 已經含 reasoning（與 history.rs 同一個規則），重建的 graph 把 reasoning 設 0，
//!   input 取剩下的部分，所以 `parseGraphResult` 算出來的總數不變。

use std::path::Path;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::history::normalize_tokscale_client_name;
use super::js::{as_number, first_truthy_string};
use crate::error::{AppError, AppResult};

pub const HISTORY_ARCHIVE_FILE: &str = "daily-history-archive.json";

const DISJOINT_REASONING_CLIENTS: &[&str] = &["reasonix", "codex", "droid", "dsh"];

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub client: String,
    pub model_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub provider_id: String,
    pub tokens: i64,
    pub cost: f64,
    pub messages: i64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub unclassified_tokens: i64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub token_components_available: bool,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub cache_read_tokens: i64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub cache_write_tokens: i64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub output_tokens: i64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub reasoning_tokens: i64,
}

fn is_zero(v: &i64) -> bool {
    *v == 0
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedDay {
    pub date: String,
    pub active_time_ms: i64,
    /// key = `["client","model"]`（上游 `observationKey`）。
    pub observations: IndexMap<String, Observation>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HistoryArchive {
    pub version: u32,
    pub days: IndexMap<String, ArchivedDay>,
}

fn valid_day(s: &str) -> bool {
    s.len() == 10 && chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}

fn round0(v: f64) -> i64 {
    if v.is_finite() && v > 0.0 {
        v.round() as i64
    } else {
        0
    }
}

fn observation_key(client: &str, model: &str) -> String {
    serde_json::to_string(&[client, model]).unwrap_or_default()
}

/// 上游 `normalizeObservation` 的輸入（原始欄位，數字已經是 JS 的 `num()`）。
#[derive(Default)]
struct RawObservation {
    client: String,
    model_id: String,
    provider_id: String,
    tokens: f64,
    cost: f64,
    messages: f64,
    reasoning: f64,
    cache_read: f64,
    cache_write: f64,
    output: f64,
    /// `Some` = 鍵存在（上游 `hasOwnProperty`）。
    unclassified: Option<f64>,
    components_available: bool,
}

/// 上游 `normalizeObservation`。
fn normalize(raw: RawObservation) -> Option<Observation> {
    let tokens = round0(raw.tokens);
    let cost = raw.cost.max(0.0);
    let messages = round0(raw.messages);
    let reasoning = round0(raw.reasoning);
    let (rcr, rcw, rout) = (
        round0(raw.cache_read),
        round0(raw.cache_write),
        round0(raw.output),
    );
    let fit = rcr + rcw + rout <= tokens;
    let (cr, cw, out) = if fit { (rcr, rcw, rout) } else { (0, 0, 0) };
    let components = cr + cw + out;
    let fallback = if raw.components_available && fit {
        0.0
    } else {
        tokens as f64
    };
    let unclassified = (tokens - components)
        .max(0)
        .min(round0(raw.unclassified.unwrap_or(fallback)));
    let available = fit
        && components + unclassified <= tokens
        && unclassified == 0
        && (tokens == 0 || raw.components_available);
    if tokens == 0 && cost == 0.0 && messages == 0 {
        return None;
    }
    Some(Observation {
        client: raw.client,
        model_id: raw.model_id,
        provider_id: raw.provider_id,
        tokens,
        cost,
        messages,
        unclassified_tokens: unclassified,
        token_components_available: available,
        cache_read_tokens: if available { cr } else { 0 },
        cache_write_tokens: if available { cw } else { 0 },
        output_tokens: if available { out } else { 0 },
        reasoning_tokens: reasoning,
    })
}

/// 上游 `addObservation`。
fn add(previous: Option<&Observation>, candidate: Observation) -> Option<Observation> {
    let Some(p) = previous else {
        return Some(candidate);
    };
    normalize(RawObservation {
        provider_id: if candidate.provider_id.is_empty() {
            p.provider_id.clone()
        } else {
            candidate.provider_id.clone()
        },
        tokens: (p.tokens + candidate.tokens) as f64,
        cost: p.cost + candidate.cost,
        messages: (p.messages + candidate.messages) as f64,
        reasoning: (p.reasoning_tokens + candidate.reasoning_tokens) as f64,
        components_available: p.token_components_available && candidate.token_components_available,
        cache_read: (p.cache_read_tokens + candidate.cache_read_tokens) as f64,
        cache_write: (p.cache_write_tokens + candidate.cache_write_tokens) as f64,
        output: (p.output_tokens + candidate.output_tokens) as f64,
        unclassified: Some((p.unclassified_tokens + candidate.unclassified_tokens) as f64),
        client: candidate.client,
        model_id: candidate.model_id,
    })
}

fn nullish<'a>(obj: Option<&'a Map<String, Value>>, a: &str, b: &str) -> Option<&'a Value> {
    let obj = obj?;
    match obj.get(a) {
        Some(Value::Null) | None => obj.get(b),
        some => some,
    }
}

fn num(v: Option<&Value>) -> f64 {
    v.map(as_number).unwrap_or(0.0)
}

/// 上游 `observationsFromGraphs`（單一 graph）。
fn days_from_graph(graph: &Value) -> IndexMap<String, ArchivedDay> {
    let mut days: IndexMap<String, ArchivedDay> = IndexMap::new();
    let rows = graph
        .get("contributions")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    for row in rows {
        let Some(row_obj) = row.as_object() else {
            continue;
        };
        let date: String = first_truthy_string(row_obj, &["date"])
            .chars()
            .take(10)
            .collect();
        if !valid_day(&date) {
            continue;
        }
        let day = days.entry(date.clone()).or_insert_with(|| ArchivedDay {
            date: date.clone(),
            ..ArchivedDay::default()
        });
        day.active_time_ms += round0(num(nullish(
            Some(row_obj),
            "activeTimeMs",
            "active_time_ms",
        )));
        for c in row_obj
            .get("clients")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            let Some(c) = c.as_object() else {
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
            let tokens_obj = c.get("tokens").and_then(Value::as_object);
            let t = |k: &str| num(tokens_obj.and_then(|o| o.get(k)));
            let disjoint = DISJOINT_REASONING_CLIENTS.contains(&client.as_str());
            let reasoning = if disjoint { t("reasoning") } else { 0.0 };
            let provider = first_truthy_string(c, &["providerId", "provider_id"])
                .trim()
                .to_string();
            let explicit = match (c.get("unclassifiedTokens"), c.get("unclassified_tokens")) {
                (None, None) => None,
                _ => Some(num(nullish(
                    Some(c),
                    "unclassifiedTokens",
                    "unclassified_tokens",
                ))),
            };
            let Some(candidate) = normalize(RawObservation {
                client: client.clone(),
                model_id: model.clone(),
                provider_id: provider,
                tokens: t("input") + t("output") + t("cacheRead") + t("cacheWrite") + reasoning,
                cost: num(c.get("cost")),
                messages: num(c.get("messages")),
                reasoning: t("reasoning"),
                cache_read: num(nullish(tokens_obj, "cacheRead", "cache_read")),
                cache_write: num(nullish(tokens_obj, "cacheWrite", "cache_write")),
                output: t("output") + reasoning,
                unclassified: explicit,
                components_available: c.get("tokenComponentsAvailable")
                    != Some(&Value::Bool(false)),
            }) else {
                continue;
            };
            let key = observation_key(&client, &model);
            if let Some(merged) = add(day.observations.get(&key), candidate) {
                day.observations.insert(key, merged);
            }
        }
    }
    days
}

/// 已正規化的觀測再過一次 `normalizeObservation`（上游 `normalizeDay` 在存入與讀出時都會做）。
fn renormalize(o: &Observation) -> Option<Observation> {
    normalize(RawObservation {
        client: o.client.clone(),
        model_id: o.model_id.clone(),
        provider_id: o.provider_id.clone(),
        tokens: o.tokens as f64,
        cost: o.cost,
        messages: o.messages as f64,
        reasoning: o.reasoning_tokens as f64,
        cache_read: o.cache_read_tokens as f64,
        cache_write: o.cache_write_tokens as f64,
        output: o.output_tokens as f64,
        unclassified: (o.unclassified_tokens > 0).then_some(o.unclassified_tokens as f64),
        components_available: o.token_components_available,
    })
}

/// 上游 `normalizeDay`：每筆觀測重新正規化（同一格合併），沒有觀測也沒有活躍時間的日子丟掉。
fn normalize_day(day: ArchivedDay) -> Option<ArchivedDay> {
    let mut observations: IndexMap<String, Observation> = IndexMap::new();
    for o in day.observations.values() {
        let Some(n) = renormalize(o) else { continue };
        let key = observation_key(&n.client, &n.model_id);
        if let Some(merged) = add(observations.get(&key), n) {
            observations.insert(key, merged);
        }
    }
    let active = day.active_time_ms.max(0);
    (!observations.is_empty() || active > 0).then(|| ArchivedDay {
        date: day.date,
        active_time_ms: active,
        observations,
    })
}

/// 上游 `shouldReplaceObservation`：token 多的贏，一樣多就比 messages，再一樣就換（價格可能修正了）。
fn should_replace(previous: Option<&Observation>, incoming: &Observation) -> bool {
    match previous {
        None => true,
        Some(p) if incoming.tokens != p.tokens => incoming.tokens > p.tokens,
        Some(p) if incoming.messages != p.messages => incoming.messages > p.messages,
        Some(_) => true,
    }
}

impl HistoryArchive {
    /// 上游 `captureDailyHistoryArchive`。回傳是否有變動。
    pub fn capture(&mut self, graph: &Value, today_key: &str) -> bool {
        let before = self.clone();
        self.version = 1;
        for (date, incoming) in days_from_graph(graph) {
            if date.as_str() > today_key {
                continue;
            }
            let previous = self.days.get(&date).cloned().unwrap_or_default();
            let mut next = ArchivedDay {
                date: date.clone(),
                active_time_ms: previous.active_time_ms.max(incoming.active_time_ms),
                observations: previous.observations.clone(),
            };
            for (key, obs) in incoming.observations {
                if should_replace(previous.observations.get(&key), &obs) {
                    next.observations.insert(key, obs);
                }
            }
            if let Some(day) = normalize_day(next) {
                self.days.insert(date, day);
            }
        }
        self.days.retain(|date, _| date.as_str() <= today_key);
        *self != before
    }

    /// 上游 `graphFromDailyHistoryArchive`（沒有 liveDays）：archive 的日子取代 graph 的同一天。
    pub fn to_graph(&self, graph: &Value, today_key: &str) -> Value {
        let mut days = days_from_graph(graph);
        for (date, day) in &self.days {
            if date.as_str() <= today_key {
                if let Some(day) = normalize_day(day.clone()) {
                    days.insert(date.clone(), day);
                }
            }
        }
        let mut sorted: Vec<ArchivedDay> = days.into_values().collect();
        sorted.sort_by(|a, b| a.date.cmp(&b.date));
        let active_total: i64 = sorted.iter().map(|d| d.active_time_ms).sum();
        let contributions: Vec<Value> = sorted
            .into_iter()
            .map(|day| {
                let mut observations: Vec<(String, Observation)> =
                    day.observations.into_iter().collect();
                observations.sort_by(|a, b| a.0.cmp(&b.0));
                let clients: Vec<Value> = observations
                    .into_iter()
                    .map(|(_, o)| {
                        let input = (o.tokens
                            - o.output_tokens
                            - o.cache_read_tokens
                            - o.cache_write_tokens)
                            .max(0);
                        let mut row = json!({
                            "client": o.client,
                            "modelId": o.model_id,
                            "tokens": {
                                "input": input,
                                "output": o.output_tokens,
                                "cacheRead": o.cache_read_tokens,
                                "cacheWrite": o.cache_write_tokens,
                                "reasoning": 0
                            },
                            "tokenComponentsAvailable": o.token_components_available,
                            "cost": o.cost,
                            "messages": o.messages
                        });
                        if !o.provider_id.is_empty() {
                            row["providerId"] = Value::String(o.provider_id);
                        }
                        if o.unclassified_tokens > 0 {
                            row["unclassifiedTokens"] = Value::from(o.unclassified_tokens);
                        }
                        row
                    })
                    .collect();
                json!({ "date": day.date, "activeTimeMs": day.active_time_ms, "clients": clients })
            })
            .collect();
        let mut out = json!({ "contributions": contributions });
        let source = graph
            .get("timeMetrics")
            .filter(|v| v.is_object())
            .or_else(|| graph.get("time_metrics").filter(|v| v.is_object()));
        if let Some(Value::Object(tm)) = source {
            let mut tm = tm.clone();
            let total = num(nullish(
                Some(&tm),
                "totalActiveTimeMs",
                "total_active_time_ms",
            ));
            tm.insert(
                "totalActiveTimeMs".into(),
                super::history::jnum(total.max(active_total as f64)),
            );
            out["timeMetrics"] = Value::Object(tm);
        }
        out
    }

    pub fn load(path: &Path) -> HistoryArchive {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                tracing::warn!(error = %e, "daily history archive is unreadable; starting over");
                HistoryArchive::default()
            }),
            Err(_) => HistoryArchive::default(),
        }
    }

    pub fn save(&self, path: &Path) -> AppResult<()> {
        let dir = path
            .parent()
            .ok_or_else(|| AppError::Storage("no parent dir".into()))?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| AppError::Storage("bad file name".into()))?;
        crate::store::write_json_in(dir, name, self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph(days: &[(&str, i64)]) -> Value {
        json!({ "contributions": days.iter().map(|(d, n)| json!({
            "date": d, "activeTimeMs": 1000,
            "clients": [{ "client": "claude", "modelId": "m", "tokens": { "input": n, "output": 1, "cacheRead": 2, "cacheWrite": 0, "reasoning": 5 }, "cost": 0.5, "messages": 3 }]
        })).collect::<Vec<_>>() })
    }

    #[test]
    fn days_the_client_deleted_stay_in_history() {
        let mut archive = HistoryArchive::default();
        assert!(archive.capture(
            &graph(&[("2026-08-01", 100), ("2026-09-24", 10)]),
            "2026-09-24"
        ));
        // 八月的 transcript 被刪了：graph 只剩今天。
        let now = graph(&[("2026-09-24", 20)]);
        assert!(archive.capture(&now, "2026-09-24"));
        let rebuilt = archive.to_graph(&now, "2026-09-24");
        let h = super::super::history::history_from_graph(&rebuilt, "2026-09-24").unwrap();
        let dates: Vec<&str> = h["daily"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["date"].as_str().unwrap())
            .collect();
        assert_eq!(dates, ["2026-08-01", "2026-09-24"]);
        assert_eq!(
            h["daily"][0]["tokens"], 103,
            "claude reasoning is not part of the total"
        );
        assert_eq!(
            h["daily"][1]["tokens"], 23,
            "today follows the bigger capture"
        );
    }

    #[test]
    fn a_smaller_rescan_never_replaces_a_bigger_day() {
        let mut archive = HistoryArchive::default();
        archive.capture(&graph(&[("2026-09-20", 500)]), "2026-09-24");
        assert!(!archive.capture(&graph(&[("2026-09-20", 100)]), "2026-09-24"));
        assert_eq!(
            archive.days["2026-09-20"]
                .observations
                .values()
                .next()
                .unwrap()
                .tokens,
            503
        );
    }
}
