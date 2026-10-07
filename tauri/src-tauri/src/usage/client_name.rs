//! Client 與 model 名稱正規化。client id 是 hub 上的分區鍵：同一個工具在不同
//! tokscale 版本或拼法下必須收斂到同一個 id（上游 AGENTS.md「Client ids are partition keys」）。

use super::keys::{DISJOINT_REASONING_CLIENTS, REASONIX_CLIENT};

/// tokscale 的 raw id → Token Monitor id（history.js `TOKSCALE_CLIENT_ALIASES`）。
const TOKSCALE_CLIENT_ALIASES: &[(&str, &str)] = &[
    ("antigravity-cli", "antigravity"),
    ("micode", "mimo"),
    ("micode-desktop", "mimo"),
    ("omp", "pi"),
    ("kilocode", "kilo"),
    ("devin-cli", "devin"),
    ("devin-desktop", "devin"),
];

/// Token Monitor id → 實際傳給 `tokscale --client` 的 id（tokscaleClientMapping.js）。
/// `mimo` / `devin` 是傘狀 id，tokscale 本身不認得，只能傳子 id。
pub fn tokscale_scan_ids(client: &str) -> Vec<&str> {
    match client {
        "antigravity" => vec!["antigravity", "antigravity-cli"],
        "mimo" => vec!["micode", "micode-desktop"],
        "pi" => vec!["pi", "omp"],
        "kilo" => vec!["kilo", "kilocode"],
        "devin" => vec!["devin-cli", "devin-desktop"],
        other => vec![other],
    }
}

fn normalize_tokscale_client_name(value: &str) -> Option<String> {
    let raw = value.trim().to_lowercase();
    if raw.is_empty() {
        return None;
    }
    Some(
        TOKSCALE_CLIENT_ALIASES
            .iter()
            .find(|(from, _)| *from == raw)
            .map(|(_, to)| (*to).to_string())
            .unwrap_or(raw),
    )
}

