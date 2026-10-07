//! 方案名稱（上游 src/shared/limits/providerHelpers.js `planLabelFromParts`、
//! providers/claude/limits.js `claudePlanLabelFromParts`、providers/codex/limits.js
//! `codexPlanLabelFromParts`）。結果放在 provider 的 `accountLabel`（上游 OAuth 路徑的 `planLabel` 恆為空）。

const DEFAULT_PREFIXES: &[&str] = &["claude", "chatgpt", "openai"];
const UPPER_WORDS: &[&str] = &["ai", "api", "cbp", "gpt", "k12"];

/// 上游 `cleanPlanText`：去掉開頭的產品名（可重複）、`_`/`-` 換空白、小寫。
pub fn clean_plan_text(text: &str, prefixes: &[&str]) -> String {
    let raw = text.trim();
    if raw.is_empty() || raw.contains('@') {
        return String::new();
    }
    let mut clean = raw.to_string();
    'strip: loop {
        let lower = clean.to_lowercase();
        for p in prefixes {
            if let Some(rest) = lower.strip_prefix(p) {
                let sep = rest
                    .chars()
                    .take_while(|c| c.is_whitespace() || *c == '_' || *c == '-')
                    .count();
                if sep > 0 {
                    // 用字元數切原字串（前綴是 ASCII，長度相同）。
                    let cut: usize =
                        p.len() + rest.chars().take(sep).map(char::len_utf8).sum::<usize>();
                    clean = clean[cut..].to_string();
                    continue 'strip;
                }
            }
        }
        break;
    }
    clean
        .replace(['_', '-'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn display_word(word: &str) -> String {
    if UPPER_WORDS.contains(&word.to_lowercase().as_str()) {
        return word.to_uppercase();
    }
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

pub(crate) fn display_plan_text(raw: &str, max_words: Option<usize>) -> String {
    let words: Vec<&str> = raw.split_whitespace().collect();
    let visible = match max_words {
        Some(n) => &words[..words.len().min(n)],
        None => &words[..],
    };
    visible
        .iter()
        .map(|w| display_word(w))
        .collect::<Vec<_>>()
        .join(" ")
}

fn alias(raw: &str) -> Option<&'static str> {
    Some(match raw {
        "free" => "Free",
        "plus" => "Plus",
        "pro" => "Pro",
        "max" => "Max",
        "team" | "teams" => "Team",
        "enterprise" => "Enterprise",
        "ultra" => "Ultra",
        _ => return None,
    })
}

/// 上游 `planLabelFromParts`（單一字串版本）。
pub fn plan_label(text: &str) -> String {
    let raw = clean_plan_text(text, DEFAULT_PREFIXES);
    if raw.is_empty() {
        return String::new();
    }
    alias(&raw)
        .map(str::to_string)
        .unwrap_or_else(|| display_plan_text(&raw, Some(3)))
}

/// 上游 providers/antigravity/limits.js `antigravityPlanLabelFromParts`：先去掉開頭的 `Google` / `AI`
/// （`Google AI Pro` → `Pro`），再走通用規則。
pub fn antigravity_plan_label(text: &str) -> String {
    let raw = clean_plan_text(text, &["google", "ai"]);
    if raw.is_empty() {
        return String::new();
    }
    plan_label(&raw)
}

fn claude_tier_label(tier: &str) -> String {
    let raw = clean_plan_text(tier, &[]);
    let words: Vec<&str> = raw
        .split_whitespace()
        .filter(|w| !matches!(*w, "default" | "claude" | "ai" | "raven"))
        .collect();
    if words.is_empty() {
        return String::new();
    }
    plan_label(&words.join(" "))
}

/// Claude：`subscriptionType` 為 Max 時，`rateLimitTier` 的 `Max 5x` / `Max 20x` 更精確。
pub fn claude_plan_label(subscription_type: &str, rate_limit_tier: &str) -> String {
    let sub = plan_label(subscription_type);
    let tier = claude_tier_label(rate_limit_tier);
    // 上游 `/^Max\s+(?:5x|20x)$/i`；tier 已經整理成單一空白分隔。
    let is_max_multiple = matches!(tier.to_lowercase().as_str(), "max 5x" | "max 20x");
    if sub == "Max" && is_max_multiple {
        return tier;
    }
    if sub.is_empty() {
        tier
    } else {
        sub
    }
}

/// Codex：`pro` 是 Pro 20x、`prolite` 是 Pro 5x；其餘照通用規則，字數不設上限。
pub fn codex_plan_label(plan_type: &str) -> String {
    let text = plan_type.trim();
    if text.is_empty() || text.contains('@') {
        return String::new();
    }
    let exact = |s: &str| -> Option<&'static str> {
        Some(match s {
            "pro" => "Pro 20x",
            "prolite" | "pro_lite" | "pro-lite" | "pro lite" => "Pro 5x",
            _ => return None,
        })
    };
    if let Some(v) = exact(&text.to_lowercase()) {
        return v.to_string();
    }
    let cleaned = clean_plan_text(text, &["codex", "chatgpt", "openai"]);
    if cleaned.is_empty() {
        return String::new();
    }
    if let Some(v) = exact(&cleaned) {
        return v.to_string();
    }
    let aliased = match cleaned.as_str() {
        "free" => Some("Free"),
        "plus" => Some("Plus"),
        "max" => Some("Max"),
        "team" | "teams" => Some("Team"),
        "enterprise" | "enterprise cbp usage based" => Some("Enterprise"),
        "self serve business usage based" => Some("Business"),
        _ => None,
    };
    aliased
        .map(str::to_string)
        .unwrap_or_else(|| display_plan_text(&cleaned, None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_table_matches_upstream() {
        // 上游 node 執行過的對照表（tests/shared/limitPlanLabels.test.js）。
        for (sub, tier, want) in [
            ("max", "default_claude_max_20x", "Max 20x"),
            ("max", "default_claude_max_5x", "Max 5x"),
            ("max", "", "Max"),
            ("max", "default_claude_max_10x", "Max"),
            ("pro", "default_claude_ai", "Pro"),
            ("team", "default_claude_max_5x", "Team"),
            ("enterprise", "default_raven", "Enterprise"),
            ("free", "", "Free"),
            ("", "default_claude_max_5x", "Max 5x"),
            ("", "default_claude_ai", ""),
            ("", "default_raven", ""),
            ("claude_pro", "", "Pro"),
            ("teams", "", "Team"),
            ("pro_api", "", "Pro API"),
            (
                "business_plan_something_long",
                "",
                "Business Plan Something",
            ),
            ("", "default_claude_pro", "Pro"),
            ("max", "claude_max_20x", "Max 20x"),
        ] {
            assert_eq!(claude_plan_label(sub, tier), want, "{sub:?} {tier:?}");
        }
    }

    #[test]
    fn antigravity_table_matches_upstream() {
        // node 以上游 `antigravityPlanLabelFromParts` 的原文跑出來的結果。
        for (input, want) in [
            ("Google AI Pro", "Pro"),
            ("Google AI Ultra", "Ultra"),
            ("google_ai_pro", "Pro"),
            ("AI Premium", "Premium"),
            ("Antigravity Starter Quota", "Antigravity Starter Quota"),
            ("Free", "Free"),
            ("g1-pro-tier", "G1 Pro Tier"),
            ("Google", "Google"),
            ("user@example.com", ""),
            ("Google AI Pro (Trial)", "Pro (trial)"),
            ("  ai-ultra  ", "Ultra"),
            ("Google One AI Premium plan tier", "One AI Premium"),
        ] {
            assert_eq!(antigravity_plan_label(input), want, "{input:?}");
        }
    }

    #[test]
    fn codex_table_matches_upstream() {
        for (input, want) in [
            ("plus", "Plus"),
            ("PLUS", "Plus"),
            ("ChatGPT Plus", "Plus"),
            ("pro", "Pro 20x"),
            (" Pro ", "Pro 20x"),
            ("prolite", "Pro 5x"),
            ("pro_lite", "Pro 5x"),
            ("team", "Team"),
            ("business", "Business"),
            ("enterprise", "Enterprise"),
            ("edu", "Edu"),
            ("education", "Education"),
            ("free", "Free"),
            ("free_workspace", "Free Workspace"),
            ("go", "Go"),
            ("guest", "Guest"),
            ("k12", "K12"),
            ("enterprise_cbp_usage_based", "Enterprise"),
            ("self_serve_business_usage_based", "Business"),
            ("quorum", "Quorum"),
            ("a@b.com", ""),
        ] {
            assert_eq!(codex_plan_label(input), want, "{input:?}");
        }
    }
}
