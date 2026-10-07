//! Cursor 的額度（上游 src/shared/providers/cursor/{limits,probe}.js）。
//!
//! 帳號就是 tokscale 的 `cursor-credentials.json`（collector/cursor.rs 會自動從 Cursor 桌面版的登入
//! 寫進去，也可以在設定頁手動貼 token）。以 `WorkosCursorSessionToken` cookie 呼叫 cursor.com 的
//! dashboard API：
//! - `GET /api/usage-summary`：方案、計費週期、方案與 on-demand 的用量（金額是 cent）。
//! - `GET /api/auth/me`：email 與 `sub`（user id，accountKey 用）。
//! - `GET /api/usage?user=<sub>`：舊的「每月 N 次請求」方案的請求數。
//! - `POST /api/dashboard/get-sand-usage-status`：Grok Bot 的週額度（最多等 5 秒）。
//!
//! v1 只查 active 那一個帳號（上游會查全部、可停用個別帳號）。

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Map, Value};

use super::hash::hash_key;
use super::http::ProbeError;
use super::normalize::finish_provider;
use crate::wire::{LimitProvider, LimitWindow, ProviderStatus, WindowKind};

const USAGE_SUMMARY_URL: &str = "https://cursor.com/api/usage-summary";
const AUTH_ME_URL: &str = "https://cursor.com/api/auth/me";
const REQUEST_USAGE_URL: &str = "https://cursor.com/api/usage";
const SAND_USAGE_URL: &str = "https://cursor.com/api/dashboard/get-sand-usage-status";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const SAND_TIMEOUT: Duration = Duration::from_secs(5);
/// 上游 browserUserAgent.js：cursor.com 會擋非瀏覽器的 user-agent。
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

#[derive(Debug, Clone, PartialEq)]
pub struct CursorAccount {
    pub id: String,
    pub session_token: String,
    pub user_id: Option<String>,
    pub label: Option<String>,
}

/// 上游 auth.js `listAccounts` 的第一個（active 優先）。
pub fn active_account(credentials_file: &Path) -> Option<CursorAccount> {
    let parsed: Value =
        serde_json::from_str(&std::fs::read_to_string(credentials_file).ok()?).ok()?;
    let accounts = parsed.get("accounts")?.as_object()?;
    let active = parsed
        .get("activeAccountId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let normalize = |id: &str, acct: &Value| -> Option<CursorAccount> {
        let token = acct
            .get("sessionToken")?
            .as_str()
            .filter(|t| !t.is_empty())?;
        Some(CursorAccount {
            id: id.to_string(),
            session_token: token.to_string(),
            user_id: acct
                .get("userId")
                .and_then(Value::as_str)
                .map(str::to_string),
            label: acct
                .get("label")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    };
    let mut list: Vec<CursorAccount> = accounts
        .iter()
        .filter_map(|(id, acct)| normalize(id, acct))
        .collect();
    list.sort_by(|a, b| {
        let rank = |x: &CursorAccount| if x.id == active { 0 } else { 1 };
        let name = |x: &CursorAccount| {
            x.label
                .clone()
                .or_else(|| x.user_id.clone())
                .unwrap_or_else(|| x.id.clone())
                .to_lowercase()
        };
        rank(a).cmp(&rank(b)).then_with(|| name(a).cmp(&name(b)))
    });
    list.into_iter().next()
}

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|f| f.is_finite())
}

fn clamp_percent(v: Option<f64>) -> Option<f64> {
    v.map(|n| n.clamp(0.0, 100.0))
}

fn cents_to_usd(v: Option<f64>) -> f64 {
    v.map(|c| c.round() / 100.0).unwrap_or(0.0)
}

fn percent_from(used: Option<f64>, limit: Option<f64>) -> Option<f64> {
    match (used, limit) {
        (Some(u), Some(l)) if l > 0.0 => clamp_percent(Some(u / l * 100.0)),
        _ => None,
    }
}

