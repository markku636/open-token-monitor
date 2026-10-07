//! 上傳 payload 與大小預算（上游 src/shared/syncPayload.js 的移植）。
//!
//! hub 的 body 上限是 1 MiB（src/shared/http.js `MAX_JSON_BODY_BYTES`），上游留 16 KiB 餘裕。
//!
//! history 一律只有最近 30 天帶 token 組成（cacheRead / cacheWrite / output / unclassified），
//! 更早的日子只留 tokens / cost / messages（上游 `historyForSync`）。history 的列永遠不會被丟。
//!
//! 超過預算時依序縮減：
//! 0. history 全部的日子都拿掉 token 組成（組成是附加資訊，不能因為它擠掉專案或 session）。
//! 1. 丟掉 allTime 的專案拆分（設 `allTimeProjectsOmitted`）。
//! 2. month、再 today：session 依「最近使用 → token 多 → key」排序，二分搜尋保留能放進去的最多筆
//!    （設 `sessionDetailsOmitted[period]`），並改帶權威的專案彙總，免得 hub 從殘缺的 session 重算。
//! 3. 仍放不下就丟掉該期的專案（設 `periodProjectsOmitted[period]`）。
//!
//! 總數（totalTokens、clients、models…）永遠完整，被縮減的只有明細。

use serde::Serialize;
use serde_json::{Map, Value};

use crate::usage::history::day_key_add_days;
use crate::wire::time::timestamp_ms;

pub const MAX_JSON_BODY_BYTES: usize = 1024 * 1024;
pub const SYNC_PAYLOAD_MARGIN_BYTES: usize = 16 * 1024;
pub const SYNC_PAYLOAD_BUDGET_BYTES: usize = MAX_JSON_BODY_BYTES - SYNC_PAYLOAD_MARGIN_BYTES;
/// 上游 `SYNC_HISTORY_COMPONENT_DAYS`：history 只有這麼多天帶 token 組成。
pub const SYNC_HISTORY_COMPONENT_DAYS: i64 = 30;

#[derive(Debug, Clone, Copy, Default)]
pub struct PayloadOptions {
    pub omit_all_time_projects: bool,
    pub omit_history_token_components: bool,
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadOmissions {
    /// 預算不夠，history 連最近 30 天的 token 組成也拿掉了。
    pub history_token_components: bool,
    pub all_time_projects: bool,
    pub session_details: Vec<(String, usize)>,
    pub period_projects: Vec<(String, usize)>,
}

impl PayloadOmissions {
    pub fn is_empty(&self) -> bool {
        !self.history_token_components
            && !self.all_time_projects
            && self.session_details.is_empty()
            && self.period_projects.is_empty()
    }
}

#[derive(Debug, Clone)]
pub struct SerializedPayload {
    pub payload: Value,
    pub body: Vec<u8>,
    pub omissions: PayloadOmissions,
}

fn is_reasonix_session(key: &str, session: &Value) -> bool {
    let norm = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_lowercase()
    };
    let client = norm(session.get("client"));
    let id = {
        let a = norm(session.get("sessionId"));
        if a.is_empty() {
            norm(session.get("session_id"))
        } else {
            a
        }
    };
    let k = key.trim().to_lowercase();
    client == "reasonix"
        || client == "reasonix-stats"
        || id.starts_with("reasonix-stats:")
        || id.starts_with("reasonix:")
        || k.starts_with("reasonix:")
        || k.contains("reasonix-stats:")
}

fn clean_sessions(sessions: &mut Map<String, Value>, projects_enabled: bool) {
    sessions.retain(|k, v| !is_reasonix_session(k, v));
    for session in sessions.values_mut() {
        if let Some(obj) = session.as_object_mut() {
            // 標題只留在本機（隱私）；v1 本來就不產生，這裡是保險。
            obj.remove("title");
            if !projects_enabled {
                for k in ["projectId", "project_id", "projectLabel", "project_label"] {
                    obj.remove(k);
                }
            }
        }
    }
}

fn project_entries(period: Option<&Value>) -> usize {
    period
        .and_then(|p| p.get("projects"))
        .and_then(Value::as_object)
        .map(Map::len)
        .unwrap_or(0)
}

