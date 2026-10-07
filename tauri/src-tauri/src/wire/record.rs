//! 上傳到 hub 的裝置記錄。
//!
//! 鍵與順序照上游 collector 的 summary（collector.js `collectUsageOnce`）再疊上
//! envelope 與 limits（deviceState.js `publish`）。hub 端 `normalizeDeviceRecord()`
//! 只在 `hasOwn` 時處理 osName / trackedClients / clientStatus / periodWindows /
//! historyAvailable / syncUploadIntervalMs，所以這些欄位都要明確送出。
//! 不送 `wslStatus` / `clientHealth`（v1 不產生），hub 視為未提供。
//! `history` 是三態：不帶（hub 保留舊的）、`null`（關閉）、物件（整份取代）。

use std::sync::Arc;

use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use super::limits::LimitsSummary;
use super::period::Period;
use super::time::PeriodWindows;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClientStatus {
    /// tokscale 在 allTime 讀到這個工具的用量。
    Active,
    /// 資料夾存在但還沒有用量。
    Waiting,
    /// 本機沒有這個工具的資料夾。
    Missing,
}

/// 每個程序固定不變的裝置識別。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Envelope {
    pub device_id: String,
    pub hostname: String,
    pub platform: String,
    pub os_name: String,
    pub os_version: String,
    pub agent_version: String,
    pub agent_runtime: String,
    /// 使用者的公司信箱（設定頁的「公司信箱」或 `TOKEN_MONITOR_OWNER_EMAIL`）；空字串 = 不回報。
    pub owner_email: String,
}

impl Envelope {
    pub fn with_owner_email(mut self, email: &str) -> Self {
        self.owner_email = email.to_string();
        self
    }
}

/// 收集器每個 tick 的產出（不含裝置識別與 limits）。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct UsageSummary {
    pub updated_at: String,
    pub projects_enabled: bool,
    pub tracked_clients: Vec<String>,
    pub client_status: IndexMap<String, ClientStatus>,
    pub period_windows: PeriodWindows,
    /// 上游 `historyAvailable = historyEnabled !== false`。
    pub history_available: bool,
    pub today: Period,
    pub month: Period,
    pub all_time: Period,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    pub device_id: String,
    pub hostname: String,
    pub platform: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub os_name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub os_version: String,
    pub updated_at: String,
    pub agent_version: String,
    pub agent_runtime: String,
    /// 公司 hub 用這個信箱自動把裝置歸給員工（monorepo 根目錄 overlay 的 `hub/org.js`）。上游
    /// `normalizeDeviceRecord()` 不認得這個鍵、直接略過，所以沒填時整個鍵不送，上傳內容與以前相同。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub owner_email: String,
    pub projects_enabled: bool,
    pub tracked_clients: Vec<String>,
    pub client_status: IndexMap<String, ClientStatus>,
    pub period_windows: PeriodWindows,
    /// 每筆都明確送：hub 只在 `hasOwn` 時才更新這個旗標。
    pub history_available: bool,
    /// 必須等於實際的上傳間隔：hub 用它算 stale 門檻（`max(base, 2 × interval)`）。
    pub sync_upload_interval_ms: u64,
    pub today: Period,
    pub month: Period,
    pub all_time: Period,
    /// `None` = 這筆不帶；`Some(Null)` = history 關閉；其他 = 完整的 `{daily, monthly, summary}`。
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub history: Option<Arc<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits: Option<LimitsSummary>,
}

/// 鍵存在就是 `Some`（包括 `null`）；鍵不存在由 `#[serde(default)]` 給 `None`。
fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Arc<Value>>, D::Error> {
    Value::deserialize(d).map(|v| Some(Arc::new(v)))
}

impl DeviceRecord {
    pub fn compose(
        envelope: &Envelope,
        usage: &UsageSummary,
        sync_upload_interval_ms: u64,
        history: Option<&Arc<Value>>,
        limits: Option<&LimitsSummary>,
    ) -> Self {
        DeviceRecord {
            device_id: envelope.device_id.clone(),
            hostname: envelope.hostname.clone(),
            platform: envelope.platform.clone(),
            os_name: envelope.os_name.clone(),
            os_version: envelope.os_version.clone(),
            updated_at: usage.updated_at.clone(),
            agent_version: envelope.agent_version.clone(),
            agent_runtime: envelope.agent_runtime.clone(),
            owner_email: envelope.owner_email.clone(),
            projects_enabled: usage.projects_enabled,
            tracked_clients: usage.tracked_clients.clone(),
            client_status: usage.client_status.clone(),
            period_windows: usage.period_windows.clone(),
            history_available: usage.history_available,
            sync_upload_interval_ms,
            today: usage.today.clone(),
            month: usage.month.clone(),
            all_time: usage.all_time.clone(),
            history: history.cloned(),
            limits: limits.cloned(),
        }
    }
}
