//! session usage archive（上游 src/shared/sessionUsageArchive.js）：client 刪掉舊紀錄後，用量不跟著消失。
//!
//! Claude Code 預設 30 天後刪 transcript，tokscale 就再也讀不到那些 session，本機的 allTime（與當月）
//! 會縮水。archive 記住每個看過的 session 在各期間的最新數字；發佈前，這次掃描沒有、但 archive 有的
//! session 以 `archived: true` 加回去，總數與拆分一起加。
//!
//! - today 只在同一個本地日期、month 只在同一個本地月份套用；allTime 一律套用（`shouldApplyPeriod`）。
//! - 換日、換月時剪掉過期的 today / month；剪的界線只往前走，晚到的舊快照不會把它拉回來。
//! - 同一個 session 在同一期間只保留較新的擷取（比較擷取時間），內容沒變就不算變動。
//! - 錨點（精確 delta 的基準）仍是 tokscale 的原始結果，archive 只在發佈前套用，與上游的
//!   `transformUsage` 相同。
//!
//! 沒移植：Cursor 舊 CSV 列改由新 session 取代的連結（`linkLegacyCursorEvents`）與 Reasonix 的合成
//! session（公司的七個工具不含 Reasonix）。

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::wire::period::{add_cost, add_count};
use crate::wire::{Period, Session, UsageSummary};

pub const PERIODS: [&str; 3] = ["today", "month", "allTime"];

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodWindow {
    pub captured_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub month: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub client: String,
    pub session_id: String,
    pub captured_at: String,
    pub day: String,
    pub month: String,
    #[serde(default)]
    pub period_windows: IndexMap<String, PeriodWindow>,
    #[serde(default)]
    pub periods: IndexMap<String, Session>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionArchive {
    pub sessions: IndexMap<String, ArchiveEntry>,
    pub pruned_day: Option<String>,
    pub pruned_month: Option<String>,
}

/// 擷取的時間點：本地日期、月份與 UTC 時間戳（ms）。
#[derive(Debug, Clone)]
pub struct CaptureAt {
    pub iso: String,
    pub millis: i64,
    pub day: String,
    pub month: String,
}

impl CaptureAt {
    pub fn from_local(t: chrono::DateTime<chrono::Local>) -> CaptureAt {
        CaptureAt {
            iso: crate::wire::time::iso_millis(t.with_timezone(&chrono::Utc)),
            millis: t.timestamp_millis(),
            day: t.format("%Y-%m-%d").to_string(),
            month: t.format("%Y-%m").to_string(),
        }
    }
}

fn has_usage(s: &Session) -> bool {
    s.total_tokens > 0 || s.cost_usd > 0.0
}

fn session_key(s: &Session) -> Option<String> {
    let client = s.client.trim();
    let id = s.session_id.trim();
    (!client.is_empty() && !id.is_empty()).then(|| format!("{client}:{id}"))
}

fn period_of<'a>(summary: &'a UsageSummary, name: &str) -> &'a Period {
    match name {
        "today" => &summary.today,
        "month" => &summary.month,
        _ => &summary.all_time,
    }
}

fn period_of_mut<'a>(summary: &'a mut UsageSummary, name: &str) -> &'a mut Period {
    match name {
        "today" => &mut summary.today,
        "month" => &mut summary.month,
        _ => &mut summary.all_time,
    }
}

fn millis(iso: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|d| d.timestamp_millis())
}

