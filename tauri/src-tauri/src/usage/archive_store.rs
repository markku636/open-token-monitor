//! session usage archive 的存放（上游 sessionUsageArchiveStore.js 同樣用 SQLite）。
//!
//! 一年下來 allTime 可能有幾千個 session，整份 JSON 每次即時更新都重寫太重；這裡每個 session 一列，
//! 每次只 upsert 這次有變動的 key。讀檔時壞掉的列略過（寧可少補一筆，也不要整個 archive 讀不進來）。
//! 檔案在設定目錄的 `session-usage-archive.sqlite`。
//!
//! GUI 與 tm-agent 可能同時開著同一個檔（device/agent_pid.rs）：寫入前與 GUI 讓出寫入權時都先
//! `refresh`，另一個程序 commit 過（`PRAGMA data_version` 變了）就整份重讀，不會拿舊的記憶體內容
//! 蓋掉對方剛寫的列（上游以 revision 欄位增量重讀，這裡的 schema 沒有 revision，整份重讀也只要幾毫秒）。

use std::path::Path;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};

use super::archive::{ArchiveEntry, CaptureAt, SessionArchive};
use crate::error::{AppError, AppResult};
use crate::wire::UsageSummary;

pub const ARCHIVE_FILE: &str = "session-usage-archive.sqlite";

/// 另一個程序正在寫時最多等多久（上游 `PRAGMA busy_timeout = 5000`）。
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

pub struct ArchiveStore {
    conn: Connection,
    archive: SessionArchive,
    /// dry run：照樣讀、照樣補回，但不寫檔（上游 dry run 不建 archive store）。
    read_only: bool,
    /// 上次讀檔時的 `PRAGMA data_version`；別的連線 commit 後才會變（自己的寫入不會）。
    data_version: i64,
}

fn db_err(e: rusqlite::Error) -> AppError {
    AppError::Storage(format!("session archive: {e}"))
}

fn data_version(conn: &Connection) -> AppResult<i64> {
    conn.query_row("PRAGMA data_version", [], |r| r.get(0))
        .map_err(db_err)
}

/// 整份讀進記憶體。壞掉的列略過。
fn load(conn: &Connection) -> AppResult<SessionArchive> {
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
    Ok(archive)
}

