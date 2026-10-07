//! tokscale 輸出的解析：上游 src/shared/usage.js 與 sessionMetadata.js 的 Rust 移植。

pub mod archive;
pub mod archive_store;
pub mod client_name;
pub mod delta;
pub mod extract;
pub mod history;
pub mod history_archive;
pub mod js;
pub mod keys;
pub mod merge;
pub mod projects;
pub mod session_meta;

use serde_json::Value;

use crate::wire::Period;

/// 一次 tokscale 掃描輸出 → 一個 period：先摺入 session / workspace metadata，
/// 再抽出用量列，最後（projects 開啟時）由 session 彙總專案。
pub fn period_from_tokscale(mut json: Value, projects_enabled: bool) -> Period {
    session_meta::apply_tokscale_session_metadata(&mut json, projects_enabled);
    let mut period = extract::extract_usage(&json);
    if projects_enabled {
        projects::apply_project_rollups(&mut period);
    }
    period
}
