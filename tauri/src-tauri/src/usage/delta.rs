//! watch tick 的精確 delta（上游 src/shared/usage.js `applyPeriodDelta` / `deltaValue`）。
//!
//! 錨點（anchor）是上一次完整掃描的 today / month / allTime。自錨點之後寫進 log 的 token
//! 同時屬於 today 與每個更大的期間，而且 session log 只會附加，所以
//! `month = anchor.month + (freshToday − anchor.today)` 是恆等式，不是估計。
//! 跨過本地午夜後錨點就失效，呼叫端必須改跑完整掃描（collector::Anchor::usable_on）。
//!
//! 以 JSON 值遞迴處理所有鍵的聯集，所以 period 將來多出的數字欄位（clients、models、
//! sessions……）不必逐一記帳。規則逐條照抄上游：
//! - 數字：`max(0, base + fresh − anchor)`；缺值當 0。整數欄位維持整數。
//! - 字串：`base ?? fresh`（空字串不是 null，所以 base 的空字串會留著；
//!   collector 的 `propagate_today_projects` 負責補上今天才有的專案）。
//! - `startedAt` 取早、`lastUsedAt` 取晚。
//! - `capabilities.tokenComponents`：base 與 fresh 都是 true 才是 true；
//!   `capabilities.throughput`：三者都是 true 才是 true（上游註解有理由）。

use serde_json::{Map, Number, Value};

use crate::wire::Period;

/// 以錨點與新的 today 推出更大的期間。三個輸入都來自我們自己的 `Period`，序列化不會失敗；
/// 萬一反序列化失敗（型別被改壞），退回 base，寧可少算也不要讓 widget 當掉。
pub fn apply_period_delta(base: &Period, fresh_today: &Period, anchor_today: &Period) -> Period {
    let to_value = |p: &Period| serde_json::to_value(p).unwrap_or(Value::Null);
    let (b, f, a) = (
        to_value(base),
        to_value(fresh_today),
        to_value(anchor_today),
    );
    let merged = delta_value(Some(&b), Some(&f), Some(&a), "");
    match serde_json::from_value(merged) {
        Ok(period) => period,
        Err(e) => {
            tracing::error!(error = %e, "period delta produced an invalid period; keeping the anchor");
            base.clone()
        }
    }
}

/// JS 的 `undefined` 與 `null` 在上游的 `??` 與 `find(v => v != null)` 裡等價。
fn present(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| !v.is_null())
}

/// 上游 `timestampMs`：可解析的 ISO 字串 → 毫秒，否則 0（視為沒有）。
fn timestamp_ms(v: Option<&Value>) -> i64 {
    let Some(text) = present(v).and_then(Value::as_str) else {
        return 0;
    };
    chrono::DateTime::parse_from_rfc3339(text)
        .map(|d| d.timestamp_millis())
        .unwrap_or(0)
}

/// JS 的 `base || fresh || ''`：空字串是 falsy。
fn first_truthy_string(base: Option<&Value>, fresh: Option<&Value>) -> Value {
    for v in [base, fresh].into_iter().flatten() {
        if let Some(s) = v.as_str() {
            if !s.is_empty() {
                return v.clone();
            }
        } else if !v.is_null() {
            return v.clone();
        }
    }
    Value::String(String::new())
}

/// 上游 `asNumber`：有限數字，否則 0。
fn as_f64(v: Option<&Value>) -> f64 {
    present(v)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .unwrap_or(0.0)
}

fn number_delta(base: Option<&Value>, fresh: Option<&Value>, anchor: Option<&Value>) -> Value {
    let all_integers = [base, fresh, anchor]
        .into_iter()
        .filter_map(present)
        .all(|v| v.is_i64() || v.is_u64());
    if all_integers {
        let n = |v: Option<&Value>| present(v).and_then(Value::as_i64).unwrap_or(0) as i128;
        let result = (n(base) + n(fresh) - n(anchor)).max(0);
        return Value::from(result.min(i64::MAX as i128) as i64);
    }
    // 與 JS 相同的運算順序：(base + fresh) − anchor，再和 0 取大，結果位元相同。
    let result = (as_f64(base) + as_f64(fresh) - as_f64(anchor)).max(0.0);
    Number::from_f64(result)
        .map(Value::Number)
        .unwrap_or_else(|| Value::from(0))
}