impl SessionArchive {
    /// 上游 `pruneExpiredSessionUsagePeriods`。
    fn prune(&mut self, at: &CaptureAt, changed: &mut Vec<String>) {
        let prune_day = self.pruned_day.as_ref().is_none_or(|d| *d < at.day);
        let prune_month = self.pruned_month.as_ref().is_none_or(|m| *m < at.month);
        if !prune_day && !prune_month {
            return;
        }
        for (key, entry) in self.sessions.iter_mut() {
            let mut touched = false;
            let retained_day = entry
                .period_windows
                .get("today")
                .and_then(|w| w.day.clone())
                .unwrap_or_else(|| entry.day.clone());
            if prune_day && entry.periods.contains_key("today") && retained_day < at.day {
                entry.periods.shift_remove("today");
                entry.period_windows.shift_remove("today");
                touched = true;
            }
            let retained_month = entry
                .period_windows
                .get("month")
                .and_then(|w| w.month.clone())
                .unwrap_or_else(|| entry.month.clone());
            if prune_month && entry.periods.contains_key("month") && retained_month < at.month {
                entry.periods.shift_remove("month");
                entry.period_windows.shift_remove("month");
                touched = true;
            }
            if touched {
                changed.push(key.clone());
            }
        }
        if prune_day {
            self.pruned_day = Some(at.day.clone());
        }
        if prune_month {
            self.pruned_month = Some(at.month.clone());
        }
    }

    /// 上游 `updateSessionUsageArchive`：記住這次看到的每個 session。回傳有變動的 key（寫檔用）。
    pub fn capture(&mut self, summary: &UsageSummary, at: &CaptureAt) -> Vec<String> {
        let mut changed = Vec::new();
        self.prune(at, &mut changed);
        for name in PERIODS {
            if name == "today" && self.pruned_day.as_ref().is_some_and(|d| at.day < *d) {
                continue;
            }
            if name == "month" && self.pruned_month.as_ref().is_some_and(|m| at.month < *m) {
                continue;
            }
            for session in period_of(summary, name).sessions.values() {
                if !has_usage(session) {
                    continue;
                }
                let Some(key) = session_key(session) else {
                    continue;
                };
                let entry = self
                    .sessions
                    .entry(key.clone())
                    .or_insert_with(|| ArchiveEntry {
                        client: session.client.clone(),
                        session_id: session.session_id.clone(),
                        captured_at: at.iso.clone(),
                        day: at.day.clone(),
                        month: at.month.clone(),
                        ..ArchiveEntry::default()
                    });
                let window = entry.period_windows.get(name);
                // 兩個收集器先後完成的順序可能與收集時間相反：保留較新的那一次。
                if window
                    .and_then(|w| millis(&w.captured_at))
                    .is_some_and(|t| t > at.millis)
                {
                    continue;
                }
                let same_window = match name {
                    "today" => window.and_then(|w| w.day.as_deref()) == Some(at.day.as_str()),
                    "month" => window.and_then(|w| w.month.as_deref()) == Some(at.month.as_str()),
                    _ => true,
                };
                let mut next = session.clone();
                next.archived = false;
                if same_window && entry.periods.get(name) == Some(&next) {
                    continue;
                }
                entry.client = session.client.clone();
                entry.session_id = session.session_id.clone();
                entry.captured_at = at.iso.clone();
                entry.day = at.day.clone();
                entry.month = at.month.clone();
                entry.periods.insert(name.to_string(), next);
                entry.period_windows.insert(
                    name.to_string(),
                    PeriodWindow {
                        captured_at: at.iso.clone(),
                        day: (name == "today").then(|| at.day.clone()),
                        month: (name == "month").then(|| at.month.clone()),
                    },
                );
                if !changed.contains(&key) {
                    changed.push(key);
                }
            }
        }
        changed
    }

    /// 上游 `shouldApplyPeriod`。
    fn applies(name: &str, entry: &ArchiveEntry, now: &CaptureAt) -> bool {
        let window = entry.period_windows.get(name);
        match name {
            "today" => window.and_then(|w| w.day.as_deref()).unwrap_or(&entry.day) == now.day,
            "month" => {
                window
                    .and_then(|w| w.month.as_deref())
                    .unwrap_or(&entry.month)
                    == now.month
            }
            _ => true,
        }
    }

