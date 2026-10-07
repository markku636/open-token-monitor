//! AI 服務的線上狀態（上游 src/electron/serviceStatus.js）：Claude、OpenAI、Cursor、DeepSeek 的
//! Atlassian Statuspage `summary.json`。畫面打開時才查，結果快取 60 秒（有失敗時 10 秒，網路一時不通
//! 很快就會恢復）。
//!
//! - `status.indicator`：none → 正常、minor → 降級、major / critical → 中斷，其他 → 未知。
//! - 受影響的組件：狀態不是 operational / under_maintenance 的組件（維護另外算）。
//! - 事件：沒有 resolved / completed / postmortem 的 incident；維護：沒有 completed / canceled 的排程維護。

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

pub struct Provider {
    pub id: &'static str,
    pub label: &'static str,
    pub page_url: &'static str,
    pub summary_url: &'static str,
}

pub const PROVIDERS: &[Provider] = &[
    Provider {
        id: "claude",
        label: "Claude",
        page_url: "https://status.claude.com",
        summary_url: "https://status.claude.com/api/v2/summary.json",
    },
    Provider {
        id: "openai",
        label: "OpenAI",
        page_url: "https://status.openai.com",
        summary_url: "https://status.openai.com/api/v2/summary.json",
    },
    Provider {
        id: "cursor",
        label: "Cursor",
        page_url: "https://status.cursor.com",
        summary_url: "https://status.cursor.com/api/v2/summary.json",
    },
    Provider {
        id: "deepseek",
        label: "DeepSeek",
        // 官方頁面只給瀏覽器 HTML，JSON 要從 Atlassian 代管的鏡像拿；連結仍指向官方頁面（上游同樣）。
        page_url: "https://status.deepseek.com",
        summary_url: "https://deepseek.statuspage.io/api/v2/summary.json",
    },
];

pub const TIMEOUT: Duration = Duration::from_secs(5);
pub const CACHE_MS: i64 = 60_000;
pub const ERROR_CACHE_MS: i64 = 10_000;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: String,
    pub label: String,
    pub page_url: String,
    /// `ok` | `degraded` | `outage` | `unknown`
    pub status: &'static str,
    pub description: String,
    pub checked_at: String,
    pub component_issues: Vec<String>,
    pub incident_title: String,
    pub incident_count: usize,
    pub maintenance_count: usize,
    pub error: Option<String>,
}

fn norm(v: Option<&Value>) -> String {
    v.and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_lowercase()
}

pub fn tone(indicator: &str) -> &'static str {
    match indicator {
        "none" => "ok",
        "minor" => "degraded",
        "major" | "critical" => "outage",
        _ => "unknown",
    }
}

fn active<'a>(items: Option<&'a Value>, inactive: &[&str]) -> Vec<&'a Value> {
    items
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|i| {
                    let s = norm(i.get("status"));
                    !s.is_empty() && !inactive.contains(&s.as_str())
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 上游 `summarizeStatuspageProvider`。
pub fn summarize(p: &Provider, payload: Result<&Value, &str>, checked_at: &str) -> ProviderStatus {
    let base = |status: &'static str, description: String, error: Option<String>| ProviderStatus {
        id: p.id.into(),
        label: p.label.into(),
        page_url: p.page_url.into(),
        status,
        description,
        checked_at: checked_at.into(),
        component_issues: Vec::new(),
        incident_title: String::new(),
        incident_count: 0,
        maintenance_count: 0,
        error,
    };
    let body = match payload {
        Ok(v) if v.is_object() => v,
        Ok(_) => {
            return base(
                "unknown",
                "Unable to check status".into(),
                Some("Unable to check status".into()),
            )
        }
        Err(e) => {
            return base(
                "unknown",
                "Unable to check status".into(),
                Some(e.to_string()),
            )
        }
    };
    let indicator = norm(body.get("status").and_then(|s| s.get("indicator")));
    let issues: Vec<String> = body
        .get("components")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|c| {
                    !matches!(
                        norm(c.get("status")).as_str(),
                        "operational" | "under_maintenance"
                    )
                })
                .map(|c| {
                    c.get("name")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|n| !n.is_empty())
                        .unwrap_or("Unknown")
                        .to_string()
                })
                .collect()
        })
        .unwrap_or_default();
    let incidents = active(
        body.get("incidents"),
        &["resolved", "completed", "postmortem"],
    );
    let maintenances = active(
        body.get("scheduled_maintenances"),
        &["completed", "canceled"],
    );
    let description = body
        .get("status")
        .and_then(|s| s.get("description"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .unwrap_or("Unknown")
        .to_string();
    ProviderStatus {
        status: tone(if indicator.is_empty() {
            "unknown"
        } else {
            &indicator
        }),
        description,
        component_issues: issues,
        incident_title: incidents
            .first()
            .and_then(|i| i.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string(),
        incident_count: incidents.len(),
        maintenance_count: maintenances.len(),
        ..base("unknown", String::new(), None)
    }
}

/// 同時查所有服務（各 5 秒逾時）。
pub async fn fetch_all(http: &reqwest::Client) -> Vec<ProviderStatus> {
    let checked_at = crate::wire::time::iso_millis(chrono::Utc::now());
    let tasks = PROVIDERS.iter().map(|p| {
        let http = http.clone();
        let checked_at = checked_at.clone();
        async move {
            let result: Result<Value, String> = async {
                let resp = http
                    .get(p.summary_url)
                    .timeout(TIMEOUT)
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;
                if !resp.status().is_success() {
                    return Err(format!("HTTP {}", resp.status().as_u16()));
                }
                resp.json::<Value>().await.map_err(|e| e.to_string())
            }
            .await;
            match &result {
                Ok(v) => summarize(p, Ok(v), &checked_at),
                Err(e) => summarize(p, Err(e), &checked_at),
            }
        }
    });
    futures_util::future::join_all(tasks).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn summarizes_a_statuspage_payload() {
        let payload = json!({
            "status": { "indicator": "minor", "description": "Partially Degraded Service" },
            "components": [
                { "name": "API", "status": "degraded_performance" },
                { "name": "Console", "status": "operational" },
                { "name": "Docs", "status": "under_maintenance" }
            ],
            "incidents": [
                { "name": "Elevated errors on Claude Haiku", "status": "investigating" },
                { "name": "Old", "status": "resolved" }
            ],
            "scheduled_maintenances": [{ "status": "scheduled" }, { "status": "completed" }]
        });
        let s = summarize(&PROVIDERS[0], Ok(&payload), "t");
        assert_eq!(s.status, "degraded");
        assert_eq!(s.component_issues, ["API"]);
        assert_eq!(s.incident_title, "Elevated errors on Claude Haiku");
        assert_eq!(s.incident_count, 1);
        assert_eq!(s.maintenance_count, 1);
        assert_eq!(s.description, "Partially Degraded Service");
        assert_eq!(s.error, None);
    }

    #[test]
    fn maps_indicators_and_errors() {
        assert_eq!(tone("none"), "ok");
        assert_eq!(tone("critical"), "outage");
        assert_eq!(tone("weird"), "unknown");
        let s = summarize(&PROVIDERS[3], Err("timeout"), "t");
        assert_eq!((s.status, s.error.as_deref()), ("unknown", Some("timeout")));
        assert_eq!(s.page_url, "https://status.deepseek.com");
    }
}
