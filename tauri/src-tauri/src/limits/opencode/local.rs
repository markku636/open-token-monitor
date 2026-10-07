//! OpenCode Go 的本機估算（上游 providers/opencode/goLimits.js，逐條移植）。
//!
//! 讀 OpenCode 自己的 `opencode*.db`（唯讀），把 `opencode-go` 的助理訊息成本依 5 小時、本週（UTC 週一）、
//! 本月（以第一筆用量的日期時間為錨）加總，除以官方的 $12 / $30 / $60。只看得到這台電腦的紀錄，
//! 同一個帳號在別處用的量算不到，所以預設關閉（`opencodeLocalLimitsEnabled`），而且排在 API 與 cookie
//! 之後。

use std::path::{Path, PathBuf};

use super::transport::{clamp_pct, js_iso, js_string_to_number, round1};
use super::OpencodeEnv;
use crate::wire::{LimitWindow, ProviderStatus, WindowKind};

const SESSION_MS: i64 = 5 * 60 * 60 * 1000;
const WEEK_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// OpenCode Go 的官方上限（USD）：https://opencode.ai/docs/go/ 。伺服器端的固定值、不在本機資料庫裡，
/// 所以寫死；`TOKEN_MONITOR_OPENCODE_GO_LIMITS=12,30,60` 可以覆寫。
const DEFAULT_GO_LIMITS: GoLimits = GoLimits {
    session: 12.0,
    weekly: 30.0,
    monthly: 60.0,
};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GoLimits {
    pub session: f64,
    pub weekly: f64,
    pub monthly: f64,
}

/// 上游 `goLimits`：三個正的有限數字才採用。
pub fn go_limits(env: &OpencodeEnv) -> GoLimits {
    let raw = env.var("TOKEN_MONITOR_OPENCODE_GO_LIMITS").trim();
    if raw.is_empty() {
        return DEFAULT_GO_LIMITS;
    }
    let parts: Vec<f64> = raw
        .split(',')
        .map(|s| js_string_to_number(s.trim()))
        .collect();
    if parts.len() == 3 && parts.iter().all(|n| n.is_finite() && *n > 0.0) {
        return GoLimits {
            session: parts[0],
            weekly: parts[1],
            monthly: parts[2],
        };
    }
    DEFAULT_GO_LIMITS
}

/// 一則 `opencode-go` 助理訊息：建立時間（ms）與成本（USD）。
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoRow {
    pub created_ms: i64,
    pub cost: f64,
}

fn utc(ms: i64) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default()
}

/// `Date.UTC(year, month, day, h, m, s, ms)`，month 可以超出 0–11（JS 會進位）。
fn date_utc(year: i32, month0: i32, day: u32, h: u32, m: u32, s: u32, ms: u32) -> i64 {
    let y = year + month0.div_euclid(12);
    let mo = month0.rem_euclid(12) as u32 + 1;
    let base = chrono::NaiveDate::from_ymd_opt(y, mo, 1)
        .unwrap_or_default()
        .and_hms_milli_opt(h, m, s, ms)
        .unwrap_or_default()
        .and_utc()
        .timestamp_millis();
    base + (i64::from(day) - 1) * 86_400_000
}

fn last_day(year: i32, month0: i32) -> u32 {
    let start = date_utc(year, month0, 1, 0, 0, 0, 0);
    let next = date_utc(year, month0 + 1, 1, 0, 0, 0, 0);
    ((next - start) / 86_400_000) as u32
}

/// 上游 `weekStartMs`：包含 now 的那一週的 UTC 週一 00:00。
pub fn week_start_ms(now_ms: i64) -> i64 {
    use chrono::Datelike;
    let d = utc(now_ms);
    let since_monday = d.weekday().num_days_from_monday();
    date_utc(d.year(), d.month0() as i32, d.day(), 0, 0, 0, 0)
        - i64::from(since_monday) * 86_400_000
}

