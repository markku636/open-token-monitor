//! 資料匯出（上游 src/shared/exporter.js 與 main.js `writeExportTo`）：把本機的三個期間與每日歷史寫成
//! JSON 與 CSV，給 Excel、Obsidian 或自己的腳本用。
//!
//! - `token-monitor-export.json`：`{generatedAt, app, snapshot: {today, month, allTime}, daily, monthly}`，
//!   期間原樣（無損）。
//! - `token-monitor-snapshot.csv`：`period,dimension,name,tokens,cost_usd`（dimension = tool / model）。
//! - `token-monitor-daily.csv`：`date,tool,tokens,cost_usd`（有歷史才寫）。
//! - `token-monitor-daily-models.csv`：每天每個模型的 token 組成與成本（有歷史才寫）。
//!
//! CSV 是 UTF-8 BOM + CRLF + RFC 4180 引號（Excel 直接開）。每個檔先寫暫存檔再改名；這次沒寫的舊檔
//! 會刪掉，讀的人不會看到過期的日表。還沒有歷史（第一次掃描前、掃描失敗）時什麼都不寫：只寫快照會
//! 讓孤兒清理把既有的日表刪掉。不含其他裝置與額度（上游的隱私界線）；金額一律 USD、模型 id 原樣。

use std::path::Path;

use serde_json::{json, Map, Value};

use crate::error::{AppError, AppResult};
use crate::wire::{DeviceRecord, Period};

pub const EXPORT_FILENAMES: [&str; 4] = [
    "token-monitor-export.json",
    "token-monitor-snapshot.csv",
    "token-monitor-daily.csv",
    "token-monitor-daily-models.csv",
];

const BOM: &str = "\u{feff}";
const SNAPSHOT_COLUMNS: &[&str] = &["period", "dimension", "name", "tokens", "cost_usd"];
const DAILY_COLUMNS: &[&str] = &["date", "tool", "tokens", "cost_usd"];
const DAILY_MODEL_COLUMNS: &[&str] = &[
    "date",
    "model",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "unclassified_tokens",
    "total_tokens",
    "cost_usd",
];

pub fn csv_escape(value: &str) -> String {
    if value.contains(['"', ',', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

/// JS 的 `String(number)`：整數不帶小數點。
fn num_text(v: f64) -> String {
    if !v.is_finite() {
        return "0".into();
    }
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

fn to_csv(columns: &[&str], rows: &[Vec<String>]) -> String {
    let mut out = String::from(BOM);
    out.push_str(
        &columns
            .iter()
            .map(|c| csv_escape(c))
            .collect::<Vec<_>>()
            .join(","),
    );
    out.push_str("\r\n");
    for row in rows {
        out.push_str(
            &row.iter()
                .map(|c| csv_escape(c))
                .collect::<Vec<_>>()
                .join(","),
        );
        out.push_str("\r\n");
    }
    out
}

fn num(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .unwrap_or(0.0)
}

fn snapshot_rows(periods: &[(&str, &Period)]) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    for (name, p) in periods {
        for (k, v) in &p.clients {
            let cost = p.client_costs.get(k).copied().unwrap_or(0.0);
            rows.push(vec![
                name.to_string(),
                "tool".into(),
                k.clone(),
                v.to_string(),
                num_text(cost),
            ]);
        }
        for (k, v) in &p.models {
            let cost = p.model_costs.get(k).copied().unwrap_or(0.0);
            rows.push(vec![
                name.to_string(),
                "model".into(),
                k.clone(),
                v.to_string(),
                num_text(cost),
            ]);
        }
    }
    rows
}

fn days(history: &Value) -> Vec<(&str, &Value)> {
    history
        .get("daily")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|d| Some((d.get("date")?.as_str()?.get(..10)?, d)))
                .collect()
        })
        .unwrap_or_default()
}

fn daily_rows(history: &Value) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    for (date, day) in days(history) {
        if let Some(per) = day.get("perClient").and_then(Value::as_object) {
            for (tool, v) in per {
                rows.push(vec![
                    date.to_string(),
                    tool.clone(),
                    num_text(num(v.get("tokens"))),
                    num_text(num(v.get("cost"))),
                ]);
            }
        }
    }
    rows
}

