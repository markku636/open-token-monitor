//! 本機明細：工具與模型的 token 組成、工具的模型拆分、專案、session 清單。
//!
//! 前端打開那個畫面時才向 Rust 要（`usage_detail` / `usage_sessions` 指令），不隨每次掃描推送：
//! allTime 的 session 可能上千筆，每 3–5 秒搬一次沒有意義。
//!
//! 規則逐條照上游 renderer：usageAttributionRows.js `attributionRows`、toolDetails.js
//! `modelRowsForTool`、projectRows.js `projectRowsForPeriod`、sessionRows.js `sessionRowsForPeriod`
//! 與 `groupBackgroundReviewRows`。顯示用的字串（時間、session id 清理）在前端 src/detailFormat.ts。

use indexmap::{IndexMap, IndexSet};
use serde::Serialize;

use crate::usage::projects::{canonical_project_key, deterministic_label};
use crate::wire::{CostMap, CountMap, DeviceRecord, Period};

/// 總量扣掉各列加總後的餘數（上游 `UNATTRIBUTED_KEY`）。
pub const UNATTRIBUTED: &str = "__unattributed";
/// session 清單一頁的筆數（上游 breakdownRenderPolicy.js `BREAKDOWN_PAGE_SIZE`）。
pub const SESSION_PAGE_SIZE: usize = 100;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Share {
    pub key: String,
    pub tokens: i64,
    pub cost_usd: f64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unattributed: bool,
}

