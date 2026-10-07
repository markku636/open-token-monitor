//! session usage archive 的存放（上游 sessionUsageArchiveStore.js 同樣用 SQLite）。
//!
//! 一年下來 allTime 可能有幾千個 session，整份 JSON 每次即時更新都重寫太重；這裡每個 session 一列，
//! 每次只 upsert 這次有變動的 key。讀檔時壞掉的列略過（寧可少補一筆，也不要整個 archive 讀不進來）。
//! 檔案在設定目錄的 `session-usage-archive.sqlite`。

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use super::archive::{ArchiveEntry, CaptureAt, SessionArchive};
use crate::error::{AppError, AppResult};
use crate::wire::UsageSummary;

pub const ARCHIVE_FILE: &str = "session-usage-archive.sqlite";

pub struct ArchiveStore {
    conn: Connection,
    archive: SessionArchive,
    /// dry run：照樣讀、照樣補回，但不寫檔（上游 dry run 不建 archive store）。
    read_only: bool,
}

fn db_err(e: rusqlite::Error) -> AppError {
    AppError::Storage(format!("session archive: {e}"))
}

impl ArchiveStore {
    pub fn open(path: &Path) -> AppResult<ArchiveStore> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| AppError::Storage(e.to_string()))?;
        }
        Self::init(Connection::open(path).map_err(db_err)?)
    }

    /// dry run 而且還沒有 archive：用記憶體資料庫，不在設定目錄留下檔案。
    pub fn open_in_memory() -> AppResult<ArchiveStore> {
        Self::init(Connection::open_in_memory().map_err(db_err)?)
    }

    fn init(conn: Connection) -> AppResult<ArchiveStore> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS sessions (key TEXT PRIMARY KEY, entry TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);",
        )
        .map_err(db_err)?;
        let mut archive = SessionArchive::default();
        {
            let mut stmt = conn
                .prepare("SELECT key, entry FROM sessions ORDER BY rowid")
                .map_err(db_err)?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(db_err)?;
            for row in rows {
                let (key, json) = row.map_err(db_err)?;
                match serde_json::from_str::<ArchiveEntry>(&json) {
                    Ok(entry) => {
                        archive.sessions.insert(key, entry);
                    }
                    Err(e) => {
                        tracing::warn!(%key, error = %e, "skipping unreadable archived session")
                    }
                }
            }
        }
        let meta = |k: &str| -> AppResult<Option<String>> {
            conn.query_row("SELECT v FROM meta WHERE k = ?1", [k], |r| r.get(0))
                .optional()
                .map_err(db_err)
        };
        archive.pruned_day = meta("prunedDay")?;
        archive.pruned_month = meta("prunedMonth")?;
        Ok(ArchiveStore {
            conn,
            archive,
            read_only: false,
        })
    }

    pub fn set_read_only(&mut self, read_only: bool) {
        self.read_only = read_only;
    }

    pub fn len(&self) -> usize {
        self.archive.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.archive.sessions.is_empty()
    }

    /// 記住這次的 session 並寫入有變動的列。回傳變動的筆數。
    pub fn capture(&mut self, summary: &UsageSummary, at: &CaptureAt) -> AppResult<usize> {
        let before = (
            self.archive.pruned_day.clone(),
            self.archive.pruned_month.clone(),
        );
        let changed = self.archive.capture(summary, at);
        let meta_changed = before
            != (
                self.archive.pruned_day.clone(),
                self.archive.pruned_month.clone(),
            );
        if (changed.is_empty() && !meta_changed) || self.read_only {
            return Ok(changed.len());
        }
        let tx = self.conn.transaction().map_err(db_err)?;
        {
            let mut upsert = tx
                .prepare("INSERT INTO sessions (key, entry) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET entry = excluded.entry")
                .map_err(db_err)?;
            for key in &changed {
                if let Some(entry) = self.archive.sessions.get(key) {
                    let json = serde_json::to_string(entry)
                        .map_err(|e| AppError::Internal(e.to_string()))?;
                    upsert.execute(params![key, json]).map_err(db_err)?;
                }
            }
            for (k, v) in [
                ("prunedDay", &self.archive.pruned_day),
                ("prunedMonth", &self.archive.pruned_month),
            ] {
                if let Some(v) = v {
                    tx.execute(
                        "INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                        params![k, v],
                    )
                    .map_err(db_err)?;
                }
            }
        }
        tx.commit().map_err(db_err)?;
        Ok(changed.len())
    }

    pub fn apply(&self, summary: &mut UsageSummary, now: &CaptureAt) -> usize {
        self.archive.apply(summary, now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::Session;

    #[test]
    fn survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ARCHIVE_FILE);
        let at = CaptureAt::from_local(chrono::Local::now());
        let mut summary = UsageSummary::default();
        summary.all_time.sessions.insert(
            "codex:x".into(),
            Session {
                client: "codex".into(),
                session_id: "x".into(),
                total_tokens: 42,
                ..Session::default()
            },
        );
        {
            let mut store = ArchiveStore::open(&path).unwrap();
            assert_eq!(store.capture(&summary, &at).unwrap(), 1);
            assert_eq!(store.capture(&summary, &at).unwrap(), 0, "unchanged");
        }
        let store = ArchiveStore::open(&path).unwrap();
        assert_eq!(store.len(), 1);
        let mut empty = UsageSummary::default();
        assert_eq!(store.apply(&mut empty, &at), 1);
        assert_eq!(empty.all_time.total_tokens, 42);
        assert!(empty.all_time.sessions["codex:x"].archived);
    }
}