fn has_any(obj: &Map<String, Value>, keys: &[&str]) -> bool {
    keys.iter().any(|k| num(obj.get(*k)).is_some())
}

/// 上游 probe.js `parseUsageSummary` 的結果（只留 limits.js 用得到的欄位）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CursorUsage {
    pub plan_percent: Option<f64>,
    pub auto_percent: Option<f64>,
    pub api_percent: Option<f64>,
    pub plan_used_usd: f64,
    pub plan_limit_usd: f64,
    pub plan_remaining_usd: Option<f64>,
    pub on_demand_used_usd: f64,
    pub on_demand_limit_usd: Option<f64>,
    pub on_demand_remaining_usd: Option<f64>,
    pub team_on_demand_used_usd: Option<f64>,
    pub team_on_demand_limit_usd: Option<f64>,
    pub team_on_demand_remaining_usd: Option<f64>,
    pub team_pooled_percent: Option<f64>,
    pub team_pooled_used_usd: Option<f64>,
    pub team_pooled_limit_usd: Option<f64>,
    pub team_pooled_remaining_usd: Option<f64>,
    pub billing_cycle_end: Option<String>,
    pub membership_type: Option<String>,
    pub has_overall_usage: bool,
    pub has_team_pooled_usage: bool,
    pub requests_used: Option<f64>,
    pub requests_limit: Option<f64>,
    pub grok_bot: Option<GrokBot>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct GrokBot {
    pub used_percent: Option<f64>,
    pub resets_at: Option<String>,
    pub window_minutes: Option<f64>,
    pub has_non_zero_included_limit: bool,
}

fn obj(v: Option<&Value>) -> &Map<String, Value> {
    static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
    v.and_then(Value::as_object)
        .unwrap_or_else(|| EMPTY.get_or_init(Map::new))
}

fn iso_or_none(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::Null => None,
        Value::String(s) if s.is_empty() => None,
        other => super::normalize::iso_timestamp(other),
    }
}

/// 上游 `parseGrokBotUsage`。
pub fn parse_grok_bot(input: &Value) -> GrokBot {
    let usage = obj(Some(input));
    let resets_at = iso_or_none(usage.get("nextResetTimestampUtc"));
    let start = iso_or_none(usage.get("currentPeriodStart"));
    let ms = |s: &Option<String>| {
        s.as_deref()
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .map(|d| d.timestamp_millis())
    };
    let window_minutes = match (ms(&start), ms(&resets_at)) {
        (Some(a), Some(b)) if b > a => Some(((b - a) as f64 / 60000.0).round()),
        _ => None,
    };
    GrokBot {
        used_percent: clamp_percent(num(usage.get("usagePercent"))),
        resets_at,
        window_minutes,
        has_non_zero_included_limit: usage.get("hasNonZeroIncludedLimit")
            == Some(&Value::Bool(true)),
    }
}

