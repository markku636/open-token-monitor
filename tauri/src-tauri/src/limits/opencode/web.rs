//! opencode.ai 的 cookie 路徑（上游 providers/opencode/web.js，逐條移植）。
//!
//! - workspace：TanStack server function（`_server?id=…`）回的是 text/javascript，常常不是 JSON，
//!   所以先試 JSON、再用與上游相同的正規表示式規則（這裡手寫比對，不引入 regex crate）。
//! - Go 額度：`/workspace/<id>/go` 頁面裡的 rollingUsage / weeklyUsage / monthlyUsage。
//! - Zen：訂閱的 server function，取 rolling / weekly 窗口與預付餘額。
//! - server function 的 id 是 opencode.ai 的建置雜湊，改版可能失效（上游跟著 codexbar 更新）。

use serde_json::Value;

use super::transport::{
    clamp_pct, js_date_parse, js_iso, js_space, js_string_to_number, round1, HttpRequest,
    HttpResponse, Transport,
};
use super::OpencodeEnv;
use crate::wire::{LimitWindow, ProviderStatus, WindowKind};

pub const BASE_URL: &str = "https://opencode.ai";
pub const SERVER_URL: &str = "https://opencode.ai/_server";
pub const WORKSPACES_SERVER_ID: &str =
    "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";
pub const SUBSCRIPTION_SERVER_ID: &str =
    "7abeebee372f304e050aaaf92be863f4a86490e382f8c79db68fd94040d691b4";
/// 上游 browserUserAgent.js（與 limits/cursor.rs 同一個值）。
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

const PCT_KEYS: &[&str] = &[
    "usagePercent",
    "usedPercent",
    "percentUsed",
    "percent",
    "usage_percent",
    "used_percent",
    "utilization",
    "utilizationPercent",
    "utilization_percent",
    "usage",
];
const RESET_SEC_KEYS: &[&str] = &[
    "resetInSec",
    "resetInSeconds",
    "resetSeconds",
    "reset_sec",
    "reset_in_sec",
    "resetsInSec",
    "resetsInSeconds",
    "resetIn",
    "resetSec",
];
const RESET_AT_KEYS: &[&str] = &[
    "resetAt",
    "resetsAt",
    "reset_at",
    "resets_at",
    "nextReset",
    "next_reset",
    "renewAt",
    "renew_at",
];
const BALANCE_KEYS: &[&str] = &[
    "balanceUSD",
    "balanceUsd",
    "currentBalance",
    "zenBalance",
    "currentBalanceUSD",
];

/// 上游 `GO_WINDOW_MINUTES`。
pub const SESSION_MINUTES: f64 = 300.0;
pub const WEEKLY_MINUTES: f64 = 10080.0;
pub const MONTHLY_MINUTES: f64 = 43200.0;

/// `new Date(...).toISOString()` 丟 RangeError 的情況（重置時間大到超出日期範圍）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RangeError;

/// 上游 `sanitizeCookieHeader`：去掉 `Cookie:` 前綴、整理分號；沒有 `name=` 的裸值當成 `auth` cookie。
pub fn sanitize_cookie_header(raw: &str) -> String {
    let text = raw.trim_matches(js_space);
    if text.is_empty() {
        return String::new();
    }
    let text = strip_cookie_prefix(text);
    let cleaned = text
        .split(';')
        .map(|p| p.trim_matches(js_space))
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("; ");
    if !cleaned.is_empty() && !cleaned.contains('=') {
        return format!("auth={cleaned}");
    }
    cleaned
}

/// `/^cookie\s*:\s*/i`
fn strip_cookie_prefix(text: &str) -> &str {
    let bytes = text.as_bytes();
    if bytes.len() < 6 || !bytes[..6].eq_ignore_ascii_case(b"cookie") {
        return text;
    }
    let rest = text[6..].trim_start_matches(js_space);
    match rest.strip_prefix(':') {
        Some(after) => after.trim_start_matches(js_space),
        None => text,
    }
}

/// 上游 `serverRequestUrl`：GET 把 id 與 args 放在 query（URLSearchParams 的編碼），POST 打固定網址。
pub fn server_request_url(server_id: &str, args: Option<&Value>, method: &str) -> String {
    if !method.eq_ignore_ascii_case("GET") {
        return SERVER_URL.into();
    }
    let mut q = url::form_urlencoded::Serializer::new(String::new());
    q.append_pair("id", server_id);
    if let Some(Value::Array(a)) = args {
        if !a.is_empty() {
            q.append_pair("args", &Value::Array(a.clone()).to_string());
        }
    }
    format!("{SERVER_URL}?{}", q.finish())
}

