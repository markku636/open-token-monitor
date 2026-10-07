//! Windows 系統 proxy 設定的字串格式。上游 Electron 交給 Chromium，規則照它的
//! `ProxyConfig::ProxyRules::ParseFromString` 與 `ProxyBypassRules`（WinINet 格式）。
//!
//! 手動 proxy（Internet Settings 的 `ProxyServer`，[`pick_proxy`]）：
//! - `host:port`：所有 scheme 用同一個；`;` 後面的其他項目忽略（第一段就是要用的）。
//! - `http=host:port;https=host:port`：依 scheme，沒列到的 scheme 直連；第一段是依 scheme 的，後面
//!   沒有 `=` 的段落忽略。同一格裡 `,` 分隔的多個 proxy 只用第一個（reqwest 不做容錯切換）。
//! - 項目可以帶 `http://` / `https://`（TLS 連到 proxy）；`socks=` 與 `socks://` reqwest 沒編進來，略過。
//!
//! PAC / WPAD 的結果（[`pick_pac_proxy`]）：`;` 是依序嘗試的清單，不支援的項目跳過；PAC 原本的
//! `PROXY host:port` / `DIRECT` 寫法也接受（WinHTTP 通常已轉成 `host:port`）。
//!
//! 排除清單（`ProxyOverride`）：`;`、`,` 或空白分隔。`<local>` 是不含 `.` 的主機名；`<-loopback>` 取消
//! 隱含的 loopback 直連；其他是 `[scheme://]主機樣式[:port]`，樣式可用 `*` / `?`，開頭的 `.` 等於 `*.`，
//! 不分大小寫，不帶 `*` 時只比對主機本身。不支援 CIDR。

// 只有 Windows 的系統 proxy 用得到；其他平台只編不用。
#![cfg_attr(not(windows), allow(dead_code))]

use std::net::{Ipv4Addr, Ipv6Addr};

use url::{Host, Url};

/// 這個 scheme 要走的 proxy；`None` = 直連。
pub fn pick_proxy(list: &str, scheme: &str) -> Option<Url> {
    let mut per_scheme = false;
    for segment in list.split(';').map(str::trim).filter(|s| !s.is_empty()) {
        match segment.split_once('=') {
            None => {
                if per_scheme {
                    continue;
                }
                return first_proxy(segment);
            }
            Some((name, proxies)) => {
                per_scheme = true;
                if name.trim().eq_ignore_ascii_case(scheme) {
                    return first_proxy(proxies);
                }
            }
        }
    }
    None
}

/// PAC / WPAD 的結果（`WINHTTP_PROXY_INFO.lpszProxy`）：`;` 是依序嘗試的清單，不是設定的分段，所以
/// 跳過不支援的項目往下找；遇到 `DIRECT` 就直連。帶 `=` 的寫法照 [`pick_proxy`]。
pub fn pick_pac_proxy(list: &str, scheme: &str) -> Option<Url> {
    if list.contains('=') {
        return pick_proxy(list, scheme);
    }
    first_proxy(&list.replace(';', ","))
}

/// `,` 或空白分隔的 proxy 清單裡第一個能用的；先遇到 `DIRECT` 就是直連。
fn first_proxy(list: &str) -> Option<Url> {
    for token in list.split(',').map(str::trim).filter(|t| !t.is_empty()) {
        // `PROXY host:port` 是一項；其他以空白分開的是多項。
        let entries: Vec<&str> = if starts_with_keyword(token) {
            vec![token]
        } else {
            token.split_whitespace().collect()
        };
        for entry in entries {
            match proxy_entry(entry) {
                Entry::Direct => return None,
                Entry::Proxy(url) => return Some(url),
                Entry::Unsupported => {
                    tracing::debug!(entry, "skipping an unsupported proxy entry");
                }
            }
        }
    }
    None
}

const PAC_KEYWORDS: &[&str] = &["PROXY", "HTTP", "HTTPS", "SOCKS", "SOCKS4", "SOCKS5"];