/// 上游 `parseUsageSummary`（含 `parseRequestUsage`）。
pub fn parse_usage_summary(input: &Value, request_usage: Option<&Value>) -> CursorUsage {
    let summary = obj(Some(input));
    let individual = obj(summary.get("individualUsage"));
    let plan = obj(individual.get("plan"));
    let on_demand = obj(individual.get("onDemand"));
    let overall = obj(individual.get("overall"));
    let team = obj(summary.get("teamUsage"));
    let team_on_demand = obj(team.get("onDemand"));
    let team_pooled = obj(team.get("pooled"));
    let plan_used = num(plan.get("used")).unwrap_or(0.0);
    let plan_limit = num(plan.get("limit")).unwrap_or(0.0);
    let overall_used = num(overall.get("used"));
    let overall_limit = num(overall.get("limit"));
    let overall_remaining = num(overall.get("remaining"));
    let od_used = num(on_demand.get("used")).unwrap_or(0.0);
    let od_limit = num(on_demand.get("limit"));
    let od_remaining = num(on_demand.get("remaining"));
    let tod_used = num(team_on_demand.get("used"));
    let tod_limit = num(team_on_demand.get("limit"));
    let tod_remaining = num(team_on_demand.get("remaining"));
    let tp_used = num(team_pooled.get("used"));
    let tp_limit = num(team_pooled.get("limit"));
    let tp_remaining = num(team_pooled.get("remaining"));

    let mut plan_percent = clamp_percent(num(plan.get("totalPercentUsed")));
    if plan_percent.is_none() {
        plan_percent = if plan_limit > 0.0 {
            percent_from(Some(plan_used), Some(plan_limit))
        } else if overall_limit.is_some_and(|l| l > 0.0) {
            percent_from(overall_used, overall_limit)
        } else if tp_limit.is_some_and(|l| l > 0.0) {
            percent_from(tp_used, tp_limit)
        } else {
            Some(0.0)
        };
    }
    let (mut used, mut limit) = (plan_used, plan_limit);
    let mut remaining = match plan.get("remaining") {
        None => None,
        v => num(v),
    };
    if limit <= 0.0 && used <= 0.0 {
        if let (Some(u), Some(l)) = (overall_used, overall_limit) {
            (used, limit, remaining) = (u, l, overall_remaining);
        } else if let (Some(u), Some(l)) = (tp_used, tp_limit) {
            (used, limit, remaining) = (u, l, tp_remaining);
        }
    }
    let request = obj(request_usage);
    let gpt4 = request
        .get("gpt-4")
        .or_else(|| request.get("gpt4"))
        .map(|v| obj(Some(v)))
        .unwrap_or_else(|| obj(None));
    let string = |k: &str| summary.get(k).and_then(Value::as_str).map(str::to_string);
    CursorUsage {
        plan_percent,
        auto_percent: clamp_percent(num(plan.get("autoPercentUsed"))),
        api_percent: clamp_percent(num(plan.get("apiPercentUsed"))),
        plan_used_usd: cents_to_usd(Some(used)),
        plan_limit_usd: cents_to_usd(Some(limit)),
        plan_remaining_usd: remaining.map(|r| cents_to_usd(Some(r))),
        on_demand_used_usd: cents_to_usd(Some(od_used)),
        on_demand_limit_usd: od_limit.map(|l| cents_to_usd(Some(l))),
        on_demand_remaining_usd: od_remaining.map(|r| cents_to_usd(Some(r))),
        team_on_demand_used_usd: tod_used.map(|v| cents_to_usd(Some(v))),
        team_on_demand_limit_usd: tod_limit.map(|v| cents_to_usd(Some(v))),
        team_on_demand_remaining_usd: tod_remaining.map(|v| cents_to_usd(Some(v))),
        team_pooled_percent: percent_from(tp_used, tp_limit),
        team_pooled_used_usd: tp_used.map(|v| cents_to_usd(Some(v))),
        team_pooled_limit_usd: tp_limit.map(|v| cents_to_usd(Some(v))),
        team_pooled_remaining_usd: tp_remaining.map(|v| cents_to_usd(Some(v))),
        billing_cycle_end: string("billingCycleEnd"),
        membership_type: string("membershipType"),
        has_overall_usage: has_any(overall, &["used", "limit", "remaining"]),
        has_team_pooled_usage: has_any(team_pooled, &["used", "limit", "remaining"]),
        requests_used: num(gpt4.get("numRequestsTotal")).or_else(|| num(gpt4.get("numRequests"))),
        requests_limit: num(gpt4.get("maxRequestUsage")),
        grok_bot: None,
    }
}

fn billing(label: &str) -> LimitWindow {
    LimitWindow {
        label: label.into(),
        ..LimitWindow::new(WindowKind::Billing)
    }
}

/// 上游 `formatCursorMembership`。
pub fn membership_label(kind: Option<&str>) -> String {
    let raw = kind.unwrap_or("").trim().to_lowercase();
    if raw.is_empty() {
        return String::new();
    }
    if raw == "pro+" || raw == "pro_plus" {
        return "Pro+".into();
    }
    super::plan::display_plan_text(&super::plan::clean_plan_text(&raw, &[]), None)
}

