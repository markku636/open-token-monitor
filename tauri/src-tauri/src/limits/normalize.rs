//! 額度資料的正規化（上游 src/shared/limits/core.js 的 `normalize*` 函式）。
//!
//! 我們送出的摘要要與上游正規化後的結果一致：hub 會再正規化一次，而 `tests/compat` 驗證
//! 「上游正規化我們的輸出之後完全不變」。所以每個欄位都在這裡照上游的規則收斂。

use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use crate::wire::{LimitProvider, LimitWindow};

/// 上游 `asNumber`：有限數字，或去掉 `%`、`,`、`$` 後能轉成數字的字串。
pub fn as_number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()),
        Value::String(s) if !s.trim().is_empty() => {
            let cleaned: String = s
                .chars()
                .filter(|c| !matches!(c, '%' | ',' | '$'))
                .collect();
            cleaned.trim().parse::<f64>().ok().filter(|f| f.is_finite())
        }
        _ => None,
    }
}

pub fn clamp_percent(v: f64) -> f64 {
    v.clamp(0.0, 100.0)
}

/// `Number((100 - used).toFixed(3))`。JS 的 toFixed 遇到恰好一半時進位，f64::round 對正數相同。
pub fn remaining_percent(used: f64) -> f64 {
    ((100.0 - used) * 1000.0).round() / 1000.0
}

fn iso_millis(ms: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

/// 上游 `normalizeIsoTimestamp`：數字小於 2e10 當秒，否則毫秒；字串交給日期解析；
/// 輸出一律 `YYYY-MM-DDTHH:MM:SS.sssZ`（毫秒以下截掉）。純數字字串 JS 解析不了，回 None。
pub fn iso_timestamp(v: &Value) -> Option<String> {
    match v {
        Value::Number(n) => {
            let f = n.as_f64().filter(|f| f.is_finite())?;
            let ms = if f < 20_000_000_000.0 { f * 1000.0 } else { f };
            iso_millis(ms.trunc() as i64)
        }
        Value::String(s) => iso_from_text(s),
        _ => None,
    }
}

pub fn iso_from_text(s: &str) -> Option<String> {
    let s = s.trim();
    if s.is_empty() || s.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if let Ok(d) = chrono::DateTime::parse_from_rfc3339(s) {
        return iso_millis(d.timestamp_millis());
    }
    // `2026-06-11`：JS 當 UTC 午夜。
    if let Ok(d) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return iso_millis(d.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis());
    }
    // 沒有時區的日期時間：JS 當本地時間。
    for fmt in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
    ] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(s, fmt) {
            use chrono::TimeZone;
            let local = chrono::Local.from_local_datetime(&naive).earliest()?;
            return iso_millis(local.timestamp_millis());
        }
    }
    None
}

/// 上游 `normalizeWindowLabel`：超過 32 字元整個丟掉（不是截斷），只留 `[A-Za-z0-9 +._/-]`。
pub fn window_label(s: &str) -> String {
    let raw = s.trim();
    if raw.is_empty() || raw.chars().count() > 32 {
        return String::new();
    }
    let kept: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '+' | '.' | '_' | '/' | '-'))
        .collect();
    collapse_ws(&kept)
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn limit_id(s: &str) -> Option<String> {
    let cleaned: String = s.chars().filter(|c| !c.is_control()).collect();
    let cleaned = cleaned.trim();
    (!cleaned.is_empty() && cleaned.chars().count() <= 128).then(|| cleaned.to_string())
}

pub fn currency(s: &str) -> Option<String> {
    let up: String = s.trim().to_uppercase().chars().take(8).collect();
    (!up.is_empty()).then_some(up)
}

fn sensitive(s: &str) -> bool {
    let n: String = s.nfkc().collect();
    let lower = n.to_lowercase();
    n.contains('@') || lower.contains("http://") || lower.contains("https://")
}

/// 組合用記號（\p{M}）：NFC 之後多半已經合成；這裡涵蓋常見的組合區段。
fn is_mark(c: char) -> bool {
    matches!(c as u32,
        0x0300..=0x036F | 0x0483..=0x0489 | 0x0591..=0x05BD | 0x0610..=0x061A | 0x064B..=0x065F
        | 0x0900..=0x0903 | 0x093A..=0x094F | 0x0E31 | 0x0E34..=0x0E3A | 0x0E47..=0x0E4E
        | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0x3099..=0x309A | 0xFE20..=0xFE2F)
}