/// 上游 `dailyModelComponents`：組成超過總量時整列算未分類；沒有 `unclassifiedTokens` 時，
/// 那天的組成可用就是 0，否則剩下的都算未分類。
fn daily_model_components(day: &Value, value: &Map<String, Value>) -> [f64; 6] {
    let total = num(value.get("tokens")).max(0.0);
    let output = num(value.get("outputTokens")).max(0.0);
    let cache_read = num(value.get("cacheReadTokens")).max(0.0);
    let cache_write = num(value.get("cacheWriteTokens")).max(0.0);
    let known = output + cache_read + cache_write;
    if known > total {
        return [0.0, 0.0, 0.0, 0.0, total, total];
    }
    let remaining = total - known;
    let unclassified = match value.get("unclassifiedTokens") {
        Some(v) => remaining.min(num(Some(v)).max(0.0)),
        None if day.get("tokenComponentsAvailable").and_then(Value::as_bool) == Some(true) => 0.0,
        None => remaining,
    };
    [
        (remaining - unclassified).max(0.0),
        output,
        cache_read,
        cache_write,
        unclassified,
        total,
    ]
}

fn daily_model_rows(history: &Value) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    for (date, day) in days(history) {
        if let Some(per) = day.get("perModel").and_then(Value::as_object) {
            for (model, v) in per {
                let Some(obj) = v.as_object() else { continue };
                let mut row = vec![date.to_string(), model.clone()];
                row.extend(
                    daily_model_components(day, obj)
                        .iter()
                        .map(|n| num_text(*n)),
                );
                row.push(num_text(num(obj.get("cost"))));
                rows.push(row);
            }
        }
    }
    rows
}

/// 匯出的檔案（檔名、內容）。`history` 是 `Null`（歷史關閉）時只有 JSON 與快照 CSV。
pub fn file_set(
    record: &DeviceRecord,
    history: &Value,
    app_version: &str,
    generated_at: &str,
) -> Vec<(&'static str, String)> {
    let empty = Vec::new();
    let arr = |k: &str| {
        history
            .get(k)
            .and_then(Value::as_array)
            .unwrap_or(&empty)
            .clone()
    };
    let payload = json!({
        "generatedAt": generated_at,
        "app": { "name": "token-monitor", "version": app_version },
        "snapshot": {
            "today": record.today,
            "month": record.month,
            "allTime": record.all_time,
        },
        "daily": arr("daily"),
        "monthly": arr("monthly"),
    });
    let mut json_text = serde_json::to_string_pretty(&payload).unwrap_or_default();
    json_text.push('\n');
    let periods = [
        ("today", &record.today),
        ("month", &record.month),
        ("allTime", &record.all_time),
    ];
    let mut files = vec![
        (EXPORT_FILENAMES[0], json_text),
        (
            EXPORT_FILENAMES[1],
            to_csv(SNAPSHOT_COLUMNS, &snapshot_rows(&periods)),
        ),
    ];
    let daily = daily_rows(history);
    if !daily.is_empty() {
        files.push((EXPORT_FILENAMES[2], to_csv(DAILY_COLUMNS, &daily)));
    }
    let models = daily_model_rows(history);
    if !models.is_empty() {
        files.push((EXPORT_FILENAMES[3], to_csv(DAILY_MODEL_COLUMNS, &models)));
    }
    files
}

/// 內容的簽章（不含 generatedAt）：自動匯出時資料沒變就不重寫同步資料夾。
pub fn signature(record: &DeviceRecord, history: &Value) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    for part in [
        serde_json::to_vec(&record.today),
        serde_json::to_vec(&record.month),
        serde_json::to_vec(&record.all_time),
        serde_json::to_vec(history),
    ] {
        h.update(part.unwrap_or_default());
        h.update([0]);
    }
    format!("{:x}", h.finalize())
}

