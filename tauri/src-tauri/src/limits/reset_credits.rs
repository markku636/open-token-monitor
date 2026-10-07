//! 額度重置券的正規化（上游 src/shared/limits/core.js `normalizeProviderResetCredits`、
//! `normalizeResetCreditExpirations`、`normalizeResetCreditGrants`）。
//!
//! 兩個 provider 先各自把 API 回應轉成上游的中間形狀（camelCase、值維持 API 的原樣，見
//! `claude::reset_credits_input`、`codex::parse_reset_credits_payload`），再一起經過這裡。
//! 與上游 `map*ToProvider` → `normalizeLimitProvider` 的兩段完全相同，JS 的 `??`、truthiness、
//! `Number()` 與 `Date.parse()` 才能逐條對上；`tests/compat` 以同一份回應逐欄比對。

use serde_json::Value;

use super::normalize::{as_number, is_js_object, iso_timestamp, nullish};
use crate::usage::js::{to_js_string, truthy};
use crate::wire::{ResetCredits, ResetGrant};

/// 正規化過的 ISO 字串 → 毫秒（排序用；解析不了排最後）。
fn iso_ms(iso: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(iso)
        .map(|d| d.timestamp_millis())
        .unwrap_or(i64::MAX)
}

/// `Math.max(0, Math.floor(x))`；`-0` 也寫成 0（JSON.stringify(-0) 是 "0"）。
fn floor_nonneg(x: f64) -> f64 {
    let n = x.floor();
    if n > 0.0 {
        n
    } else {
        0.0
    }
}

/// `String(value)`，但只在 JS 會當成 truthy 時（上游 `entry.id ? String(entry.id) : 省略`）。
fn truthy_string(v: Option<&Value>) -> Option<String> {
    v.filter(|v| truthy(v)).map(to_js_string)
}

/// 上游 `normalizeResetCreditExpirations`：只收 status 是空的或 `available` 的，去重、由早到晚。
fn expirations(input: &Value) -> Vec<String> {
    let g = |k: &str| input.get(k);
    let raw = nullish(&[
        g("expirations"),
        g("expirationTimes"),
        g("expiresAtList"),
        g("expires_at_list"),
        g("credits"),
    ]);
    let Some(Value::Array(items)) = raw else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for value in items {
        let object = is_js_object(value);
        if object {
            let status = truthy_string(value.get("status"))
                .unwrap_or_default()
                .to_lowercase();
            if !status.is_empty() && status != "available" {
                continue;
            }
        }
        let source = if object {
            nullish(&[
                value.get("expiresAt"),
                value.get("expires_at"),
                value.get("nextExpiresAt"),
                value.get("next_expires_at"),
            ])
        } else {
            Some(value)
        };
        let Some(iso) = source.and_then(iso_timestamp) else {
            continue;
        };
        if !out.contains(&iso) {
            out.push(iso);
        }
    }
    out.sort_by_key(|iso| iso_ms(iso));
    out
}

/// 上游 `normalizeResetCreditGrants`：Claude 的券有標籤、清掉哪些窗口、現在能不能用；
/// Codex 的是匿名的，所以只有 Claude 會有這個欄位。
fn grants(input: Option<&Value>) -> Vec<ResetGrant> {
    let Some(Value::Array(items)) = input else {
        return Vec::new();
    };
    items
        .iter()
        .filter(|e| is_js_object(e))
        .map(|e| {
            let g = |k: &str| e.get(k);
            let count =
                |a: &str, b: &str| nullish(&[g(a), g(b)]).and_then(as_number).map(floor_nonneg);
            let time = |a: &str, b: &str| nullish(&[g(a), g(b)]).and_then(iso_timestamp);
            let flag = |a: &str, b: &str| nullish(&[g(a), g(b)]).map(truthy);
            let mut clears: Vec<String> = Vec::new();
            if let Some(Value::Array(values)) = g("clears") {
                for v in values {
                    let text = truthy_string(Some(v)).unwrap_or_default();
                    let text = text.trim();
                    if !text.is_empty() && !clears.iter().any(|c| c == text) {
                        clears.push(text.to_string());
                    }
                }
            }
            ResetGrant {
                id: truthy_string(g("id")),
                label: truthy_string(g("label")),
                resets_left: count("resetsLeft", "resets_left"),
                resets_total: count("resetsTotal", "resets_total"),
                starts_at: time("startsAt", "starts_at"),
                ends_at: time("endsAt", "ends_at"),
                clears,
                usable_now: flag("usableNow", "usable_now"),
                use_requires_limit: flag("useRequiresLimit", "use_requires_limit"),
                // 上游是 `entry.paused !== undefined`：null 也算有值（→ false）。
                paused: g("paused").map(truthy),
            }
        })
        .collect()
}

