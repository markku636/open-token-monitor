//! 由 session 彙總出每個專案（資料夾）的用量（上游 usage.js `projectRollupFromSessions`、
//! src/shared/projectKey.js）。上游 agent 的 transformUsage 在 projects 開啟時對三個期間都做。

use indexmap::IndexMap;
use unicode_normalization::UnicodeNormalization;

use super::client_name::normalize_client_name;
use crate::wire::period::add_count;
use crate::wire::{Period, Project};

fn nfc(s: &str) -> String {
    s.nfc().collect()
}

/// `canonicalProjectKey`：trim + NFC + 小寫 + NFC。
pub fn canonical_project_key(value: &str) -> String {
    let label = nfc(value.trim());
    if label.is_empty() {
        String::new()
    } else {
        nfc(&label.to_lowercase())
    }
}

/// `deterministicProjectLabel`：兩個 label 取字典序較小者，讓結果與合併順序無關。
pub fn deterministic_label(left: &str, right: &str) -> String {
    let a = nfc(left.trim());
    let b = nfc(right.trim());
    if a.is_empty() {
        return b;
    }
    if b.is_empty() {
        return a;
    }
    if a < b {
        a
    } else {
        b
    }
}

pub fn rollup_from_sessions(period: &Period) -> IndexMap<String, Project> {
    let mut projects: IndexMap<String, Project> = IndexMap::new();
    for session in period.sessions.values() {
        let label = nfc(session.project_label.trim());
        let key = canonical_project_key(&label);
        if key.is_empty() {
            continue;
        }
        let project = projects.entry(key).or_insert_with(|| Project {
            label: label.clone(),
            ..Project::default()
        });
        project.label = deterministic_label(&project.label, &label);
        let tokens = session.total_tokens.max(0);
        project.tokens += tokens;
        project.cost_usd += session.cost_usd;
        if let Some(client) = normalize_client_name(&session.client) {
            if tokens > 0 {
                add_count(&mut project.clients, &client, tokens);
            }
        }
    }
    projects
}

pub fn apply_project_rollups(period: &mut Period) {
    period.projects = rollup_from_sessions(period);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::Session;

    #[test]
    fn rolls_up_case_insensitively_with_stable_label() {
        let mut p = Period::default();
        for (id, label, tokens) in [("a", "Repo", 10), ("b", "repo", 5), ("c", "", 7)] {
            p.sessions.insert(
                format!("claude:{id}"),
                Session {
                    client: "claude".into(),
                    session_id: id.into(),
                    total_tokens: tokens,
                    cost_usd: 0.5,
                    project_label: label.into(),
                    ..Session::default()
                },
            );
        }
        apply_project_rollups(&mut p);
        assert_eq!(p.projects.len(), 1);
        let project = &p.projects["repo"];
        assert_eq!(project.label, "Repo");
        assert_eq!(project.tokens, 15);
        assert_eq!(project.clients["claude"], 15);
        assert!((project.cost_usd - 1.0).abs() < 1e-9);
    }
}