/// 上游 `syncLimits(undefined)`：沒有 limits 時也要送一個空的正規化摘要。hub 的
/// `mergeDeviceRecord` 看到 `limits` 鍵才會取代舊值，所以「關掉 limits」必須送空集合，
/// 不能省略鍵，否則 hub 會一直顯示最後一次的額度。
fn empty_limits() -> Value {
    serde_json::json!({ "updatedAt": null, "refreshMs": 300_000, "providers": [] })
}

const TOKEN_COMPONENT_KEYS: &[&str] = &[
    "cacheReadTokens",
    "cacheWriteTokens",
    "outputTokens",
    "unclassifiedTokens",
    "tokenComponentsAvailable",
];

/// 上游 `stripTokenComponents` 套在一天與它的 perClient / perModel。
fn strip_row_components(row: &mut Value) {
    let Some(obj) = row.as_object_mut() else {
        return;
    };
    for k in TOKEN_COMPONENT_KEYS {
        obj.remove(*k);
    }
    for section in ["perClient", "perModel"] {
        // 上游 `Object.fromEntries(Object.entries(row?.perClient || {}))`：沒有就補空物件。
        let mut entries = match obj.remove(section) {
            Some(Value::Object(m)) => m,
            _ => Map::new(),
        };
        for v in entries.values_mut() {
            if let Some(e) = v.as_object_mut() {
                for k in TOKEN_COMPONENT_KEYS {
                    e.remove(*k);
                }
            }
        }
        obj.insert(section.into(), Value::Object(entries));
    }
}

/// 上游 `historyForSync` / `historyWithoutTokenComponents`：`all = true` 時每一天都拿掉組成，
/// 否則只拿掉 `today − 29` 之前的。今天以 `periodWindows.today.key` 為準，沒有就用最新的一天。
fn history_for_sync(history: &Value, period_windows: Option<&Value>, all: bool) -> Value {
    let Some(daily) = history.get("daily").and_then(Value::as_array) else {
        return history.clone();
    };
    let row_key = |row: &Value| -> String {
        row.get("date")
            .map(|d| match d {
                Value::String(s) => s.chars().take(10).collect(),
                Value::Null => String::new(),
                other => crate::usage::js::to_js_string(other)
                    .chars()
                    .take(10)
                    .collect(),
            })
            .unwrap_or_default()
    };
    let latest = daily.iter().map(row_key).max().unwrap_or_default();
    let today_key: String = period_windows
        .and_then(|w| w.get("today"))
        .and_then(|t| t.get("key"))
        .and_then(Value::as_str)
        .filter(|k| !k.is_empty())
        .map(str::to_string)
        .unwrap_or(latest)
        .chars()
        .take(10)
        .collect();
    let start = if all {
        None
    } else {
        match day_key_add_days(&today_key, -(SYNC_HISTORY_COMPONENT_DAYS - 1)) {
            Some(s) => Some(s),
            None => return history.clone(),
        }
    };
    let mut out = history.clone();
    if let Some(Value::Array(rows)) = out.get_mut("daily") {
        for row in rows.iter_mut() {
            let key = row_key(row);
            let keep = start
                .as_deref()
                .is_some_and(|s| key.as_str() >= s && key <= today_key);
            if !keep {
                strip_row_components(row);
            }
        }
    }
    out
}

pub fn build_sync_payload(summary: &Value, opts: PayloadOptions) -> Value {
    let Some(src) = summary.as_object() else {
        return summary.clone();
    };
    let omit_all_time_projects = opts.omit_all_time_projects;
    let mut payload = src.clone();
    if !payload.get("limits").map(Value::is_object).unwrap_or(false) {
        payload.insert("limits".into(), empty_limits());
    }
    if let Some(history) = src.get("history").filter(|h| h.is_object()) {
        let mut h = history_for_sync(history, src.get("periodWindows"), false);
        if opts.omit_history_token_components {
            h = history_for_sync(&h, src.get("periodWindows"), true);
        }
        payload.insert("history".into(), h);
    }
    let projects_enabled = src.get("projectsEnabled").and_then(Value::as_bool) != Some(false);
    for k in [
        "nativeSessions",
        "nativeProjects",
        "allTimeProjectsOmitted",
        "allTimeProjectsIncomplete",
        "sessionDetailsOmitted",
        "periodProjectsOmitted",
    ] {
        payload.remove(k);
    }
    for period in ["today", "month"] {
        if let Some(Value::Object(p)) = payload.get_mut(period) {
            // hub 會從 session 重建 today / month 的專案拆分（docs/API.md），不必重複上傳。
            p.remove("projects");
            if let Some(Value::Object(sessions)) = p.get_mut("sessions") {
                clean_sessions(sessions, projects_enabled);
            }
        }
    }
    let mut omitted = false;
    if let Some(Value::Object(all)) = payload.get_mut("allTime") {
        all.remove("sessions");
        if !projects_enabled {
            all.remove("projects");
        }
        if omit_all_time_projects && all.remove("projects").is_some() {
            omitted = true;
        }
    }
    if omitted {
        payload.insert("allTimeProjectsOmitted".into(), Value::Bool(true));
    }
    Value::Object(payload)
}

