//! tokscale JSON → `Period`。逐條移植上游 src/shared/usage.js 的
//! `collectUsageRows` / `addUsageRowToPeriod` / `sessionFromRow` / `mergeSession` /
//! `fallbackUsagePeriod` / `extractUsageBundleFromTokscale`。
//!
//! 這裡的每個判斷都影響 hub 上的數字，改動前先跑 `npm run test:compat`（以上游函式產生
//! 的 golden 比對）。

use indexmap::IndexMap;
use serde_json::Value;

use super::client_name::{
    has_disjoint_reasoning, normalize_client_name, normalize_model_name_for_client,
    normalize_provider_name,
};
use super::js::{
    any_truthy, as_number, first_number, first_string, first_truthy_string, round_nonneg, Obj,
};
use super::keys::*;
use crate::wire::period::{add_cost, add_count};
use crate::wire::time::{iso_millis, normalize_iso, timestamp_ms};
use crate::wire::{Period, Session};

/// 沒有 client 的列歸到這個分區（usage.js `UNATTRIBUTED_USAGE_CLIENT`）。
pub const UNATTRIBUTED_USAGE_CLIENT: &str = "__unattributed";

pub fn detect_client(obj: &Obj) -> Option<String> {
    normalize_client_name(&first_truthy_string(obj, CLIENT_FIELDS))
}

fn detect_model(obj: &Obj, client: Option<&str>) -> Option<String> {
    normalize_model_name_for_client(&first_truthy_string(obj, MODEL_FIELDS), client)
}

fn detect_session_id(obj: &Obj) -> Option<String> {
    let id = first_string(obj, SESSION_ID_KEYS);
    (!id.is_empty()).then_some(id)
}

fn token_value(obj: &Obj) -> f64 {
    let direct = first_number(obj, TOKEN_KEYS);
    if direct != 0.0 {
        return direct;
    }
    // 每個存在的成分鍵都加（同一個量以兩種拼法出現也會加兩次）——照抄上游。
    TOKEN_COMPONENT_KEYS
        .iter()
        .filter_map(|k| obj.get(*k))
        .map(as_number)
        .sum()
}

fn token_value_for_client(obj: &Obj, client: Option<&str>) -> f64 {
    let base = token_value(obj);
    if !has_disjoint_reasoning(client) {
        return base;
    }
    if first_number(obj, TOKEN_KEYS) != 0.0 {
        base
    } else {
        base + first_number(obj, REASONING_TOKEN_KEYS).max(0.0)
    }
}

fn output_value_for_client(obj: &Obj, client: Option<&str>) -> f64 {
    let output = first_number(obj, OUTPUT_TOKEN_KEYS).max(0.0);
    if has_disjoint_reasoning(client) {
        output + first_number(obj, REASONING_TOKEN_KEYS).max(0.0)
    } else {
        output
    }
}

fn cost_value(obj: &Obj) -> f64 {
    first_number(obj, COST_KEYS)
}

fn looks_like_usage_row(obj: &Obj) -> bool {
    let client = detect_client(obj);
    if token_value_for_client(obj, client.as_deref()) == 0.0 && cost_value(obj) == 0.0 {
        return false;
    }
    any_truthy(obj, ROW_HINT_FIELDS) || detect_session_id(obj).is_some()
}

/// 深度優先找出所有「看起來像用量列」的物件；命中的列不再往下走。
pub fn collect_usage_rows<'a>(node: &'a Value, rows: &mut Vec<&'a Obj>) {
    match node {
        Value::Array(items) => {
            for item in items {
                collect_usage_rows(item, rows);
            }
        }
        Value::Object(obj) => {
            if looks_like_usage_row(obj) {
                rows.push(obj);
                return;
            }
            for value in obj.values() {
                if matches!(value, Value::Array(_) | Value::Object(_)) {
                    collect_usage_rows(value, rows);
                }
            }
        }
        _ => {}
    }
}

fn normalize_session_kind(value: &str) -> String {
    if value.trim() == "background-review" {
        "background-review".into()
    } else {
        String::new()
    }
}

/// Reasonix 的 session 只在本機檢視，從不經 period.sessions 上傳（reasonix/sessionGuard.js）。
fn is_reasonix_synthetic(client: &str, session_id: &str, key: &str) -> bool {
    let c = client.trim().to_lowercase();
    let id = session_id.trim().to_lowercase();
    let k = key.trim().to_lowercase();
    c == "reasonix"
        || c == "reasonix-stats"
        || id.starts_with("reasonix-stats:")
        || id.starts_with("reasonix:")
        || k.starts_with("reasonix:")
        || k.contains("reasonix-stats:")
}

