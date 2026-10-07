//! 把 tokscale（fork 版）附在列旁的 `sessions[]` 與 `workspaces[]` 摺回每一列
//! （上游 src/shared/sessionMetadata.js `applyTokscaleSessionMetadata`）。
//!
//! - `sessions[]`：每個 session 的起訖時間與標題 → 列的 `startedAt` / `lastUsedAt`。
//! - `workspaces[]`：workspace key 解碼出的真實路徑 → `projectId`（雜湊）與 `projectLabel`。
//!
//! 只有解碼出路徑的 workspace 才算數：不透明的 key 直接雜湊會替同一個資料夾產生第二個身分。

use std::collections::HashMap;

use serde_json::Value;

use super::js::first_truthy_string;
use crate::limits::hash::hash_key;
use crate::wire::time::iso_from_ms;

struct SessionMeta {
    started_at: Option<String>,
    last_used_at: Option<String>,
}

struct Identity {
    project_id: String,
    project_label: String,
}

fn ms_field(entry: &serde_json::Map<String, Value>, camel: &str, snake: &str) -> Option<String> {
    let v = entry.get(camel).or_else(|| entry.get(snake))?;
    let ms = v.as_f64()?;
    // 0 是 tokscale 的「沒有可用時間」，不是 epoch。
    (ms.is_finite() && ms > 0.0)
        .then(|| iso_from_ms(ms as i64))
        .flatten()
}

