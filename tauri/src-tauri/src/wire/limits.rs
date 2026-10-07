//! 額度（limits）的 wire 形狀，等同上游 `syncLimits()` 的輸出，也就是
//! src/shared/limits/core.js `normalizeLimitsSummary` / `normalizeLimitProvider` /
//! `normalizeLimitWindow` 正規化**之後**的形狀（欄位與順序照抄）。
//!
//! hub 收到後會再正規化一次；我們送出已正規化的值，`tests/compat` 以「上游正規化後不變」守著。
//! 只帶摘要：絕不含 access token、lastAttempt、error 或 credentialDigest。

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderStatus {
    Ok,
    Disabled,
    NotConfigured,
    Unauthorized,
    RateLimited,
    SourceRateLimited,
    Unavailable,
    Error,
}

impl ProviderStatus {
    /// 暫時性的失敗：保留上一次成功的數字，只換狀態（上游 limits/runtime.js TRANSIENT_STATUSES）。
    pub fn is_transient(self) -> bool {
        matches!(
            self,
            ProviderStatus::RateLimited
                | ProviderStatus::SourceRateLimited
                | ProviderStatus::Unavailable
                | ProviderStatus::Error
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowKind {
    Session,
    Daily,
    Weekly,
    Billing,
}

impl WindowKind {
    /// 上游 WINDOW_ORDER 的位置。
    pub fn rank(self) -> usize {
        match self {
            WindowKind::Session => 0,
            WindowKind::Daily => 1,
            WindowKind::Weekly => 2,
            WindowKind::Billing => 3,
        }
    }
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitWindow {
    pub kind: WindowKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric: Option<String>,
    /// 這個窗口的來源：`web`（伺服器的數字）或 `local`（本機估算）。目前只有 OpenCode 帶
    /// （上游 `VALID_LIMIT_WINDOW_SOURCES`）；hub 合併同一帳號時 web 優先於 local。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_id: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub additional: bool,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub used: Option<f64>,
    #[serde(default)]
    pub limit: Option<f64>,
    #[serde(default)]
    pub remaining: Option<f64>,
    #[serde(default)]
    pub used_percent: Option<f64>,
    #[serde(default)]
    pub remaining_percent: Option<f64>,
    #[serde(default)]
    pub resets_at: Option<String>,
    #[serde(default)]
    pub window_minutes: Option<f64>,
    #[serde(default)]
    pub reset_description: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default = "yes")]
    pub show_meter: bool,
}

impl LimitWindow {
    pub fn new(kind: WindowKind) -> LimitWindow {
        LimitWindow {
            kind,
            metric: None,
            source: None,
            limit_id: None,
            additional: false,
            label: String::new(),
            used: None,
            limit: None,
            remaining: None,
            used_percent: None,
            remaining_percent: None,
            resets_at: None,
            window_minutes: None,
            reset_description: String::new(),
            detail: String::new(),
            currency: None,
            show_meter: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitProvider {
    pub provider: String,
    #[serde(default)]
    pub account_key: String,
    /// OpenCode：cookie 解出的 workspace 身分（上游只在 opencode 帶）。hub 以它挑合併後帳號的正式身分。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_account_key: Option<String>,
    /// OpenCode：同一帳號的其他身分（API key、Go／Zen workspace）。hub 靠它把只有 key 的裝置與
    /// 有 cookie 的裝置併成一個帳號；排序、去重、最多 8 個（上游 `normalizeOpenCodeAccountKeyAliases`）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub account_key_aliases: Vec<String>,
    #[serde(default)]
    pub account_label: String,
    #[serde(default)]
    pub plan_label: String,
    #[serde(default)]
    pub account_name: String,
    #[serde(default)]
    pub account_email: String,
    #[serde(default)]
    pub workspace_kind: String,
    pub status: ProviderStatus,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub source_detail: String,
    pub updated_at: Option<String>,
    #[serde(default)]
    pub windows: Vec<LimitWindow>,
    #[serde(default)]
    pub balance_usd: Option<f64>,
    #[serde(default)]
    pub balance: Option<Value>,
    #[serde(default)]
    pub reset_credits: Option<Value>,
    #[serde(default)]
    pub region: String,
}

impl LimitProvider {
    /// 沒有身分的狀態列（上游 collector.js 在 probe 丟錯時發佈的那一列）。
    pub fn status_row(provider: &str, status: ProviderStatus, updated_at: String) -> LimitProvider {
        LimitProvider {
            provider: provider.to_string(),
            account_key: String::new(),
            web_account_key: None,
            account_key_aliases: Vec::new(),
            account_label: String::new(),
            plan_label: String::new(),
            account_name: String::new(),
            account_email: String::new(),
            workspace_kind: String::new(),
            status,
            source: String::new(),
            source_detail: String::new(),
            updated_at: Some(updated_at),
            windows: Vec::new(),
            balance_usd: None,
            balance: None,
            reset_credits: None,
            region: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LimitsSummary {
    pub updated_at: Option<String>,
    pub refresh_ms: u64,
    #[serde(default)]
    pub providers: Vec<LimitProvider>,
}
