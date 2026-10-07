//! 資料匯出的 GUI 端（檔案格式在 crate::export）：選資料夾、手動匯出一次、自動匯出的背景工作。
//!
//! 自動匯出（設定 `exportAutoEnabled` + `exportDir`）每 `exportIntervalMs` 檢查一次最新的本機 record，
//! 內容（期間 + 歷史）與上次寫到同一個資料夾的相同就不重寫：資料夾常是 OneDrive 之類的同步資料夾。
//! 設定改變時立刻檢查。手動匯出一律寫。

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Notify;

use super::state::AppState;
use crate::error::{AppError, AppResult};

static WAKE: OnceLock<Notify> = OnceLock::new();
static LAST: Mutex<Option<(String, String)>> = Mutex::new(None);
static STATUS: Mutex<ExportStatus> = Mutex::new(ExportStatus {
    last_at: None,
    last_error: None,
});

fn wake() -> &'static Notify {
    WAKE.get_or_init(Notify::new)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportStatus {
    /// 最近一次自動匯出成功（真的寫了檔）的時間。
    pub last_at: Option<String>,
    pub last_error: Option<String>,
}

fn export_once(app: &AppHandle, dir: &str, skip_unchanged: bool) -> AppResult<bool> {
    let record = app
        .state::<AppState>()
        .record
        .read()
        .unwrap()
        .clone()
        .ok_or_else(|| AppError::InvalidArgument("還沒有掃描結果".into()))?;
    let history = record
        .history
        .as_deref()
        .ok_or_else(|| AppError::InvalidArgument("每日歷史還沒掃好，稍後再試".into()))?;
    let signature = crate::export::signature(&record, history);
    if skip_unchanged
        && LAST.lock().unwrap().as_ref() == Some(&(dir.to_string(), signature.clone()))
    {
        return Ok(false);
    }
    crate::export::export_record(
        std::path::Path::new(dir),
        &record,
        crate::baked::AGENT_VERSION,
    )?;
    if skip_unchanged {
        *LAST.lock().unwrap() = Some((dir.to_string(), signature));
    }
    Ok(true)
}

pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let settings = app.state::<AppState>().settings();
            let active = settings.export_auto_enabled && !settings.export_dir.trim().is_empty();
            if active {
                let result = export_once(&app, settings.export_dir.trim(), true);
                let mut status = STATUS.lock().unwrap();
                match result {
                    Ok(true) => {
                        status.last_at = Some(crate::wire::time::iso_millis(chrono::Utc::now()));
                        status.last_error = None;
                    }
                    Ok(false) => {}
                    // 還沒掃好等暫時性的原因：下一輪再試，不記成錯誤。
                    Err(AppError::InvalidArgument(_)) => {}
                    Err(e) => {
                        tracing::warn!(error = %e, "auto export failed");
                        status.last_error = Some(e.to_string());
                    }
                }
            }
            let wait = if active {
                Duration::from_millis(settings.export_interval_ms.max(1_000))
            } else {
                Duration::from_secs(60 * 60)
            };
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = wake().notified() => {}
            }
        }
    });
}

/// 自動匯出的設定改了：立刻檢查一次。
pub fn on_settings_changed() {
    wake().notify_one();
}

async fn pick_folder(app: &AppHandle, start: &str) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file();
    let start = if start.trim().is_empty() {
        dirs::document_dir().or_else(dirs::home_dir)
    } else {
        Some(std::path::PathBuf::from(start.trim()))
    };
    if let Some(dir) = start {
        dialog = dialog.set_directory(dir);
    }
    dialog.pick_folder(move |path| {
        let _ = tx.send(path.and_then(|p| p.into_path().ok()));
    });
    rx.await.ok().flatten().map(|p| p.display().to_string())
}

/// 選自動匯出的資料夾並存進設定；取消回 `None`。
#[tauri::command]
pub async fn export_pick_dir(app: AppHandle) -> AppResult<Option<String>> {
    let current = app.state::<AppState>().settings().export_dir;
    let Some(dir) = pick_folder(&app, &current).await else {
        return Ok(None);
    };
    let mut patch = Map::new();
    patch.insert("exportDir".into(), Value::String(dir.clone()));
    super::commands::apply_settings_patch(&app, patch).await?;
    Ok(Some(dir))
}

/// 選一個資料夾立刻匯出一次（一律寫）；取消回 `None`。
#[tauri::command]
pub async fn export_now(app: AppHandle) -> AppResult<Option<String>> {
    let current = app.state::<AppState>().settings().export_dir;
    let Some(dir) = pick_folder(&app, &current).await else {
        return Ok(None);
    };
    export_once(&app, &dir, false)?;
    Ok(Some(dir))
}

#[tauri::command]
pub fn export_status() -> ExportStatus {
    STATUS.lock().unwrap().clone()
}