/// 上游 `monthBoundsMs`：以錨點（第一筆用量）的日、時分秒切月；沒有錨點用 UTC 的日曆月。
pub fn month_bounds_ms(now_ms: i64, anchor_ms: Option<i64>) -> (i64, i64) {
    use chrono::{Datelike, Timelike};
    let now = utc(now_ms);
    let (year, month0) = (now.year(), now.month0() as i32);
    let Some(anchor_ms) = anchor_ms else {
        return (
            date_utc(year, month0, 1, 0, 0, 0, 0),
            date_utc(year, month0 + 1, 1, 0, 0, 0, 0),
        );
    };
    let a = utc(anchor_ms);
    let anchored = |y: i32, m0: i32| {
        date_utc(
            y,
            m0,
            a.day().min(last_day(y, m0)),
            a.hour(),
            a.minute(),
            a.second(),
            a.timestamp_subsec_millis(),
        )
    };
    let (mut y, mut m0) = (year, month0);
    let mut start = anchored(y, m0);
    if start > now_ms {
        m0 -= 1;
        if m0 < 0 {
            m0 = 11;
            y -= 1;
        }
        start = anchored(y, m0);
    }
    let (mut ey, mut em) = (y, m0 + 1);
    if em > 11 {
        em = 0;
        ey += 1;
    }
    (start, anchored(ey, em))
}

fn sum_cost(rows: &[GoRow], start: i64, end: i64) -> f64 {
    rows.iter()
        .filter(|r| r.created_ms >= start && r.created_ms < end)
        .map(|r| r.cost)
        .sum()
}

/// 上游 `buildWindows`：5 小時（以窗口內最早一筆 + 5 小時為重置）、本週、本月。
pub fn build_windows(rows: &[GoRow], now_ms: i64, limits: GoLimits) -> Vec<LimitWindow> {
    let earliest = rows.iter().map(|r| r.created_ms).min();
    let session_start = now_ms - SESSION_MS;
    let week_start = week_start_ms(now_ms);
    let (month_start, month_end) = month_bounds_ms(now_ms, earliest);
    let session_oldest = rows
        .iter()
        .filter(|r| r.created_ms >= session_start && r.created_ms < now_ms)
        .map(|r| r.created_ms)
        .fold(now_ms, i64::min);
    let monthly_minutes = ((month_end - month_start) as f64 / 60000.0).round();
    let mk = |kind: WindowKind, used: f64, limit: f64, reset_ms: i64, minutes: f64| LimitWindow {
        used: Some(round1(used)),
        limit: Some(limit),
        used_percent: (limit > 0.0).then(|| round1(clamp_pct(used / limit * 100.0))),
        resets_at: js_iso(reset_ms as f64),
        window_minutes: Some(minutes),
        ..LimitWindow::new(kind)
    };
    vec![
        mk(
            WindowKind::Session,
            sum_cost(rows, session_start, now_ms),
            limits.session,
            session_oldest + SESSION_MS,
            300.0,
        ),
        mk(
            WindowKind::Weekly,
            sum_cost(rows, week_start, week_start + WEEK_MS),
            limits.weekly,
            week_start + WEEK_MS,
            10080.0,
        ),
        mk(
            WindowKind::Billing,
            sum_cost(rows, month_start, month_end),
            limits.monthly,
            month_end,
            monthly_minutes,
        ),
    ]
}

/// `opencode.db` 或 `opencode-<channel>.db`（channel 為 `[A-Za-z0-9._-]`），不含 WAL／SHM。
fn is_opencode_db(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".db") else {
        return false;
    };
    if stem == "opencode" {
        return true;
    }
    stem.strip_prefix("opencode-").is_some_and(|ch| {
        !ch.is_empty()
            && ch
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    })
}

/// 上游 `discoverDbPaths`：`OPENCODE_DB` 是檔案就只用它；否則資料目錄裡的 opencode*.db（排序）。
pub fn discover_db_paths(env: &OpencodeEnv) -> Vec<PathBuf> {
    let over = env.var("OPENCODE_DB").trim();
    if !over.is_empty() && Path::new(over).is_file() {
        return vec![PathBuf::from(over)];
    }
    let dir = super::api::data_dir(env);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|n| is_opencode_db(n))
        .collect();
    names.sort();
    names.into_iter().map(|n| dir.join(n)).collect()
}

