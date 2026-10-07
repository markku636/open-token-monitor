//! 期間相加（上游 src/shared/usage.js `mergePeriods` / `addPeriodInto` / `addProjectInto`）。
//!
//! 用在 WSL：主機的期間與 WSL 裡掃到的期間分開算，發佈前才相加（collector/wsl.rs）。上游先以
//! `normalizePeriod` 正規化每個輸入再相加；我們的輸入都是自己 `extract` / delta 出來、已經是
//! 正規化形狀的 `Period`，那一步是恆等（`tests/compat` 以上游 `mergePeriods` 逐欄比對守著），
//! 所以這裡只移植相加本身。
//!
//! 規則逐條照抄：
//! - 各 client / model 的快取讀寫、輸出與未分類只加真值（0 不留鍵），而且只看來源 `clients` /
//!   `models` 裡有的鍵。
//! - `capabilities`：兩邊都是 true 才是 true。
//! - session 以 `client:sessionId` 合併（`mergeSession`）；專案以正規化的 label 合併。
//! - 順序：先放第一個期間的鍵，後面的期間只把新鍵接在後面（與 JS 物件的插入序相同）。

use super::extract::add_session_ref;
use super::projects::{canonical_project_key, deterministic_label};
use crate::usage::client_name::normalize_client_name;
use crate::wire::period::{add_cost, add_count};
use crate::wire::{CountMap, Period, Project};

use unicode_normalization::UnicodeNormalization;

/// 上游 `mergePeriods(...periods)`：從空期間開始，依序加上每一個。
pub fn merge_periods(periods: &[&Period]) -> Period {
    let mut target = Period::default();
    for period in periods {
        add_period_into(&mut target, period);
    }
    target
}

/// 期間是不是空的（沒有任何用量與明細）；與空期間相加是恆等，呼叫端可以跳過。
pub fn is_empty_period(period: &Period) -> bool {
    *period == Period::default()
}

/// 上游 `addPeriodInto`。
pub fn add_period_into(target: &mut Period, source: &Period) {
    target.capabilities.token_components =
        target.capabilities.token_components && source.capabilities.token_components;
    target.capabilities.throughput =
        target.capabilities.throughput && source.capabilities.throughput;
    target.total_tokens += source.total_tokens;
    target.cost_usd += source.cost_usd;
    target.cache_read_tokens += source.cache_read_tokens;
    target.cache_write_tokens += source.cache_write_tokens;
    target.output_tokens += source.output_tokens;
    target.unclassified_tokens += source.unclassified_tokens;
    target.timed_tokens += source.timed_tokens;
    target.timed_output_tokens += source.timed_output_tokens;
    target.timed_duration_ms += source.timed_duration_ms;
    // JS 的 `if (source.x?.[k])`：只有非 0 的值才加。
    let add_truthy = |map: &mut CountMap, from: &CountMap, key: &str| {
        if let Some(v) = from.get(key).copied().filter(|v| *v != 0) {
            add_count(map, key, v);
        }
    };
    for (client, tokens) in &source.clients {
        add_count(&mut target.clients, client, *tokens);
        add_truthy(
            &mut target.client_cache_reads,
            &source.client_cache_reads,
            client,
        );
        add_truthy(
            &mut target.client_cache_writes,
            &source.client_cache_writes,
            client,
        );
        add_truthy(&mut target.client_outputs, &source.client_outputs, client);
        add_truthy(
            &mut target.client_unclassified_tokens,
            &source.client_unclassified_tokens,
            client,
        );
    }
    for (client, cost) in &source.client_costs {
        add_cost(&mut target.client_costs, client, *cost);
    }
    for (model, tokens) in &source.models {
        add_count(&mut target.models, model, *tokens);
        add_truthy(
            &mut target.model_cache_reads,
            &source.model_cache_reads,
            model,
        );
        add_truthy(
            &mut target.model_cache_writes,
            &source.model_cache_writes,
            model,
        );
        add_truthy(&mut target.model_outputs, &source.model_outputs, model);
        add_truthy(
            &mut target.model_unclassified_tokens,
            &source.model_unclassified_tokens,
            model,
        );
    }
    for (model, cost) in &source.model_costs {
        add_cost(&mut target.model_costs, model, *cost);
    }
    for (client, models) in &source.client_models {
        let entry = target.client_models.entry(client.clone()).or_default();
        for (model, tokens) in models {
            add_count(entry, model, *tokens);
        }
    }
    for (client, models) in &source.client_model_costs {
        let entry = target.client_model_costs.entry(client.clone()).or_default();
        for (model, cost) in models {
            add_cost(entry, model, *cost);
        }
    }
    for (key, project) in &source.projects {
        add_project_into(&mut target.projects, key, project);
    }
    for session in source.sessions.values() {
        add_session_ref(target, session);
    }
}