/// 沒有開著的 store 時（archive 關閉、或檔案壞到開不起來）直接刪檔，連同 WAL 的兩個附屬檔
/// （上游 store `clear()`）。回傳是否真的刪了東西。
pub fn remove_files(path: &Path) -> AppResult<bool> {
    let mut removed = false;
    let name = path.as_os_str().to_owned();
    for suffix in ["", "-wal", "-shm"] {
        let mut file = name.clone();
        file.push(suffix);
        match std::fs::remove_file(&file) {
            Ok(()) => removed = true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(AppError::Storage(format!(
                    "{}: {e}",
                    Path::new(&file).display()
                )))
            }
        }
    }
    Ok(removed)
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
        conn.busy_timeout(BUSY_TIMEOUT).map_err(db_err)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS sessions (key TEXT PRIMARY KEY, entry TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);",
        )
        .map_err(db_err)?;
        // 先記版本再讀：兩者之間別人 commit 了，下一次 refresh 會再讀一次，不會漏。
        let data_version = data_version(&conn)?;
        let archive = load(&conn)?;
        Ok(ArchiveStore {
            conn,
            archive,
            read_only: false,
            data_version,
        })
    }

    pub fn set_read_only(&mut self, read_only: bool) {
        self.read_only = read_only;
    }

    /// 另一個程序（tm-agent，或讓出寫入權期間的 GUI 以外的寫入者）commit 過就整份重讀（上游
    /// `sessionUsageArchiveStore.refresh`）。回傳是否重讀了。
    pub fn refresh(&mut self) -> AppResult<bool> {
        let version = data_version(&self.conn)?;
        if version == self.data_version {
            return Ok(false);
        }
        self.archive = load(&self.conn)?;
        self.data_version = version;
        Ok(true)
    }

    /// 清掉所有保留的 session（上游 `sessionUsageArchive:clear` 的 store 部分）。上游是關掉連線再刪檔；
    /// 這裡連線還開著（Windows 不能刪開著的檔），所以刪列、再 VACUUM 把檔案縮回去。回傳清掉的筆數。
    pub fn clear(&mut self) -> AppResult<usize> {
        let removed = self.archive.sessions.len();
        self.conn
            .execute_batch("BEGIN IMMEDIATE; DELETE FROM sessions; DELETE FROM meta; COMMIT;")
            .map_err(|e| {
                let _ = self.conn.execute_batch("ROLLBACK");
                db_err(e)
            })?;
        self.archive = SessionArchive::default();
        if let Err(e) = self.conn.execute_batch("VACUUM") {
            tracing::warn!(error = %e, "session archive vacuum failed");
        }
        Ok(removed)
    }

    pub fn len(&self) -> usize {
        self.archive.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.archive.sessions.is_empty()
    }

    /// 記住這次的 session 並寫入有變動的列。回傳變動的筆數。
    ///
    /// 會寫檔時先 `refresh`：GUI 剛從讓出寫入權恢復、或兩邊短暫同時在寫時，比較的基準是檔案裡最新的
    /// 內容，不會把對方較新的擷取改回自己手上較舊的。dry run 不重讀（記憶體裡的擷取就是它的全部）。
    pub fn capture(&mut self, summary: &UsageSummary, at: &CaptureAt) -> AppResult<usize> {
        if !self.read_only {
            self.refresh()?;
        }
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

    fn summary_with(id: &str, tokens: i64) -> UsageSummary {
        let mut summary = UsageSummary::default();
        summary.all_time.sessions.insert(
            format!("codex:{id}"),
            Session {
                client: "codex".into(),
                session_id: id.into(),
                total_tokens: tokens,
                ..Session::default()
            },
        );
        summary
    }

    fn at(minutes_ago: i64) -> CaptureAt {
        CaptureAt::from_local(chrono::Local::now() - chrono::Duration::minutes(minutes_ago))
    }

    #[test]
    fn refresh_reads_what_another_process_committed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ARCHIVE_FILE);
        let mut gui = ArchiveStore::open(&path).unwrap();
        let mut agent = ArchiveStore::open(&path).unwrap();
        assert!(!gui.refresh().unwrap(), "nothing changed yet");
        agent.capture(&summary_with("a", 10), &at(0)).unwrap();
        assert!(!agent.refresh().unwrap(), "its own commit is not a change");
        assert!(gui.refresh().unwrap());
        assert_eq!(gui.len(), 1);
        assert!(!gui.refresh().unwrap());
    }

    #[test]
    fn a_stale_writer_does_not_overwrite_a_newer_capture() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ARCHIVE_FILE);
        let mut older = ArchiveStore::open(&path).unwrap();
        let mut newer = ArchiveStore::open(&path).unwrap();
        newer.capture(&summary_with("x", 50), &at(0)).unwrap();
        // 另一個程序手上是更早的觀察：capture 前先重讀，就不會把 50 改回 40。
        assert_eq!(older.capture(&summary_with("x", 40), &at(5)).unwrap(), 0);
        let reopened = ArchiveStore::open(&path).unwrap();
        let mut empty = UsageSummary::default();
        reopened.apply(&mut empty, &at(0));
        assert_eq!(empty.all_time.total_tokens, 50);
    }

    #[test]
    fn clear_empties_the_store_and_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ARCHIVE_FILE);
        let mut store = ArchiveStore::open(&path).unwrap();
        store.capture(&summary_with("a", 10), &at(0)).unwrap();
        store.capture(&summary_with("b", 20), &at(0)).unwrap();
        assert_eq!(store.clear().unwrap(), 2);
        assert!(store.is_empty());
        let mut empty = UsageSummary::default();
        assert_eq!(store.apply(&mut empty, &at(0)), 0);
        drop(store);
        assert!(ArchiveStore::open(&path).unwrap().is_empty());
    }

    #[test]
    fn remove_files_deletes_the_database_and_its_wal() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ARCHIVE_FILE);
        assert!(!remove_files(&path).unwrap(), "nothing to remove");
        ArchiveStore::open(&path)
            .unwrap()
            .capture(&summary_with("a", 10), &at(0))
            .unwrap();
        std::fs::write(dir.path().join(format!("{ARCHIVE_FILE}-wal")), b"").unwrap();
        assert!(remove_files(&path).unwrap());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ARCHIVE_FILE);
        let at = CaptureAt::from_local(chrono::Local::now());
        let summary = summary_with("x", 42);
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