/// 一列的 token 組成（上游 `tokenComponentBreakdown` 的輸入；快取未命中由前端推）。
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Components {
    pub cache_read_tokens: i64,
    pub output_tokens: i64,
    pub unclassified_tokens: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    #[serde(flatten)]
    pub share: Share,
    /// 沒有組成資料時為 `None`，前端就不給展開 token 組成；未分類那一列用期間總量扣掉各鍵。
    pub components: Option<Components>,
    /// 工具列才有：這個工具依模型拆分（依 token、成本、名稱排序）。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<Share>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRow {
    pub key: String,
    pub label: String,
    pub tokens: i64,
    pub cost_usd: f64,
    /// 依工具拆分（token 由多到少）；專案總量大於各工具加總時，餘數是 `unattributed` 的一列。
    pub clients: Vec<Share>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PeriodDetail {
    pub total_tokens: i64,
    pub cost_usd: f64,
    pub tools: Vec<UsageRow>,
    pub models: Vec<UsageRow>,
    pub projects: Vec<ProjectRow>,
    pub session_count: usize,
}

fn round6(v: f64) -> f64 {
    (v * 1e6).round() / 1e6
}

/// 上游 `attributionRows`：各鍵（token 與成本的聯集，保持出現順序）只留有 token 或有成本的，
/// 總量大於加總時補一列餘數。不排序。
pub fn attribution_rows(
    values: &CountMap,
    costs: &CostMap,
    total: i64,
    total_cost: f64,
) -> Vec<Share> {
    let keys: IndexSet<&str> = values
        .keys()
        .chain(costs.keys())
        .map(String::as_str)
        .collect();
    let mut rows: Vec<Share> = keys
        .into_iter()
        .map(|key| Share {
            key: key.to_string(),
            tokens: values.get(key).copied().unwrap_or(0),
            cost_usd: costs.get(key).copied().unwrap_or(0.0),
            unattributed: false,
        })
        .filter(|r| r.tokens > 0 || r.cost_usd > 0.0)
        .collect();
    let attributed: i64 = rows.iter().map(|r| r.tokens.max(0)).sum();
    let attributed_cost: f64 = rows.iter().map(|r| r.cost_usd.max(0.0)).sum();
    let remainder = (total - attributed).max(0);
    let remainder_cost = round6(total_cost - attributed_cost).max(0.0);
    if remainder > 0 || remainder_cost > 0.0 {
        rows.push(Share {
            key: UNATTRIBUTED.into(),
            tokens: remainder,
            cost_usd: remainder_cost,
            unattributed: true,
        });
    }
    rows
}

fn by_tokens_then_key(a: &Share, b: &Share) -> std::cmp::Ordering {
    b.tokens.cmp(&a.tokens).then_with(|| a.key.cmp(&b.key))
}

fn components_for(
    key: &str,
    cache_reads: &CountMap,
    outputs: &CountMap,
    unclassified: &CountMap,
) -> Option<Components> {
    let present = cache_reads.contains_key(key)
        || outputs.contains_key(key)
        || unclassified.contains_key(key);
    present.then(|| Components {
        cache_read_tokens: cache_reads.get(key).copied().unwrap_or(0),
        output_tokens: outputs.get(key).copied().unwrap_or(0),
        unclassified_tokens: unclassified.get(key).copied().unwrap_or(0),
    })
}

/// 上游 `modelRowsForTool`：工具的模型拆分，餘數以這個工具自己的總量計。
pub fn model_rows_for_tool(p: &Period, client: &str) -> Vec<Share> {
    let models = p.client_models.get(client);
    let costs = p.client_model_costs.get(client);
    if models.is_none() && costs.is_none() {
        return Vec::new();
    }
    let empty_counts = CountMap::new();
    let empty_costs = CostMap::new();
    let mut rows = attribution_rows(
        models.unwrap_or(&empty_counts),
        costs.unwrap_or(&empty_costs),
        p.clients.get(client).copied().unwrap_or(0).max(0),
        p.client_costs.get(client).copied().unwrap_or(0.0).max(0.0),
    );
    rows.sort_by(|a, b| {
        b.tokens
            .cmp(&a.tokens)
            .then(
                b.cost_usd
                    .partial_cmp(&a.cost_usd)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
            .then_with(|| a.key.cmp(&b.key))
    });
    rows
}

/// 上游 usageAttributionRows.js `attributionValue` 對未分類那一列的算法：期間的總量扣掉各鍵的加總
/// （不小於 0），所以餘數那一列也看得到 token 組成。
fn remainder_components(
    p: &Period,
    cache_reads: &CountMap,
    outputs: &CountMap,
    unclassified: &CountMap,
) -> Components {
    let rest =
        |total: i64, map: &CountMap| (total - map.values().map(|v| v.max(&0)).sum::<i64>()).max(0);
    Components {
        cache_read_tokens: rest(p.cache_read_tokens, cache_reads),
        output_tokens: rest(p.output_tokens, outputs),
        unclassified_tokens: rest(p.unclassified_tokens, unclassified),
    }
}

pub fn tool_rows(p: &Period) -> Vec<UsageRow> {
    let mut shares = attribution_rows(&p.clients, &p.client_costs, p.total_tokens, p.cost_usd);
    shares.sort_by(by_tokens_then_key);
    shares
        .into_iter()
        .map(|share| {
            let (components, models) = if share.unattributed {
                (
                    Some(remainder_components(
                        p,
                        &p.client_cache_reads,
                        &p.client_outputs,
                        &p.client_unclassified_tokens,
                    )),
                    Vec::new(),
                )
            } else {
                (
                    components_for(
                        &share.key,
                        &p.client_cache_reads,
                        &p.client_outputs,
                        &p.client_unclassified_tokens,
                    ),
                    model_rows_for_tool(p, &share.key),
                )
            };
            UsageRow {
                share,
                components,
                models,
            }
        })
        .collect()
}

pub fn model_rows(p: &Period) -> Vec<UsageRow> {
    let mut shares = attribution_rows(&p.models, &p.model_costs, p.total_tokens, p.cost_usd);
    shares.sort_by(by_tokens_then_key);
    shares
        .into_iter()
        .map(|share| UsageRow {
            components: if share.unattributed {
                Some(remainder_components(
                    p,
                    &p.model_cache_reads,
                    &p.model_outputs,
                    &p.model_unclassified_tokens,
                ))
            } else {
                components_for(
                    &share.key,
                    &p.model_cache_reads,
                    &p.model_outputs,
                    &p.model_unclassified_tokens,
                )
            },
            models: Vec::new(),
            share,
        })
        .collect()
}

struct ProjectAcc {
    label: String,
    tokens: i64,
    cost: f64,
    clients: IndexMap<String, i64>,
}

/// 上游 `projectRowsForPeriod`：以 period.projects 為準，沒有時由 session 的專案標籤重建。
/// 依成本、token、名稱排序；不設上限。
pub fn project_rows(p: &Period) -> Vec<ProjectRow> {
    let mut projects: IndexMap<String, ProjectAcc> = IndexMap::new();
    let mut add = |label: &str, tokens: i64, cost: f64, clients: &[(&str, i64)]| {
        let key = canonical_project_key(label);
        let label = label.trim();
        if key.is_empty() || label.is_empty() {
            return;
        }
        let entry = projects.entry(key).or_insert_with(|| ProjectAcc {
            label: label.to_string(),
            tokens: 0,
            cost: 0.0,
            clients: IndexMap::new(),
        });
        entry.label = deterministic_label(&entry.label, label);
        entry.tokens += tokens.max(0);
        entry.cost += cost;
        for (client, t) in clients {
            if *t > 0 {
                *entry.clients.entry(client.to_string()).or_insert(0) += t;
            }
        }
    };
    if !p.projects.is_empty() {
        for (raw_key, project) in &p.projects {
            let label = if project.label.trim().is_empty() {
                raw_key.as_str()
            } else {
                project.label.as_str()
            };
            let clients: Vec<(&str, i64)> = project
                .clients
                .iter()
                .map(|(c, t)| (c.as_str(), *t))
                .collect();
            add(label, project.tokens, project.cost_usd, &clients);
        }
    } else {
        for session in p.sessions.values() {
            let tokens = session.total_tokens.max(0);
            let clients: Vec<(&str, i64)> = if session.client.is_empty() {
                Vec::new()
            } else {
                vec![(session.client.as_str(), tokens)]
            };
            add(&session.project_label, tokens, session.cost_usd, &clients);
        }
    }
    let mut rows: Vec<ProjectRow> = projects
        .into_iter()
        .map(|(key, acc)| {
            let attributed: i64 = acc.clients.values().sum();
            let mut clients: Vec<Share> = acc
                .clients
                .into_iter()
                .map(|(client, tokens)| Share {
                    key: client,
                    tokens,
                    cost_usd: 0.0,
                    unattributed: false,
                })
                .collect();
            if acc.tokens > attributed {
                clients.push(Share {
                    key: UNATTRIBUTED.into(),
                    tokens: acc.tokens - attributed,
                    cost_usd: 0.0,
                    unattributed: true,
                });
            }
            clients.sort_by(by_tokens_then_key);
            ProjectRow {
                key,
                label: acc.label,
                tokens: acc.tokens,
                cost_usd: acc.cost,
                clients,
            }
        })
        .collect();
    rows.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.tokens.cmp(&a.tokens))
            .then_with(|| a.label.cmp(&b.label))
    });
    rows
}