    /// 上游 `applySessionUsageArchive`：把這次沒掃到的 session 加回對應的期間。回傳加回幾筆。
    pub fn apply(&self, summary: &mut UsageSummary, now: &CaptureAt) -> usize {
        let mut added = 0;
        for (key, entry) in &self.sessions {
            for name in PERIODS {
                let Some(session) = entry.periods.get(name) else {
                    continue;
                };
                if !has_usage(session) || !Self::applies(name, entry, now) {
                    continue;
                }
                let period = period_of_mut(summary, name);
                if period.sessions.contains_key(key) {
                    continue;
                }
                add_archived_session(period, session, key);
                added += 1;
            }
        }
        added
    }
}

fn round_nonneg(v: i64) -> i64 {
    v.max(0)
}

/// 上游 `addSessionBreakdown`：只有單一模型時才能把 token 組成歸到那個模型。
fn add_session_breakdown(period: &mut Period, s: &Session) {
    let client = s.client.as_str();
    let cache_read = round_nonneg(s.cache_read_tokens);
    let cache_write = round_nonneg(s.cache_write_tokens);
    let output = round_nonneg(s.output_tokens);
    if cache_read > 0 {
        add_count(&mut period.client_cache_reads, client, cache_read);
    }
    if cache_write > 0 {
        add_count(&mut period.client_cache_writes, client, cache_write);
    }
    if output > 0 {
        add_count(&mut period.client_outputs, client, output);
    }
    let models: Vec<(&String, i64)> = s
        .models
        .iter()
        .map(|(m, t)| (m, *t))
        .filter(|(_, t)| *t > 0)
        .collect();
    let total: i64 = models.iter().map(|(_, t)| t).sum();
    if total == 0 {
        return;
    }
    if models.len() > 1 {
        for (model, tokens) in models {
            add_count(&mut period.model_unclassified_tokens, model, tokens);
        }
        period.capabilities.token_components = false;
        return;
    }
    for (model, tokens) in models {
        let cr = tokens.min(cache_read);
        let cw = (tokens - cr).min(cache_write);
        let ou = (tokens - cr - cw).min(output);
        if cr > 0 {
            add_count(&mut period.model_cache_reads, model, cr);
        }
        if cw > 0 {
            add_count(&mut period.model_cache_writes, model, cw);
        }
        if ou > 0 {
            add_count(&mut period.model_outputs, model, ou);
        }
        let unclassified = (tokens - cr - cw - ou).max(0);
        if unclassified > 0 {
            add_count(&mut period.model_unclassified_tokens, model, unclassified);
            period.capabilities.token_components = false;
        }
    }
}