fn to_body(v: &Value) -> Vec<u8> {
    serde_json::to_vec(v).expect("JSON value serializes")
}

fn session_timestamp(session: &Value) -> i64 {
    let s = |k: &str| {
        session
            .get(k)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
    };
    s("lastUsedAt")
        .or_else(|| s("startedAt"))
        .map(timestamp_ms)
        .unwrap_or(0)
}

fn recent_session_entries(sessions: &Map<String, Value>) -> Vec<(String, Value)> {
    let mut entries: Vec<(String, Value)> = sessions
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    entries.sort_by(|(ak, a), (bk, b)| {
        session_timestamp(b)
            .cmp(&session_timestamp(a))
            .then_with(|| {
                let t = |v: &Value| v.get("totalTokens").and_then(Value::as_f64).unwrap_or(0.0);
                t(b).partial_cmp(&t(a)).unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| ak.cmp(bk))
    });
    entries
}

fn set_omission(payload: &mut Map<String, Value>, field: &str, period: &str, omitted: usize) {
    let mut next = payload
        .get(field)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if omitted > 0 {
        next.insert(period.into(), Value::from(omitted as u64));
    } else {
        next.remove(period);
    }
    // JS 的 `delete` + 重新指派會把鍵移到最後；這裡同樣先移除再插入，鍵序才與上游一致。
    payload.remove(field);
    if !next.is_empty() {
        payload.insert(field.into(), Value::Object(next));
    }
}

fn fit_recent_session_entries(
    payload: &mut Value,
    period: &str,
    entries: &[(String, Value)],
    max: usize,
) {
    let obj = payload.as_object_mut().expect("payload is an object");
    let apply = |obj: &mut Map<String, Value>, count: usize| {
        let sessions: Map<String, Value> = entries[..count].iter().cloned().collect();
        if let Some(Value::Object(p)) = obj.get_mut(period) {
            p.insert("sessions".into(), Value::Object(sessions));
        }
        set_omission(obj, "sessionDetailsOmitted", period, entries.len() - count);
    };
    let (mut low, mut high) = (0usize, entries.len());
    while low < high {
        let count = (low + high).div_ceil(2);
        apply(obj, count);
        if to_body(&Value::Object(obj.clone())).len() <= max {
            low = count;
        } else {
            high = count - 1;
        }
    }
    apply(obj, low);
}

fn fit_period_sessions(payload: &mut Value, summary: &Value, period: &str, max: usize) {
    let entries = match payload
        .get(period)
        .and_then(|p| p.get("sessions"))
        .and_then(Value::as_object)
    {
        Some(s) if !s.is_empty() => recent_session_entries(s),
        _ => return,
    };
    let projects_enabled = summary.get("projectsEnabled").and_then(Value::as_bool) != Some(false);
    if projects_enabled {
        if let Some(projects) = summary
            .get(period)
            .and_then(|p| p.get("projects"))
            .filter(|p| p.is_object())
        {
            if let Some(Value::Object(p)) = payload.get_mut(period) {
                p.insert("projects".into(), projects.clone());
            }
        }
    }
    fit_recent_session_entries(payload, period, &entries, max);
    let omitted_projects = project_entries(payload.get(period));
    if to_body(payload).len() > max && omitted_projects > 0 {
        if let Some(Value::Object(p)) = payload.get_mut(period) {
            p.remove("projects");
        }
        let obj = payload.as_object_mut().expect("payload is an object");
        set_omission(obj, "periodProjectsOmitted", period, omitted_projects);
        fit_recent_session_entries(payload, period, &entries, max);
    }
}

fn omissions_of(payload: &Value, history_token_components: bool) -> PayloadOmissions {
    let pairs = |field: &str| -> Vec<(String, usize)> {
        payload
            .get(field)
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .map(|(k, v)| (k.clone(), v.as_u64().unwrap_or(0) as usize))
                    .collect()
            })
            .unwrap_or_default()
    };
    PayloadOmissions {
        history_token_components,
        all_time_projects: payload
            .get("allTimeProjectsOmitted")
            .and_then(Value::as_bool)
            == Some(true),
        session_details: pairs("sessionDetailsOmitted"),
        period_projects: pairs("periodProjectsOmitted"),
    }
}

