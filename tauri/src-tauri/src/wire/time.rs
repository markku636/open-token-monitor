//! 時間格式：對齊上游 JavaScript `Date` 的行為。
//!
//! - 輸出一律 `Date#toISOString()` 格式：UTC、毫秒三位、`Z` 結尾。
//! - 解析對齊 V8 的 `new Date(string)`：RFC 3339（任意小數位，截到毫秒）、
//!   沒有時區的日期時間視為**本地時間**、只有日期視為 **UTC** 午夜、RFC 2822。
//!   純數字字串在 V8 是 NaN（`new Date("1716000000000")`），這裡同樣回 `None`。

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};

pub fn iso_millis(dt: DateTime<Utc>) -> String {
    dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub fn iso_from_ms(ms: i64) -> Option<String> {
    if ms <= 0 {
        return None;
    }
    Utc.timestamp_millis_opt(ms).single().map(iso_millis)
}

/// `new Date(value).getTime()`；無法解析回 `None`。
pub fn parse_js_date(value: &str) -> Option<DateTime<Utc>> {
    let s = value.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(truncate_to_ms(dt.with_timezone(&Utc)));
    }
    // RFC 3339 的變體：空白代替 T、時區寫成 +0800。
    for fmt in [
        "%Y-%m-%d %H:%M:%S%.f%:z",
        "%Y-%m-%dT%H:%M:%S%.f%z",
        "%Y-%m-%d %H:%M:%S%.f%z",
    ] {
        if let Ok(dt) = DateTime::parse_from_str(s, fmt) {
            return Some(truncate_to_ms(dt.with_timezone(&Utc)));
        }
    }
    let upper = s.to_ascii_uppercase();
    if let Some(stripped) = upper.strip_suffix('Z') {
        for fmt in [
            "%Y-%m-%dT%H:%M:%S%.f",
            "%Y-%m-%d %H:%M:%S%.f",
            "%Y-%m-%dT%H:%M",
        ] {
            if let Ok(naive) = NaiveDateTime::parse_from_str(stripped, fmt) {
                return Some(truncate_to_ms(Utc.from_utc_datetime(&naive)));
            }
        }
    }
    // 沒有時區：V8 視為本地時間。
    for fmt in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M",
    ] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(s, fmt) {
            return local_to_utc(naive).map(truncate_to_ms);
        }
    }
    // 只有日期：ES 規格規定視為 UTC。
    if let Ok(date) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return date.and_hms_opt(0, 0, 0).map(|n| Utc.from_utc_datetime(&n));
    }
    if let Ok(dt) = DateTime::parse_from_rfc2822(s) {
        return Some(truncate_to_ms(dt.with_timezone(&Utc)));
    }
    // V8 不檢查星期幾是否正確；chrono 會。去掉 "Tue, " 這類前綴再試一次。
    if let Some((day, rest)) = s.split_once(", ") {
        if day.len() == 3 && day.chars().all(|c| c.is_ascii_alphabetic()) {
            if let Ok(dt) = DateTime::parse_from_rfc2822(rest) {
                return Some(truncate_to_ms(dt.with_timezone(&Utc)));
            }
        }
    }
    None
}

/// `normalizeIsoTimestamp`：可解析且 > 0 才回 ISO，否則空字串。
pub fn normalize_iso(value: &str) -> String {
    match parse_js_date(value) {
        Some(dt) if dt.timestamp_millis() > 0 => iso_millis(dt),
        _ => String::new(),
    }
}

pub fn timestamp_ms(value: &str) -> i64 {
    parse_js_date(value)
        .map(|d| d.timestamp_millis())
        .unwrap_or(0)
}

fn truncate_to_ms(dt: DateTime<Utc>) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(dt.timestamp_millis())
        .single()
        .unwrap_or(dt)
}

/// 本地時間轉 UTC。DST 的空隙（該時刻不存在）往後推一小時，對齊 JS `new Date(y, m, d)` 的行為。
fn local_to_utc(naive: NaiveDateTime) -> Option<DateTime<Utc>> {
    Local
        .from_local_datetime(&naive)
        .earliest()
        .or_else(|| {
            Local
                .from_local_datetime(&(naive + Duration::hours(1)))
                .earliest()
        })
        .map(|d| d.with_timezone(&Utc))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PeriodWindow {
    pub key: String,
    pub ends_at: String,
}

/// 裝置自己的日／月視窗（上游 `computePeriodWindows`，collector.js）。hub 用 `endsAt`
/// 判斷離線裝置的 today / month 是否已過期，所以必須以裝置的本地時區計算。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PeriodWindows {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub time_zone: String,
    pub today: PeriodWindow,
    pub month: PeriodWindow,
}

impl PeriodWindows {
    pub fn compute(now: DateTime<Local>) -> Self {
        let date = now.date_naive();
        let next_day = date.succ_opt().unwrap_or(date);
        let (ny, nm) = if date.month() == 12 {
            (date.year() + 1, 1)
        } else {
            (date.year(), date.month() + 1)
        };
        let next_month = NaiveDate::from_ymd_opt(ny, nm, 1).unwrap_or(next_day);
        let midnight = |d: NaiveDate| {
            d.and_hms_opt(0, 0, 0)
                .and_then(local_to_utc)
                .map(iso_millis)
                .unwrap_or_default()
        };
        PeriodWindows {
            time_zone: iana_time_zone::get_timezone().unwrap_or_default(),
            today: PeriodWindow {
                key: date.format("%Y-%m-%d").to_string(),
                ends_at: midnight(next_day),
            },
            month: PeriodWindow {
                key: date.format("%Y-%m").to_string(),
                ends_at: midnight(next_month),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_like_v8() {
        assert_eq!(
            normalize_iso("2026-09-23T10:00:00Z"),
            "2026-09-23T10:00:00.000Z"
        );
        assert_eq!(
            normalize_iso("2026-09-23T10:00:00.123456Z"),
            "2026-09-23T10:00:00.123Z"
        );
        assert_eq!(
            normalize_iso("2026-09-23T10:00:00+08:00"),
            "2026-09-23T02:00:00.000Z"
        );
        assert_eq!(normalize_iso("2026-09-23"), "2026-09-23T00:00:00.000Z");
        assert_eq!(
            normalize_iso("Tue, 23 Sep 2026 10:00:00 GMT"),
            "2026-09-23T10:00:00.000Z"
        );
        assert_eq!(normalize_iso("1716000000000"), "");
        assert_eq!(normalize_iso("garbage"), "");
        assert_eq!(normalize_iso(""), "");
        let local = Local
            .with_ymd_and_hms(2026, 9, 23, 10, 0, 0)
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(normalize_iso("2026-09-23T10:00:00"), iso_millis(local));
    }

    #[test]
    fn iso_from_ms_rejects_zero() {
        assert_eq!(iso_from_ms(0), None);
        assert_eq!(
            iso_from_ms(1790156194179).as_deref(),
            Some("2026-09-23T09:36:34.179Z")
        );
    }

    #[test]
    fn windows_roll_over_year_end() {
        let now = Local.with_ymd_and_hms(2026, 12, 31, 23, 30, 0).unwrap();
        let w = PeriodWindows::compute(now);
        assert_eq!(w.today.key, "2026-12-31");
        assert_eq!(w.month.key, "2026-12");
        let jan1 = Local
            .with_ymd_and_hms(2027, 1, 1, 0, 0, 0)
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(w.today.ends_at, iso_millis(jan1));
        assert_eq!(w.month.ends_at, iso_millis(jan1));
    }
}