fn nfc(s: &str) -> String {
    s.nfc().collect()
}

/// 上游 `addProjectInto`：以 label（沒有就用原本的鍵）的 canonical key 合併，label 取字典序小者。
fn add_project_into(
    projects: &mut indexmap::IndexMap<String, Project>,
    raw_key: &str,
    source: &Project,
) {
    let label = nfc(if source.label.is_empty() {
        raw_key.trim()
    } else {
        source.label.trim()
    });
    let name = if label.is_empty() { raw_key } else { &label };
    let key = canonical_project_key(name);
    if key.is_empty() {
        return;
    }
    let target = projects.entry(key).or_insert_with(|| Project {
        label: nfc(name.trim()),
        ..Project::default()
    });
    target.label = deterministic_label(&target.label, name);
    target.tokens += source.tokens.max(0);
    target.cost_usd += source.cost_usd;
    for (client, tokens) in &source.clients {
        if let Some(id) = normalize_client_name(client) {
            add_count(&mut target.clients, &id, (*tokens).max(0));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::Session;

    fn period(client: &str, session: &str, tokens: i64, cache_read: i64) -> Period {
        let mut p = Period {
            total_tokens: tokens,
            cost_usd: 0.1,
            cache_read_tokens: cache_read,
            ..Period::default()
        };
        p.clients.insert(client.into(), tokens);
        p.client_costs.insert(client.into(), 0.1);
        p.client_cache_reads.insert(client.into(), cache_read);
        p.models.insert("m".into(), tokens);
        p.client_models
            .entry(client.into())
            .or_default()
            .insert("m".into(), tokens);
        p.sessions.insert(
            format!("{client}:{session}"),
            Session {
                client: client.into(),
                session_id: session.into(),
                total_tokens: tokens,
                cost_usd: 0.1,
                started_at: "2026-09-24T02:00:00.000Z".into(),
                last_used_at: "2026-09-24T03:00:00.000Z".into(),
                project_label: "Repo".into(),
                project_id: "p".into(),
                ..Session::default()
            },
        );
        crate::usage::projects::apply_project_rollups(&mut p);
        p
    }

    #[test]
    fn merging_with_an_empty_period_is_the_identity() {
        let host = period("claude", "a", 10, 4);
        assert_eq!(merge_periods(&[&host, &Period::default()]), host);
        assert!(is_empty_period(&Period::default()));
        assert!(!is_empty_period(&host));
    }

    #[test]
    fn adds_keys_in_first_seen_order_and_drops_zero_breakdowns() {
        let host = period("claude", "a", 10, 0);
        let mut wsl = period("codex", "b", 5, 2);
        wsl.capabilities.throughput = false;
        let merged = merge_periods(&[&host, &wsl]);
        assert_eq!(merged.total_tokens, 15);
        assert_eq!(
            merged.clients.keys().collect::<Vec<_>>(),
            ["claude", "codex"]
        );
        assert_eq!(merged.models["m"], 15);
        assert_eq!(merged.client_models["codex"]["m"], 5);
        // host 的 0 不留鍵（JS 的 `if (source.clientCacheReads?.[client])`）。
        assert_eq!(
            merged.client_cache_reads.keys().collect::<Vec<_>>(),
            ["codex"]
        );
        assert!(merged.capabilities.token_components);
        assert!(!merged.capabilities.throughput);
        assert_eq!(merged.projects["repo"].tokens, 15);
        assert_eq!(merged.sessions.len(), 2);
    }

    #[test]
    fn the_same_session_on_both_sides_is_summed() {
        let host = period("claude", "a", 10, 0);
        let mut wsl = period("claude", "a", 5, 0);
        wsl.sessions["claude:a"].started_at = "2026-09-24T01:00:00.000Z".into();
        let merged = merge_periods(&[&host, &wsl]);
        let s = &merged.sessions["claude:a"];
        assert_eq!(s.total_tokens, 15);
        assert_eq!(s.started_at, "2026-09-24T01:00:00.000Z");
        assert_eq!(s.last_used_at, "2026-09-24T03:00:00.000Z");
        assert!((merged.cost_usd - 0.2).abs() < 1e-12);
    }
}