/// 上游 `addArchivedSession`。
fn add_archived_session(period: &mut Period, session: &Session, key: &str) {
    let mut archived = session.clone();
    archived.archived = true;
    let tokens = round_nonneg(archived.total_tokens);
    let cost = archived.cost_usd;
    let cache_read = round_nonneg(archived.cache_read_tokens);
    let cache_write = round_nonneg(archived.cache_write_tokens);
    let output = round_nonneg(archived.output_tokens);
    period.total_tokens += tokens;
    period.cost_usd += cost;
    period.cache_read_tokens += cache_read;
    period.cache_write_tokens += cache_write;
    period.output_tokens += output;
    let unclassified = (tokens - cache_read - cache_write - output).max(0);
    let client = archived.client.clone();
    if unclassified > 0 {
        period.unclassified_tokens += unclassified;
        add_count(
            &mut period.client_unclassified_tokens,
            &client,
            unclassified,
        );
        period.capabilities.token_components = false;
    }
    if tokens > 0 {
        add_count(&mut period.clients, &client, tokens);
    }
    if cost > 0.0 {
        add_cost(&mut period.client_costs, &client, cost);
    }
    for (model, t) in &archived.models {
        let next = round_nonneg(*t);
        if next <= 0 {
            continue;
        }
        add_count(&mut period.models, model, next);
        add_count(
            period.client_models.entry(client.clone()).or_default(),
            model,
            next,
        );
    }
    for (model, c) in &archived.model_costs {
        if *c <= 0.0 {
            continue;
        }
        add_cost(&mut period.model_costs, model, *c);
        add_cost(
            period.client_model_costs.entry(client.clone()).or_default(),
            model,
            *c,
        );
    }
    add_session_breakdown(period, &archived);
    period.sessions.insert(key.to_string(), archived);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(day: &str, hour: u32) -> CaptureAt {
        use chrono::TimeZone;
        let d = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").unwrap();
        let t = chrono::Local
            .from_local_datetime(&d.and_hms_opt(hour, 0, 0).unwrap())
            .unwrap();
        CaptureAt::from_local(t)
    }

    fn session(id: &str, tokens: i64) -> Session {
        let mut models = IndexMap::new();
        models.insert("claude-opus-5".to_string(), tokens);
        Session {
            client: "claude".into(),
            session_id: id.into(),
            total_tokens: tokens,
            cost_usd: tokens as f64 / 1000.0,
            cache_read_tokens: tokens / 2,
            output_tokens: tokens / 10,
            models,
            ..Session::default()
        }
    }

    fn summary(sessions: &[Session]) -> UsageSummary {
        let mut s = UsageSummary::default();
        for p in [&mut s.today, &mut s.month, &mut s.all_time] {
            for x in sessions {
                p.sessions
                    .insert(format!("claude:{}", x.session_id), x.clone());
                p.total_tokens += x.total_tokens;
            }
        }
        s
    }

    #[test]
    fn deleted_sessions_come_back_as_archived() {
        let mut archive = SessionArchive::default();
        let first = summary(&[session("a", 1000), session("b", 500)]);
        let changed = archive.capture(&first, &at("2026-09-24", 9));
        assert_eq!(changed, vec!["claude:a", "claude:b"]);
        assert!(
            archive.capture(&first, &at("2026-09-24", 10)).is_empty(),
            "nothing new"
        );

        // 同一天稍晚：client 刪掉了 b。
        let mut later = summary(&[session("a", 1200)]);
        archive.capture(&later, &at("2026-09-24", 11));
        let added = archive.apply(&mut later, &at("2026-09-24", 11));
        assert_eq!(added, 3, "today, month and allTime");
        let b = &later.all_time.sessions["claude:b"];
        assert!(b.archived);
        assert_eq!(later.all_time.total_tokens, 1700);
        assert_eq!(later.all_time.clients["claude"], 500);
        assert_eq!(later.all_time.model_cache_reads["claude-opus-5"], 250);
    }

    #[test]
    fn today_and_month_expire_but_all_time_stays() {
        let mut archive = SessionArchive::default();
        archive.capture(&summary(&[session("old", 800)]), &at("2026-08-31", 23));
        // 隔月：old 已經被刪了。
        let mut next = summary(&[]);
        let changed = archive.capture(&next, &at("2026-09-01", 8));
        assert_eq!(changed, vec!["claude:old"], "today and month were pruned");
        assert_eq!(archive.apply(&mut next, &at("2026-09-01", 8)), 1);
        assert!(next.today.sessions.is_empty());
        assert!(next.month.sessions.is_empty());
        assert_eq!(next.all_time.total_tokens, 800);
        // 晚到的前一天快照不能把剪掉的 today 帶回來。
        let stale = summary(&[session("old", 800)]);
        archive.capture(&stale, &at("2026-08-31", 23));
        assert!(!archive.sessions["claude:old"].periods.contains_key("today"));
    }

    #[test]
    fn a_newer_capture_is_never_overwritten_by_an_older_one() {
        let mut archive = SessionArchive::default();
        archive.capture(&summary(&[session("a", 900)]), &at("2026-09-24", 12));
        archive.capture(&summary(&[session("a", 100)]), &at("2026-09-24", 11));
        assert_eq!(
            archive.sessions["claude:a"].periods["allTime"].total_tokens,
            900
        );
    }
}
