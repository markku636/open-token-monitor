//! Cursor IDE / Cursor CLI：帳號探測與 token 正規化（上游 src/shared/providers/cursor/auth.js）。
//!
//! Cursor 的用量不在本機紀錄裡，而是 Cursor 帳號層級的用量匯出，所以 IDE 與 CLI 都算得到。
//! 流程：
//! 1. 從 Cursor 桌面版的 `state.vscdb`（SQLite，`ItemTable` 的 `cursorAuth/accessToken`）讀出登入 token。
//! 2. 正規化後寫進 tokscale 的帳號檔 `~/.config/tokscale/cursor-credentials.json`
//!    （與上游 Electron 版、`tokscale cursor login` 共用同一個檔案與格式）。
//! 3. `tokscale cursor sync --json` 把用量拉進 `~/.config/tokscale/cursor-cache/`，之後的掃描才讀得到。
//!
//! 第 2 步刻意不切換 active 帳號（上游 `activate: false`）：員工若自己用 tokscale 管理多個帳號，
//! 我們只補上桌面版的那一個，不改他選的。token 只寫到本機，從不寫 log、不上傳到 hub。

use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

const DESKTOP_TOKEN_KEY: &str = "cursorAuth/accessToken";
const MAX_TOKEN_LEN: usize = 16 * 1024;

pub fn credentials_path(home: &Path) -> PathBuf {
    home.join(".config")
        .join("tokscale")
        .join("cursor-credentials.json")
}

pub fn cache_dir(home: &Path) -> PathBuf {
    home.join(".config").join("tokscale").join("cursor-cache")
}

/// Cursor 桌面版的 state.vscdb 可能位置（依平台）。
pub fn desktop_state_candidates(home: &Path) -> Vec<PathBuf> {
    let tail = |base: PathBuf| {
        base.join("Cursor")
            .join("User")
            .join("globalStorage")
            .join("state.vscdb")
    };
    if cfg!(target_os = "macos") {
        return vec![tail(home.join("Library").join("Application Support"))];
    }
    if cfg!(windows) {
        let mut out = Vec::new();
        if let Some(app_data) =
            std::env::var_os("APPDATA").filter(|v| !v.to_string_lossy().trim().is_empty())
        {
            out.push(tail(PathBuf::from(app_data)));
        }
        out.push(tail(home.join("AppData").join("Roaming")));
        return out;
    }
    vec![tail(home.join(".config"))]
}

/// `canonicalCursorUserId`：取出 `user_XXXX` 形式的使用者 id。
pub fn canonical_user_id(value: &str) -> Option<String> {
    // 等同 `/user_[A-Za-z0-9_]+/` 的第一個相符。
    value.match_indices("user_").find_map(|(start, _)| {
        let id: String = value[start..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        (id.len() > "user_".len()).then_some(id)
    })
}

fn split_head(token: &str) -> Option<&str> {
    for sep in ["%3A%3A", "::"] {
        if let Some((head, _)) = token.split_once(sep) {
            let head = head.trim();
            if !head.is_empty() {
                return Some(head);
            }
        }
    }
    None
}

/// `extractUserId`
pub fn extract_user_id(token: &str) -> Option<String> {
    split_head(token).and_then(canonical_user_id)
}

/// `deriveAccountId`：`user_…%3A%3A…` 取前半；否則 `anon-` + sha256 前 12 碼。
pub fn derive_account_id(token: &str) -> String {
    if let Some(head) = split_head(token) {
        return head.to_string();
    }
    let digest = Sha256::digest(token.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("anon-{}", &hex[..12])
}

/// 本機 access token 是 JWT：`sub` 裡帶 `user_…`。
fn user_id_from_access_token(token: &str) -> Option<String> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[1].trim_end_matches('='))
        .ok()?;
    let value: Value = serde_json::from_slice(&payload).ok()?;
    value
        .get("sub")
        .and_then(Value::as_str)
        .and_then(canonical_user_id)
}

