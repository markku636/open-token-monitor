//! 幣別換算（上游 src/shared/currency.js、exchangeRates.js）：成本一律以 USD 計，畫面上依設定
//! `currency` 換算。匯率優先序：使用者手動設定（`currencyRates`）> 抓到的每日匯率 > 內建值。
//!
//! - 來源：fawazahmed0 currency-api 的 jsDelivr 與 Cloudflare Pages 鏡像（免金鑰），依序試、各 8 秒；
//!   回應要包含所有支援的幣別才算數。
//! - 快取：`<config_dir>/exchange-rates.json`。日期不是今天（UTC）**而且**抓取超過 24 小時才算過期。
//! - 抓不到（公司網路擋外連等）時安靜地用快取或內建值；不影響其他功能。
//!
//! 匯出的檔案與額度的金額不換算（上游相同）。

use std::time::Duration;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 支援的幣別：代碼、符號、內建匯率（1 USD = ?）。
pub const CURRENCIES: &[(&str, &str, f64)] = &[
    ("USD", "$", 1.0),
    ("TWD", "NT$", 31.5),
    ("HKD", "HK$", 7.8),
    ("CNY", "¥", 6.8),
];

pub const RATE_SOURCES: &[&str] = &[
    "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
    "https://latest.currency-api.pages.dev/v1/currencies/usd.json",
];

pub const CACHE_FILE: &str = "exchange-rates.json";
const FETCH_TIMEOUT: Duration = Duration::from_secs(8);
const STALE_AFTER_MS: i64 = 24 * 60 * 60 * 1000;

pub fn is_supported(code: &str) -> bool {
    CURRENCIES.iter().any(|(c, _, _)| *c == code)
}

pub fn symbol(code: &str) -> &'static str {
    CURRENCIES
        .iter()
        .find(|(c, _, _)| *c == code)
        .map(|(_, s, _)| *s)
        .unwrap_or("$")
}

fn builtin(code: &str) -> f64 {
    CURRENCIES
        .iter()
        .find(|(c, _, _)| *c == code)
        .map(|(_, _, r)| *r)
        .unwrap_or(1.0)
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RateCache {
    /// 大寫代碼 → 1 USD 等於多少（不含 USD）。
    pub rates: IndexMap<String, f64>,
    /// 來源資料的日期（`YYYY-MM-DD`）。
    pub date: String,
    pub source: String,
    pub fetched_at: String,
}

/// 來源回應 `{date, usd: {twd, hkd, cny, …}}` → 支援的幣別。缺任何一個就整份不算（上游同樣規則）。
pub fn parse_rates(body: &Value) -> Option<(IndexMap<String, f64>, String)> {
    let usd = body.get("usd")?.as_object()?;
    let mut rates = IndexMap::new();
    for (code, _, _) in CURRENCIES.iter().filter(|(c, _, _)| *c != "USD") {
        let v = usd.get(&code.to_lowercase())?.as_f64()?;
        if !(v.is_finite() && v > 0.0) {
            return None;
        }
        rates.insert(code.to_string(), v);
    }
    let date = body
        .get("date")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Some((rates, date))
}

/// 上游 `isRateCacheStale`：日期不是今天（UTC）而且抓取超過 24 小時。
pub fn is_stale(cache: Option<&RateCache>, now: chrono::DateTime<chrono::Utc>) -> bool {
    let Some(c) = cache else { return true };
    if c.rates.is_empty() {
        return true;
    }
    let today = now.format("%Y-%m-%d").to_string();
    let fetched = crate::wire::time::timestamp_ms(&c.fetched_at);
    c.date != today && (fetched <= 0 || now.timestamp_millis() - fetched > STALE_AFTER_MS)
}

/// 手動 > 抓到的 > 內建。
pub fn effective_rate(
    code: &str,
    overrides: &IndexMap<String, f64>,
    cache: Option<&RateCache>,
) -> f64 {
    if code == "USD" {
        return 1.0;
    }
    overrides
        .get(code)
        .copied()
        .filter(|v| v.is_finite() && *v > 0.0)
        .or_else(|| cache.and_then(|c| c.rates.get(code).copied()))
        .unwrap_or_else(|| builtin(code))
}

pub fn load_cache(dir: &std::path::Path) -> Option<RateCache> {
    crate::store::read_json_in::<RateCache>(dir, CACHE_FILE)
        .ok()
        .flatten()
}

pub fn save_cache(dir: &std::path::Path, cache: &RateCache) {
    if let Err(e) = crate::store::write_json_in(dir, CACHE_FILE, cache) {
        tracing::warn!(error = %e, "failed to save exchange rates");
    }
}

/// 依序試各來源；都失敗回最後一個錯誤。
pub async fn fetch(http: &reqwest::Client) -> Result<RateCache, String> {
    let mut last = String::from("no source");
    for url in RATE_SOURCES {
        let result = async {
            let resp = http
                .get(*url)
                .timeout(FETCH_TIMEOUT)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(format!("HTTP {}", resp.status().as_u16()));
            }
            let body: Value = resp.json().await.map_err(|e| e.to_string())?;
            parse_rates(&body).ok_or_else(|| "incomplete rates".to_string())
        }
        .await;
        match result {
            Ok((rates, date)) => {
                return Ok(RateCache {
                    rates,
                    date,
                    source: url.to_string(),
                    fetched_at: crate::wire::time::iso_millis(chrono::Utc::now()),
                })
            }
            Err(e) => last = format!("{url}: {e}"),
        }
    }
    Err(last)
}