fn starts_with_keyword(token: &str) -> bool {
    token
        .split_once(char::is_whitespace)
        .is_some_and(|(kw, _)| PAC_KEYWORDS.iter().any(|k| kw.eq_ignore_ascii_case(k)))
}

enum Entry {
    Direct,
    Proxy(Url),
    Unsupported,
}

fn proxy_entry(token: &str) -> Entry {
    let token = token.trim();
    if token.eq_ignore_ascii_case("DIRECT") || token.eq_ignore_ascii_case("direct://") {
        return Entry::Direct;
    }
    let (scheme, rest) = if let Some((kw, addr)) = token.split_once(char::is_whitespace) {
        let scheme = match kw.to_ascii_uppercase().as_str() {
            "PROXY" | "HTTP" => "http",
            "HTTPS" => "https",
            _ => return Entry::Unsupported,
        };
        (scheme.to_string(), addr.trim())
    } else if let Some((s, addr)) = token.split_once("://") {
        (s.to_ascii_lowercase(), addr)
    } else {
        ("http".to_string(), token)
    };
    if !matches!(scheme.as_str(), "http" | "https") {
        return Entry::Unsupported;
    }
    match Url::parse(&format!("{scheme}://{rest}")) {
        Ok(url) if url.host_str().is_some_and(|h| !h.is_empty()) => Entry::Proxy(url),
        _ => Entry::Unsupported,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Pattern {
    scheme: Option<String>,
    /// 小寫的主機樣式（`*` / `?`）。
    host: String,
    port: Option<u16>,
}

/// `ProxyOverride` / PAC 結果的排除清單。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BypassRules {
    patterns: Vec<Pattern>,
    local: bool,
    implicit_loopback: bool,
}

impl Default for BypassRules {
    fn default() -> Self {
        BypassRules {
            patterns: Vec::new(),
            local: false,
            implicit_loopback: true,
        }
    }
}

impl BypassRules {
    pub fn parse(list: &str) -> BypassRules {
        let mut rules = BypassRules::default();
        for raw in list
            .split(|c: char| c == ';' || c == ',' || c.is_whitespace())
            .filter(|s| !s.is_empty())
        {
            if raw.eq_ignore_ascii_case("<local>") {
                rules.local = true;
                continue;
            }
            if raw.eq_ignore_ascii_case("<-loopback>") {
                rules.implicit_loopback = false;
                continue;
            }
            if let Some(p) = parse_pattern(raw) {
                rules.patterns.push(p);
            }
        }
        rules
    }

    /// loopback / link-local 是否一律直連（Chromium 的隱含規則，`<-loopback>` 關掉）。
    pub fn implicit_loopback(&self) -> bool {
        self.implicit_loopback
    }

    /// 明確的排除規則（不含隱含的 loopback）。
    pub fn matches(&self, url: &Url) -> bool {
        let Some(host) = url.host_str() else {
            return false;
        };
        let host = host.to_ascii_lowercase();
        if self.local && !host.contains('.') && !host.contains(':') {
            return true;
        }
        let port = url.port_or_known_default();
        self.patterns.iter().any(|p| {
            p.scheme.as_deref().is_none_or(|s| s == url.scheme())
                && p.port.is_none_or(|want| Some(want) == port)
                && glob_match(&p.host, &host)
        })
    }
}

fn parse_pattern(raw: &str) -> Option<Pattern> {
    let (scheme, rest) = match raw.split_once("://") {
        Some((s, r)) => (Some(s.to_ascii_lowercase()), r),
        None => (None, raw),
    };
    let rest = rest.trim_end_matches('/');
    if rest.is_empty() || rest.contains('/') {
        // CIDR 或帶路徑的寫法不支援。
        return None;
    }
    let (host, port) = split_host_port(rest);
    let host = if host.starts_with('.') {
        format!("*{host}")
    } else {
        host.to_string()
    };
    Some(Pattern {
        scheme,
        host: host.to_ascii_lowercase(),
        port,
    })
}

/// `[v6]:port`、`host:port`、`host`；冒號後不是數字時整串都是主機樣式。
fn split_host_port(s: &str) -> (&str, Option<u16>) {
    if s.starts_with('[') {
        if let Some(end) = s.find(']') {
            let port = s[end + 1..].strip_prefix(':').and_then(|p| p.parse().ok());
            return (&s[..=end], port);
        }
        return (s, None);
    }
    match s.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') => match p.parse::<u16>() {
            Ok(port) => (h, Some(port)),
            Err(_) => (s, None),
        },
        _ => (s, None),
    }
}

