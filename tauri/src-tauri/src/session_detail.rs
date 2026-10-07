//! session 的逐回合明細（上游 src/shared/sessionDetail.js、sessionFiles.js、providers/opencode/session.js）：
//! 點 session 清單的一列時，讀那個 session 自己的紀錄，依使用者的每一則提問分組，列出每一輪 AI 回覆的
//! token（輸入、輸出、快取、推理）與用到的工具。
//!
//! - Claude Code：`<CLAUDE_CONFIG_DIR 或 ~/.claude>/projects|transcripts/**/<id>.jsonl`。續接時重放的舊行以
//!   `uuid` 去重；同一個 API 回覆拆成多行（thinking / text / tool_use）時以 `message.id` 只算一次、合併工具。
//! - Codex：`<CODEX_HOME 或 ~/.codex>/sessions/YYYY/MM/DD/<rollout id>.jsonl`；`token_count` 的
//!   `last_token_usage` 是一輪，input 扣掉 cached 才與快取不重疊，reasoning 是輸出的一部分（只顯示）。
//! - OpenCode：`opencode*.db`（SQLite，唯讀）的 message / part；每則助理訊息有自己的成本。
//!
//! Claude 與 Codex 的成本依 token 比例分攤 session 的成本（tokscale 沒有逐輪的成本）；OpenCode 用真的成本。
//! 期間是 today / month 時只留那段期間內的回合（裝置本地時間）。只在本機讀，不上傳。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    /// 輸出的一部分（OpenAI / Codex 的 reasoning_output_tokens），只顯示、不加進總數。
    pub reasoning: f64,
    pub total: f64,
}

fn num(v: Option<&Value>) -> f64 {
    v.and_then(|v| {
        v.as_f64()
            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
    })
    .filter(|n| n.is_finite())
    .unwrap_or(0.0)
}

/// 上游 `makeTokens`：總數 = 輸入 + 輸出 + 快取讀 + 快取寫（與 tokscale 對 session 的加總相同）。
pub fn make_tokens(
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    reasoning: f64,
) -> Tokens {
    Tokens {
        input,
        output,
        cache_read,
        cache_write,
        reasoning,
        total: input + output + cache_read + cache_write,
    }
}

