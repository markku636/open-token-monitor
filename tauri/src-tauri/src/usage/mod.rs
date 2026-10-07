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
pub mod projects;
pub mod session_meta;

use std::path::Path;

use serde_json::Value;

use crate::error::AppResult;
use crate::wire::Period;

/// 清除保留的 session 與每日歷史（上游 main.js `sessionUsageArchive:clear`：session store 的 `clear()`
/// 加上 `clearDailyHistoryArchive()`）。`store` 是開著的 session archive（清記憶體與檔案）；沒有開著的
/// （archive 關閉時）就直接刪 `dir` 裡的檔。保留功能關閉時資料仍在，所以一樣要清。
pub fn clear_retained_archives(
    dir: &Path,
    store: Option<&mut archive_store::ArchiveStore>,
) -> AppResult<()> {
    match store {
        Some(store) => {
            let removed = store.clear()?;
            tracing::info!(sessions = removed, "session usage archive cleared");
        }
        None => {
            archive_store::remove_files(&dir.join(archive_store::ARCHIVE_FILE))?;
        }
    }
    history_archive::clear(&dir.join(history_archive::HISTORY_ARCHIVE_FILE))?;
    Ok(())
}

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
