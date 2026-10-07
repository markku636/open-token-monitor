//! OS 認證管理員裡的秘密：client secret 的覆寫值（金鑰輪替）與額度 provider 的登入
//! （GitHub Copilot 的 OAuth token）。
//!
//! 正常情況 secret 內建在 binary；只有 hub 換了 secret、員工還沒裝新版時，才由設定頁或
//! `tm-agent secret set` 寫一份覆寫值到 OS 認證管理員（Windows Credential Manager）。
//! 刻意不寫進 settings.json：設定檔是給人看、給 IT 改的，不該出現 secret。

use crate::baked::APP_IDENTIFIER;
use crate::error::{AppError, AppResult};

const ACCOUNT: &str = "hub-client-secret";
/// GitHub Copilot 額度用的 GitHub OAuth token（設定頁以 device flow 登入取得）。
pub const COPILOT_TOKEN: &str = "copilot-github-token";

fn entry() -> AppResult<keyring::Entry> {
    named(ACCOUNT)
}

fn named(account: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(APP_IDENTIFIER, account).map_err(|e| AppError::Secret(e.to_string()))
}

/// 讀一個具名的秘密；沒有或讀取失敗都回 `None`。
pub fn get(account: &str) -> Option<String> {
    if std::env::var_os("TOKEN_MONITOR_DISABLE_KEYRING").is_some() {
        return None;
    }
    match named(account).ok()?.get_password() {
        Ok(v) if !v.trim().is_empty() => Some(v.trim().to_string()),
        Ok(_) | Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            tracing::debug!(error = %e, account, "keyring read failed");
            None
        }
    }
}

pub fn set(account: &str, value: &str) -> AppResult<()> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return clear(account);
    }
    named(account)?
        .set_password(trimmed)
        .map_err(|e| AppError::Secret(e.to_string()))
}

pub fn clear(account: &str) -> AppResult<()> {
    match named(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Secret(e.to_string())),
    }
}

/// 讀覆寫值；沒有或讀取失敗都回 `None`（失敗只記 log，不帶出 secret 內容）。
pub fn override_secret() -> Option<String> {
    if std::env::var_os("TOKEN_MONITOR_DISABLE_KEYRING").is_some() {
        return None;
    }
    let entry = entry().ok()?;
    match entry.get_password() {
        Ok(v) if !v.trim().is_empty() => Some(v.trim().to_string()),
        Ok(_) | Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            tracing::debug!(error = %e, "keyring read failed");
            None
        }
    }
}

pub fn set_override_secret(secret: &str) -> AppResult<()> {
    let trimmed = secret.trim();
    if trimmed.is_empty() {
        return clear_override_secret();
    }
    entry()?
        .set_password(trimmed)
        .map_err(|e| AppError::Secret(e.to_string()))
}

pub fn clear_override_secret() -> AppResult<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Secret(e.to_string())),
    }
}