fn server_headers(server_id: &str, cookie: &str, referer: &str) -> Vec<(&'static str, String)> {
    vec![
        ("Cookie", cookie.to_string()),
        ("X-Server-Id", server_id.to_string()),
        (
            "X-Server-Instance",
            format!("server-fn:{}", uuid::Uuid::new_v4()),
        ),
        ("User-Agent", BROWSER_USER_AGENT.to_string()),
        ("Origin", BASE_URL.to_string()),
        ("Referer", referer.to_string()),
        (
            "Accept",
            "text/javascript, application/json;q=0.9, */*;q=0.8".to_string(),
        ),
    ]
}

/// 上游 `asNum`：有限數字，或非空字串的 `Number()`。
fn as_num(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()),
        Value::String(s) if !s.trim_matches(js_space).is_empty() => {
            Some(js_string_to_number(s)).filter(|f| f.is_finite())
        }
        _ => None,
    }
}

/// 上游 `toMs`：大於 1e12 當毫秒、大於 1e9 當秒，其他數字不算；字串交給日期解析。
fn to_ms(v: Option<&Value>) -> Option<f64> {
    if let Some(n) = as_num(v) {
        return if n > 1e12 {
            Some(n)
        } else if n > 1e9 {
            Some(n * 1000.0)
        } else {
            None
        };
    }
    match v? {
        Value::String(s) => js_date_parse(s),
        _ => None,
    }
}

/// `obj[k]` 第一個不是 undefined 的（null 也算）。陣列沒有這些字串鍵。
fn pick<'a>(obj: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    let o = obj.as_object()?;
    keys.iter().find_map(|k| o.get(*k))
}

fn get<'a>(obj: &'a Value, key: &str) -> Option<&'a Value> {
    obj.as_object()?.get(key)
}

fn is_object(v: &Value) -> bool {
    matches!(v, Value::Object(_) | Value::Array(_))
}

/// `Object.entries(v)` 的值（陣列依索引）。
fn values(v: &Value) -> Box<dyn Iterator<Item = &Value> + '_> {
    match v {
        Value::Object(o) => Box::new(o.values()),
        Value::Array(a) => Box::new(a.iter()),
        _ => Box::new(std::iter::empty()),
    }
}

/// 上游 `parseWorkspaceIds`：`id: "wrk_…"`（或 `id="wrk_…"`）全部找出來；一個都沒有時才把回應當 JSON
/// 走一遍，找 `wrk_` 開頭的字串。
pub fn parse_workspace_ids(text: &str) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    let mut pos = 0;
    while let Some(off) = text[pos..].find("id") {
        let start = pos + off;
        match match_workspace_id(&text[start + 2..]) {
            Some((id, len)) => {
                if !ids.iter().any(|x| x == id) {
                    ids.push(id.to_string());
                }
                pos = start + 2 + len;
            }
            None => pos = start + 1,
        }
    }
    if ids.is_empty() {
        if let Ok(root) = serde_json::from_str::<Value>(text) {
            fn walk(v: &Value, out: &mut Vec<String>) {
                match v {
                    Value::String(s) if s.starts_with("wrk_") => {
                        if !out.contains(s) {
                            out.push(s.clone());
                        }
                    }
                    Value::Array(_) | Value::Object(_) => {
                        for child in values(v) {
                            walk(child, out);
                        }
                    }
                    _ => {}
                }
            }
            walk(&root, &mut ids);
        }
    }
    ids
}

/// `\s*[:=]\s*"(wrk_[^"]+)"`：回傳擷取到的 id 與整段比對的長度。
fn match_workspace_id(s: &str) -> Option<(&str, usize)> {
    let rest = s.trim_start_matches(js_space);
    let rest = rest.strip_prefix([':', '='])?;
    let rest = rest.trim_start_matches(js_space);
    let rest = rest.strip_prefix('"')?;
    if !rest.starts_with("wrk_") {
        return None;
    }
    let close = rest.find('"')?;
    if close <= 4 {
        return None;
    }
    let consumed = s.len() - rest.len() + close + 1;
    Some((&rest[..close], consumed))
}

fn window(kind: WindowKind, used_percent: f64, resets_at: String, minutes: f64) -> LimitWindow {
    LimitWindow {
        used_percent: Some(used_percent),
        resets_at: Some(resets_at),
        window_minutes: Some(minutes),
        ..LimitWindow::new(kind)
    }
}