const GO_ROWS_SQL: &str = "
  SELECT CAST(COALESCE(json_extract(data,'$.time.created'), time_created) AS INTEGER) AS createdMs,
         CAST(json_extract(data,'$.cost') AS REAL) AS cost
  FROM message
  WHERE json_valid(data)
    AND json_extract(data,'$.providerID') = 'opencode-go'
    AND json_extract(data,'$.role') = 'assistant'
    AND json_type(data,'$.cost') IN ('integer','real')";

fn read_go_rows(path: &Path) -> rusqlite::Result<Vec<GoRow>> {
    let conn =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.busy_timeout(std::time::Duration::from_millis(250))?;
    let mut stmt = conn.prepare(GO_ROWS_SQL)?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<f64>>(1)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        if let (Some(created_ms), Some(cost)) = row? {
            if created_ms > 0 && cost.is_finite() && cost >= 0.0 {
                out.push(GoRow { created_ms, cost });
            }
        }
    }
    Ok(out)
}

/// `collectGo` 的結果。
#[derive(Debug, Clone, PartialEq)]
pub struct GoLocal {
    pub status: ProviderStatus,
    pub windows: Vec<LimitWindow>,
    pub identity: String,
}

impl GoLocal {
    pub fn not_configured() -> GoLocal {
        GoLocal {
            status: ProviderStatus::NotConfigured,
            windows: Vec::new(),
            identity: String::new(),
        }
    }
}