fn session_from_row(row: &Obj) -> Option<Session> {
    let client = detect_client(row)?;
    let raw_client = first_truthy_string(row, &["client"]);
    let raw_id = first_truthy_string(row, &["sessionId", "session_id"]);
    if client == REASONIX_CLIENT || is_reasonix_synthetic(&raw_client, &raw_id, "") {
        return None;
    }
    let id = detect_session_id(row)?;
    let mut s = Session {
        client: client.clone(),
        session_id: id,
        ..Session::default()
    };
    s.total_tokens = round_nonneg(token_value_for_client(row, Some(&client)));
    s.cost_usd = cost_value(row);
    s.message_count = round_nonneg(first_number(row, MESSAGE_COUNT_KEYS));
    s.input_tokens = round_nonneg(first_number(row, INPUT_TOKEN_KEYS));
    s.cache_read_tokens = round_nonneg(first_number(row, CACHE_READ_TOKEN_KEYS));
    s.cache_write_tokens = round_nonneg(first_number(row, CACHE_WRITE_TOKEN_KEYS));
    s.reasoning_tokens = round_nonneg(first_number(row, REASONING_TOKEN_KEYS));
    s.output_tokens = round_nonneg(output_value_for_client(row, Some(&client)));
    s.started_at = normalize_iso(&first_string(row, STARTED_AT_KEYS));
    s.last_used_at = normalize_iso(&first_string(row, LAST_USED_AT_KEYS));
    s.project_id = first_truthy_string(row, &["projectId", "project_id"])
        .trim()
        .to_string();
    s.project_label = first_truthy_string(row, &["projectLabel", "project_label"])
        .trim()
        .to_string();
    s.session_kind =
        normalize_session_kind(&first_truthy_string(row, &["sessionKind", "session_kind"]));
    let mut model = detect_model(row, Some(&client));
    if client == "cursor" && model.as_deref() == Some("auto") {
        model = Some("cursor-auto".into());
    }
    if let Some(m) = &model {
        if s.total_tokens > 0 {
            add_count(&mut s.models, m, s.total_tokens);
        }
        if s.cost_usd > 0.0 {
            add_cost(&mut s.model_costs, m, s.cost_usd);
        }
    }
    if let Some(p) = normalize_provider_name(&first_truthy_string(row, &["provider"])) {
        if s.total_tokens > 0 {
            add_count(&mut s.providers, &p, s.total_tokens);
        }
    }
    Some(s)
}

fn merge_session(target: &mut Session, source: &Session) {
    target.total_tokens += source.total_tokens.max(0);
    target.cost_usd += source.cost_usd;
    target.message_count += source.message_count.max(0);
    target.input_tokens += source.input_tokens.max(0);
    target.output_tokens += source.output_tokens.max(0);
    target.cache_read_tokens += source.cache_read_tokens.max(0);
    target.cache_write_tokens += source.cache_write_tokens.max(0);
    target.reasoning_tokens += source.reasoning_tokens.max(0);
    let source_started = timestamp_ms(&source.started_at);
    let target_started = timestamp_ms(&target.started_at);
    if source_started > 0 && (target_started == 0 || source_started < target_started) {
        target.started_at = ms_to_iso(source_started);
    }
    let source_last = timestamp_ms(&source.last_used_at);
    let target_last = timestamp_ms(&target.last_used_at);
    if source_last > 0 && source_last > target_last {
        target.last_used_at = ms_to_iso(source_last);
    }
    if target.project_id.is_empty() && !source.project_id.is_empty() {
        target.project_id = source.project_id.clone();
        target.project_label = source.project_label.clone();
    } else if target.project_id == source.project_id
        && target.project_label.is_empty()
        && !source.project_label.is_empty()
    {
        target.project_label = source.project_label.clone();
    }
    if target.session_kind.is_empty() && !source.session_kind.is_empty() {
        target.session_kind = normalize_session_kind(&source.session_kind);
    }
    for (model, tokens) in &source.models {
        if let Some(key) = normalize_model_name_for_client(model, Some(&target.client)) {
            add_count(&mut target.models, &key, (*tokens).max(0));
        }
    }
    for (model, cost) in &source.model_costs {
        if let Some(key) = normalize_model_name_for_client(model, Some(&target.client)) {
            add_cost(&mut target.model_costs, &key, *cost);
        }
    }
    for (provider, tokens) in &source.providers {
        if let Some(key) = normalize_provider_name(provider) {
            add_count(&mut target.providers, &key, (*tokens).max(0));
        }
    }
}

fn ms_to_iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(iso_millis)
        .unwrap_or_default()
}