/// 上游 limits.js `fetchCursorAccountLimits` 成功時的窗口。
pub fn map_windows(usage: &CursorUsage) -> Vec<LimitWindow> {
    let resets_at = usage
        .billing_cycle_end
        .as_deref()
        .and_then(|s| super::normalize::iso_timestamp(&Value::String(s.into())));
    let mut windows = Vec::new();
    let has_requests =
        usage.requests_used.is_some() && usage.requests_limit.is_some_and(|l| l > 0.0);
    if has_requests {
        let (u, l) = (usage.requests_used.unwrap(), usage.requests_limit.unwrap());
        windows.push(LimitWindow {
            used_percent: percent_from(Some(u), Some(l)),
            used: Some(u),
            limit: Some(l),
            remaining: Some((l - u).max(0.0)),
            resets_at: resets_at.clone(),
            reset_description: usage
                .membership_type
                .as_deref()
                .map(|m| format!("Cursor {m}"))
                .unwrap_or_default(),
            ..billing("Requests")
        });
    } else if usage.auto_percent.is_some() || usage.api_percent.is_some() {
        if let Some(p) = usage.auto_percent {
            windows.push(LimitWindow {
                used_percent: Some(p),
                resets_at: resets_at.clone(),
                ..billing("Cursor Models")
            });
        }
        if let Some(p) = usage.api_percent {
            windows.push(LimitWindow {
                used_percent: Some(p),
                resets_at: resets_at.clone(),
                ..billing("Other Models")
            });
        }
    } else if usage.has_overall_usage && usage.plan_percent.is_some() {
        windows.push(LimitWindow {
            used_percent: usage.plan_percent,
            used: Some(usage.plan_used_usd),
            limit: Some(usage.plan_limit_usd),
            remaining: usage.plan_remaining_usd,
            resets_at: resets_at.clone(),
            ..billing("Overall")
        });
    }
    if let Some(g) = usage
        .grok_bot
        .as_ref()
        .filter(|g| g.has_non_zero_included_limit && g.used_percent.is_some())
    {
        windows.push(LimitWindow {
            label: "Grok Bot".into(),
            used_percent: g.used_percent,
            resets_at: g.resets_at.clone(),
            window_minutes: g.window_minutes,
            ..LimitWindow::new(WindowKind::Weekly)
        });
    }
    if usage.has_team_pooled_usage
        || usage.team_pooled_limit_usd.is_some()
        || usage.team_pooled_used_usd.is_some_and(|u| u > 0.0)
    {
        let remaining = usage.team_pooled_remaining_usd.or_else(|| {
            usage
                .team_pooled_limit_usd
                .map(|l| (l - usage.team_pooled_used_usd.unwrap_or(0.0)).max(0.0))
        });
        windows.push(LimitWindow {
            used_percent: usage
                .team_pooled_percent
                .or_else(|| percent_from(usage.team_pooled_used_usd, usage.team_pooled_limit_usd)),
            used: usage.team_pooled_used_usd,
            limit: usage.team_pooled_limit_usd,
            remaining,
            resets_at: resets_at.clone(),
            reset_description: "Shared team usage pool.".into(),
            ..billing("Team pool")
        });
    }
    if let Some(w) = on_demand_window(usage, resets_at) {
        windows.push(w);
    }
    windows
}