/// `normalizeCursorSessionToken`：接受 cookie header、`WorkosCursorSessionToken=…`、引號、
/// `user::token`、裸 JWT，一律轉成 `user_…%3A%3A<token>`。無效時回空字串。
pub fn normalize_session_token(input: &str) -> String {
    let mut token = input.trim().to_string();
    if token.is_empty() || token.len() > MAX_TOKEN_LEN {
        return String::new();
    }
    if token.to_lowercase().starts_with("cookie:") {
        token = token[7..].trim().to_string();
    }
    let lower = token.to_lowercase();
    if let Some(pos) = lower.find("workoscursorsessiontoken=") {
        let rest = &token[pos + "workoscursorsessiontoken=".len()..];
        token = rest
            .chars()
            .take_while(|c| *c != ';' && !c.is_whitespace())
            .collect();
    }
    let quoted = |t: &str, q: char| t.len() >= 2 && t.starts_with(q) && t.ends_with(q);
    if quoted(&token, '"') || quoted(&token, '\'') {
        token = token[1..token.len() - 1].trim().to_string();
    }
    if token.is_empty() || token.chars().any(char::is_whitespace) {
        return String::new();
    }
    if let Some(sep) = token.find("::").filter(|&i| i > 0) {
        token = format!("{}%3A%3A{}", &token[..sep], &token[sep + 2..]);
    } else if !token.contains("%3A%3A") {
        if let Some(user_id) = user_id_from_access_token(&token) {
            token = format!("{user_id}%3A%3A{token}");
        }
    }
    token
}

/// 讀 Cursor 桌面版登入中的 access token；沒安裝或沒登入回 `None`。
pub fn read_desktop_access_token(candidates: &[PathBuf]) -> AppResult<Option<String>> {
    let Some(db_path) = candidates.iter().find(|p| p.is_file()) else {
        return Ok(None);
    };
    use rusqlite::{types::ValueRef, OpenFlags};
    // 唯讀開啟：Cursor 執行中也能讀（WAL），而且絕不改到 Cursor 自己的資料庫。
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| AppError::Storage(format!("Cursor state.vscdb: {e}")))?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(2));
    let token = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = ?1",
            [DESKTOP_TOKEN_KEY],
            |row| {
                Ok(match row.get_ref(0)? {
                    ValueRef::Text(t) => String::from_utf8_lossy(t).trim().to_string(),
                    ValueRef::Blob(b) => String::from_utf8_lossy(b).trim().to_string(),
                    _ => String::new(),
                })
            },
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(AppError::Storage(format!("Cursor state.vscdb: {other}"))),
        })?;
    Ok(token.filter(|t| !t.is_empty()))
}

fn account_is_valid(accounts: &Map<String, Value>, id: &str) -> bool {
    accounts
        .get(id)
        .and_then(|a| a.get("sessionToken"))
        .and_then(Value::as_str)
        .map(|t| !t.is_empty())
        .unwrap_or(false)
}