fn resets_at(now_ms: i64, reset_sec: f64) -> Result<String, RangeError> {
    js_iso(now_ms as f64 + reset_sec * 1000.0).ok_or(RangeError)
}

/// 上游 `parseWindowObj`。注意 0–1 之間的百分比會乘以 100（上游的行為，照抄）。
fn parse_window_obj(
    obj: Option<&Value>,
    kind: WindowKind,
    minutes: f64,
    now_ms: i64,
) -> Result<Option<LimitWindow>, RangeError> {
    let Some(obj) = obj.filter(|v| is_object(v)) else {
        return Ok(None);
    };
    let mut pct = PCT_KEYS.iter().find_map(|k| as_num(get(obj, k)));
    if pct.is_none() {
        let used = as_num(pick(obj, &["used", "consumed"]));
        let limit = as_num(pick(obj, &["limit", "total", "quota", "max", "cap"]));
        if let (Some(u), Some(l)) = (used, limit) {
            if l > 0.0 {
                pct = Some(u / l * 100.0);
            }
        }
    }
    let Some(mut pct) = pct else {
        return Ok(None);
    };
    if (0.0..=1.0).contains(&pct) {
        pct *= 100.0;
    }
    let pct = round1(clamp_pct(pct));
    let mut reset_sec = RESET_SEC_KEYS.iter().find_map(|k| as_num(get(obj, k)));
    if reset_sec.is_none() {
        if let Some(ms) = to_ms(pick(obj, RESET_AT_KEYS)) {
            reset_sec = Some((((ms - now_ms as f64) / 1000.0).round()).max(0.0));
        }
    }
    let reset_sec = reset_sec.unwrap_or(0.0).max(0.0);
    Ok(Some(window(
        kind,
        pct,
        resets_at(now_ms, reset_sec)?,
        minutes,
    )))
}

/// 上游 `findByKeyword`：先看這一層的鍵名（小寫包含 keyword 且值是物件），再往下找，最多 4 層。
fn find_by_keyword<'a>(obj: &'a Value, keyword: &str, depth: usize) -> Option<&'a Value> {
    if !is_object(obj) || depth > 4 {
        return None;
    }
    if let Value::Object(o) = obj {
        for (k, v) in o {
            if k.to_lowercase().contains(keyword) && is_object(v) {
                return Some(v);
            }
        }
    }
    values(obj)
        .filter(|v| is_object(v))
        .find_map(|v| find_by_keyword(v, keyword, depth + 1))
}

/// 上游 `findBalance`。
fn find_balance(obj: &Value, depth: usize) -> Option<f64> {
    if !is_object(obj) || depth > 4 {
        return None;
    }
    if let Some(n) = BALANCE_KEYS.iter().find_map(|k| as_num(get(obj, k))) {
        return Some(n);
    }
    values(obj)
        .filter(|v| is_object(v))
        .find_map(|v| find_balance(v, depth + 1))
}

/// `[0-9]+(?:\.[0-9]+)?`（或只有整數），從開頭比對。
fn leading_number(s: &str, decimal: bool) -> Option<&str> {
    let int = s.bytes().take_while(u8::is_ascii_digit).count();
    if int == 0 {
        return None;
    }
    let mut end = int;
    if decimal && s.as_bytes().get(int) == Some(&b'.') {
        let frac = s[int + 1..].bytes().take_while(u8::is_ascii_digit).count();
        if frac > 0 {
            end = int + 1 + frac;
        }
    }
    Some(&s[..end])
}

/// `KEY[^}]*?FIELD\s*[SEP]\s*(數字)`：第一個比對成功的擷取（正規表示式最左、最短的語意）。
fn capture_after_key<'a>(
    text: &'a str,
    key: &str,
    field: &str,
    seps: &[char],
    decimal: bool,
) -> Option<&'a str> {
    let mut search = 0;
    while let Some(off) = text[search..].find(key) {
        let start = search + off;
        let mut k = start + key.len();
        loop {
            let at = &text[k..];
            if let Some(rest) = at.strip_prefix(field) {
                let rest = rest.trim_start_matches(js_space);
                if let Some(rest) = rest.strip_prefix(seps) {
                    if let Some(n) = leading_number(rest.trim_start_matches(js_space), decimal) {
                        return Some(n);
                    }
                }
            }
            match at.chars().next() {
                None | Some('}') => break,
                Some(c) => k += c.len_utf8(),
            }
        }
        search = start + 1;
    }
    None
}