impl Tokens {
    fn add(&mut self, o: &Tokens) {
        self.input += o.input;
        self.output += o.output;
        self.cache_read += o.cache_read;
        self.cache_write += o.cache_write;
        self.reasoning += o.reasoning;
        self.total += o.total;
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Prompt {
        timestamp: String,
        text: String,
    },
    Turn {
        timestamp: String,
        tokens: Tokens,
        tools: Vec<String>,
        /// OpenCode 的真實成本；Claude / Codex 為 None（之後依比例分攤）。
        cost: Option<f64>,
    },
}

fn unique(tools: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    tools
        .into_iter()
        .filter(|t| !t.is_empty() && seen.insert(t.clone()))
        .collect()
}

/// 上游 `cleanPromptText`：去掉 `[Image: source: …]` 的重複參照，保留 `[Image #N]`，空白收斂。
pub fn clean_prompt_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("[Image:") {
        out.push_str(&rest[..i]);
        match rest[i..].find(']') {
            Some(j) => rest = &rest[i + j + 1..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 上游 `isSyntheticClaudePrompt`：slash 指令區塊、中斷通知等 harness 注入的使用者訊息不是提問。
fn is_synthetic_claude_prompt(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return false;
    }
    if t.starts_with("[Request interrupted") || t.starts_with("Base directory for this skill:") {
        return true;
    }
    const TAGS: &[&str] = &[
        "command-name",
        "command-message",
        "command-args",
        "local-command-stdout",
        "local-command-caveat",
        "bash-input",
        "bash-stdout",
        "bash-stderr",
        "system-reminder",
    ];
    let body = t.strip_prefix("</").or_else(|| t.strip_prefix('<'));
    match body {
        Some(b) => TAGS.iter().any(|tag| {
            b.starts_with(tag)
                && !b[tag.len()..]
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_alphanumeric() || c == '_')
        }),
        None => false,
    }
}

/// 上游 `claudePromptText`：`None` = 不是提問的邊界（工具結果、注入的訊息）。
fn claude_prompt_text(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => {
            if is_synthetic_claude_prompt(s) {
                return None;
            }
            let c = clean_prompt_text(s);
            (!c.is_empty()).then_some(c)
        }
        Value::Array(parts) => {
            let ty = |p: &Value| {
                p.get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            };
            if parts.iter().any(|p| ty(p) == "tool_result") {
                return None;
            }
            let raw: Vec<String> = parts
                .iter()
                .filter(|p| ty(p) == "text")
                .map(|p| {
                    p.get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string()
                })
                .collect();
            if raw.iter().any(|t| is_synthetic_claude_prompt(t)) {
                return None;
            }
            let joined = clean_prompt_text(
                &raw.iter()
                    .map(|t| clean_prompt_text(t))
                    .filter(|t| !t.is_empty())
                    .collect::<Vec<_>>()
                    .join(" "),
            );
            if !joined.is_empty() {
                return Some(joined);
            }
            parts
                .iter()
                .any(|p| ty(p) == "image")
                .then(|| "[image]".to_string())
        }
        _ => None,
    }
}

/// 上游 `parseClaudeTranscript`。
pub fn parse_claude(text: &str) -> Vec<Event> {
    let mut events: Vec<Event> = Vec::new();
    let mut seen_uuids = HashSet::new();
    let mut turn_by_message: HashMap<String, usize> = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(uuid) = obj.get("uuid").and_then(Value::as_str) {
            if !seen_uuids.insert(uuid.to_string()) {
                continue;
            }
        }
        let message = obj.get("message").cloned().unwrap_or(Value::Null);
        let timestamp = obj
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let ty = obj.get("type").and_then(Value::as_str).unwrap_or_default();
        if ty == "assistant" {
            let Some(u) = message.get("usage") else {
                continue;
            };
            let tools: Vec<String> = message
                .get("content")
                .and_then(Value::as_array)
                .map(|c| {
                    c.iter()
                        .filter(|p| p.get("type").and_then(Value::as_str) == Some("tool_use"))
                        .filter_map(|p| p.get("name").and_then(Value::as_str).map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let id = message
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string);
            if let Some(idx) = id.as_ref().and_then(|id| turn_by_message.get(id)) {
                if let Event::Turn {
                    tools: existing, ..
                } = &mut events[*idx]
                {
                    let mut merged = existing.clone();
                    merged.extend(tools);
                    *existing = unique(merged);
                }
                continue;
            }
            let tokens = make_tokens(
                num(u.get("input_tokens")),
                num(u.get("output_tokens")),
                num(u.get("cache_read_input_tokens")),
                num(u.get("cache_creation_input_tokens")),
                0.0,
            );
            if let Some(id) = id {
                turn_by_message.insert(id, events.len());
            }
            events.push(Event::Turn {
                timestamp,
                tokens,
                tools: unique(tools),
                cost: None,
            });
        } else if ty == "user" {
            if let Some(text) = claude_prompt_text(message.get("content").unwrap_or(&Value::Null)) {
                events.push(Event::Prompt { timestamp, text });
            }
        }
    }
    events
}

/// 上游 `codexPromptText`：IDE 擴充在前面加的 editor context，真正的提問在 `## My request for Codex:` 之後。
fn codex_prompt_text(raw: &str) -> String {
    const MARKER: &str = "## My request for Codex:";
    match raw.find(MARKER) {
        Some(i) => clean_prompt_text(&raw[i + MARKER.len()..]),
        None => clean_prompt_text(raw),
    }
}

fn media_marker(count: usize, one: &str, many: &str) -> String {
    match count {
        0 => String::new(),
        1 => one.to_string(),
        n => many.replace("{n}", &n.to_string()),
    }
}

/// 上游 `codexResponseItemPrompt`。
fn codex_response_item_prompt(payload: &Value) -> Option<String> {
    if payload.get("type").and_then(Value::as_str) != Some("message")
        || payload.get("role").and_then(Value::as_str) != Some("user")
    {
        return None;
    }
    let content = payload
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let kinds = payload
        .get("internal_chat_message_metadata_passthrough")
        .and_then(|m| m.get("content_item_kinds"))
        .and_then(Value::as_array);
    let selected: Vec<&Value> = content
        .iter()
        .enumerate()
        .filter(|(i, _)| match kinds {
            Some(k) => k
                .get(*i)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .starts_with("user."),
            None => true,
        })
        .map(|(_, p)| p)
        .collect();
    if kinds.is_some() && selected.is_empty() {
        return None;
    }
    let ty = |p: &Value| {
        p.get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let text = codex_prompt_text(
        &selected
            .iter()
            .filter(|p| ty(p) == "input_text")
            .map(|p| p.get("text").and_then(Value::as_str).unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n"),
    );
    let images = selected.iter().filter(|p| ty(p) == "input_image").count();
    let audio = selected.iter().filter(|p| ty(p) == "input_audio").count();
    let label = [
        media_marker(images, "[image]", "[{n} images]"),
        media_marker(audio, "[audio]", "[{n} audio clips]"),
        text,
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    (!label.is_empty()).then_some(label)
}

fn codex_tool_name(payload: &Value) -> String {
    ["name", "tool_name", "tool"]
        .iter()
        .find_map(|k| {
            payload
                .get(*k)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_default()
        .to_string()
}

#[derive(Clone)]
struct Adjacent {
    source: &'static str,
    index: usize,
    text: String,
}

/// 上游 `parseCodexTranscript`。
pub fn parse_codex(text: &str) -> Vec<Event> {
    let mut events: Vec<Event> = Vec::new();
    let mut pending_tools: Vec<String> = Vec::new();
    let mut adjacent: Option<Adjacent> = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let previous = adjacent.take();
        let Ok(obj) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let payload = obj.get("payload").cloned().unwrap_or(Value::Null);
        let ty = obj.get("type").and_then(Value::as_str).unwrap_or_default();
        let pty = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let timestamp = obj
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let last_is = |p: &Option<Adjacent>, source: &str, label: &str, len: usize| {
            p.as_ref().is_some_and(|a| {
                a.source == source && len > 0 && a.index == len - 1 && a.text == label
            })
        };
        let tool_call = (ty == "response_item"
            && matches!(
                pty,
                "function_call" | "custom_tool_call" | "tool_search_call"
            ))
            || (ty == "event_msg" && pty == "mcp_tool_call_end");
        if tool_call {
            let name = codex_tool_name(&payload);
            if !name.is_empty() {
                pending_tools.push(name);
            }
        } else if ty == "event_msg" && pty == "user_message" {
            let raw = payload
                .get("message")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .or_else(|| payload.get("text").and_then(Value::as_str))
                .unwrap_or_default();
            let text = codex_prompt_text(raw);
            let count = |k: &str| {
                payload
                    .get(k)
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or(0)
            };
            let images = count("images") + count("local_images");
            let label = [media_marker(images, "[image]", "[{n} images]"), text]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            if !label.is_empty() {
                let prompt = Event::Prompt {
                    timestamp,
                    text: label.clone(),
                };
                if last_is(&previous, "response_item", &label, events.len()) {
                    let idx = previous.as_ref().unwrap().index;
                    events[idx] = prompt;
                } else {
                    events.push(prompt);
                }
                adjacent = Some(Adjacent {
                    source: "event_msg",
                    index: events.len() - 1,
                    text: label,
                });
            }
        } else if ty == "response_item" {
            if let Some(label) = codex_response_item_prompt(&payload) {
                if !last_is(&previous, "event_msg", &label, events.len()) {
                    events.push(Event::Prompt {
                        timestamp,
                        text: label.clone(),
                    });
                }
                adjacent = Some(Adjacent {
                    source: "response_item",
                    index: events.len() - 1,
                    text: label,
                });
            }
        } else if ty == "event_msg" && pty == "token_count" {
            let Some(u) = payload.get("info").and_then(|i| i.get("last_token_usage")) else {
                continue;
            };
            if u.is_null() {
                continue;
            }
            let cache_read = num(u.get("cached_input_tokens"));
            let tokens = make_tokens(
                (num(u.get("input_tokens")) - cache_read).max(0.0),
                num(u.get("output_tokens")),
                cache_read,
                0.0,
                num(u.get("reasoning_output_tokens")),
            );
            if tokens.total == 0.0 {
                pending_tools.clear();
                continue;
            }
            events.push(Event::Turn {
                timestamp,
                tokens,
                tools: unique(std::mem::take(&mut pending_tools)),
                cost: None,
            });
        }
    }
    events
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub timestamp: String,
    pub tokens: Tokens,
    pub tools: Vec<String>,
    pub cost_estimate: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Exchange {
    pub prompt_preview: String,
    pub started_at: String,
    pub ended_at: String,
    pub turn_count: usize,
    pub tools: Vec<String>,
    pub tokens: Tokens,
    pub cost_estimate: f64,
    pub turns: Vec<Turn>,
}

fn new_exchange(prompt: &str, timestamp: &str) -> Exchange {
    Exchange {
        prompt_preview: prompt.to_string(),
        started_at: timestamp.to_string(),
        ended_at: timestamp.to_string(),
        turn_count: 0,
        tools: Vec::new(),
        tokens: Tokens::default(),
        cost_estimate: 0.0,
        turns: Vec::new(),
    }
}

fn finalize(ex: &mut Exchange) {
    ex.turn_count = ex.turns.len();
    ex.tools = unique(ex.turns.iter().flat_map(|t| t.tools.clone()).collect());
}

/// 上游 `groupEvents`：每則提問開一組，之後的回覆都歸它；開頭沒有提問的回覆自成一組（提問空白）。
pub fn group_events(events: &[Event]) -> Vec<Exchange> {
    let mut out: Vec<Exchange> = Vec::new();
    for e in events {
        match e {
            Event::Prompt { timestamp, text } => {
                if let Some(last) = out.last_mut() {
                    finalize(last);
                }
                out.push(new_exchange(text, timestamp));
            }
            Event::Turn {
                timestamp,
                tokens,
                tools,
                cost,
            } => {
                if out.is_empty() {
                    out.push(new_exchange("", timestamp));
                }
                let ex = out.last_mut().unwrap();
                ex.turns.push(Turn {
                    timestamp: timestamp.clone(),
                    tokens: *tokens,
                    tools: tools.clone(),
                    cost_estimate: cost.unwrap_or(0.0),
                });
                ex.tokens.add(tokens);
                if !timestamp.is_empty() && (ex.started_at.is_empty() || *timestamp < ex.started_at)
                {
                    ex.started_at = timestamp.clone();
                }
                if !timestamp.is_empty() && *timestamp > ex.ended_at {
                    ex.ended_at = timestamp.clone();
                }
            }
        }
    }
    if let Some(last) = out.last_mut() {
        finalize(last);
    }
    out
}

/// 期間的判斷用裝置本地時間（上游 `withinPeriod`）。
fn within(timestamp: &str, period: &str, now: chrono::DateTime<chrono::Local>) -> bool {
    use chrono::Datelike;
    if period != "today" && period != "month" {
        return true;
    }
    let Some(t) = crate::wire::time::parse_js_date(timestamp) else {
        return false;
    };
    let t = t.with_timezone(&chrono::Local);
    if period == "today" {
        t.date_naive() == now.date_naive()
    } else {
        t.year() == now.year() && t.month() == now.month()
    }
}

/// 上游 `filterExchangesByPeriod`：只留期間內的回合，沒有回合的提問整組去掉。
pub fn filter_by_period(
    exchanges: Vec<Exchange>,
    period: &str,
    now: chrono::DateTime<chrono::Local>,
) -> Vec<Exchange> {
    exchanges
        .into_iter()
        .filter_map(|ex| {
            let turns: Vec<Turn> = ex
                .turns
                .into_iter()
                .filter(|t| within(&t.timestamp, period, now))
                .collect();
            if turns.is_empty() {
                return None;
            }
            let mut next = new_exchange(&ex.prompt_preview, &ex.started_at);
            for t in &turns {
                next.tokens.add(&t.tokens);
            }
            next.started_at = turns
                .iter()
                .map(|t| t.timestamp.as_str())
                .filter(|s| !s.is_empty())
                .min()
                .unwrap_or_default()
                .to_string();
            next.ended_at = turns
                .iter()
                .map(|t| t.timestamp.as_str())
                .max()
                .unwrap_or_default()
                .to_string();
            next.turns = turns;
            finalize(&mut next);
            Some(next)
        })
        .collect()
}

/// 上游 `distributeCost`：session 的成本依 token 比例分給每一組與每一輪。
pub fn distribute_cost(exchanges: &mut [Exchange], session_cost: f64) {
    let grand: f64 = exchanges.iter().map(|e| e.tokens.total).sum();
    for ex in exchanges.iter_mut() {
        ex.cost_estimate = if grand > 0.0 {
            session_cost * ex.tokens.total / grand
        } else {
            0.0
        };
        for t in ex.turns.iter_mut() {
            t.cost_estimate = if grand > 0.0 {
                session_cost * t.tokens.total / grand
            } else {
                0.0
            };
        }
    }
}

// ---- 找檔案 ---------------------------------------------------------------------

/// 上游 `isSafeSessionId`：只能是一個路徑片段，不能帶分隔符號或 `..`。
pub fn is_safe_session_id(id: &str) -> bool {
    !id.is_empty() && id != "." && id != ".." && !id.contains(['\0', '/', '\\'])
}

fn find_file(root: &Path, file_name: &str, depth: usize) -> Option<PathBuf> {
    if depth > 8 {
        return None;
    }
    let entries = std::fs::read_dir(root).ok()?;
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_file() && entry.file_name().to_string_lossy() == file_name {
            return Some(entry.path());
        }
        if ft.is_dir() {
            dirs.push(entry.path());
        }
    }
    dirs.into_iter()
        .find_map(|d| find_file(&d, file_name, depth + 1))
}

fn env_dir(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// 上游 `resolveSessionFile`：Claude 先找 projects 再找 transcripts；Codex 先用 rollout 檔名的日期
/// 直接定位，找不到再掃 sessions。
pub fn resolve_session_file(client: &str, session_id: &str, home: &Path) -> Option<PathBuf> {
    if !is_safe_session_id(session_id) {
        return None;
    }
    let file = format!("{session_id}.jsonl");
    match client {
        "claude" => {
            let base = env_dir("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.join(".claude"));
            find_file(&base.join("projects"), &file, 0)
                .or_else(|| find_file(&base.join("transcripts"), &file, 0))
        }
        "codex" => {
            let sessions = env_dir("CODEX_HOME")
                .unwrap_or_else(|| home.join(".codex"))
                .join("sessions");
            let direct = session_id
                .strip_prefix("rollout-")
                .filter(|r| r.len() >= 11 && r.as_bytes()[10] == b'T')
                .map(|r| {
                    sessions
                        .join(&r[0..4])
                        .join(&r[5..7])
                        .join(&r[8..10])
                        .join(&file)
                })
                .filter(|p| p.is_file());
            direct.or_else(|| find_file(&sessions, &file, 0))
        }
        _ => None,
    }
}

// ---- OpenCode（SQLite）-------------------------------------------------------------

fn opencode_db_paths(home: &Path) -> Vec<PathBuf> {
    if let Some(p) = env_dir("OPENCODE_DB").filter(|p| p.is_file()) {
        return vec![p];
    }
    let data = env_dir("XDG_DATA_HOME")
        .unwrap_or_else(|| home.join(".local").join("share"))
        .join("opencode");
    let Ok(entries) = std::fs::read_dir(&data) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("opencode") && n.ends_with(".db"))
        })
        .collect();
    out.sort();
    out
}

/// 上游 providers/opencode/session.js `readSessionEvents`：每則使用者訊息是一個邊界，助理訊息帶真實成本。
pub fn read_opencode_events(session_id: &str, home: &Path) -> Option<Vec<Event>> {
    for db in opencode_db_paths(home) {
        let Ok(conn) =
            rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        else {
            continue;
        };
        let _ = conn.busy_timeout(std::time::Duration::from_millis(250));
        let messages: Vec<(String, i64, String, f64, [f64; 5])> = match conn.prepare(
            "SELECT id,
                    CAST(COALESCE(json_extract(data,'$.time.created'), time_created) AS INTEGER),
                    COALESCE(json_extract(data,'$.role'), ''),
                    COALESCE(json_extract(data,'$.cost'), 0),
                    COALESCE(json_extract(data,'$.tokens.input'), 0),
                    COALESCE(json_extract(data,'$.tokens.output'), 0),
                    COALESCE(json_extract(data,'$.tokens.reasoning'), 0),
                    COALESCE(json_extract(data,'$.tokens.cache.read'), 0),
                    COALESCE(json_extract(data,'$.tokens.cache.write'), 0)
             FROM message WHERE session_id = ?1 AND json_valid(data)
             ORDER BY 2 ASC, id ASC",
        ) {
            Ok(mut stmt) => stmt
                .query_map([session_id], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                        r.get::<_, String>(2)?,
                        r.get::<_, f64>(3).unwrap_or(0.0),
                        [
                            r.get::<_, f64>(4).unwrap_or(0.0),
                            r.get::<_, f64>(5).unwrap_or(0.0),
                            r.get::<_, f64>(6).unwrap_or(0.0),
                            r.get::<_, f64>(7).unwrap_or(0.0),
                            r.get::<_, f64>(8).unwrap_or(0.0),
                        ],
                    ))
                })
                .map(|rows| rows.flatten().collect())
                .unwrap_or_default(),
            Err(_) => continue,
        };
        if messages.is_empty() {
            continue;
        }
        let mut text_by: HashMap<String, Vec<String>> = HashMap::new();
        let mut tools_by: HashMap<String, Vec<String>> = HashMap::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT message_id, COALESCE(json_extract(data,'$.type'),''), COALESCE(json_extract(data,'$.text'),''),
                    COALESCE(json_extract(data,'$.tool'),'')
             FROM part WHERE session_id = ?1 AND json_valid(data) ORDER BY time_created ASC, id ASC",
        ) {
            if let Ok(rows) = stmt.query_map([session_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))
            }) {
                for (mid, ty, text, tool) in rows.flatten() {
                    if ty == "text" && !text.is_empty() {
                        text_by.entry(mid).or_default().push(text);
                    } else if ty == "tool" && !tool.is_empty() {
                        tools_by.entry(mid).or_default().push(tool);
                    }
                }
            }
        }
        let iso = |ms: i64| crate::wire::time::iso_from_ms(ms).unwrap_or_default();
        let events = messages
            .into_iter()
            .filter_map(|(id, ms, role, cost, t)| match role.as_str() {
                "user" => Some(Event::Prompt {
                    timestamp: iso(ms),
                    text: text_by
                        .get(&id)
                        .map(|v| v.join(" "))
                        .unwrap_or_default()
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" "),
                }),
                "assistant" => Some(Event::Turn {
                    timestamp: iso(ms),
                    tokens: make_tokens(t[0], t[1], t[3], t[4], t[2]),
                    tools: unique(tools_by.get(&id).cloned().unwrap_or_default()),
                    cost: Some(cost),
                }),
                _ => None,
            })
            .collect();
        return Some(events);
    }
    None
}