/// `runCursorLogin(token, { activate: false })`：新增或更新帳號；只有在目前沒有有效的 active 帳號時才設為 active。
/// 回傳 `(accountId, 檔案是否有變)`。沒變就不寫檔。
pub fn upsert_account(file: &Path, token: &str, now_iso: &str) -> AppResult<(String, bool)> {
    let account_id = derive_account_id(token);
    let user_id = extract_user_id(token);
    let existing: Option<Value> = std::fs::read(file)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .filter(Value::is_object);
    let before = existing.clone();
    let mut store = existing
        .unwrap_or_else(|| json!({ "version": 1, "activeAccountId": account_id, "accounts": {} }));
    let obj = store.as_object_mut().expect("store is an object");
    if !obj.get("accounts").map(Value::is_object).unwrap_or(false) {
        obj.insert("accounts".into(), json!({}));
    }
    let active = obj
        .get("activeAccountId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let accounts = obj
        .get_mut("accounts")
        .and_then(Value::as_object_mut)
        .expect("accounts is an object");
    let active_valid = !active.is_empty() && account_is_valid(accounts, &active);
    let previous = accounts.get(&account_id).cloned();
    let created_at = previous
        .as_ref()
        .and_then(|a| a.get("createdAt"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(now_iso)
        .to_string();
    let label = previous
        .as_ref()
        .and_then(|a| a.get("label"))
        .cloned()
        .unwrap_or(Value::Null);
    let mut entry = previous
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    entry.insert("sessionToken".into(), Value::String(token.to_string()));
    entry.insert(
        "userId".into(),
        user_id.map(Value::String).unwrap_or(Value::Null),
    );
    entry.insert("createdAt".into(), Value::String(created_at));
    entry.insert("expiresAt".into(), Value::Null);
    entry.insert("label".into(), label);
    accounts.insert(account_id.clone(), Value::Object(entry));
    if !active_valid {
        obj.insert("activeAccountId".into(), Value::String(account_id.clone()));
    }
    if !obj.contains_key("version") {
        obj.insert("version".into(), json!(1));
    }
    if before.as_ref() == Some(&store) {
        return Ok((account_id, false));
    }
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("json.tmp");
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(&store).map_err(|e| AppError::Internal(e.to_string()))?,
    )?;
    std::fs::rename(&tmp, file)?;
    Ok((account_id, true))
}

pub fn saved_account_count(file: &Path) -> usize {
    std::fs::read(file)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| {
            v.get("accounts")
                .and_then(Value::as_object)
                .map(|a| a.len())
        })
        .unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoverOutcome {
    /// 沒安裝 Cursor 桌面版，或沒有登入。
    NotSignedIn,
    /// 已寫入（或已存在且相同）。
    Imported { account_id: String, changed: bool },
}

/// `runCursorDiscover`：讀桌面版 token → 正規化 → 寫入 tokscale 帳號檔（不切換 active、不觸發同步）。
pub fn discover(home: &Path) -> AppResult<DiscoverOutcome> {
    let Some(access) = read_desktop_access_token(&desktop_state_candidates(home))? else {
        return Ok(DiscoverOutcome::NotSignedIn);
    };
    let token = normalize_session_token(&access);
    if token.is_empty() || extract_user_id(&token).is_none() {
        return Err(AppError::Internal(
            "Cursor 桌面版的 token 沒有可辨識的帳號".into(),
        ));
    }
    let now = crate::wire::time::iso_millis(chrono::Utc::now());
    let (account_id, changed) = upsert_account(&credentials_path(home), &token, &now)?;
    Ok(DiscoverOutcome::Imported {
        account_id,
        changed,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncResult {
    pub synced: bool,
    pub rows: u64,
    pub not_authenticated: bool,
}

/// `parseCursorSyncResult`：`{"synced":bool,"rows":n,"error":…}`；「未登入」不算失敗。
pub fn parse_sync_result(json: &Value) -> AppResult<SyncResult> {
    let synced = json.get("synced").and_then(Value::as_bool).ok_or_else(|| {
        AppError::TokscaleOutput("tokscale cursor sync returned an invalid result".into())
    })?;
    let error = json
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let not_authenticated = !synced && error.to_lowercase().contains("not authenticated");
    if !synced && !not_authenticated {
        return Err(AppError::Internal(if error.is_empty() {
            "Cursor sync failed".into()
        } else {
            error
        }));
    }
    let rows = json
        .get("rows")
        .and_then(Value::as_f64)
        .filter(|r| r.is_finite() && *r > 0.0)
        .unwrap_or(0.0) as u64;
    Ok(SyncResult {
        synced,
        rows,
        not_authenticated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(sub: &str) -> String {
        let enc = |v: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v);
        format!(
            "{}.{}.sig",
            enc(r#"{"alg":"HS256"}"#),
            enc(&format!(r#"{{"sub":"{sub}"}}"#))
        )
    }

    #[test]
    fn normalizes_like_upstream() {
        // 上游 tests/shared/cursorAuth.test.js 的案例
        assert_eq!(
            normalize_session_token(
                "Cookie: other=x; WorkosCursorSessionToken=user_01ABC::opaque; next=y"
            ),
            "user_01ABC%3A%3Aopaque"
        );
        let t = jwt("auth0|user_01LOCAL");
        assert_eq!(
            normalize_session_token(&t),
            format!("user_01LOCAL%3A%3A{t}")
        );
        assert_eq!(
            normalize_session_token("\"user_01Q::tok\""),
            "user_01Q%3A%3Atok"
        );
        assert_eq!(normalize_session_token("has space"), "");
        assert_eq!(normalize_session_token(""), "");
    }

    #[test]
    fn account_ids() {
        assert_eq!(derive_account_id("user_01HXYZ%3A%3Atok"), "user_01HXYZ");
        assert_eq!(
            extract_user_id("user_01HXYZ%3A%3Atok").as_deref(),
            Some("user_01HXYZ")
        );
        assert!(derive_account_id("plain-token").starts_with("anon-"));
        assert_eq!(derive_account_id("plain-token").len(), "anon-".len() + 12);
        assert_eq!(extract_user_id("plain-token"), None);
    }

    #[test]
    fn upsert_keeps_existing_active_account_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let file = credentials_path(dir.path());
        let (a, changed) =
            upsert_account(&file, "user_01A%3A%3Atoken-a", "2026-09-23T00:00:00.000Z").unwrap();
        assert!(changed);
        let (b, _) =
            upsert_account(&file, "user_01B%3A%3Atoken-b", "2026-09-23T00:00:01.000Z").unwrap();
        let v: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(
            v["activeAccountId"], a,
            "discovery never steals the active account"
        );
        assert_eq!(v["accounts"][&b]["userId"], "user_01B");
        assert_eq!(v["accounts"][&a]["expiresAt"], Value::Null);
        let (_, changed) =
            upsert_account(&file, "user_01B%3A%3Atoken-b", "2026-09-24T00:00:00.000Z").unwrap();
        assert!(!changed, "same token → no rewrite, createdAt preserved");
        let (_, changed) =
            upsert_account(&file, "user_01B%3A%3Atoken-b2", "2026-09-24T00:00:00.000Z").unwrap();
        assert!(changed, "rotated token is written");
        let v: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(v["accounts"][&b]["createdAt"], "2026-09-23T00:00:01.000Z");
        assert_eq!(saved_account_count(&file), 2);
    }

    #[test]
    fn reads_desktop_token_from_sqlite() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("state.vscdb");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);",
        )
        .unwrap();
        let token = jwt("user_01DESK");
        conn.execute(
            "INSERT INTO ItemTable (key, value) VALUES (?1, ?2)",
            ["cursorAuth/accessToken", token.as_str()],
        )
        .unwrap();
        drop(conn);
        assert_eq!(
            read_desktop_access_token(std::slice::from_ref(&db))
                .unwrap()
                .as_deref(),
            Some(token.as_str())
        );
        assert_eq!(
            read_desktop_access_token(&[dir.path().join("missing.vscdb")]).unwrap(),
            None
        );
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute("DELETE FROM ItemTable", []).unwrap();
        drop(conn);
        assert_eq!(read_desktop_access_token(&[db]).unwrap(), None);
    }

    #[test]
    fn sync_result_parsing() {
        let ok = parse_sync_result(&json!({ "synced": true, "rows": 12 })).unwrap();
        assert_eq!(
            ok,
            SyncResult {
                synced: true,
                rows: 12,
                not_authenticated: false
            }
        );
        let signed_out =
            parse_sync_result(&json!({ "synced": false, "rows": 0, "error": "Not authenticated" }))
                .unwrap();
        assert!(signed_out.not_authenticated);
        assert!(parse_sync_result(&json!({ "synced": false, "error": "HTTP 500" })).is_err());
        assert!(parse_sync_result(&json!({ "rows": 1 })).is_err());
    }
}