/// 上游 `collectGo`：沒有資料庫、或有資料庫但沒有 opencode-go 的用量，都是 notConfigured；
/// 資料庫都讀不了才是 unavailable。
pub fn collect_go(env: &OpencodeEnv, now_ms: i64) -> GoLocal {
    let paths = discover_db_paths(env);
    if paths.is_empty() {
        return GoLocal::not_configured();
    }
    let mut rows = Vec::new();
    let mut read = false;
    for path in &paths {
        match read_go_rows(path) {
            Ok(r) => {
                rows.extend(r);
                read = true;
            }
            Err(e) => tracing::debug!(error = %e, path = %path.display(), "opencode db unreadable"),
        }
    }
    if !read {
        return GoLocal {
            status: ProviderStatus::Unavailable,
            ..GoLocal::not_configured()
        };
    }
    if rows.is_empty() {
        return GoLocal::not_configured();
    }
    GoLocal {
        status: ProviderStatus::Ok,
        windows: build_windows(&rows, now_ms, go_limits(env)),
        identity: format!("opencode-go:{}", paths[0].display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_767_225_600_000; // 2026-01-01T00:00:00.000Z（星期四）

    #[test]
    fn weeks_start_on_utc_monday() {
        assert_eq!(
            js_iso(week_start_ms(NOW) as f64).unwrap(),
            "2025-12-29T00:00:00.000Z"
        );
    }

    #[test]
    fn months_are_anchored_on_the_first_use() {
        let anchor = 1_764_673_200_000; // 2025-12-02T11:00:00Z
        let (s, e) = month_bounds_ms(NOW, Some(anchor));
        assert_eq!(js_iso(s as f64).unwrap(), "2025-12-02T11:00:00.000Z");
        assert_eq!(js_iso(e as f64).unwrap(), "2026-01-02T11:00:00.000Z");
        // 31 號的錨點在短月份夾到月底。
        let anchor = 1_767_182_400_000; // 2025-12-31T12:00:00Z
        let feb = 1_771_243_200_000; // 2026-02-16T12:00:00Z
        let (s, e) = month_bounds_ms(feb, Some(anchor));
        assert_eq!(js_iso(s as f64).unwrap(), "2026-01-31T12:00:00.000Z");
        assert_eq!(js_iso(e as f64).unwrap(), "2026-02-28T12:00:00.000Z");
        let (s, e) = month_bounds_ms(NOW, None);
        assert_eq!(js_iso(s as f64).unwrap(), "2026-01-01T00:00:00.000Z");
        assert_eq!(js_iso(e as f64).unwrap(), "2026-02-01T00:00:00.000Z");
    }

    #[test]
    fn windows_sum_costs_against_the_official_limits() {
        let rows = [
            GoRow {
                created_ms: NOW - 3_600_000,
                cost: 3.0,
            },
            GoRow {
                created_ms: NOW - 2 * 86_400_000,
                cost: 6.0,
            },
            GoRow {
                created_ms: NOW - 20 * 86_400_000,
                cost: 1.25,
            },
        ];
        let w = build_windows(&rows, NOW, DEFAULT_GO_LIMITS);
        assert_eq!(w[0].used, Some(3.0));
        assert_eq!(w[0].used_percent, Some(25.0));
        assert_eq!(w[0].resets_at.as_deref(), Some("2026-01-01T04:00:00.000Z"));
        assert_eq!(w[1].used, Some(9.0));
        assert_eq!(w[1].used_percent, Some(30.0));
        assert_eq!(w[2].used, Some(10.3), "rounded to one decimal");
        assert_eq!(w[2].used_percent, Some(17.1));
        assert_eq!(w[2].kind, WindowKind::Billing);
    }

    #[test]
    fn limits_can_be_overridden() {
        let dir = std::path::Path::new(".");
        let env =
            |v: &str| OpencodeEnv::from_pairs(&[("TOKEN_MONITOR_OPENCODE_GO_LIMITS", v)], dir);
        assert_eq!(go_limits(&env("10, 20 ,40")).weekly, 20.0);
        assert_eq!(go_limits(&env("10,20")), DEFAULT_GO_LIMITS);
        assert_eq!(go_limits(&env("10,0,40")), DEFAULT_GO_LIMITS);
    }

    #[test]
    fn reads_only_go_assistant_rows() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("share");
        let db_dir = data.join("opencode");
        std::fs::create_dir_all(&db_dir).unwrap();
        let conn = rusqlite::Connection::open(db_dir.join("opencode.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE message (id TEXT, time_created INTEGER, data TEXT);
             INSERT INTO message VALUES
               ('a', 0, '{\"providerID\":\"opencode-go\",\"role\":\"assistant\",\"cost\":2,\"time\":{\"created\":1767222000000}}'),
               ('b', 1767222000000, '{\"providerID\":\"opencode-go\",\"role\":\"assistant\",\"cost\":1.5}'),
               ('c', 1767222000000, '{\"providerID\":\"opencode-go\",\"role\":\"user\",\"cost\":9}'),
               ('d', 1767222000000, '{\"providerID\":\"anthropic\",\"role\":\"assistant\",\"cost\":9}'),
               ('e', 1767222000000, '{\"providerID\":\"opencode-go\",\"role\":\"assistant\",\"cost\":\"9\"}'),
               ('f', 1767222000000, 'not json');",
        )
        .unwrap();
        drop(conn);
        std::fs::write(db_dir.join("opencode-beta.db-wal"), b"").unwrap();
        let env = OpencodeEnv::from_pairs(&[("XDG_DATA_HOME", data.to_str().unwrap())], dir.path());
        assert_eq!(discover_db_paths(&env), vec![db_dir.join("opencode.db")]);
        let got = collect_go(&env, NOW);
        assert_eq!(got.status, ProviderStatus::Ok);
        assert_eq!(got.windows[0].used, Some(3.5));
        assert!(got.identity.starts_with("opencode-go:"));

        let empty = OpencodeEnv::from_pairs(&[("XDG_DATA_HOME", "Z:/nowhere")], dir.path());
        assert_eq!(
            collect_go(&empty, NOW).status,
            ProviderStatus::NotConfigured
        );
        assert!(is_opencode_db("opencode-beta.1.db") && !is_opencode_db("opencode-.db"));
    }
}