/// 上游 `extractWindowByRegex`（Zen，`:`）與 `extractGoWindow`（Go 頁面，`[:=]`）。
fn window_by_pattern(
    text: &str,
    key: &str,
    seps: &[char],
    kind: WindowKind,
    minutes: f64,
    now_ms: i64,
) -> Result<Option<LimitWindow>, RangeError> {
    let Some(pct) = capture_after_key(text, key, "usagePercent", seps, true) else {
        return Ok(None);
    };
    let reset_sec = capture_after_key(text, key, "resetInSec", seps, false)
        .map(|n| n.parse::<f64>().unwrap_or(0.0).max(0.0))
        .unwrap_or(0.0);
    let pct = round1(clamp_pct(pct.parse::<f64>().unwrap_or(0.0)));
    Ok(Some(window(
        kind,
        pct,
        resets_at(now_ms, reset_sec)?,
        minutes,
    )))
}

/// `/(?:balanceUSD|currentBalance|zenBalance|balanceUsd)[^0-9-]{0,20}([0-9]+(?:\.[0-9]+)?)/i`
fn balance_by_pattern(text: &str) -> Option<f64> {
    const ALTS: [&[u8]; 3] = [b"balanceusd", b"currentbalance", b"zenbalance"];
    for (i, _) in text.char_indices() {
        let rest = &text[i..];
        for alt in ALTS {
            if rest.len() < alt.len() || !rest.as_bytes()[..alt.len()].eq_ignore_ascii_case(alt) {
                continue;
            }
            let tail = &rest[alt.len()..];
            // `{0,20}` 數的是 UTF-16 單位；中間不能有數字或 `-`，所以貪婪吃完後下一個必須是數字。
            let (mut units, mut consumed) = (0usize, 0usize);
            for c in tail.chars() {
                if c.is_ascii_digit() || c == '-' || units + c.len_utf16() > 20 {
                    break;
                }
                units += c.len_utf16();
                consumed += c.len_utf8();
            }
            if let Some(n) = leading_number(&tail[consumed..], true) {
                return n.parse().ok();
            }
        }
    }
    None
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Subscription {
    pub windows: Vec<LimitWindow>,
    pub balance_usd: Option<f64>,
}

fn is_explicit_null(text: &str) -> bool {
    text.trim_matches(js_space).to_lowercase() == "null"
}

/// 上游 `parseSubscription`：先試 JSON，拿不到窗口再用字面比對；餘額同理。
/// 字面比對的 RangeError 在上游不在 try 裡，會一路丟到 `fetchZen` 的 catch（unavailable），所以往外回。
pub fn parse_subscription(text: &str, now_ms: i64) -> Result<Subscription, RangeError> {
    if is_explicit_null(text) {
        return Ok(Subscription::default());
    }
    let mut windows = Vec::new();
    let mut balance_usd = None;
    if let Ok(root) = serde_json::from_str::<Value>(text) {
        if !root.is_null() {
            // 上游整段包在 try 裡：任何一個窗口丟 RangeError，這一段的結果（含餘額）都不算。
            let attempt = (|| -> Result<(Vec<LimitWindow>, Option<f64>), RangeError> {
                let w1 = parse_window_obj(
                    find_by_keyword(&root, "rolling", 0),
                    WindowKind::Session,
                    SESSION_MINUTES,
                    now_ms,
                )?;
                let w2 = parse_window_obj(
                    find_by_keyword(&root, "weekly", 0)
                        .or_else(|| find_by_keyword(&root, "week", 0)),
                    WindowKind::Weekly,
                    WEEKLY_MINUTES,
                    now_ms,
                )?;
                Ok((w1.into_iter().chain(w2).collect(), find_balance(&root, 0)))
            })();
            if let Ok((w, b)) = attempt {
                windows = w;
                balance_usd = b;
            }
        }
    }
    if windows.is_empty() {
        let r1 = window_by_pattern(
            text,
            "rollingUsage",
            &[':'],
            WindowKind::Session,
            SESSION_MINUTES,
            now_ms,
        )?;
        let r2 = window_by_pattern(
            text,
            "weeklyUsage",
            &[':'],
            WindowKind::Weekly,
            WEEKLY_MINUTES,
            now_ms,
        )?;
        windows.extend(r1);
        windows.extend(r2);
    }
    if balance_usd.is_none() {
        balance_usd = balance_by_pattern(text);
    }
    Ok(Subscription {
        windows,
        balance_usd,
    })
}

/// 上游 `looksSignedOut`：回應裡出現登入頁的字樣就當成沒登入（包含任何含 `login` 的頁面，照抄）。
pub fn looks_signed_out(text: &str) -> bool {
    let l = text.to_lowercase();
    l.contains("login")
        || l.contains("sign in")
        || l.contains("auth/authorize")
        || l.contains("not associated with an account")
        || l.contains("actor of type \"public\"")
}

/// 上游 `normalizeWorkspaceId`：`wrk_…` 或含它的網址。
pub fn normalize_workspace_id(raw: &str) -> Option<String> {
    let mut search = 0;
    while let Some(off) = raw[search..].find("wrk_") {
        let start = search + off;
        let len = raw[start + 4..]
            .bytes()
            .take_while(u8::is_ascii_alphanumeric)
            .count();
        if len > 0 {
            return Some(raw[start..start + 4 + len].to_string());
        }
        search = start + 1;
    }
    None
}

async fn server_text<T: Transport>(
    t: &T,
    server_id: &str,
    args: Option<Value>,
    method: &'static str,
    referer: &str,
    cookie: &str,
) -> Result<HttpResponse, String> {
    let url = server_request_url(server_id, args.as_ref(), method);
    let mut headers = server_headers(server_id, cookie, referer);
    let mut body = None;
    if method != "GET" {
        if let Some(Value::Array(a)) = &args {
            headers.push(("Content-Type", "application/json".into()));
            body = Some(Value::Array(a.clone()).to_string());
        }
    }
    t.send(HttpRequest {
        method,
        url,
        headers,
        body,
    })
    .await
}

#[derive(Debug, Clone, PartialEq)]
enum Workspace {
    Ok(String),
    Failed(ProviderStatus),
}

/// 上游 `resolveWorkspaceId`：`TOKEN_MONITOR_OPENCODE_WORKSPACE_ID` 優先；否則 GET、找不到再 POST。
/// 網路錯誤往外丟（呼叫端當 unavailable）。
async fn resolve_workspace<T: Transport>(
    t: &T,
    cookie: &str,
    env: &OpencodeEnv,
) -> Result<Workspace, String> {
    if let Some(id) = normalize_workspace_id(env.var("TOKEN_MONITOR_OPENCODE_WORKSPACE_ID")) {
        return Ok(Workspace::Ok(id));
    }
    let r = server_text(t, WORKSPACES_SERVER_ID, None, "GET", BASE_URL, cookie).await?;
    if r.status == 401 || r.status == 403 || looks_signed_out(&r.text) {
        return Ok(Workspace::Failed(ProviderStatus::Unauthorized));
    }
    let mut ids = parse_workspace_ids(&r.text);
    if ids.is_empty() {
        let r = server_text(
            t,
            WORKSPACES_SERVER_ID,
            Some(Value::Array(vec![])),
            "POST",
            BASE_URL,
            cookie,
        )
        .await?;
        if looks_signed_out(&r.text) {
            return Ok(Workspace::Failed(ProviderStatus::Unauthorized));
        }
        ids = parse_workspace_ids(&r.text);
    }
    Ok(match ids.into_iter().next() {
        Some(id) => Workspace::Ok(id),
        None => Workspace::Failed(ProviderStatus::Unavailable),
    })
}

/// `fetchZen` 的結果。
#[derive(Debug, Clone, PartialEq)]
pub struct Zen {
    pub status: ProviderStatus,
    pub workspace_id: String,
    pub windows: Vec<LimitWindow>,
    pub balance_usd: Option<f64>,
}

impl Zen {
    fn failed(status: ProviderStatus) -> Zen {
        Zen {
            status,
            workspace_id: String::new(),
            windows: Vec::new(),
            balance_usd: None,
        }
    }
}

fn bad_subscription_status(r: &HttpResponse) -> Option<ProviderStatus> {
    if r.status == 429 {
        return Some(ProviderStatus::SourceRateLimited);
    }
    if r.status == 401 || r.status == 403 || looks_signed_out(&r.text) {
        return Some(ProviderStatus::Unauthorized);
    }
    None
}

/// 上游 `fetchZen`：Zen 的窗口與預付餘額。
pub async fn fetch_zen<T: Transport>(
    t: &T,
    raw_cookie: &str,
    env: &OpencodeEnv,
    now_ms: i64,
) -> Zen {
    let cookie = sanitize_cookie_header(raw_cookie);
    if cookie.is_empty() {
        return Zen::failed(ProviderStatus::NotConfigured);
    }
    let run = async {
        let workspace_id = match resolve_workspace(t, &cookie, env).await? {
            Workspace::Ok(id) => id,
            Workspace::Failed(s) => return Ok(Zen::failed(s)),
        };
        let referer = format!("{BASE_URL}/workspace/{workspace_id}/billing");
        let args = Value::Array(vec![Value::String(workspace_id.clone())]);
        let r = server_text(
            t,
            SUBSCRIPTION_SERVER_ID,
            Some(args.clone()),
            "GET",
            &referer,
            &cookie,
        )
        .await?;
        if let Some(bad) = bad_subscription_status(&r) {
            return Ok(Zen::failed(bad));
        }
        let out_of_range = |_| "subscription reset is out of range".to_string();
        let mut parsed = parse_subscription(&r.text, now_ms).map_err(out_of_range)?;
        // GET 什麼都沒有、而且不是明確的 `null`（沒有訂閱資料）時才用 POST 再試一次。
        if parsed.windows.is_empty() && parsed.balance_usd.is_none() && !is_explicit_null(&r.text) {
            let r = server_text(
                t,
                SUBSCRIPTION_SERVER_ID,
                Some(args),
                "POST",
                &referer,
                &cookie,
            )
            .await?;
            if let Some(bad) = bad_subscription_status(&r) {
                return Ok(Zen::failed(bad));
            }
            parsed = parse_subscription(&r.text, now_ms).map_err(out_of_range)?;
        }
        Ok::<Zen, String>(Zen {
            status: ProviderStatus::Ok,
            workspace_id,
            windows: parsed.windows,
            balance_usd: parsed.balance_usd,
        })
    };
    run.await
        .unwrap_or_else(|_| Zen::failed(ProviderStatus::Unavailable))
}

fn parse_go_usage_json(text: &str, now_ms: i64) -> Result<Vec<LimitWindow>, RangeError> {
    let Ok(root) = serde_json::from_str::<Value>(text) else {
        return Ok(Vec::new());
    };
    if !is_object(&root) {
        return Ok(Vec::new());
    }
    let rolling = parse_window_obj(
        find_by_keyword(&root, "rolling", 0),
        WindowKind::Session,
        SESSION_MINUTES,
        now_ms,
    )?;
    let weekly = parse_window_obj(
        find_by_keyword(&root, "weekly", 0).or_else(|| find_by_keyword(&root, "week", 0)),
        WindowKind::Weekly,
        WEEKLY_MINUTES,
        now_ms,
    )?;
    let monthly = parse_window_obj(
        find_by_keyword(&root, "monthly", 0).or_else(|| find_by_keyword(&root, "month", 0)),
        WindowKind::Billing,
        MONTHLY_MINUTES,
        now_ms,
    )?;
    let (Some(rolling), Some(weekly)) = (rolling, weekly) else {
        return Ok(Vec::new());
    };
    Ok([Some(rolling), Some(weekly), monthly]
        .into_iter()
        .flatten()
        .collect())
}

/// 上游 web.js `parseGoUsage`：5 小時與每週必須都有，每月可有可無。
pub fn parse_go_usage(text: &str, now_ms: i64) -> Result<Vec<LimitWindow>, RangeError> {
    let from_json = parse_go_usage_json(text, now_ms)?;
    if !from_json.is_empty() {
        return Ok(from_json);
    }
    let seps = &[':', '='];
    let rolling = window_by_pattern(
        text,
        "rollingUsage",
        seps,
        WindowKind::Session,
        SESSION_MINUTES,
        now_ms,
    )?;
    let weekly = window_by_pattern(
        text,
        "weeklyUsage",
        seps,
        WindowKind::Weekly,
        WEEKLY_MINUTES,
        now_ms,
    )?;
    let (Some(rolling), Some(weekly)) = (rolling, weekly) else {
        return Ok(Vec::new());
    };
    let monthly = window_by_pattern(
        text,
        "monthlyUsage",
        seps,
        WindowKind::Billing,
        MONTHLY_MINUTES,
        now_ms,
    )?;
    Ok([Some(rolling), Some(weekly), monthly]
        .into_iter()
        .flatten()
        .collect())
}

/// `fetchGoWeb` 的結果。workspaceId 在解析失敗時也帶著（上游讓呼叫端給 Zen 重用）。
#[derive(Debug, Clone, PartialEq)]
pub struct GoWeb {
    pub status: ProviderStatus,
    pub workspace_id: String,
    pub windows: Vec<LimitWindow>,
}

impl GoWeb {
    fn failed(status: ProviderStatus, workspace_id: String) -> GoWeb {
        GoWeb {
            status,
            workspace_id,
            windows: Vec::new(),
        }
    }
}

/// 上游 `fetchGoWeb`：Go 的 dashboard 頁面上的真實額度。
pub async fn fetch_go_web<T: Transport>(
    t: &T,
    raw_cookie: &str,
    env: &OpencodeEnv,
    now_ms: i64,
) -> GoWeb {
    let cookie = sanitize_cookie_header(raw_cookie);
    if cookie.is_empty() {
        return GoWeb::failed(ProviderStatus::NotConfigured, String::new());
    }
    let run = async {
        let workspace_id = match resolve_workspace(t, &cookie, env).await? {
            Workspace::Ok(id) => id,
            Workspace::Failed(s) => return Ok(GoWeb::failed(s, String::new())),
        };
        let page = t
            .send(HttpRequest {
                method: "GET",
                url: format!("{BASE_URL}/workspace/{workspace_id}/go"),
                headers: vec![
                    ("Cookie", cookie.clone()),
                    ("User-Agent", BROWSER_USER_AGENT.to_string()),
                    (
                        "Accept",
                        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
                            .to_string(),
                    ),
                ],
                body: None,
            })
            .await?;
        if page.status == 429 {
            return Ok(GoWeb::failed(
                ProviderStatus::SourceRateLimited,
                workspace_id,
            ));
        }
        if page.status == 401 || page.status == 403 || looks_signed_out(&page.text) {
            return Ok(GoWeb::failed(ProviderStatus::Unauthorized, workspace_id));
        }
        if page.status != 200 {
            return Ok(GoWeb::failed(ProviderStatus::Unavailable, workspace_id));
        }
        // 上游的 RangeError 會落到外層 catch：unavailable，而且不帶 workspaceId。
        let Ok(windows) = parse_go_usage(&page.text, now_ms) else {
            return Err("go usage reset is out of range".to_string());
        };
        if windows.is_empty() {
            return Ok(GoWeb::failed(ProviderStatus::Unavailable, workspace_id));
        }
        Ok::<GoWeb, String>(GoWeb {
            status: ProviderStatus::Ok,
            workspace_id,
            windows,
        })
    };
    run.await
        .unwrap_or_else(|_| GoWeb::failed(ProviderStatus::Unavailable, String::new()))
}

/// 上游 `summarizeLink(go, zen).expired`：兩個來源都說 unauthorized 才算過期。
pub fn link_expired(go: &GoWeb, zen: &Zen) -> bool {
    go.status == ProviderStatus::Unauthorized && zen.status == ProviderStatus::Unauthorized
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_767_225_600_000; // 2026-01-01T00:00:00.000Z

    #[test]
    fn cookies_are_sanitized_like_upstream() {
        assert_eq!(sanitize_cookie_header("  "), "");
        assert_eq!(
            sanitize_cookie_header("Cookie : auth=abc; ;x=1 "),
            "auth=abc; x=1"
        );
        assert_eq!(sanitize_cookie_header("abc123"), "auth=abc123");
        assert_eq!(sanitize_cookie_header("cookies=1"), "cookies=1");
    }

    #[test]
    fn server_urls_encode_args_like_url_search_params() {
        assert_eq!(
            server_request_url("abc", Some(&json!(["wrk_1"])), "GET"),
            "https://opencode.ai/_server?id=abc&args=%5B%22wrk_1%22%5D"
        );
        assert_eq!(
            server_request_url("abc", None, "GET"),
            "https://opencode.ai/_server?id=abc"
        );
        assert_eq!(
            server_request_url("abc", Some(&json!([])), "POST"),
            SERVER_URL
        );
    }

    #[test]
    fn workspace_ids_come_from_text_then_json() {
        assert_eq!(
            parse_workspace_ids(r#"$R[1]={id:"wrk_A1",name:"x"};{userid = "wrk_B2"}{id:"wrk_A1"}"#),
            ["wrk_A1", "wrk_B2"]
        );
        assert_eq!(
            parse_workspace_ids(r#"{id:"wrk_A1"};{workspaceId = "wrk_B2"}"#),
            ["wrk_A1"],
            "case-sensitive like the upstream regex"
        );
        assert_eq!(
            parse_workspace_ids(r#"{"list":[{"w":"wrk_Z"},"wrk_Y"]}"#),
            ["wrk_Z", "wrk_Y"]
        );
        assert!(parse_workspace_ids(r#"id:"wrk_""#).is_empty());
        assert_eq!(
            normalize_workspace_id("https://opencode.ai/workspace/wrk_9x/go"),
            Some("wrk_9x".into())
        );
        assert_eq!(normalize_workspace_id("wrk_-"), None);
    }

    #[test]
    fn subscription_json_and_text_forms() {
        let s = parse_subscription(
            r#"{"data":{"rollingUsage":{"usagePercent":0.5,"resetInSec":60},"weeklyUsage":{"used":3,"limit":12,"resetsAt":"2026-01-02T00:00:00Z"}},"billing":{"balanceUSD":"12.5"}}"#,
            NOW,
        )
        .unwrap();
        assert_eq!(s.windows.len(), 2);
        assert_eq!(
            s.windows[0].used_percent,
            Some(50.0),
            "0–1 is scaled like upstream"
        );
        assert_eq!(
            s.windows[0].resets_at.as_deref(),
            Some("2026-01-01T00:01:00.000Z")
        );
        assert_eq!(s.windows[1].used_percent, Some(25.0));
        assert_eq!(
            s.windows[1].resets_at.as_deref(),
            Some("2026-01-02T00:00:00.000Z")
        );
        assert_eq!(s.balance_usd, Some(12.5));

        let s = parse_subscription(
            r#"$R={rollingUsage:{usagePercent:12.34,resetInSec:30},weeklyUsage:{status:"ok",usagePercent : 7},zenBalance: "$ 4.20"}"#,
            NOW,
        )
        .unwrap();
        assert_eq!(s.windows[0].used_percent, Some(12.3));
        assert_eq!(s.windows[1].used_percent, Some(7.0));
        assert_eq!(
            s.windows[1].resets_at.as_deref(),
            Some("2026-01-01T00:00:00.000Z")
        );
        assert_eq!(s.balance_usd, Some(4.2));
        assert_eq!(
            parse_subscription(" NULL ", NOW),
            Ok(Subscription::default())
        );
        assert_eq!(
            parse_subscription(
                "rollingUsage:{usagePercent:1,resetInSec:99999999999999}",
                NOW
            ),
            Err(RangeError),
            "the text fallback throws out to fetchZen's catch"
        );
        assert_eq!(
            balance_by_pattern("currentBalance-5"),
            None,
            "a minus sign stops the match"
        );
        assert_eq!(balance_by_pattern("BALANCEusd is 3"), Some(3.0));
        assert_eq!(
            balance_by_pattern(&format!("zenBalance{}9", "x".repeat(21))),
            None
        );
    }

    #[test]
    fn a_key_match_does_not_cross_a_closing_brace() {
        assert_eq!(
            capture_after_key(
                "rollingUsage:{a:1} usagePercent: 5",
                "rollingUsage",
                "usagePercent",
                &[':'],
                true
            ),
            None
        );
        assert_eq!(
            capture_after_key(
                "rollingUsage:{a:1} rollingUsage:{usagePercent: 5.25}",
                "rollingUsage",
                "usagePercent",
                &[':'],
                true
            ),
            Some("5.25")
        );
    }

    #[test]
    fn go_page_needs_session_and_weekly() {
        let html = "<script>x={rollingUsage:{usagePercent=40,resetInSec=3600},weeklyUsage:{usagePercent:10},monthlyUsage:{usagePercent:2.5}}</script>";
        let w = parse_go_usage(html, NOW).unwrap();
        assert_eq!(w.len(), 3);
        assert_eq!(w[2].kind, WindowKind::Billing);
        assert_eq!(w[2].window_minutes, Some(MONTHLY_MINUTES));
        assert!(parse_go_usage("rollingUsage:{usagePercent:1}", NOW)
            .unwrap()
            .is_empty());
        assert_eq!(
            parse_window_obj(
                Some(&json!({"percent": 5, "resetIn": 1e14})),
                WindowKind::Session,
                300.0,
                NOW
            ),
            Err(RangeError),
            "an absurd reset throws like Date#toISOString"
        );
    }

    #[test]
    fn signed_out_pages() {
        assert!(looks_signed_out("<a href=/auth/authorize>"));
        assert!(looks_signed_out("Please Sign In"));
        assert!(!looks_signed_out("{id:\"wrk_1\"}"));
    }
}