/// 之前的程序中途結束留下的 `<匯出檔名>.tmp-*`（只刪我們自己的檔名樣式）。
fn sweep_stale_temp_files(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if EXPORT_FILENAMES
            .iter()
            .any(|f| name.starts_with(&format!("{f}.tmp-")))
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// 寫到資料夾：逐檔暫存 + 改名，最後刪掉這次沒寫的舊檔。
pub fn write_to(dir: &Path, files: &[(&'static str, String)]) -> AppResult<()> {
    std::fs::create_dir_all(dir)
        .map_err(|e| AppError::Storage(format!("{}: {e}", dir.display())))?;
    sweep_stale_temp_files(dir);
    let token = uuid::Uuid::new_v4().simple().to_string();
    for (name, contents) in files {
        let dest = dir.join(name);
        let tmp = dir.join(format!("{name}.tmp-{}-{token}", std::process::id()));
        let written = std::fs::write(&tmp, contents.as_bytes())
            .map_err(|e| AppError::Storage(format!("{}: {e}", tmp.display())))
            .and_then(|()| {
                std::fs::rename(&tmp, &dest)
                    .map_err(|e| AppError::Storage(format!("{}: {e}", dest.display())))
            });
        if let Err(e) = written {
            // 目的檔被 Excel 開著時改名會失敗：暫存檔要清掉，否則每個匯出間隔留一個。
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
    }
    for name in EXPORT_FILENAMES {
        if !files.iter().any(|(n, _)| *n == name) {
            let _ = std::fs::remove_file(dir.join(name));
        }
    }
    Ok(())
}

/// 本機 record → 寫出。還沒有歷史（`None`）時不寫，回 `history-unavailable`。
pub fn export_record(dir: &Path, record: &DeviceRecord, app_version: &str) -> AppResult<()> {
    let Some(history) = record.history.as_deref() else {
        return Err(AppError::InvalidArgument("history-unavailable".into()));
    };
    let now = crate::wire::time::iso_millis(chrono::Utc::now());
    write_to(dir, &file_set(record, history, app_version, &now))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> DeviceRecord {
        let mut r = DeviceRecord::compose(
            &crate::wire::Envelope::default(),
            &crate::wire::UsageSummary::default(),
            600_000,
            None,
            None,
        );
        r.today.clients.insert("claude".into(), 100);
        r.today.client_costs.insert("claude".into(), 1.5);
        r.today.models.insert("model, \"x\"".into(), 100);
        r
    }

    fn history() -> Value {
        json!({ "daily": [{ "date": "2026-09-24", "tokens": 100, "tokenComponentsAvailable": true,
            "perClient": { "claude": { "tokens": 100, "cost": 1.5 } },
            "perModel": {
                "m1": { "tokens": 100, "cost": 1.5, "outputTokens": 10, "cacheReadTokens": 60, "unclassifiedTokens": 0 },
                "bad": { "tokens": 5, "outputTokens": 9 },
                "legacy": { "tokens": 7, "outputTokens": 2 }
            } }], "monthly": [] })
    }

    #[test]
    fn csv_is_excel_friendly() {
        assert_eq!(csv_escape("a,b"), "\"a,b\"");
        assert_eq!(csv_escape("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_escape("plain"), "plain");
        let files = file_set(&record(), &history(), "0.1.0", "2026-09-24T00:00:00.000Z");
        let snapshot = &files[1].1;
        assert!(snapshot.starts_with('\u{feff}'));
        assert!(snapshot.contains("period,dimension,name,tokens,cost_usd\r\n"));
        assert!(snapshot.contains("today,tool,claude,100,1.5\r\n"));
        assert!(snapshot.contains("today,model,\"model, \"\"x\"\"\",100,0\r\n"));
    }

    #[test]
    fn daily_model_components_follow_upstream() {
        let files = file_set(&record(), &history(), "0.1.0", "t");
        assert_eq!(files.len(), 4);
        let models = &files[3].1;
        // m1: 100 − 10 − 60 = 30 輸入；bad: 組成超過總量 → 整列未分類；legacy: 沒寫未分類但那天組成可用 → 0。
        assert!(models.contains("2026-09-24,m1,30,10,60,0,0,100,1.5\r\n"));
        assert!(models.contains("2026-09-24,bad,0,0,0,0,5,5,0\r\n"));
        assert!(models.contains("2026-09-24,legacy,5,2,0,0,0,7,0\r\n"));
        let json: Value = serde_json::from_str(&files[0].1).unwrap();
        assert_eq!(json["app"]["name"], "token-monitor");
        assert_eq!(json["snapshot"]["today"]["clients"]["claude"], 100);
        assert_eq!(json["daily"][0]["date"], "2026-09-24");
    }

    #[test]
    fn writing_replaces_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("token-monitor-daily.csv"), "stale").unwrap();
        let files = file_set(&record(), &Value::Null, "0.1.0", "t");
        assert_eq!(files.len(), 2, "no history: JSON and snapshot only");
        write_to(dir.path(), &files).unwrap();
        assert!(dir.path().join("token-monitor-export.json").exists());
        assert!(
            !dir.path().join("token-monitor-daily.csv").exists(),
            "orphan removed"
        );
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty());
        // 前一次留下的暫存檔會在下一次匯出時清掉。
        std::fs::write(dir.path().join("token-monitor-snapshot.csv.tmp-1-x"), "x").unwrap();
        write_to(dir.path(), &files).unwrap();
        assert!(!dir
            .path()
            .join("token-monitor-snapshot.csv.tmp-1-x")
            .exists());
        let mut r = record();
        r.history = None;
        assert!(export_record(dir.path(), &r, "0.1.0").is_err());
        assert_ne!(
            signature(&record(), &history()),
            signature(&record(), &Value::Null)
        );
    }
}
