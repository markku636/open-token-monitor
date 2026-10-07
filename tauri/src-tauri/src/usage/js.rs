//! JavaScript 語意的小工具：上游的解析規則大量依賴 truthiness、`String(x)`、
//! `Number(x)`，移植時必須逐一對齊，否則同一份 tokscale 輸出會算出不同的數字。

use serde_json::{Map, Value};

pub type Obj = Map<String, Value>;

/// JS truthiness。
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `String(value)`。
pub fn to_js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_to_js_string(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => to_js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn number_to_js_string(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    if f == f.trunc() && f.abs() < 1e21 {
        // 整數值：JS 不印小數點（`String(123.0) === "123"`，`String(-0) === "0"`）。
        return format!("{}", f as i128);
    }
    format!("{f}")
}

/// `String(obj[a] || obj[b] || … || '')`：取第一個 truthy 值轉字串。
pub fn first_truthy_string(obj: &Obj, keys: &[&str]) -> String {
    keys.iter()
        .filter_map(|k| obj.get(*k))
        .find(|v| truthy(v))
        .map(to_js_string)
        .unwrap_or_default()
}

pub fn any_truthy(obj: &Obj, keys: &[&str]) -> bool {
    keys.iter().filter_map(|k| obj.get(*k)).any(truthy)
}

/// 上游 `asNumber`：有限數字原樣；非空字串去掉 `$` 與 `,` 後 `Number()`；其餘為 0。
pub fn as_number(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()).unwrap_or(0.0),
        Value::String(s) if !s.trim().is_empty() => {
            let cleaned: String = s.chars().filter(|c| *c != '$' && *c != ',').collect();
            parse_js_number(&cleaned)
        }
        _ => 0.0,
    }
}

pub fn as_number_opt(v: Option<&Value>) -> f64 {
    v.map(as_number).unwrap_or(0.0)
}

/// `Number(string)` 的常見子集：前後空白、十進位、指數、`0x` 十六進位；空字串為 0，其餘無法解析為 0
///（上游再經 `Number.isFinite` 過濾，所以 NaN / Infinity 最後都成為 0）。
fn parse_js_number(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return i64::from_str_radix(hex, 16)
            .map(|v| v as f64)
            .unwrap_or(0.0);
    }
    if t.eq_ignore_ascii_case("infinity")
        || t.eq_ignore_ascii_case("+infinity")
        || t.eq_ignore_ascii_case("-infinity")
    {
        return 0.0;
    }
    t.parse::<f64>()
        .ok()
        .filter(|f| f.is_finite())
        .unwrap_or(0.0)
}

/// 上游 `firstNumber`：第一個存在且非 0 的鍵（0 會被跳過、繼續往下找）。
pub fn first_number(obj: &Obj, keys: &[&str]) -> f64 {
    for key in keys {
        if let Some(v) = obj.get(*key) {
            let n = as_number(v);
            if n != 0.0 {
                return n;
            }
        }
    }
    0.0
}

/// 上游 `firstString`：第一個 `String(v || '').trim()` 非空的鍵。
pub fn first_string(obj: &Obj, keys: &[&str]) -> String {
    for key in keys {
        if let Some(v) = obj.get(*key) {
            let s = if truthy(v) {
                to_js_string(v)
            } else {
                String::new()
            };
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

/// `Math.max(0, Math.round(x))`。非負數的四捨五入與 JS 相同（半數進位）；負數一律為 0。
pub fn round_nonneg(x: f64) -> i64 {
    if x.is_finite() && x > 0.0 {
        x.round() as i64
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn number_semantics() {
        assert_eq!(as_number(&json!("$1,234.5")), 1234.5);
        assert_eq!(as_number(&json!("  12 ")), 12.0);
        assert_eq!(as_number(&json!("abc")), 0.0);
        assert_eq!(as_number(&json!(true)), 0.0);
        assert_eq!(as_number(&json!(null)), 0.0);
        assert_eq!(round_nonneg(2.5), 3);
        assert_eq!(round_nonneg(-2.5), 0);
        assert_eq!(round_nonneg(0.4), 0);
    }

    #[test]
    fn first_number_skips_zero() {
        let obj = json!({ "a": 0, "b": "0", "c": 7 });
        assert_eq!(
            first_number(obj.as_object().unwrap(), &["a", "b", "c"]),
            7.0
        );
    }

    #[test]
    fn string_semantics() {
        assert_eq!(to_js_string(&json!(123.0)), "123");
        assert_eq!(to_js_string(&json!([1, "a", null])), "1,a,");
        assert_eq!(
            to_js_string(&json!(0.30000000000000004)),
            "0.30000000000000004"
        );
        let obj = json!({ "x": "", "y": 0, "z": "  hi " });
        assert_eq!(
            first_string(obj.as_object().unwrap(), &["x", "y", "z"]),
            "hi"
        );
    }
}