// ---- 對外 -------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    pub found: bool,
    pub client: String,
    pub session_id: String,
    pub period: String,
    pub exchanges: Vec<Exchange>,
    pub total_tokens: f64,
    pub cost_usd: f64,
    pub turn_count: usize,
}

/// 支援逐回合明細的工具（上游 renderer 同樣只讓這幾個 session 可以點開）。
pub const DETAIL_CLIENTS: &[&str] = &["claude", "codex", "opencode"];

/// 上游 `readSessionDetail`。`session_cost` 是清單上那個 session 在這段期間的成本（Claude / Codex 用它分攤）。
pub fn read_session_detail(
    client: &str,
    session_id: &str,
    period: &str,
    session_cost: f64,
    home: &Path,
    now: chrono::DateTime<chrono::Local>,
) -> SessionDetail {
    let empty = |found: bool| SessionDetail {
        found,
        client: client.to_string(),
        session_id: session_id.to_string(),
        period: period.to_string(),
        exchanges: Vec::new(),
        total_tokens: 0.0,
        cost_usd: session_cost,
        turn_count: 0,
    };
    let (events, real_cost) = match client {
        "opencode" => match read_opencode_events(session_id, home) {
            Some(e) => (e, true),
            None => return empty(false),
        },
        "claude" | "codex" => {
            let Some(path) = resolve_session_file(client, session_id, home) else {
                return empty(false);
            };
            let Ok(text) = std::fs::read_to_string(&path) else {
                return empty(false);
            };
            (
                if client == "claude" {
                    parse_claude(&text)
                } else {
                    parse_codex(&text)
                },
                false,
            )
        }
        _ => return empty(false),
    };
    let mut exchanges = filter_by_period(group_events(&events), period, now);
    let cost = if real_cost {
        for ex in exchanges.iter_mut() {
            ex.cost_estimate = ex.turns.iter().map(|t| t.cost_estimate).sum();
        }
        exchanges.iter().map(|e| e.cost_estimate).sum()
    } else {
        distribute_cost(&mut exchanges, session_cost);
        session_cost
    };
    SessionDetail {
        found: true,
        client: client.to_string(),
        session_id: session_id.to_string(),
        period: period.to_string(),
        total_tokens: exchanges.iter().map(|e| e.tokens.total).sum(),
        turn_count: exchanges.iter().map(|e| e.turn_count).sum(),
        cost_usd: cost,
        exchanges,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn lines(rows: &[Value]) -> String {
        rows.iter()
            .map(|r| r.to_string())
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn claude_dedupes_replays_and_split_replies() {
        let usage = json!({ "input_tokens": 1, "output_tokens": 2, "cache_read_input_tokens": 3, "cache_creation_input_tokens": 4 });
        let text = lines(&[
            json!({ "type": "user", "uuid": "u0", "message": { "content": "<command-name>/clear</command-name>" } }),
            json!({ "type": "user", "uuid": "u1", "timestamp": "t1", "message": { "content": "hi [Image: source: x.png] [Image #1]" } }),
            json!({ "type": "assistant", "uuid": "a1", "timestamp": "t2", "message": { "id": "m1", "usage": usage, "content": [] } }),
            json!({ "type": "assistant", "uuid": "a2", "timestamp": "t3", "message": { "id": "m1", "usage": usage, "content": [{ "type": "tool_use", "name": "Bash" }] } }),
            json!({ "type": "assistant", "uuid": "a2", "timestamp": "t3", "message": { "id": "m9", "usage": usage } }),
            json!({ "type": "user", "uuid": "u2", "message": { "content": [{ "type": "tool_result" }] } }),
        ]);
        let events = parse_claude(&text);
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[0],
            Event::Prompt {
                timestamp: "t1".into(),
                text: "hi [Image #1]".into()
            }
        );
        let Event::Turn { tokens, tools, .. } = &events[1] else {
            panic!("turn")
        };
        assert_eq!(tokens.total, 10.0);
        assert_eq!(tools, &vec!["Bash".to_string()]);
    }

    #[test]
    fn codex_keeps_one_prompt_per_twin_and_splits_cache() {
        let text = lines(&[
            json!({ "type": "response_item", "timestamp": "t1", "payload": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "## My request for Codex:\nfix it" }] } }),
            json!({ "type": "event_msg", "timestamp": "t1", "payload": { "type": "user_message", "message": "fix it" } }),
            json!({ "type": "response_item", "payload": { "type": "function_call", "name": "shell" } }),
            json!({ "type": "event_msg", "timestamp": "t2", "payload": { "type": "token_count", "info": { "last_token_usage": { "input_tokens": 100, "cached_input_tokens": 80, "output_tokens": 10, "reasoning_output_tokens": 4 } } } }),
        ]);
        let events = parse_codex(&text);
        assert_eq!(events.len(), 2);
        let Event::Turn { tokens, tools, .. } = &events[1] else {
            panic!("turn")
        };
        assert_eq!(
            (
                tokens.input,
                tokens.cache_read,
                tokens.output,
                tokens.reasoning,
                tokens.total
            ),
            (20.0, 80.0, 10.0, 4.0, 110.0)
        );
        assert_eq!(tools, &vec!["shell".to_string()]);
    }

    #[test]
    fn grouping_filtering_and_cost_split() {
        let t = |ts: &str, total: f64| Event::Turn {
            timestamp: ts.into(),
            tokens: make_tokens(total, 0.0, 0.0, 0.0, 0.0),
            tools: vec![],
            cost: None,
        };
        let events = vec![
            t("2026-09-23T10:00:00Z", 10.0),
            Event::Prompt {
                timestamp: "2026-09-24T01:00:00Z".into(),
                text: "q".into(),
            },
            t("2026-09-24T01:00:05Z", 30.0),
        ];
        let grouped = group_events(&events);
        assert_eq!(grouped.len(), 2);
        assert_eq!(
            grouped[0].prompt_preview, "",
            "turns before any prompt form their own group"
        );
        let now = chrono::DateTime::parse_from_rfc3339("2026-09-24T12:00:00+08:00")
            .unwrap()
            .with_timezone(&chrono::Local);
        let today = filter_by_period(grouped.clone(), "today", now);
        assert_eq!(today.len(), 1);
        let mut all = filter_by_period(grouped, "total", now);
        distribute_cost(&mut all, 4.0);
        assert_eq!(all[0].cost_estimate, 1.0);
        assert_eq!(all[1].cost_estimate, 3.0);
    }

    #[test]
    fn session_ids_cannot_escape_the_log_folder() {
        assert!(is_safe_session_id("rollout-2026-09-24T10-00-00-abc"));
        for bad in ["", ".", "..", "a/b", r"a\b", r"..\x"] {
            assert!(!is_safe_session_id(bad), "{bad:?}");
        }
        let home = std::env::temp_dir().join("tm-no-such-home");
        assert!(
            !read_session_detail("claude", "../x", "total", 0.0, &home, chrono::Local::now()).found
        );
        assert!(
            !read_session_detail("cursor", "abc", "total", 0.0, &home, chrono::Local::now()).found
        );
    }
}