/// `*` 任意長度、`?` 一個字元（Chromium `base::MatchPattern`）。
fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some((pi, ti));
            pi += 1;
        } else if let Some((sp, st)) = star {
            pi = sp + 1;
            ti = st + 1;
            star = Some((sp, st + 1));
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == '*')
}

/// Chromium 的隱含直連：localhost、`*.localhost`、127.0.0.0/8、::1、169.254.0.0/16、fe80::/10。
pub fn is_implicit_bypass(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            d == "localhost" || d.ends_with(".localhost")
        }
        Some(Host::Ipv4(ip)) => loopback_v4(ip),
        Some(Host::Ipv6(ip)) => loopback_v6(ip),
        None => false,
    }
}

fn loopback_v4(ip: Ipv4Addr) -> bool {
    ip.is_loopback() || ip.is_link_local()
}

fn loopback_v6(ip: Ipv6Addr) -> bool {
    ip.is_loopback()
        || (ip.segments()[0] & 0xffc0) == 0xfe80
        || ip.to_ipv4_mapped().is_some_and(loopback_v4)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn pick(list: &str, scheme: &str) -> Option<String> {
        pick_proxy(list, scheme).map(|u| u.to_string())
    }

    #[test]
    fn single_proxy_applies_to_every_scheme() {
        assert_eq!(
            pick("proxy:8080", "https").as_deref(),
            Some("http://proxy:8080/")
        );
        assert_eq!(
            pick(" proxy:8080 ", "http").as_deref(),
            Some("http://proxy:8080/")
        );
        assert_eq!(pick("proxy", "http").as_deref(), Some("http://proxy/"));
        // 第一項沒有 `=`：整串是單一清單，後面的依 scheme 設定忽略。
        assert_eq!(
            pick("a:80;https=b:443", "https").as_deref(),
            Some("http://a/")
        );
        // PAC 常見的多個 proxy：用第一個。
        assert_eq!(
            pick("a:3128;b:3128", "https").as_deref(),
            Some("http://a:3128/")
        );
        assert_eq!(
            pick("a:3128,b:3128", "https").as_deref(),
            Some("http://a:3128/")
        );
    }

    #[test]
    fn per_scheme_lists_pick_the_matching_scheme() {
        let list = "http=web:80;https=secure:8443;ftp=f:21";
        assert_eq!(pick(list, "http").as_deref(), Some("http://web/"));
        assert_eq!(pick(list, "https").as_deref(), Some("http://secure:8443/"));
        assert_eq!(
            pick("HTTPS=secure:8443", "https").as_deref(),
            Some("http://secure:8443/")
        );
        // 沒列到的 scheme 直連；依 scheme 之後的裸項目忽略。
        assert_eq!(pick("https=secure:8443", "http"), None);
        assert_eq!(pick("https=secure:8443;other:1", "http"), None);
        // socks 不支援：略過。
        assert_eq!(pick("socks=s:1080", "https"), None);
        assert_eq!(
            pick("http=web:80;socks=s:1080", "http").as_deref(),
            Some("http://web/")
        );
    }

    #[test]
    fn explicit_schemes_and_pac_keywords() {
        assert_eq!(
            pick("https://tls-proxy:443", "https").as_deref(),
            Some("https://tls-proxy/")
        );
        assert_eq!(
            pick("http://p:3128", "https").as_deref(),
            Some("http://p:3128/")
        );
        assert_eq!(pick("socks5://s:1080", "https"), None);
        assert_eq!(
            pick("socks5://s:1080,http://p:1", "https").as_deref(),
            Some("http://p:1/")
        );
        assert_eq!(
            pick("a:3128 b:3128", "https").as_deref(),
            Some("http://a:3128/")
        );
        assert_eq!(pick("", "https"), None);
        assert_eq!(pick(";;", "https"), None);
    }

    #[test]
    fn pac_results_are_ordered_fallback_lists() {
        let pac = |list: &str, scheme: &str| pick_pac_proxy(list, scheme).map(|u| u.to_string());
        assert_eq!(
            pac("a:3128;b:3128", "https").as_deref(),
            Some("http://a:3128/")
        );
        assert_eq!(
            pac("PROXY a:80; DIRECT", "https").as_deref(),
            Some("http://a/")
        );
        assert_eq!(pac("DIRECT; PROXY a:80", "https"), None);
        assert_eq!(pac("DIRECT", "https"), None);
        // 不支援的項目跳過，往下一個找（設定字串則是只看第一段）。
        assert_eq!(
            pac("SOCKS5 s:1080; PROXY b:81", "https").as_deref(),
            Some("http://b:81/")
        );
        assert_eq!(pick("socks5://s:1080;b:81", "https"), None);
        assert_eq!(
            pac("socks5://s:1080;b:81", "https").as_deref(),
            Some("http://b:81/")
        );
        assert_eq!(pac("HTTPS s:443", "https").as_deref(), Some("https://s/"));
        assert_eq!(
            pac("http=web:80;https=secure:443", "https").as_deref(),
            Some("http://secure:443/")
        );
        assert_eq!(pac("", "https"), None);
    }

    #[test]
    fn bypass_list_patterns() {
        let rules = BypassRules::parse(
            "<local>;*.corp.example; .intra.example, 10.* 172.16.1.?;http://plain.example;host.example:8443;[::1];EXACT.example",
        );
        assert!(rules.matches(&u("https://intranet/")));
        assert!(!rules.matches(&u("https://intranet.local/")));
        assert!(rules.matches(&u("https://a.corp.example/")));
        assert!(rules.matches(&u("https://b.a.corp.example/")));
        assert!(!rules.matches(&u("https://corp.example/")));
        assert!(rules.matches(&u("https://x.intra.example/")));
        assert!(rules.matches(&u("http://10.1.2.3/")));
        assert!(rules.matches(&u("http://172.16.1.7/")));
        assert!(!rules.matches(&u("http://172.16.1.17/")));
        assert!(rules.matches(&u("http://plain.example/")));
        assert!(!rules.matches(&u("https://plain.example/")));
        assert!(rules.matches(&u("https://host.example:8443/")));
        assert!(!rules.matches(&u("https://host.example/")));
        assert!(rules.matches(&u("http://[::1]:8080/")));
        assert!(rules.matches(&u("https://exact.example/")));
        assert!(!rules.matches(&u("https://sub.exact.example/")));
        assert!(rules.implicit_loopback());

        assert!(BypassRules::parse("*").matches(&u("https://anything.example/")));
        assert!(!BypassRules::parse("").matches(&u("https://intranet/")));
        assert!(!BypassRules::parse("<-loopback>").implicit_loopback());
    }

    #[test]
    fn implicit_bypass_covers_loopback_and_link_local() {
        for yes in [
            "http://localhost:1420/",
            "http://LOCALHOST./",
            "http://app.localhost/",
            "http://127.0.0.1/",
            "http://127.9.9.9/",
            "http://[::1]:80/",
            "http://169.254.1.1/",
            "http://[fe80::1]/",
            "http://[::ffff:127.0.0.1]/",
        ] {
            assert!(is_implicit_bypass(&u(yes)), "{yes}");
        }
        for no in [
            "https://example.com/",
            "http://10.0.0.1/",
            "http://localhost.example.com/",
        ] {
            assert!(!is_implicit_bypass(&u(no)), "{no}");
        }
    }

    #[test]
    fn glob_matching() {
        assert!(glob_match("*", ""));
        assert!(glob_match("a*c", "abbbc"));
        assert!(glob_match("*.b", "a.b"));
        assert!(!glob_match("*.b", "ab"));
        assert!(glob_match("a?c", "abc"));
        assert!(!glob_match("a?c", "ac"));
        assert!(glob_match("*a*", "banana"));
    }
}