fn account_text(s: &str, max_in: usize, max_out: usize, allow_plus: bool) -> String {
    let raw = s.trim();
    if raw.is_empty() || raw.encode_utf16().count() > max_in || sensitive(raw) {
        return String::new();
    }
    let nfc: String = raw.nfc().collect();
    let kept: String = nfc
        .chars()
        .filter(|&c| {
            c.is_alphanumeric()
                || is_mark(c)
                || c.is_whitespace()
                || matches!(c, '.' | '_' | '-')
                || (allow_plus && c == '+')
        })
        .collect();
    let clean = collapse_ws(&kept);
    if clean.is_empty() || clean.chars().count() > max_out {
        String::new()
    } else {
        clean
    }
}

/// 上游 `normalizeAccountLabel`：方案名稱之類的短標籤；含 email、網址或超過 32 字就丟掉。
pub fn account_label(s: &str) -> String {
    account_text(s, 256, 32, true)
}

/// 上游 `normalizeAccountName`。
pub fn account_name(s: &str) -> String {
    account_text(s, 512, 64, false)
}

/// 上游 `normalizeAccountEmail`。
pub fn account_email(s: &str) -> String {
    let raw = s.trim().to_lowercase();
    if raw.is_empty() || raw.len() > 254 {
        return String::new();
    }
    let Some((local, domain)) = raw.split_once('@') else {
        return String::new();
    };
    let ok = !local.is_empty()
        && !local.chars().any(char::is_whitespace)
        && !domain.contains('@')
        && !domain.chars().any(char::is_whitespace)
        && domain
            .rsplit_once('.')
            .is_some_and(|(a, b)| !a.is_empty() && !b.is_empty());
    if ok {
        raw
    } else {
        String::new()
    }
}

/// 把 provider 產出的原始窗口收斂成上游 `normalizeLimitWindow` 的結果。
pub fn finish_window(mut w: LimitWindow) -> LimitWindow {
    w.label = window_label(&w.label);
    w.source = w
        .source
        .map(|s| s.trim().to_lowercase())
        .filter(|s| matches!(s.as_str(), "web" | "local"));
    w.limit_id = w.limit_id.as_deref().and_then(limit_id);
    w.currency = w.currency.as_deref().and_then(currency);
    w.used_percent = match w.used_percent {
        Some(p) if p.is_finite() => Some(clamp_percent(p)),
        _ => match (w.used, w.limit) {
            (Some(u), Some(l)) if l > 0.0 => Some(clamp_percent(u / l * 100.0)),
            _ => None,
        },
    };
    w.remaining_percent = w.used_percent.map(remaining_percent);
    w
}

/// 上游 core.js `normalizeLimitProvider` 的排序（穩定排序）：
/// - Cursor（`cursorWindowRank`）：官方 dashboard 的順序，兩個模型池 → Grok Bot → 其他 → on-demand 花費。
/// - Antigravity：Gemini → Claude / GPT → 其他，同組內依窗口種類。
/// - Codex：`additional` 的桶排在正規窗口後面。
/// - 其他：session → daily → weekly → billing。
pub fn sort_windows(windows: &mut [LimitWindow], provider: &str) {
    match provider {
        "cursor" => windows.sort_by_key(|w| {
            if w.metric.as_deref() == Some("spend") {
                4
            } else {
                match w.label.as_str() {
                    "Requests" | "Cursor Models" => 0,
                    "Other Models" => 1,
                    "Grok Bot" => 2,
                    _ => 3,
                }
            }
        }),
        "antigravity" => windows.sort_by_key(|w| {
            let label = w.label.to_lowercase();
            let group = if label.contains("gemini") {
                0
            } else if label.contains("claude") || label.contains("gpt") {
                1
            } else {
                2
            };
            (group, w.kind.rank())
        }),
        _ => {
            let codex = provider == "codex";
            windows.sort_by_key(|w| {
                let group = if codex && w.additional { 4 } else { 0 };
                group + w.kind.rank()
            })
        }
    }
}

/// 上游 `normalizeOpenCodeAccountKeyAliases`：去空白、去掉與 accountKey 相同的、超過 128 字的，
/// 去重後排序，最多 8 個。
pub fn account_key_aliases(values: &[String], account_key: &str) -> Vec<String> {
    let canonical = account_key.trim();
    let mut out: Vec<String> = values
        .iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty() && v != canonical && v.encode_utf16().count() <= 128)
        .collect();
    out.sort();
    out.dedup();
    out.truncate(8);
    out
}