/// 前端 `fmtUsd` 的 Rust 版：換算後 < 0.01 顯示「<符號0.01」，一萬以上取整數加千分位，其他兩位小數。
pub fn format_amount(symbol: &str, rate: f64, usd: f64) -> String {
    let amount = if usd.is_finite() && rate.is_finite() && rate > 0.0 {
        usd * rate
    } else {
        usd.max(0.0)
    };
    if amount > 0.0 && amount < 0.01 {
        return format!("<{symbol}0.01");
    }
    if amount >= 10_000.0 {
        let whole = format!("{amount:.0}");
        let mut grouped = String::new();
        for (i, ch) in whole.chars().enumerate() {
            if i > 0 && (whole.len() - i) % 3 == 0 {
                grouped.push(',');
            }
            grouped.push(ch);
        }
        return format!("{symbol}{grouped}");
    }
    format!("{symbol}{amount:.2}")
}

/// 給畫面的：目前的幣別、符號、匯率與來源（`source` 空 = 內建值或手動）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CurrencyView {
    pub code: String,
    pub symbol: String,
    pub rate: f64,
    /// `manual` | `live` | `default`
    pub mode: &'static str,
    /// 抓到的匯率的日期（`YYYY-MM-DD`）。
    pub date: Option<String>,
}

pub fn view(
    code: &str,
    overrides: &IndexMap<String, f64>,
    cache: Option<&RateCache>,
) -> CurrencyView {
    let code = if is_supported(code) { code } else { "USD" };
    let manual = code != "USD" && overrides.get(code).is_some_and(|v| *v > 0.0);
    let live = !manual && code != "USD" && cache.is_some_and(|c| c.rates.contains_key(code));
    CurrencyView {
        code: code.to_string(),
        symbol: symbol(code).to_string(),
        rate: effective_rate(code, overrides, cache),
        mode: if manual {
            "manual"
        } else if live {
            "live"
        } else {
            "default"
        },
        date: cache
            .filter(|_| live)
            .map(|c| c.date.clone())
            .filter(|d| !d.is_empty()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rates_need_every_supported_currency() {
        let (rates, date) = parse_rates(
            &json!({ "date": "2026-09-24", "usd": { "twd": 32.1, "hkd": 7.79, "cny": 7.1, "eur": 0.9 } }),
        )
        .unwrap();
        assert_eq!(rates["TWD"], 32.1);
        assert_eq!(rates.len(), 3);
        assert_eq!(date, "2026-09-24");
        assert!(parse_rates(&json!({ "usd": { "twd": 32.1, "hkd": 7.79 } })).is_none());
        assert!(parse_rates(&json!({ "usd": { "twd": 0, "hkd": 7.79, "cny": 7.1 } })).is_none());
    }

    #[test]
    fn staleness_needs_both_an_old_date_and_an_old_fetch() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-09-24T12:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let cache = |date: &str, fetched: &str| RateCache {
            rates: [("TWD".to_string(), 32.0)].into_iter().collect(),
            date: date.into(),
            source: "x".into(),
            fetched_at: fetched.into(),
        };
        assert!(!is_stale(
            Some(&cache("2026-09-24", "2026-09-20T00:00:00Z")),
            now
        ));
        assert!(!is_stale(
            Some(&cache("2026-09-23", "2026-09-24T01:00:00Z")),
            now
        ));
        assert!(is_stale(
            Some(&cache("2026-09-23", "2026-09-23T01:00:00Z")),
            now
        ));
        assert!(is_stale(None, now));
    }

    #[test]
    fn amounts_format_like_the_widget() {
        assert_eq!(format_amount("$", 1.0, 0.0), "$0.00");
        assert_eq!(format_amount("$", 1.0, 0.004), "<$0.01");
        assert_eq!(format_amount("NT$", 32.0, 1.0), "NT$32.00");
        assert_eq!(format_amount("NT$", 32.0, 500.0), "NT$16,000");
        assert_eq!(format_amount("$", 1.0, 1_234_567.4), "$1,234,567");
    }

    #[test]
    fn manual_beats_live_beats_builtin() {
        let cache = RateCache {
            rates: [("TWD".to_string(), 32.0)].into_iter().collect(),
            date: "2026-09-24".into(),
            ..RateCache::default()
        };
        let mut overrides = IndexMap::new();
        assert_eq!(view("TWD", &overrides, Some(&cache)).rate, 32.0);
        assert_eq!(view("TWD", &overrides, Some(&cache)).mode, "live");
        assert_eq!(view("TWD", &overrides, None).rate, 31.5);
        assert_eq!(view("TWD", &overrides, None).mode, "default");
        overrides.insert("TWD".into(), 30.0);
        let v = view("TWD", &overrides, Some(&cache));
        assert_eq!((v.rate, v.mode, v.date), (30.0, "manual", None));
        assert_eq!(view("USD", &overrides, Some(&cache)).rate, 1.0);
        assert_eq!(view("XYZ", &overrides, None).code, "USD");
        assert_eq!(view("HKD", &overrides, None).symbol, "HK$");
    }
}
