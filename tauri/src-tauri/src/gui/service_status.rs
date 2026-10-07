//! 服務狀態的指令（邏輯在 crate::service_status）：畫面打開時才查，結果在程序內快取 60 秒
//! （有失敗 10 秒）；`force` 略過快取（重新整理按鈕）。點一列用系統瀏覽器開那個服務的狀態頁。

use std::sync::Mutex;
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::error::{AppError, AppResult};
use crate::service_status::{self, ProviderStatus, CACHE_MS, ERROR_CACHE_MS, PROVIDERS};

static CACHE: Mutex<Option<(i64, Vec<ProviderStatus>)>> = Mutex::new(None);

#[tauri::command]
pub async fn service_status_get(force: bool) -> Vec<ProviderStatus> {
    let now = chrono::Utc::now().timestamp_millis();
    if !force {
        if let Some((at, list)) = CACHE.lock().unwrap().as_ref() {
            let ttl = if list.iter().any(|p| p.error.is_some()) {
                ERROR_CACHE_MS
            } else {
                CACHE_MS
            };
            if now - at < ttl {
                return list.clone();
            }
        }
    }
    let http = reqwest::Client::builder()
        .user_agent(format!(
            "TokenMonitor/{} (+https://github.com/Javis603/token-monitor)",
            crate::baked::AGENT_VERSION
        ))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .unwrap_or_default();
    let list = service_status::fetch_all(&http).await;
    // 以開始查詢的時間記錄（上游同樣）：否則「每 1 分鐘」的前端計時器常撞上還沒過期的快取，實際變成 2 分鐘。
    *CACHE.lock().unwrap() = Some((now, list.clone()));
    list
}

/// 只開已知服務的狀態頁（id 對照表），前端不能讓它開任意網址。
#[tauri::command]
pub fn service_status_open(app: AppHandle, id: String) -> AppResult<()> {
    let p = PROVIDERS
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| AppError::InvalidArgument(format!("unknown service {id}")))?;
    app.opener()
        .open_url(p.page_url, None::<&str>)
        .map_err(|e| AppError::Internal(e.to_string()))
}