pub fn finish_provider(mut p: LimitProvider) -> LimitProvider {
    // webAccountKey 與 accountKeyAliases 是 OpenCode 專屬的欄位（上游只在 provider 是 opencode 時保留）。
    if p.provider == "opencode" {
        p.web_account_key = p.web_account_key.filter(|k| !k.is_empty());
        p.account_key_aliases = account_key_aliases(&p.account_key_aliases, &p.account_key);
    } else {
        p.web_account_key = None;
        p.account_key_aliases.clear();
    }
    p.account_label = account_label(&p.account_label);
    p.plan_label = account_label(&p.plan_label);
    p.account_name = account_name(&p.account_name);
    p.account_email = account_email(&p.account_email);
    p.windows = p.windows.into_iter().map(finish_window).collect();
    let provider = p.provider.clone();
    sort_windows(&mut p.windows, &provider);
    p
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn timestamps_match_upstream() {
        assert_eq!(
            iso_timestamp(&json!(1_770_000_000)).as_deref(),
            Some("2026-02-02T02:40:00.000Z")
        );
        assert_eq!(
            iso_timestamp(&json!(1_770_000_000_123i64)).as_deref(),
            Some("2026-02-02T02:40:00.123Z")
        );
        assert_eq!(
            iso_timestamp(&json!("2026-07-27T10:50:00.800650+00:00")).as_deref(),
            Some("2026-07-27T10:50:00.800Z"),
            "sub-millisecond digits are truncated"
        );
        assert_eq!(
            iso_timestamp(&json!("2026-06-11T05:00:00Z")).as_deref(),
            Some("2026-06-11T05:00:00.000Z")
        );
        assert_eq!(
            iso_timestamp(&json!("1770000000")),
            None,
            "numeric strings do not parse in JS"
        );
        assert_eq!(iso_timestamp(&json!(null)), None);
        assert_eq!(iso_timestamp(&json!("")), None);
    }

    #[test]
    fn numbers_and_percentages() {
        assert_eq!(as_number(&json!("12.5%")), Some(12.5));
        assert_eq!(as_number(&json!("$1,234")), Some(1234.0));
        assert_eq!(as_number(&json!("abc")), None);
        assert_eq!(
            remaining_percent(99.9375),
            0.063,
            "JS toFixed rounds a tie up"
        );
        assert_eq!(remaining_percent(34.5), 65.5);
        let mut w = LimitWindow::new(crate::wire::WindowKind::Weekly);
        w.used_percent = Some(150.0);
        assert_eq!(finish_window(w).used_percent, Some(100.0));
        let mut w = LimitWindow::new(crate::wire::WindowKind::Billing);
        w.used = Some(2.35);
        w.limit = Some(20.0);
        let w = finish_window(w);
        assert_eq!(w.used_percent, Some(11.75));
        assert_eq!(w.remaining_percent, Some(88.25));
    }

    #[test]
    fn labels_are_dropped_not_truncated() {
        assert_eq!(window_label(" Usage  credits "), "Usage credits");
        assert_eq!(window_label(&"x".repeat(33)), "");
        assert_eq!(window_label("Fable 模型"), "Fable", "non-ASCII is stripped");
        assert_eq!(account_label("Max 20x"), "Max 20x");
        assert_eq!(account_label("user@example.com"), "");
        assert_eq!(account_label("see https://x.y"), "");
        assert_eq!(account_label(&"a".repeat(33)), "");
        assert_eq!(account_name("Example Workspace!"), "Example Workspace");
        assert_eq!(account_name("A+B"), "AB");
        assert_eq!(account_email(" Owner@Example.com "), "owner@example.com");
        assert_eq!(account_email("not-an-email"), "");
        assert_eq!(account_email("a@b"), "");
    }

    #[test]
    fn codex_additional_buckets_sort_last() {
        use crate::wire::WindowKind::*;
        let mk = |k, add| {
            let mut w = LimitWindow::new(k);
            w.additional = add;
            w
        };
        let mut ws = vec![
            mk(Weekly, true),
            mk(Weekly, false),
            mk(Session, true),
            mk(Session, false),
        ];
        sort_windows(&mut ws, "codex");
        let got: Vec<_> = ws.iter().map(|w| (w.kind, w.additional)).collect();
        assert_eq!(
            got,
            vec![
                (Session, false),
                (Weekly, false),
                (Session, true),
                (Weekly, true)
            ]
        );
    }
}