pub fn period_detail(p: &Period) -> PeriodDetail {
    PeriodDetail {
        total_tokens: p.total_tokens,
        cost_usd: p.cost_usd,
        tools: tool_rows(p),
        models: model_rows(p),
        projects: project_rows(p),
        session_count: p.sessions.values().filter(|s| s.total_tokens > 0).count(),
    }
}

/// `today` / `month` / `allTime` → 本機 record 的那個期間。
pub fn record_period<'a>(r: &'a DeviceRecord, name: &str) -> Option<&'a Period> {
    match name {
        "today" => Some(&r.today),
        "month" => Some(&r.month),
        "allTime" => Some(&r.all_time),
        _ => None,
    }
}

// ---- session 清單 --------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub key: String,
    pub client: String,
    pub session_id: String,
    /// 有 token 的模型名稱（字母序）；前端顯示單一模型或「N models」。
    pub models: Vec<String>,
    pub total_tokens: i64,
    pub cost_usd: f64,
    pub message_count: i64,
    /// `lastUsedAt`，沒有時用 `startedAt`（排序與「進行中」的依據）。
    pub at: String,
    /// client 已刪掉原始紀錄、由封存保留的 session（上游標「已封存」、不算進行中）。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub archived: bool,
}

/// Codex 的背景審查 session 合成最後一列（上游 `groupBackgroundReviewRows`）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewGroup {
    pub count: usize,
    pub total_tokens: i64,
    pub cost_usd: f64,
    pub latest_at: String,
    pub latest_tokens: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SessionItem {
    Session(SessionRow),
    Review(ReviewGroup),
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionPage {
    /// 全部列數（背景審查合成的那一列算一列）。
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
    /// 所有列（不只這頁）最大的 token：長條以它為滿格（上游以全部列為準）。
    pub max_tokens: i64,
    pub rows: Vec<SessionItem>,
}

fn at_ms(s: &crate::wire::Session) -> (String, i64) {
    for v in [&s.last_used_at, &s.started_at] {
        let ms = crate::wire::time::timestamp_ms(v);
        if ms > 0 {
            return (v.clone(), ms);
        }
    }
    (String::new(), 0)
}

pub fn session_items(p: &Period) -> Vec<SessionItem> {
    let mut primary: Vec<(i64, SessionRow)> = Vec::new();
    let mut reviews: Vec<(i64, SessionRow)> = Vec::new();
    for (key, s) in &p.sessions {
        if s.total_tokens <= 0 {
            continue;
        }
        let (at, ms) = at_ms(s);
        let mut models: Vec<String> = s
            .models
            .iter()
            .filter(|(_, v)| **v > 0)
            .map(|(k, _)| k.clone())
            .collect();
        models.sort();
        let row = SessionRow {
            key: key.clone(),
            client: s.client.clone(),
            session_id: if s.session_id.is_empty() {
                key.clone()
            } else {
                s.session_id.clone()
            },
            models,
            total_tokens: s.total_tokens,
            cost_usd: s.cost_usd,
            message_count: s.message_count,
            at,
            archived: s.archived,
        };
        if s.session_kind == "background-review" {
            reviews.push((ms, row));
        } else {
            primary.push((ms, row));
        }
    }
    primary.sort_by(|(am, a), (bm, b)| {
        bm.cmp(am)
            .then(b.total_tokens.cmp(&a.total_tokens))
            .then(
                b.cost_usd
                    .partial_cmp(&a.cost_usd)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
            .then_with(|| a.key.cmp(&b.key))
    });
    let mut items: Vec<SessionItem> = primary
        .into_iter()
        .map(|(_, r)| SessionItem::Session(r))
        .collect();
    if !reviews.is_empty() {
        reviews.sort_by(|(am, _), (bm, _)| bm.cmp(am));
        let (_, latest) = &reviews[0];
        items.push(SessionItem::Review(ReviewGroup {
            count: reviews.len(),
            total_tokens: reviews.iter().map(|(_, r)| r.total_tokens).sum(),
            cost_usd: reviews.iter().map(|(_, r)| r.cost_usd).sum(),
            latest_at: latest.at.clone(),
            latest_tokens: latest.total_tokens,
        }));
    }
    items
}

pub fn session_page(p: &Period, page: usize) -> SessionPage {
    let items = session_items(p);
    let total = items.len();
    let max_tokens = items
        .iter()
        .map(|i| match i {
            SessionItem::Session(r) => r.total_tokens,
            SessionItem::Review(g) => g.total_tokens,
        })
        .max()
        .unwrap_or(0);
    let pages = total.div_ceil(SESSION_PAGE_SIZE).max(1);
    let page = page.min(pages - 1);
    let rows = items
        .into_iter()
        .skip(page * SESSION_PAGE_SIZE)
        .take(SESSION_PAGE_SIZE)
        .collect();
    SessionPage {
        total,
        page,
        page_size: SESSION_PAGE_SIZE,
        max_tokens,
        rows,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{Project, Session};

    fn counts(pairs: &[(&str, i64)]) -> CountMap {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    fn costs(pairs: &[(&str, f64)]) -> CostMap {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn attribution_adds_the_remainder_row() {
        let rows = attribution_rows(
            &counts(&[("claude", 70), ("codex", 0)]),
            &costs(&[("codex", 0.5)]),
            100,
            2.0,
        );
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].key, "claude");
        assert_eq!(rows[1].key, "codex", "kept for its cost");
        assert_eq!(rows[2].key, UNATTRIBUTED);
        assert_eq!(rows[2].tokens, 30);
        assert_eq!(rows[2].cost_usd, 1.5);
        assert!(rows[2].unattributed);
        assert!(attribution_rows(&counts(&[("a", 5)]), &costs(&[]), 5, 0.0)
            .iter()
            .all(|r| !r.unattributed));
    }

    fn period() -> Period {
        let mut p = Period {
            total_tokens: 1_000,
            cost_usd: 10.0,
            clients: counts(&[("codex", 300), ("claude", 600)]),
            client_costs: costs(&[("claude", 8.0), ("codex", 2.0)]),
            client_cache_reads: counts(&[("claude", 400)]),
            client_outputs: counts(&[("claude", 50), ("codex", 20)]),
            models: counts(&[("m1", 500), ("m2", 400)]),
            model_costs: costs(&[("m1", 7.0), ("m2", 3.0)]),
            ..Period::default()
        };
        p.client_models
            .insert("claude".into(), counts(&[("m2", 100), ("m1", 450)]));
        p.client_model_costs
            .insert("claude".into(), costs(&[("m1", 7.0), ("m2", 1.0)]));
        p
    }

    #[test]
    fn tools_carry_components_and_their_models() {
        let tools = tool_rows(&period());
        let keys: Vec<&str> = tools.iter().map(|t| t.share.key.as_str()).collect();
        assert_eq!(keys, ["claude", "codex", UNATTRIBUTED]);
        let claude = &tools[0];
        assert_eq!(
            claude.components,
            Some(Components {
                cache_read_tokens: 400,
                output_tokens: 50,
                unclassified_tokens: 0
            })
        );
        let models: Vec<(&str, i64)> = claude
            .models
            .iter()
            .map(|m| (m.key.as_str(), m.tokens))
            .collect();
        assert_eq!(models, [("m1", 450), ("m2", 100), (UNATTRIBUTED, 50)]);
        assert!(tools[1].models.is_empty(), "codex has no model split");
        // 未分類那一列：期間總量扣掉各工具的組成（period() 的總量都是 0，所以是 0）。
        assert_eq!(
            tools[2].components,
            Some(Components {
                cache_read_tokens: 0,
                output_tokens: 0,
                unclassified_tokens: 0
            })
        );
    }

    #[test]
    fn projects_merge_labels_and_sort_by_cost() {
        let mut p = Period::default();
        p.projects.insert(
            "a".into(),
            Project {
                label: "Repo".into(),
                tokens: 100,
                cost_usd: 1.0,
                clients: counts(&[("claude", 60)]),
            },
        );
        p.projects.insert(
            "b".into(),
            Project {
                label: "repo".into(),
                tokens: 50,
                cost_usd: 0.5,
                clients: counts(&[("codex", 50)]),
            },
        );
        p.projects.insert(
            "c".into(),
            Project {
                label: "Other".into(),
                tokens: 500,
                cost_usd: 0.1,
                clients: counts(&[("claude", 500)]),
            },
        );
        let rows = project_rows(&p);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].label, "Repo", "cost first; 'Repo' < 'repo'");
        assert_eq!(rows[0].tokens, 150);
        let clients: Vec<(&str, i64)> = rows[0]
            .clients
            .iter()
            .map(|c| (c.key.as_str(), c.tokens))
            .collect();
        assert_eq!(clients, [("claude", 60), ("codex", 50), (UNATTRIBUTED, 40)]);
    }

    #[test]
    fn projects_fall_back_to_session_labels() {
        let mut p = Period::default();
        p.sessions.insert(
            "s1".into(),
            Session {
                client: "codex".into(),
                total_tokens: 30,
                cost_usd: 0.3,
                project_label: "api".into(),
                ..Session::default()
            },
        );
        p.sessions.insert(
            "s2".into(),
            Session {
                client: "codex".into(),
                total_tokens: 5,
                ..Session::default()
            },
        );
        let rows = project_rows(&p);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "api");
        assert_eq!(rows[0].clients[0].key, "codex");
    }

    fn session(client: &str, tokens: i64, at: &str, kind: &str) -> Session {
        Session {
            client: client.into(),
            total_tokens: tokens,
            last_used_at: at.into(),
            session_kind: kind.into(),
            models: counts(&[("z", 1), ("a", 2), ("zero", 0)]),
            ..Session::default()
        }
    }

    #[test]
    fn sessions_sort_newest_first_and_group_codex_reviews_last() {
        let mut p = Period::default();
        for (k, s) in [
            ("old", session("claude", 10, "2026-09-24T01:00:00.000Z", "")),
            ("new", session("claude", 5, "2026-09-24T03:00:00.000Z", "")),
            (
                "empty",
                session("claude", 0, "2026-09-24T04:00:00.000Z", ""),
            ),
            (
                "r1",
                session("codex", 7, "2026-09-24T02:00:00.000Z", "background-review"),
            ),
            (
                "r2",
                session("codex", 9, "2026-09-24T05:00:00.000Z", "background-review"),
            ),
        ] {
            p.sessions.insert(k.into(), s);
        }
        let items = session_items(&p);
        assert_eq!(items.len(), 3);
        let SessionItem::Session(first) = &items[0] else {
            panic!("expected a session")
        };
        assert_eq!(first.key, "new");
        assert_eq!(first.models, ["a", "z"]);
        assert_eq!(first.session_id, "new", "falls back to the key");
        let SessionItem::Review(group) = &items[2] else {
            panic!("reviews are grouped at the end")
        };
        assert_eq!(group.count, 2);
        assert_eq!(group.total_tokens, 16);
        assert_eq!(group.latest_tokens, 9);
        assert_eq!(group.latest_at, "2026-09-24T05:00:00.000Z");
    }

    #[test]
    fn session_pages_clamp_to_the_last_page() {
        let mut p = Period::default();
        for i in 0..150 {
            p.sessions.insert(
                format!("s{i:03}"),
                session(
                    "claude",
                    1,
                    &format!("2026-09-24T00:{:02}:00.000Z", i % 60),
                    "",
                ),
            );
        }
        let page = session_page(&p, 9);
        assert_eq!(page.total, 150);
        assert_eq!(page.page, 1);
        assert_eq!(page.rows.len(), 50);
        assert_eq!(page.max_tokens, 1);
        assert_eq!(session_page(&Period::default(), 0).rows.len(), 0);
    }
}