fn object_or<'a>(v: Option<&'a Value>, empty: &'a Map<String, Value>) -> &'a Map<String, Value> {
    present(v).and_then(Value::as_object).unwrap_or(empty)
}

fn delta_value(
    base: Option<&Value>,
    fresh: Option<&Value>,
    anchor: Option<&Value>,
    key: &str,
) -> Value {
    let is_true = |v: Option<&Value>| matches!(present(v), Some(Value::Bool(true)));
    match key {
        "tokenComponents" => return Value::Bool(is_true(base) && is_true(fresh)),
        "throughput" => return Value::Bool(is_true(base) && is_true(fresh) && is_true(anchor)),
        "startedAt" | "lastUsedAt" => {
            let (b, f) = (timestamp_ms(base), timestamp_ms(fresh));
            if b != 0 && f != 0 {
                let keep_base = if key == "startedAt" { b <= f } else { b >= f };
                let chosen = if keep_base { base } else { fresh };
                return chosen.cloned().unwrap_or(Value::Null);
            }
            return first_truthy_string(base, fresh);
        }
        _ => {}
    }
    let sample = [base, fresh, anchor].into_iter().find_map(present);
    match sample {
        Some(Value::Number(_)) => number_delta(base, fresh, anchor),
        Some(Value::Object(_)) => {
            let empty = Map::new();
            let (b, f, a) = (
                object_or(base, &empty),
                object_or(fresh, &empty),
                object_or(anchor, &empty),
            );
            // 鍵的順序照 JS 的 Set：base 的鍵，再來 fresh 新增的，最後 anchor 才有的。
            let mut out = Map::new();
            for k in b.keys().chain(f.keys()).chain(a.keys()) {
                if out.contains_key(k) {
                    continue;
                }
                let v = delta_value(b.get(k), f.get(k), a.get(k), k);
                out.insert(k.clone(), v);
            }
            Value::Object(out)
        }
        // 字串、布林與其他：`base ?? fresh`。
        _ => present(base)
            .or(present(fresh))
            .cloned()
            .unwrap_or(Value::Null),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::period::{add_cost, add_count};
    use crate::wire::Session;
    use pretty_assertions::assert_eq;

    fn session(tokens: i64, cost: f64, started: &str, last: &str) -> Session {
        Session {
            client: "claude".into(),
            session_id: "s".into(),
            total_tokens: tokens,
            cost_usd: cost,
            started_at: started.into(),
            last_used_at: last.into(),
            ..Session::default()
        }
    }

    fn period(tokens: i64, cost: f64) -> Period {
        let mut p = Period {
            total_tokens: tokens,
            cost_usd: cost,
            ..Period::default()
        };
        add_count(&mut p.clients, "claude", tokens);
        add_cost(&mut p.client_costs, "claude", cost);
        p
    }

    #[test]
    fn broader_period_grows_by_what_today_grew() {
        let anchor_today = period(100, 1.0);
        let base_month = period(1_000, 10.0);
        let fresh_today = period(150, 1.5);
        let month = apply_period_delta(&base_month, &fresh_today, &anchor_today);
        assert_eq!(month.total_tokens, 1_050);
        assert_eq!(month.cost_usd, 10.0 + 1.5 - 1.0);
        assert_eq!(month.clients["claude"], 1_050);
    }

    #[test]
    fn keys_new_today_are_added_and_nothing_goes_negative() {
        let anchor_today = period(100, 1.0);
        let base = period(1_000, 10.0);
        let mut fresh = period(100, 1.0);
        add_count(&mut fresh.clients, "codex", 40);
        add_count(&mut fresh.models, "gpt-5.5", 40);
        let month = apply_period_delta(&base, &fresh, &anchor_today);
        assert_eq!(month.clients["codex"], 40);
        assert_eq!(month.models["gpt-5.5"], 40);

        // today 被 client 自己清掉一部分：不會變成負數。
        let shrunk = period(10, 0.1);
        let month = apply_period_delta(&period(50, 0.5), &shrunk, &anchor_today);
        assert_eq!(month.total_tokens, 0);
        assert_eq!(month.cost_usd, 0.0);
    }

    #[test]
    fn session_timestamps_keep_the_widest_window() {
        let mut base = period(0, 0.0);
        base.sessions.insert(
            "claude:s".into(),
            session(
                10,
                0.1,
                "2026-09-01T00:00:00.000Z",
                "2026-09-20T00:00:00.000Z",
            ),
        );
        let mut anchor = period(0, 0.0);
        anchor.sessions.insert(
            "claude:s".into(),
            session(
                4,
                0.04,
                "2026-09-24T00:00:00.000Z",
                "2026-09-24T01:00:00.000Z",
            ),
        );
        let mut fresh = period(0, 0.0);
        fresh.sessions.insert(
            "claude:s".into(),
            session(
                9,
                0.09,
                "2026-09-24T00:00:00.000Z",
                "2026-09-24T02:00:00.000Z",
            ),
        );
        fresh.sessions.insert(
            "claude:new".into(),
            session(
                3,
                0.03,
                "2026-09-24T02:00:00.000Z",
                "2026-09-24T02:05:00.000Z",
            ),
        );
        let month = apply_period_delta(&base, &fresh, &anchor);
        let s = &month.sessions["claude:s"];
        assert_eq!(s.total_tokens, 15);
        assert_eq!(s.started_at, "2026-09-01T00:00:00.000Z");
        assert_eq!(s.last_used_at, "2026-09-24T02:00:00.000Z");
        assert_eq!(month.sessions["claude:new"].total_tokens, 3);
        let keys: Vec<_> = month.sessions.keys().cloned().collect();
        assert_eq!(
            keys,
            vec!["claude:s", "claude:new"],
            "base keys first, then fresh"
        );
    }

    #[test]
    fn strings_prefer_the_anchor_side() {
        let mut base = period(0, 0.0);
        let mut s = session(1, 0.0, "", "");
        s.project_label = "old".into();
        base.sessions.insert("k".into(), s);
        let mut fresh = period(0, 0.0);
        let mut s = session(2, 0.0, "", "");
        s.project_label = "new".into();
        fresh.sessions.insert("k".into(), s);
        let month = apply_period_delta(&base, &fresh, &period(0, 0.0));
        assert_eq!(month.sessions["k"].project_label, "old");
    }

    #[test]
    fn capabilities_need_proof_from_the_right_sides() {
        let mut fresh = period(1, 0.0);
        fresh.capabilities.token_components = false;
        let month = apply_period_delta(&period(1, 0.0), &fresh, &period(1, 0.0));
        assert!(!month.capabilities.token_components);
        assert!(month.capabilities.throughput);

        let mut anchor = period(1, 0.0);
        anchor.capabilities.throughput = false;
        let month = apply_period_delta(&period(1, 0.0), &period(1, 0.0), &anchor);
        assert!(
            !month.capabilities.throughput,
            "an unproven anchor voids throughput"
        );
        assert!(month.capabilities.token_components);
    }

    #[test]
    fn identical_today_leaves_the_base_untouched() {
        // 取二進位可精確表示的金額：(a + b) − b 對任意浮點數不一定等於 a（JS 也一樣）。
        let mut base = period(1_234, 5.5);
        base.sessions.insert(
            "claude:s".into(),
            session(
                9,
                0.25,
                "2026-09-01T00:00:00.000Z",
                "2026-09-02T00:00:00.000Z",
            ),
        );
        let today = period(77, 0.25);
        assert_eq!(apply_period_delta(&base, &today, &today), base);
    }
}
