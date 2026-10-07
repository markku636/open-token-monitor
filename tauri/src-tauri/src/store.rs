//! 設定與狀態檔的持久化。
//!
//! GUI 與 tm-agent 共用同一個設定目錄：`dirs::config_dir()/<identifier>`
//! （Windows 為 `%APPDATA%\io.github.markku636.tokenmonitor`，與 Tauri 的 `app_config_dir()` 相同）。
//! 實際 IO 收斂到吃 `&Path` 的 `*_in` 函式，方便測試指向暫存目錄。
//! `TOKEN_MONITOR_CONFIG_DIR` 可覆寫目錄：E2E 與相容測試用，避免碰到使用者真正的設定。

use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::baked::APP_IDENTIFIER;
use crate::error::{AppError, AppResult};

pub const CONFIG_DIR_ENV: &str = "TOKEN_MONITOR_CONFIG_DIR";

pub fn config_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os(CONFIG_DIR_ENV).filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_IDENTIFIER)
}

/// 日誌目錄：與 Tauri 的 `app_log_dir()` 相同位置（Windows 為 `%LOCALAPPDATA%\<identifier>\logs`）。
pub fn log_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os(CONFIG_DIR_ENV).filter(|v| !v.is_empty()) {
        return PathBuf::from(dir).join("logs");
    }
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_IDENTIFIER)
        .join("logs")
}

/// 讀 JSON；檔案不存在回 `None`，壞掉的檔案回錯誤（呼叫端決定要不要用預設值蓋掉）。
pub fn read_json_in<T: DeserializeOwned>(dir: &Path, name: &str) -> AppResult<Option<T>> {
    let path = dir.join(name);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(AppError::Storage(format!("{}: {e}", path.display()))),
    };
    // 容忍 UTF-8 BOM：PowerShell 5.1 的 Set-Content / Out-File 預設會寫 BOM，
    // IT 手動改設定檔時很容易踩到（上游也曾因為 BOM 讓 JSON.parse 失敗）。
    let text = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    serde_json::from_slice(text)
        .map(Some)
        .map_err(|e| AppError::Storage(format!("{}: {e}", path.display())))
}

/// 原子寫入：先寫 `<name>.tmp` 再 rename，避免當機或斷電留下半個檔案。
pub fn write_json_in<T: Serialize>(dir: &Path, name: &str, value: &T) -> AppResult<()> {
    std::fs::create_dir_all(dir)
        .map_err(|e| AppError::Storage(format!("{}: {e}", dir.display())))?;
    let path = dir.join(name);
    let tmp = dir.join(format!("{name}.tmp"));
    let mut json = serde_json::to_vec_pretty(value)
        .map_err(|e| AppError::Storage(format!("serialize {name}: {e}")))?;
    json.push(b'\n');
    std::fs::write(&tmp, json).map_err(|e| AppError::Storage(format!("{}: {e}", tmp.display())))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| AppError::Storage(format!("{}: {e}", path.display())))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_tolerates_bom() {
        let dir = tempfile::tempdir().unwrap();
        write_json_in(dir.path(), "a.json", &serde_json::json!({ "x": 1 })).unwrap();
        let v: serde_json::Value = read_json_in(dir.path(), "a.json").unwrap().unwrap();
        assert_eq!(v["x"], 1);
        std::fs::write(dir.path().join("b.json"), b"\xEF\xBB\xBF{\"y\":2}").unwrap();
        let v: serde_json::Value = read_json_in(dir.path(), "b.json").unwrap().unwrap();
        assert_eq!(v["y"], 2);
        let missing: Option<serde_json::Value> = read_json_in(dir.path(), "none.json").unwrap();
        assert!(missing.is_none());
    }
}