/// 上游 `normalizeProviderResetCredits`：次數、最近的到期時間、全部到期時間與每張券的明細。
/// 什麼都沒有時是 None（wire 上是 `resetCredits: null`）。
pub fn normalize(input: &Value) -> Option<ResetCredits> {
    if !is_js_object(input) {
        return None;
    }
    let g = |k: &str| input.get(k);
    let available = nullish(&[
        g("availableCount"),
        g("available_count"),
        g("available"),
        g("remainingCount"),
        g("remaining_count"),
    ])
    .and_then(as_number);
    let next = nullish(&[
        g("nextExpiresAt"),
        g("next_expires_at"),
        g("nextExpirationAt"),
        g("next_expiration_at"),
        g("expiresAt"),
        g("expires_at"),
    ])
    .and_then(iso_timestamp);
    let expirations = expirations(input);
    // 兩者取早的；同一時間時 JS 的穩定排序留 nextExpiresAt（字串也相同）。
    let effective_next = [next, expirations.first().cloned()]
        .into_iter()
        .flatten()
        .min_by_key(|iso| iso_ms(iso));
    let grants = grants(g("grants"));
    if available.is_none()
        && effective_next.is_none()
        && expirations.is_empty()
        && grants.is_empty()
    {
        return None;
    }
    Some(ResetCredits {
        available_count: available.map(floor_nonneg),
        next_expires_at: effective_next,
        expirations,
        grants,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_inputs_are_null() {
        assert_eq!(normalize(&json!(null)), None);
        assert_eq!(normalize(&json!("x")), None);
        assert_eq!(normalize(&json!({})), None);
        assert_eq!(normalize(&json!([])), None);
        assert_eq!(normalize(&json!({"availableCount": "abc"})), None);
    }

    #[test]
    fn counts_and_expirations_normalize() {
        let got = normalize(&json!({
            "available_count": "2.9",
            "next_expires_at": "2026-08-05T00:00:00Z",
            "credits": [
                {"status": "available", "expires_at": "2026-08-03T00:00:00Z"},
                {"status": "used", "expires_at": "2026-08-01T00:00:00Z"},
                {"expiresAt": 1_785_542_400},
                "2026-08-03T00:00:00.000Z",
                null
            ]
        }))
        .unwrap();
        assert_eq!(got.available_count, Some(2.0));
        assert_eq!(
            got.expirations,
            vec!["2026-08-01T00:00:00.000Z", "2026-08-03T00:00:00.000Z"],
            "status-less objects count, used ones do not, duplicates collapse"
        );
        assert_eq!(
            got.next_expires_at.as_deref(),
            Some("2026-08-01T00:00:00.000Z"),
            "the earliest expiration wins over next_expires_at"
        );
        assert!(got.grants.is_empty());
        let json = serde_json::to_value(&got).unwrap();
        assert!(json.get("grants").is_none(), "empty grants are omitted");

        let negative = normalize(&json!({"availableCount": -0.5})).unwrap();
        assert_eq!(negative.available_count, Some(0.0));
        assert_eq!(
            serde_json::to_string(&negative).unwrap(),
            r#"{"availableCount":0.0,"nextExpiresAt":null}"#
        );
    }

    #[test]
    fn grant_fields_are_present_only_when_set() {
        let got = normalize(&json!({"grants": [
            {"id": 7, "label": "", "resetsLeft": "1.5", "resets_total": 3, "endsAt": "2026-08-01T00:00:00Z",
             "clears": ["five_hour", " five_hour ", "", 0, "seven_day"], "usableNow": null, "usable_now": null,
             "useRequiresLimit": null, "paused": null},
            "not a grant",
            {}
        ]}))
        .unwrap();
        assert_eq!(got.available_count, None);
        assert_eq!(got.grants.len(), 2);
        let g = &got.grants[0];
        assert_eq!(g.id.as_deref(), Some("7"));
        assert_eq!(g.label, None, "an empty label is dropped");
        assert_eq!(g.resets_left, Some(1.0));
        assert_eq!(g.resets_total, Some(3.0));
        assert_eq!(g.ends_at.as_deref(), Some("2026-08-01T00:00:00.000Z"));
        assert_eq!(g.clears, vec!["five_hour", "seven_day"]);
        assert_eq!(
            g.usable_now,
            Some(false),
            "null ?? null is null, which is not undefined"
        );
        assert_eq!(g.use_requires_limit, None, "null ?? undefined is undefined");
        assert_eq!(g.paused, Some(false));
        assert_eq!(got.grants[1], ResetGrant::default());
        assert_eq!(serde_json::to_string(&got.grants[1]).unwrap(), "{}");
    }
}
