//! 一個統計期間（today / month / allTime）的 wire 形狀。
//!
//! 欄位與順序照上游 `emptyPeriod()` / `emptySession()`（src/shared/usage.js）。hub 以
//! `normalizePeriod()` 正規化，未知鍵丟棄、缺鍵補預設，所以這裡多送的零值無害，但
//! 少送 today / month / allTime 會讓裝置在 dashboard 上歸零。

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

pub type CountMap = IndexMap<String, i64>;
pub type CostMap = IndexMap<String, f64>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Capabilities {
    pub token_components: bool,
    pub throughput: bool,
}

impl Default for Capabilities {
    fn default() -> Self {
        Capabilities {
            token_components: true,
            throughput: true,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Project {
    pub label: String,
    pub tokens: i64,
    pub cost_usd: f64,
    pub clients: CountMap,
}

/// 單一 session。本機的 session 標題刻意**沒有**欄位：上游只把標題留在 widget 本機，
/// 從不上 wire（syncPayload.js `sessionsWithoutLocalTitles`），v1 也不在 UI 顯示。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    pub client: String,
    pub session_id: String,
    pub total_tokens: i64,
    pub cost_usd: f64,
    pub message_count: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub reasoning_tokens: i64,
    pub started_at: String,
    pub last_used_at: String,
    /// context 佔用只來自 client 自己的 transcript（tokscale 不回報）；v1 不讀 transcript，恆為 0。
    pub context_tokens: i64,
    pub context_window: i64,
    pub project_id: String,
    pub project_label: String,
    pub session_kind: String,
    pub models: CountMap,
    pub model_costs: CostMap,
    pub providers: CountMap,
    /// client 已經刪掉、由 session usage archive 補回來的（usage/archive.rs）。只在 true 時送出，
    /// 與上游 `normalizeSession` 相同。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub archived: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Period {
    pub capabilities: Capabilities,
    pub total_tokens: i64,
    pub cost_usd: f64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub output_tokens: i64,
    pub unclassified_tokens: i64,
    pub timed_tokens: i64,
    pub timed_output_tokens: i64,
    pub timed_duration_ms: i64,
    pub clients: CountMap,
    pub client_costs: CostMap,
    pub client_cache_reads: CountMap,
    pub client_cache_writes: CountMap,
    pub client_outputs: CountMap,
    pub client_unclassified_tokens: CountMap,
    pub models: CountMap,
    pub model_costs: CostMap,
    pub model_cache_reads: CountMap,
    pub model_cache_writes: CountMap,
    pub model_outputs: CountMap,
    pub model_unclassified_tokens: CountMap,
    pub client_models: IndexMap<String, CountMap>,
    pub client_model_costs: IndexMap<String, CostMap>,
    pub projects: IndexMap<String, Project>,
    pub sessions: IndexMap<String, Session>,
}

pub(crate) fn add_count(map: &mut CountMap, key: &str, value: i64) {
    *map.entry(key.to_string()).or_insert(0) += value;
}

pub(crate) fn add_cost(map: &mut CostMap, key: &str, value: f64) {
    *map.entry(key.to_string()).or_insert(0.0) += value;
}