fn add_session(period: &mut Period, session: Session) {
    if session.client.is_empty() || session.session_id.is_empty() {
        return;
    }
    let key = format!("{}:{}", session.client, session.session_id);
    if is_reasonix_synthetic(&session.client, &session.session_id, &key) {
        return;
    }
    let target = period.sessions.entry(key).or_insert_with(|| Session {
        client: session.client.clone(),
        session_id: session.session_id.clone(),
        ..Session::default()
    });
    merge_session(target, &session);
}

pub fn add_usage_row_to_period(period: &mut Period, row: &Obj, client: Option<&str>) {
    let tokens = token_value_for_client(row, client);
    let cost = cost_value(row);
    let cache_read = round_nonneg(first_number(row, CACHE_READ_TOKEN_KEYS));
    let cache_write = round_nonneg(first_number(row, CACHE_WRITE_TOKEN_KEYS));
    let output = round_nonneg(output_value_for_client(row, client));
    let (timed_tokens, timed_duration_ms) = match row.get("performance") {
        Some(Value::Object(perf)) => (
            round_nonneg(first_number(perf, TIMED_TOKEN_KEYS)),
            round_nonneg(first_number(perf, TIMED_DURATION_KEYS)),
        ),
        _ => (0, 0),
    };
    // 列的 output 計入吞吐量分子，若且唯若它的時長也計入分母（usage.js 的註解）。
    let timed_output_tokens = if timed_duration_ms > 0 { output } else { 0 };
    let mut model = detect_model(row, client);
    if client == Some("cursor") && model.as_deref() == Some("auto") {
        model = Some("cursor-auto".into());
    }
    let rounded = round_nonneg(tokens);
    period.total_tokens += rounded;
    period.cost_usd += cost;
    period.cache_read_tokens += cache_read;
    period.cache_write_tokens += cache_write;
    period.output_tokens += output;
    period.timed_tokens += timed_tokens;
    period.timed_output_tokens += timed_output_tokens;
    period.timed_duration_ms += timed_duration_ms;
    let positive = tokens > 0.0;
    if let Some(c) = client {
        if positive {
            add_count(&mut period.clients, c, tokens.round() as i64);
            if cache_read > 0 {
                add_count(&mut period.client_cache_reads, c, cache_read);
            }
            if cache_write > 0 {
                add_count(&mut period.client_cache_writes, c, cache_write);
            }
            if output > 0 {
                add_count(&mut period.client_outputs, c, output);
            }
        }
        if cost > 0.0 {
            add_cost(&mut period.client_costs, c, cost);
        }
    }
    if let Some(m) = &model {
        if positive {
            add_count(&mut period.models, m, tokens.round() as i64);
            if cache_read > 0 {
                add_count(&mut period.model_cache_reads, m, cache_read);
            }
            if cache_write > 0 {
                add_count(&mut period.model_cache_writes, m, cache_write);
            }
            if output > 0 {
                add_count(&mut period.model_outputs, m, output);
            }
        }
        if cost > 0.0 {
            add_cost(&mut period.model_costs, m, cost);
        }
    }
    if let (Some(c), Some(m)) = (client, &model) {
        if positive {
            add_count(
                period.client_models.entry(c.to_string()).or_default(),
                m,
                tokens.round() as i64,
            );
        }
        if cost > 0.0 {
            add_cost(
                period.client_model_costs.entry(c.to_string()).or_default(),
                m,
                cost,
            );
        }
    }
    if let Some(session) = session_from_row(row) {
        add_session(period, session);
    }
}

/// tokscale 只給總數、沒有任何列時（舊版或彙總輸出）：總數可信，但無法拆成 cache / output。
fn fallback_usage_period(json: &Obj) -> Period {
    let total = round_nonneg(token_value(json));
    let mut period = Period {
        total_tokens: total,
        cost_usd: cost_value(json),
        unclassified_tokens: total,
        ..Period::default()
    };
    period.capabilities.token_components = total == 0;
    period.capabilities.throughput = total == 0;
    period
}

/// 一次掃描的產出：對外的彙總 period，加上依 client 切的內部分區（M2 的 watch tick delta 用）。
#[derive(Debug, Clone, Default)]
pub struct UsageBundle {
    pub period: Period,
    pub by_client: IndexMap<String, Period>,
}

pub fn extract_usage_bundle(json: &Value) -> UsageBundle {
    let mut rows = Vec::new();
    collect_usage_rows(json, &mut rows);
    if rows.is_empty() {
        if let Value::Object(obj) = json {
            let period = fallback_usage_period(obj);
            let mut by_client = IndexMap::new();
            by_client.insert(UNATTRIBUTED_USAGE_CLIENT.to_string(), period.clone());
            return UsageBundle { period, by_client };
        }
        return UsageBundle::default();
    }
    let mut bundle = UsageBundle::default();
    for row in rows {
        let client = detect_client(row);
        let partition = client
            .clone()
            .unwrap_or_else(|| UNATTRIBUTED_USAGE_CLIENT.to_string());
        add_usage_row_to_period(&mut bundle.period, row, client.as_deref());
        add_usage_row_to_period(
            bundle.by_client.entry(partition).or_default(),
            row,
            client.as_deref(),
        );
    }
    bundle
}