/// 上游 `cursorOnDemandWindow`：個人的上限優先，其次團隊；沒有上限但有花費也顯示（不畫進度條）。
fn on_demand_window(usage: &CursorUsage, resets_at: Option<String>) -> Option<LimitWindow> {
    let personal_used = usage.on_demand_used_usd;
    let team_used = usage.team_on_demand_used_usd.unwrap_or(0.0);
    let (used, limit, mut remaining) =
        match (usage.on_demand_limit_usd, usage.team_on_demand_limit_usd) {
            (Some(l), _) if l > 0.0 => (personal_used, Some(l), usage.on_demand_remaining_usd),
            (_, Some(l)) if l > 0.0 => (team_used, Some(l), usage.team_on_demand_remaining_usd),
            _ if personal_used > 0.0 => (personal_used, None, None),
            _ if team_used > 0.0 => (team_used, None, None),
            _ => return None,
        };
    if let (Some(l), None) = (limit, remaining) {
        remaining = Some((l - used).max(0.0));
    }
    Some(LimitWindow {
        metric: Some("spend".into()),
        currency: Some("USD".into()),
        used_percent: percent_from(Some(used), limit),
        used: Some(used),
        limit,
        remaining,
        resets_at,
        show_meter: false,
        ..billing("On-demand spend")
    })
}

/// 上游 `hashCursorAccountKey`。
pub fn account_key(account: &CursorAccount, resolved_user_id: Option<&str>) -> String {
    let canonical = [
        resolved_user_id,
        account.user_id.as_deref(),
        Some(account.id.as_str()),
    ]
    .into_iter()
    .flatten()
    .find_map(crate::collector::cursor::canonical_user_id);
    match canonical {
        Some(id) => hash_key(&["cursor", &id]),
        None => hash_key(&[
            "cursor-local",
            if account.id.is_empty() {
                "unknown"
            } else {
                &account.id
            },
        ]),
    }
}

/// 上游 `parseUserInfo` 取到的身分。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CursorUser {
    pub email: Option<String>,
    pub sub: Option<String>,
}

pub fn parse_user(v: &Value) -> CursorUser {
    CursorUser {
        email: v.get("email").and_then(Value::as_str).map(str::to_string),
        sub: v.get("sub").and_then(Value::as_str).map(str::to_string),
    }
}

/// 探測成功時的那一列（replay 與實際探測共用）。
pub fn provider_row(
    account: &CursorAccount,
    usage: &CursorUsage,
    user: &CursorUser,
    updated_at: String,
) -> LimitProvider {
    let membership = membership_label(usage.membership_type.as_deref());
    let label = user
        .email
        .clone()
        .filter(|e| !e.is_empty())
        .or_else(|| account.label.clone().filter(|l| !l.is_empty()))
        .unwrap_or_else(|| membership.clone());
    finish_provider(LimitProvider {
        account_key: account_key(account, user.sub.as_deref()),
        account_label: label,
        account_email: user.email.clone().unwrap_or_default(),
        plan_label: membership,
        source: "web".into(),
        windows: map_windows(usage),
        ..LimitProvider::status_row("cursor", ProviderStatus::Ok, updated_at)
    })
}

async fn request(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    post: bool,
    timeout: Duration,
) -> Result<Value, ProbeError> {
    let mut req = if post {
        http.post(url)
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .header("Origin", "https://cursor.com")
            .body("{}")
    } else {
        http.get(url).header("Accept", "*/*")
    };
    req = req
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Referer", "https://cursor.com/dashboard")
        .header(reqwest::header::USER_AGENT, BROWSER_USER_AGENT)
        .header(
            reqwest::header::COOKIE,
            format!("WorkosCursorSessionToken={token}"),
        )
        .timeout(timeout);
    let resp = req.send().await.map_err(|e| {
        ProbeError::new(
            ProviderStatus::Unavailable,
            format!("cursor request failed: {e}"),
        )
    })?;
    let code = resp.status().as_u16();
    if code == 401 || code == 403 {
        return Err(ProbeError::new(
            ProviderStatus::Unauthorized,
            format!("cursor HTTP {code}"),
        ));
    }
    if !resp.status().is_success() {
        return Err(ProbeError::new(
            ProviderStatus::Unavailable,
            format!("cursor HTTP {code}"),
        ));
    }
    resp.json::<Value>().await.map_err(|e| {
        ProbeError::new(
            ProviderStatus::Unavailable,
            format!("cursor invalid JSON: {e}"),
        )
    })
}

