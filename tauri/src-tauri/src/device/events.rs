//! 核心對外的事件。GUI 在 `gui::bridge` 把它轉成前端事件；tm-agent `--events` 印成 JSON lines。
//! 核心模組只拿 `EventSink` callback，從不碰 Tauri 的 AppHandle（核心不依賴 Tauri 的分層規則）。

use std::sync::Arc;

use serde::Serialize;

use crate::collector::self_sync::SyncReport;
use crate::error::AppError;
use crate::hub::payload::PayloadOmissions;
use crate::wire::DeviceRecord;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorInfo {
    pub kind: String,
    pub code: String,
    pub message: String,
}

impl From<&AppError> for ErrorInfo {
    fn from(e: &AppError) -> Self {
        ErrorInfo {
            kind: e.kind().into(),
            code: e.code().into(),
            message: e.message(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CoreEvent {
    #[serde(rename_all = "camelCase")]
    TickStarted { reason: String },
    #[serde(rename_all = "camelCase")]
    TickFinished { reason: String, duration_ms: u64 },
    #[serde(rename_all = "camelCase")]
    TickFailed { reason: String, error: ErrorInfo },
    #[serde(rename_all = "camelCase")]
    RecordPublished {
        revision: u64,
        record: Arc<DeviceRecord>,
    },
    #[serde(rename_all = "camelCase")]
    IngestSent {
        revision: u64,
        bytes: usize,
        retried: bool,
        omissions: PayloadOmissions,
        at: String,
    },
    #[serde(rename_all = "camelCase")]
    IngestFailed {
        revision: u64,
        error: ErrorInfo,
        will_retry: bool,
        at: String,
    },
    #[serde(rename_all = "camelCase")]
    UploadScheduled { next_at: String },
    /// 掃描前的 Cursor / Antigravity 同步結果（只在這次真的有嘗試時發出）。
    #[serde(rename_all = "camelCase")]
    SelfSync { reports: Vec<SyncReport> },
    /// 檔案監看已啟動：來源目錄有變動時 3–5 秒內更新。`mode` 是原生事件或每 2 秒輪詢；
    /// `fallback_code` 是系統拒絕給監看描述符而改成輪詢的原因（`ENOSPC` 等，上游 `watchFallbackCode`）。
    #[serde(rename_all = "camelCase")]
    WatcherReady {
        roots: Vec<String>,
        mode: crate::collector::watch::WatchMode,
        fallback_code: Option<String>,
    },
    /// 檔案監看無法啟動（沒有來源目錄或系統拒絕），只靠定時掃描。
    #[serde(rename_all = "camelCase")]
    WatcherUnavailable { error: String },
    /// history 的 graph 掃描成功（`days` = 370 天窗口裡有幾天）。
    #[serde(rename_all = "camelCase")]
    HistoryCollected {
        days: usize,
        duration_ms: u64,
        at: String,
    },
    /// history 的 graph 掃描失敗；這次不送 history，hub 保留上一份。
    #[serde(rename_all = "camelCase")]
    HistoryFailed { error: ErrorInfo, at: String },
    /// 一輪額度探測的結果（第一筆用量出現前也會發，畫面不必等上傳）。
    #[serde(rename_all = "camelCase")]
    LimitsUpdated {
        summary: crate::wire::LimitsSummary,
        next_at: String,
    },
}

pub type EventSink = Arc<dyn Fn(CoreEvent) + Send + Sync>;

pub fn noop_sink() -> EventSink {
    Arc::new(|_| {})
}