pub fn serialize_sync_payload(summary: &Value, opts: PayloadOptions) -> SerializedPayload {
    let max = opts.max_bytes.unwrap_or(SYNC_PAYLOAD_BUDGET_BYTES);
    let mut opts = opts;
    let mut payload = build_sync_payload(summary, opts);
    let mut body = to_body(&payload);
    if body.len() > max && payload.get("history").is_some_and(Value::is_object) {
        opts.omit_history_token_components = true;
        payload = build_sync_payload(summary, opts);
        body = to_body(&payload);
    }
    if !opts.omit_all_time_projects
        && body.len() > max
        && project_entries(payload.get("allTime")) > 0
    {
        opts.omit_all_time_projects = true;
        payload = build_sync_payload(summary, opts);
        body = to_body(&payload);
    }
    if body.len() > max {
        // month 的明細最先長到威脅上限；today 的即時明細盡量保留到最後。
        for period in ["month", "today"] {
            fit_period_sessions(&mut payload, summary, period, max);
            body = to_body(&payload);
            if body.len() <= max {
                break;
            }
        }
    }
    let omissions = omissions_of(
        &payload,
        opts.omit_history_token_components && payload.get("history").is_some_and(Value::is_object),
    );
    SerializedPayload {
        payload,
        body,
        omissions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn summary_with_sessions(n: usize, projects: usize) -> Value {
        let mut sessions = Map::new();
        for i in 0..n {
            sessions.insert(
                format!("claude:s{i:04}"),
                json!({ "client": "claude", "sessionId": format!("s{i:04}"), "totalTokens": i, "title": "secret",
                        "lastUsedAt": format!("2026-09-{:02}T00:00:00.000Z", 1 + (i % 28)), "projectId": "p", "projectLabel": "x" }),
            );
        }
        let mut proj = Map::new();
        for i in 0..projects {
            proj.insert(
                format!("proj{i}"),
                json!({ "label": format!("proj{i}"), "tokens": 1, "costUsd": 0, "clients": {} }),
            );
        }
        json!({
            "deviceId": "d", "projectsEnabled": true,
            "today": { "totalTokens": 1, "sessions": {}, "projects": proj.clone() },
            "month": { "totalTokens": 5, "sessions": sessions.clone(), "projects": proj.clone() },
            "allTime": { "totalTokens": 9, "sessions": sessions, "projects": proj }
        })
    }

    #[test]
    fn strips_titles_and_derived_projects() {
        let s = summary_with_sessions(3, 2);
        let p = build_sync_payload(&s, PayloadOptions::default());
        assert!(p["month"].get("projects").is_none());
        assert!(p["month"]["sessions"]["claude:s0001"]
            .get("title")
            .is_none());
        assert!(p["allTime"].get("sessions").is_none());
        assert_eq!(p["allTime"]["projects"].as_object().unwrap().len(), 2);
    }

    #[test]
    fn projects_disabled_drops_project_metadata() {
        let mut s = summary_with_sessions(2, 2);
        s["projectsEnabled"] = json!(false);
        let p = build_sync_payload(&s, PayloadOptions::default());
        assert!(p["allTime"].get("projects").is_none());
        assert!(p["month"]["sessions"]["claude:s0001"]
            .get("projectId")
            .is_none());
    }

    #[test]
    fn reductions_keep_totals_and_fit_budget() {
        let s = summary_with_sessions(400, 50);
        let full = serialize_sync_payload(&s, PayloadOptions::default());
        assert!(full.omissions.is_empty());
        let budget = full.body.len() / 3;
        let reduced = serialize_sync_payload(
            &s,
            PayloadOptions {
                max_bytes: Some(budget),
                ..Default::default()
            },
        );
        assert!(
            reduced.body.len() <= budget,
            "{} > {budget}",
            reduced.body.len()
        );
        assert!(reduced.omissions.all_time_projects);
        assert_eq!(reduced.payload["month"]["totalTokens"], 5);
        let kept = reduced.payload["month"]["sessions"]
            .as_object()
            .unwrap()
            .len();
        assert_eq!(
            reduced.payload["sessionDetailsOmitted"]["month"]
                .as_u64()
                .unwrap() as usize,
            400 - kept
        );
        // 被保留的是最近使用的 session
        let first_kept = reduced.payload["month"]["sessions"]
            .as_object()
            .unwrap()
            .values()
            .next()
            .unwrap();
        assert_eq!(first_kept["lastUsedAt"], "2026-09-28T00:00:00.000Z");
        // 明細被截斷時改帶權威的專案彙總
        assert_eq!(
            reduced.payload["month"]["projects"]
                .as_object()
                .map(Map::len),
            Some(50)
        );
    }

    fn history_row(date: &str) -> Value {
        json!({ "date": date, "tokens": 10, "cost": 1, "messages": 1, "cacheReadTokens": 4, "cacheWriteTokens": 1,
                "outputTokens": 2, "unclassifiedTokens": 0, "tokenComponentsAvailable": true, "activeTimeMs": 0,
                "perClient": { "claude": { "tokens": 10, "cost": 1, "messages": 1, "unclassifiedTokens": 0, "outputTokens": 2 } },
                "perModel": { "m": { "tokens": 10, "cost": 1, "unclassifiedTokens": 0, "cacheReadTokens": 4 } } })
    }

    #[test]
    fn history_keeps_components_for_the_last_30_days_only() {
        let s = json!({
            "deviceId": "d",
            "periodWindows": { "today": { "key": "2026-09-24" } },
            "history": { "daily": [history_row("2026-08-25"), history_row("2026-08-26"), history_row("2026-09-24")],
                         "monthly": [], "summary": {} }
        });
        let p = build_sync_payload(&s, PayloadOptions::default());
        let daily = p["history"]["daily"].as_array().unwrap();
        assert!(
            daily[0].get("outputTokens").is_none(),
            "today - 30 is stripped"
        );
        assert!(daily[0]["perClient"]["claude"]
            .get("unclassifiedTokens")
            .is_none());
        assert_eq!(daily[0]["tokens"], 10, "totals stay");
        assert_eq!(
            daily[1]["outputTokens"], 2,
            "today - 29 keeps its components"
        );
        assert_eq!(daily[2]["perModel"]["m"]["cacheReadTokens"], 4);
        assert_eq!(
            s["history"]["daily"][0]["outputTokens"], 2,
            "the record is untouched"
        );
    }

    #[test]
    fn history_components_go_before_any_project_or_session() {
        let mut s = summary_with_sessions(50, 5);
        s["periodWindows"] = json!({ "today": { "key": "2026-09-24" } });
        let rows: Vec<Value> = (0..30)
            .map(|i| history_row(&day_key_add_days("2026-09-24", -i).unwrap()))
            .collect();
        s["history"] = json!({ "daily": rows, "monthly": [], "summary": {} });
        let full = serialize_sync_payload(&s, PayloadOptions::default());
        let stripped = build_sync_payload(
            &s,
            PayloadOptions {
                omit_history_token_components: true,
                ..Default::default()
            },
        );
        let budget = to_body(&stripped).len();
        assert!(full.body.len() > budget);
        let fitted = serialize_sync_payload(
            &s,
            PayloadOptions {
                max_bytes: Some(budget),
                ..Default::default()
            },
        );
        assert!(fitted.omissions.history_token_components);
        assert!(!fitted.omissions.all_time_projects);
        assert!(fitted.omissions.session_details.is_empty());
        assert_eq!(
            fitted.payload["history"]["daily"].as_array().unwrap().len(),
            30
        );
    }

    #[test]
    fn period_projects_dropped_as_last_resort() {
        // session 多到必須截斷時才會改帶專案彙總；專案本身又太大時才整個丟掉。
        let s = summary_with_sessions(200, 3000);
        let tiny = serialize_sync_payload(
            &s,
            PayloadOptions {
                max_bytes: Some(3_000),
                ..Default::default()
            },
        );
        assert!(tiny.body.len() <= 3_000);
        assert_eq!(tiny.payload["periodProjectsOmitted"]["month"], 3000);
        assert!(tiny.payload["month"].get("projects").is_none());
        assert_eq!(tiny.payload["month"]["totalTokens"], 5);
    }
}