pub fn extract_usage(json: &Value) -> Period {
    let mut rows = Vec::new();
    collect_usage_rows(json, &mut rows);
    if rows.is_empty() {
        return match json {
            Value::Object(obj) => fallback_usage_period(obj),
            _ => Period::default(),
        };
    }
    let mut period = Period::default();
    for row in rows {
        let client = detect_client(row);
        add_usage_row_to_period(&mut period, row, client.as_deref());
    }
    period
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn root_totals_are_not_a_row() {
        // 真實 tokscale 輸出的根物件帶 totalInput / totalCost，但沒有 client 等欄位，不能算成一列。
        let json = json!({
            "groupBy": "client,workspace,session,model",
            "entries": [{
                "client": "claude", "sessionId": "s1", "model": "claude-fable-5-1", "provider": "anthropic",
                "input": 10, "output": 20, "cacheRead": 30, "cacheWrite": 40, "reasoning": 0,
                "messageCount": 2, "cost": 0.5,
                "performance": { "totalDurationMs": 1000, "timedTokens": 100 }
            }],
            "sessions": [], "workspaces": [],
            "totalInput": 10, "totalOutput": 20, "totalCacheRead": 30, "totalCacheWrite": 40, "totalCost": 0.5
        });
        let p = extract_usage(&json);
        assert_eq!(p.total_tokens, 100);
        assert_eq!(p.clients["claude"], 100);
        assert_eq!(p.models["claude-fable-5-1"], 100);
        assert_eq!(p.output_tokens, 20);
        assert_eq!(p.timed_output_tokens, 20);
        assert_eq!(p.timed_tokens, 100);
        let s = &p.sessions["claude:s1"];
        assert_eq!(s.total_tokens, 100);
        assert_eq!(s.message_count, 2);
        assert_eq!(s.providers["anthropic"], 100);
    }

    #[test]
    fn codex_reasoning_is_additive_and_cursor_auto_is_renamed() {
        let json = json!({ "entries": [
            { "client": "codex", "sessionId": "c1", "model": "gpt-5", "input": 10, "output": 5, "reasoning": 7, "cost": 0.1 },
            { "client": "cursor", "sessionId": "k1", "model": "auto", "input": 3, "output": 1 }
        ]});
        let p = extract_usage(&json);
        assert_eq!(p.clients["codex"], 22);
        assert_eq!(p.client_outputs["codex"], 12);
        assert_eq!(p.models["cursor-auto"], 4);
        assert_eq!(p.sessions["codex:c1"].output_tokens, 12);
    }

    #[test]
    fn empty_scan_falls_back_to_zero_totals() {
        let p = extract_usage(&json!({ "entries": [], "totalInput": 0, "totalCost": 0 }));
        assert_eq!(p.total_tokens, 0);
        assert!(p.capabilities.token_components);
        let p = extract_usage(&json!({ "totalTokens": 500, "totalCost": 1.5 }));
        assert_eq!(p.total_tokens, 500);
        assert_eq!(p.unclassified_tokens, 500);
        assert!(!p.capabilities.token_components);
    }

    #[test]
    fn reasonix_sessions_never_reach_the_period() {
        let p = extract_usage(&json!({ "entries": [
            { "client": "reasonix", "sessionId": "r1", "model": "deepseek/deepseek-v4", "input": 5 }
        ]}));
        assert_eq!(p.clients["reasonix"], 5);
        assert_eq!(p.models["deepseek-v4"], 5);
        assert!(p.sessions.is_empty());
    }

    #[test]
    fn sessions_merge_across_models() {
        let p = extract_usage(&json!({ "entries": [
            { "client": "claude", "sessionId": "s", "model": "a", "input": 1, "startedAt": "2026-09-23T02:00:00Z", "lastUsedAt": "2026-09-23T03:00:00Z" },
            { "client": "claude", "sessionId": "s", "model": "b", "input": 2, "startedAt": "2026-09-23T01:00:00Z", "lastUsedAt": "2026-09-23T02:30:00Z" }
        ]}));
        let s = &p.sessions["claude:s"];
        assert_eq!(s.total_tokens, 3);
        assert_eq!(s.started_at, "2026-09-23T01:00:00.000Z");
        assert_eq!(s.last_used_at, "2026-09-23T03:00:00.000Z");
        assert_eq!(s.models.len(), 2);
    }
}