pub async fn probe(http: &reqwest::Client, home: &Path) -> Result<LimitProvider, ProbeError> {
    let updated_at = crate::wire::time::iso_millis(chrono::Utc::now());
    let Some(account) = active_account(&crate::collector::cursor::credentials_path(home)) else {
        return Err(ProbeError::new(
            ProviderStatus::NotConfigured,
            "no Cursor account",
        ));
    };
    let token = account.session_token.clone();
    let sand = request(http, SAND_USAGE_URL, &token, true, SAND_TIMEOUT);
    let (summary, me) = tokio::join!(
        request(http, USAGE_SUMMARY_URL, &token, false, REQUEST_TIMEOUT),
        request(http, AUTH_ME_URL, &token, false, REQUEST_TIMEOUT)
    );
    let summary = summary?;
    let user = me.map(|v| parse_user(&v)).unwrap_or_default();
    let mut request_usage = None;
    if let Some(sub) = user.sub.as_deref() {
        let url = format!(
            "{REQUEST_USAGE_URL}?user={}",
            url::form_urlencoded::byte_serialize(sub.as_bytes()).collect::<String>()
        );
        request_usage = request(http, &url, &token, false, REQUEST_TIMEOUT)
            .await
            .ok();
    }
    let mut usage = parse_usage_summary(&summary, request_usage.as_ref());
    usage.grok_bot = sand.await.ok().map(|v| parse_grok_bot(&v));
    Ok(provider_row(&account, &usage, &user, updated_at))
}

/// replay 用：`cursor-usage.json` = `{ summary, requestUsage?, sand?, me? }`（每個都是 API 的原始回應）。
pub fn replay(v: &Value, updated_at: String) -> LimitProvider {
    let account = CursorAccount {
        id: "user_replay".into(),
        session_token: "replay".into(),
        user_id: None,
        label: None,
    };
    let mut usage = parse_usage_summary(
        v.get("summary").unwrap_or(&json!({})),
        v.get("requestUsage"),
    );
    usage.grok_bot = v.get("sand").map(parse_grok_bot);
    let user = v.get("me").map(parse_user).unwrap_or_default();
    provider_row(&account, &usage, &user, updated_at)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_based_plans_show_model_pools_and_on_demand_spend() {
        let summary = json!({
            "billingCycleEnd": "2026-10-01T00:00:00.000Z",
            "membershipType": "pro",
            "individualUsage": {
                "plan": { "used": 1234, "limit": 2000, "autoPercentUsed": 12.5, "apiPercentUsed": 40 },
                "onDemand": { "used": 350, "limit": 2000 }
            }
        });
        let usage = parse_usage_summary(&summary, None);
        let w = map_windows(&usage);
        let labels: Vec<&str> = w.iter().map(|x| x.label.as_str()).collect();
        assert_eq!(labels, ["Cursor Models", "Other Models", "On-demand spend"]);
        assert_eq!(w[2].used, Some(3.5));
        assert_eq!(w[2].remaining, Some(16.5));
        assert!(!w[2].show_meter);
        assert_eq!(membership_label(Some("pro_plus")), "Pro+");
    }

    #[test]
    fn request_plans_count_requests() {
        let usage = parse_usage_summary(
            &json!({ "membershipType": "pro" }),
            Some(&json!({ "gpt-4": { "numRequestsTotal": 120, "maxRequestUsage": 500 } })),
        );
        let w = map_windows(&usage);
        assert_eq!(w[0].label, "Requests");
        assert_eq!(w[0].used_percent, Some(24.0));
        assert_eq!(w[0].reset_description, "Cursor pro");
    }

    #[test]
    fn account_keys_follow_the_user_id() {
        let a = CursorAccount {
            id: "abc".into(),
            session_token: "t".into(),
            user_id: None,
            label: None,
        };
        assert_eq!(
            account_key(&a, Some("auth0|user_01ABC")),
            hash_key(&["cursor", "user_01ABC"])
        );
        assert_eq!(account_key(&a, None), hash_key(&["cursor-local", "abc"]));
    }
}