/// `normalizeProjectPath`：反斜線換正斜線、去掉尾端斜線（根目錄除外）、Windows 路徑一律小寫。
pub fn normalize_project_path(value: &str) -> String {
    let mut normalized = value.trim().replace('\\', "/");
    if normalized.is_empty() {
        return normalized;
    }
    let windows = is_windows_path(&normalized);
    if !is_root(&normalized) {
        normalized = normalized.trim_end_matches('/').to_string();
    }
    if windows {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

fn is_windows_path(p: &str) -> bool {
    let b = p.as_bytes();
    (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'/')
        || p.starts_with("//")
}

fn is_root(p: &str) -> bool {
    let b = p.as_bytes();
    p == "/" || (b.len() == 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'/')
}

/// `projectIdentity`：`projectId = sha256("project\0<正規化路徑>\0")`，label 取最後一段。
pub fn project_identity(path: &str) -> Option<(String, String)> {
    let normalized = normalize_project_path(path);
    if normalized.is_empty() {
        return None;
    }
    let label = if is_root(&normalized) {
        if normalized == "/" {
            "/".to_string()
        } else {
            format!("{}:\\", normalized[..1].to_uppercase())
        }
    } else {
        let display = path.trim().replace('\\', "/");
        let display = display.trim_end_matches('/');
        display.rsplit('/').next().unwrap_or(display).to_string()
    };
    Some((hash_key(&["project", &normalized]), label))
}

pub fn apply_tokscale_session_metadata(json: &mut Value, resolve_projects: bool) {
    let Some(root) = json.as_object_mut() else {
        return;
    };
    let has_rows = matches!(root.get("entries"), Some(Value::Array(rows)) if !rows.is_empty());
    if !has_rows {
        return;
    }

    let mut sessions: HashMap<String, SessionMeta> = HashMap::new();
    if let Some(Value::Array(entries)) = root.get("sessions") {
        for entry in entries.iter().filter_map(Value::as_object) {
            let client = first_truthy_string(entry, &["client"]).trim().to_string();
            let session_id = entry
                .get("sessionId")
                .or_else(|| entry.get("session_id"))
                .map(|v| super::js::to_js_string(v).trim().to_string())
                .unwrap_or_default();
            if client.is_empty() || session_id.is_empty() {
                continue;
            }
            sessions.insert(
                format!("{client}:{session_id}"),
                SessionMeta {
                    started_at: ms_field(entry, "firstActiveMs", "first_active_ms"),
                    last_used_at: ms_field(entry, "lastActiveMs", "last_active_ms"),
                },
            );
        }
    }

    // 身分以 workspace 為單位解析一次，不是每列一次：列遠多於 workspace，而且要雜湊。
    let mut identities: HashMap<String, Option<Identity>> = HashMap::new();
    if let Some(Value::Array(entries)) = root.get("workspaces") {
        for entry in entries.iter().filter_map(Value::as_object) {
            let key = entry
                .get("workspaceKey")
                .or_else(|| entry.get("workspace_key"))
                .map(|v| super::js::to_js_string(v).trim().to_string())
                .unwrap_or_default();
            if key.is_empty() || identities.contains_key(&key) {
                continue;
            }
            let path = first_truthy_string(entry, &["path"]).trim().to_string();
            let identity = if path.is_empty() {
                None
            } else {
                project_identity(&path).map(|(project_id, label)| Identity {
                    project_id,
                    project_label: if label.is_empty() {
                        first_truthy_string(entry, &["label"]).trim().to_string()
                    } else {
                        label
                    },
                })
            };
            identities.insert(key, identity);
        }
    }
    if sessions.is_empty() && identities.is_empty() {
        return;
    }

    let Some(Value::Array(rows)) = root.get_mut("entries") else {
        return;
    };
    for row in rows.iter_mut().filter_map(Value::as_object_mut) {
        let client = first_truthy_string(row, &["client"]).trim().to_string();
        let session_id = row
            .get("sessionId")
            .or_else(|| row.get("session_id"))
            .map(|v| super::js::to_js_string(v).trim().to_string())
            .unwrap_or_default();
        if !client.is_empty() && !session_id.is_empty() {
            if let Some(meta) = sessions.get(&format!("{client}:{session_id}")) {
                if let Some(started) = &meta.started_at {
                    if !row.get("startedAt").map(super::js::truthy).unwrap_or(false) {
                        row.insert("startedAt".into(), Value::String(started.clone()));
                    }
                }
                if let Some(last) = &meta.last_used_at {
                    if !row
                        .get("lastUsedAt")
                        .map(super::js::truthy)
                        .unwrap_or(false)
                    {
                        row.insert("lastUsedAt".into(), Value::String(last.clone()));
                    }
                }
            }
        }
        if !resolve_projects {
            continue;
        }
        let workspace_key = row
            .get("workspaceKey")
            .or_else(|| row.get("workspace_key"))
            .map(|v| super::js::to_js_string(v).trim().to_string())
            .unwrap_or_default();
        if workspace_key.is_empty() || row.get("projectId").map(super::js::truthy).unwrap_or(false)
        {
            continue;
        }
        if let Some(Some(identity)) = identities.get(&workspace_key) {
            row.insert(
                "projectId".into(),
                Value::String(identity.project_id.clone()),
            );
            row.insert(
                "projectLabel".into(),
                Value::String(identity.project_label.clone()),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn project_paths() {
        assert_eq!(
            normalize_project_path("D:\\Projects\\Token-Monitor\\"),
            "d:/projects/token-monitor"
        );
        assert_eq!(normalize_project_path("/home/me/repo/"), "/home/me/repo");
        assert_eq!(normalize_project_path("C:/"), "c:/");
        let (id, label) = project_identity("d:/projects/token-monitor").unwrap();
        assert!(id.starts_with("sha256:"));
        assert_eq!(label, "token-monitor");
        assert_eq!(project_identity("C:\\").unwrap().1, "C:\\");
        assert_eq!(project_identity("/").unwrap().1, "/");
    }

    #[test]
    fn folds_metadata_onto_rows() {
        let mut j = json!({
            "entries": [{ "client": "claude", "sessionId": "s1", "workspaceKey": "w", "input": 1 }],
            "sessions": [{ "client": "claude", "sessionId": "s1", "firstActiveMs": 1790156194179_i64, "lastActiveMs": 0 }],
            "workspaces": [{ "workspaceKey": "w", "label": "token-monitor", "path": "d:/projects/token-monitor" }]
        });
        apply_tokscale_session_metadata(&mut j, true);
        let row = &j["entries"][0];
        assert_eq!(row["startedAt"], "2026-09-23T09:36:34.179Z");
        assert!(row.get("lastUsedAt").is_none());
        assert_eq!(row["projectLabel"], "token-monitor");
        assert!(row["projectId"].as_str().unwrap().starts_with("sha256:"));

        let mut j2 = j.clone();
        j2["entries"][0]
            .as_object_mut()
            .unwrap()
            .remove("projectId");
        j2["entries"][0]
            .as_object_mut()
            .unwrap()
            .remove("projectLabel");
        apply_tokscale_session_metadata(&mut j2, false);
        assert!(j2["entries"][0].get("projectId").is_none());
    }
}