fn is_ws_sep(c: char) -> bool {
    c.is_whitespace() || c == '_' || c == '-'
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `/\bpi\b/`
fn has_word(raw: &str, word: &str) -> bool {
    raw.match_indices(word).any(|(i, _)| {
        let before_ok = raw[..i]
            .chars()
            .next_back()
            .map(|c| !is_word(c))
            .unwrap_or(true);
        let after_ok = raw[i + word.len()..]
            .chars()
            .next()
            .map(|c| !is_word(c))
            .unwrap_or(true);
        before_ok && after_ok
    })
}

/// `/a[\s_-]*b/`：在任意位置出現 a、可選的分隔、再接 b。
fn has_pair(raw: &str, a: &str, b: &str) -> bool {
    raw.match_indices(a).any(|(i, _)| {
        raw[i + a.len()..]
            .trim_start_matches(is_ws_sep)
            .starts_with(b)
    })
}

/// `/^a[\s_-]*b$/`
fn is_pair(raw: &str, a: &str, b: &str) -> bool {
    raw.strip_prefix(a)
        .map(|rest| rest.trim_start_matches(is_ws_sep) == b)
        .unwrap_or(false)
}

/// `/^unsloth(?:[\s_-]+(?:studio|api))?$/`
fn is_unsloth(raw: &str) -> bool {
    match raw.strip_prefix("unsloth") {
        Some("") => true,
        Some(rest) => {
            let trimmed = rest.trim_start_matches(is_ws_sep);
            trimmed.len() < rest.len() && (trimmed == "studio" || trimmed == "api")
        }
        None => false,
    }
}

/// 上游 `normalizeClientName`（usage.js）。判斷順序有意義，照抄。
pub fn normalize_client_name(value: &str) -> Option<String> {
    let raw = normalize_tokscale_client_name(value)?;
    let r = raw.as_str();
    let id = if r.contains("claude") {
        "claude"
    } else if r.contains("codex") {
        "codex"
    } else if r.contains("hermes") {
        "hermes"
    } else if r.contains("gemini") {
        "gemini"
    } else if r.contains("cursor") {
        "cursor"
    } else if r.contains("antigravity") {
        "antigravity"
    } else if r == "amp" {
        "amp"
    } else if r.contains("kimi") {
        "kimi"
    } else if r.contains("qwen") {
        "qwen"
    } else if r.contains("grok") {
        "grok"
    } else if r == "droid" {
        "droid"
    } else if r.contains("copilot") {
        "copilot"
    } else if has_word(r, "pi") {
        "pi"
    } else if r.contains("zed") {
        "zed"
    } else if is_pair(r, "kilo", "code") {
        "kilo"
    } else if has_pair(r, "command", "code") {
        "commandcode"
    } else if r.contains("micode") || r.contains("mimo") {
        "mimo"
    } else if r.contains("zcode") {
        "zcode"
    } else if r.contains("kiro") {
        "kiro"
    } else if r.contains("codebuddy") {
        "codebuddy"
    } else if r.contains("workbuddy") {
        "workbuddy"
    } else if r.contains("proma") {
        "proma"
    } else if r.contains("qodercn") || r == "qoder-cn" || r == "qoder cn" {
        "qodercn"
    } else if r.contains("reasonix") {
        "reasonix"
    } else if has_pair(r, "cherry", "studio") {
        "cherrystudio"
    } else if has_pair(r, "lm", "studio") {
        "lmstudio"
    } else if is_unsloth(r) {
        "unsloth"
    } else if r.contains("dsh") {
        "dsh"
    } else if r.contains("devin") {
        "devin"
    } else if r.contains("opencode") {
        "opencode"
    } else if r.contains("openclaw")
        || r.contains("clawd")
        || r.contains("moltbot")
        || r.contains("moldbot")
    {
        "openclaw"
    } else {
        return slug(r);
    };
    Some(id.to_string())
}

/// `raw.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || null`
fn slug(raw: &str) -> Option<String> {
    let mut out = String::with_capacity(raw.len());
    let mut in_run = false;
    for c in raw.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-' {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    let trimmed = out.trim_matches('-');
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub fn has_disjoint_reasoning(client: Option<&str>) -> bool {
    client
        .map(|c| DISJOINT_REASONING_CLIENTS.contains(&c.trim().to_lowercase().as_str()))
        .unwrap_or(false)
}

/// `normalizeModelName`：trim + 小寫；空字串視為沒有 model。
pub fn normalize_model_name(value: &str) -> Option<String> {
    let raw = value.trim().to_lowercase();
    (!raw.is_empty()).then_some(raw)
}

/// `normalizeModelNameForClient`：Reasonix 的 model 帶 `deepseek/` 前綴時去掉。
pub fn normalize_model_name_for_client(value: &str, client: Option<&str>) -> Option<String> {
    let normalized = normalize_model_name(value)?;
    let is_reasonix = client.and_then(normalize_client_name).as_deref() == Some(REASONIX_CLIENT);
    if !is_reasonix {
        return Some(normalized);
    }
    for prefix in ["deepseek/", "deepseek-flash/"] {
        if let Some(rest) = normalized.strip_prefix(prefix) {
            if !rest.is_empty() {
                return Some(rest.to_string());
            }
        }
    }
    Some(normalized)
}

/// `normalizeProviderName`：小寫、非 `[a-z0-9_-]` 的連續字元換成 `-`（不修剪頭尾）。
pub fn normalize_provider_name(value: &str) -> Option<String> {
    let raw = value.trim().to_lowercase();
    let mut out = String::with_capacity(raw.len());
    let mut in_run = false;
    for c in raw.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-' {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    (!out.is_empty()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(v: &str) -> Option<String> {
        normalize_client_name(v)
    }

    #[test]
    fn matches_upstream_normalization() {
        assert_eq!(n("Claude Code").as_deref(), Some("claude"));
        assert_eq!(n("codex-cli").as_deref(), Some("codex"));
        assert_eq!(n("micode-desktop").as_deref(), Some("mimo"));
        assert_eq!(n("antigravity-cli").as_deref(), Some("antigravity"));
        assert_eq!(n("omp").as_deref(), Some("pi"));
        assert_eq!(n("pi").as_deref(), Some("pi"));
        assert_eq!(n("spinner").as_deref(), Some("spinner"));
        assert_eq!(n("Kilo Code").as_deref(), Some("kilo"));
        assert_eq!(n("kilocode").as_deref(), Some("kilo"));
        assert_eq!(n("command-code").as_deref(), Some("commandcode"));
        assert_eq!(n("Cherry Studio").as_deref(), Some("cherrystudio"));
        assert_eq!(n("unsloth studio").as_deref(), Some("unsloth"));
        assert_eq!(n("unslothx").as_deref(), Some("unslothx"));
        assert_eq!(n("devin-cli").as_deref(), Some("devin"));
        assert_eq!(n("GitHub Copilot").as_deref(), Some("copilot"));
        assert_eq!(n("Weird Tool!").as_deref(), Some("weird-tool"));
        assert_eq!(n("  "), None);
        assert_eq!(n("!!!"), None);
    }

    #[test]
    fn every_tracked_id_is_a_fixed_point() {
        // 上游 tripwire：每個 tracked-client id 都必須是 normalize 的不動點。
        for id in crate::settings::SUPPORTED_CLIENTS {
            assert_eq!(n(id).as_deref(), Some(*id), "{id}");
        }
    }

    #[test]
    fn scan_ids_filter_back_to_parent() {
        for id in crate::settings::SUPPORTED_CLIENTS {
            for scan in tokscale_scan_ids(id) {
                assert_eq!(n(scan).as_deref(), Some(*id), "{scan} -> {id}");
            }
        }
    }

    #[test]
    fn model_names() {
        assert_eq!(
            normalize_model_name_for_client(" GPT-5 ", Some("codex")).as_deref(),
            Some("gpt-5")
        );
        assert_eq!(
            normalize_model_name_for_client("deepseek/deepseek-v4", Some("reasonix")).as_deref(),
            Some("deepseek-v4")
        );
        assert_eq!(
            normalize_provider_name("Open AI").as_deref(),
            Some("open-ai")
        );
    }
}
