//! 趨勢分頁（上游 widget 的 Trends 視圖與主頁的「活動」模組）要的資料：history 的每日與每月
//! 用量、summary，今天那一格換成即時的 today（上游 homeOverview.js `patchDailyToday`）。
//!
//! 完整 history（每天還有 perClient / perModel）留在 Rust；這裡只給畫圖要的欄位，370 天約 30 KB，
//! 打開趨勢分頁時才以 `trends_get` 要一次，本機有新 record 時重拉。

use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;

use crate::wire::Period;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrendDay {
    pub date: String,
    pub tokens: i64,
    pub cost_usd: f64,
    pub active_time_ms: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrendMonth {
    pub month: String,
    pub tokens: i64,
    pub cost_usd: f64,
    pub active_time_ms: i64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrendSummary {
    pub total_tokens: i64,
    pub total_cost: f64,
    pub active_days: i64,
    pub current_streak: i64,
    pub longest_streak: i64,
    pub peak_day_tokens: i64,
    pub favorite_model: String,
    pub messages: i64,
    pub active_time_ms: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrendsView {
    /// 裝置本地的今天（`periodWindows.today.key`）：熱力圖的最後一格。
    pub today: String,
    /// 有用量的日子（舊到新）；今天是即時數字。
    pub daily: Vec<TrendDay>,
    pub monthly: Vec<TrendMonth>,
    pub summary: TrendSummary,
}

fn num(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .unwrap_or(0.0)
}

fn int(v: Option<&Value>) -> i64 {
    num(v).round() as i64
}

/// history（graph 掃描的 `{daily, monthly, summary}`）＋即時的 today → 趨勢分頁的資料。
/// history 不是物件（關閉、還沒掃）時回 `None`。
pub fn trends_view(history: &Value, today_key: &str, today: &Period) -> Option<TrendsView> {
    let obj = history.as_object()?;
    let mut daily: Vec<TrendDay> = obj
        .get("daily")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|r| {
                    let date = r.get("date")?.as_str()?.get(..10)?.to_string();
                    Some(TrendDay {
                        date,
                        tokens: int(r.get("tokens")),
                        cost_usd: num(r.get("cost")),
                        active_time_ms: int(r.get("activeTimeMs")),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    // 上游 patchDailyToday：今天的 token 與成本換成即時數字，沒有這一列就補上。
    match daily.iter_mut().find(|d| d.date == today_key) {
        Some(d) => {
            d.tokens = today.total_tokens;
            d.cost_usd = today.cost_usd;
        }
        None if !today_key.is_empty() => daily.push(TrendDay {
            date: today_key.to_string(),
            tokens: today.total_tokens,
            cost_usd: today.cost_usd,
            active_time_ms: 0,
        }),
        None => {}
    }
    daily.sort_by(|a, b| a.date.cmp(&b.date));
    let monthly = obj
        .get("monthly")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|r| {
                    Some(TrendMonth {
                        month: r.get("month")?.as_str()?.to_string(),
                        tokens: int(r.get("tokens")),
                        cost_usd: num(r.get("cost")),
                        active_time_ms: int(r.get("activeTimeMs")),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let s = obj.get("summary");
    let field = |k: &str| s.and_then(|s| s.get(k));
    Some(TrendsView {
        today: today_key.to_string(),
        daily,
        monthly,
        summary: TrendSummary {
            total_tokens: int(field("totalTokens")),
            total_cost: num(field("totalCost")),
            active_days: int(field("activeDays")),
            current_streak: int(field("currentStreak")),
            longest_streak: int(field("longestStreak")),
            peak_day_tokens: int(field("peakDayTokens")),
            favorite_model: field("favoriteModel")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            messages: int(field("messages")),
            active_time_ms: int(field("activeTimeMs")),
        },
    })
}

// ---- 儀表板的趨勢圖 --------------------------------------------------------------

/// 儀表板「趨勢」圖的一天：總量與依工具、依模型的 token（上游 dashboard.js 的 perClient / perModel）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SeriesDay {
    pub date: String,
    pub tokens: i64,
    pub clients: IndexMap<String, i64>,
    pub models: IndexMap<String, i64>,
}

fn token_map(v: Option<&Value>) -> IndexMap<String, i64> {
    v.and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .map(|(k, v)| {
                    // antigravity-cli 併進 antigravity（上游 dashboard.js 的 renderBreakdown 同樣處理）。
                    let key = if k == "antigravity-cli" {
                        "antigravity"
                    } else {
                        k.as_str()
                    };
                    (key.to_string(), int(v.get("tokens")))
                })
                .fold(IndexMap::new(), |mut acc, (k, v)| {
                    *acc.entry(k).or_insert(0) += v;
                    acc
                })
        })
        .unwrap_or_default()
}

/// history 的每日列（有用量的日子，舊到新）；今天在即時數字不小於 history 時換成即時的 today。
pub fn history_series(history: &Value, today_key: &str, today: &Period) -> Option<Vec<SeriesDay>> {
    let rows = history.get("daily")?.as_array()?;
    let mut days: Vec<SeriesDay> = rows
        .iter()
        .filter_map(|r| {
            Some(SeriesDay {
                date: r.get("date")?.as_str()?.get(..10)?.to_string(),
                tokens: int(r.get("tokens")),
                clients: token_map(r.get("perClient")),
                models: token_map(r.get("perModel")),
            })
        })
        .collect();
    let live = SeriesDay {
        date: today_key.to_string(),
        tokens: today.total_tokens,
        clients: today.clients.clone(),
        models: today.models.clone(),
    };
    match days.iter_mut().find(|d| d.date == today_key) {
        Some(d) if live.tokens >= d.tokens => *d = live,
        Some(_) => {}
        None if !today_key.is_empty() && live.tokens > 0 => days.push(live),
        None => {}
    }
    days.sort_by(|a, b| a.date.cmp(&b.date));
    Some(days)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn today(tokens: i64) -> Period {
        Period {
            total_tokens: tokens,
            cost_usd: tokens as f64 / 100.0,
            ..Period::default()
        }
    }

    #[test]
    fn today_is_patched_with_the_live_period() {
        let history = json!({
            "daily": [
                { "date": "2026-09-24", "tokens": 10, "cost": 0.1, "activeTimeMs": 60000 },
                { "date": "2026-09-20", "tokens": 5, "cost": 0.05 }
            ],
            "monthly": [{ "month": "2026-09", "tokens": 15, "cost": 0.15, "activeTimeMs": 60000 }],
            "summary": { "activeDays": 2, "currentStreak": 1, "peakDayTokens": 10, "favoriteModel": "m" }
        });
        let v = trends_view(&history, "2026-09-24", &today(500)).unwrap();
        assert_eq!(v.daily.len(), 2);
        assert_eq!(v.daily[0].date, "2026-09-20", "sorted oldest first");
        assert_eq!(v.daily[1].tokens, 500);
        assert_eq!(v.daily[1].cost_usd, 5.0);
        assert_eq!(v.daily[1].active_time_ms, 60000, "other fields are kept");
        assert_eq!(v.monthly[0].month, "2026-09");
        assert_eq!(v.summary.active_days, 2);
        assert_eq!(v.summary.favorite_model, "m");
    }

    #[test]
    fn series_carry_clients_and_models_with_a_live_today() {
        let history = json!({ "daily": [
            { "date": "2026-09-20", "tokens": 9, "perClient": { "claude": { "tokens": 4 }, "antigravity-cli": { "tokens": 5 } },
              "perModel": { "m": { "tokens": 9 } } },
            { "date": "2026-09-24", "tokens": 3, "perClient": { "claude": { "tokens": 3 } }, "perModel": {} }
        ] });
        let mut live = today(8);
        live.clients.insert("codex".into(), 8);
        let s = history_series(&history, "2026-09-24", &live).unwrap();
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].clients["antigravity"], 5);
        assert_eq!(s[0].models["m"], 9);
        assert_eq!(s[1].tokens, 8);
        assert_eq!(s[1].clients["codex"], 8);
        assert!(history_series(&Value::Null, "2026-09-24", &live).is_none());
    }

    #[test]
    fn a_missing_today_is_appended() {
        let history = json!({ "daily": [{ "date": "2026-09-20", "tokens": 5 }], "monthly": [], "summary": {} });
        let v = trends_view(&history, "2026-09-24", &today(7)).unwrap();
        assert_eq!(v.daily.last().unwrap().date, "2026-09-24");
        assert_eq!(v.daily.last().unwrap().tokens, 7);
        assert!(trends_view(&Value::Null, "2026-09-24", &today(7)).is_none());
    }
}
