//! proxy 環境變數（上游 src/shared/outboundFetch.js 的 `resolveProxyConfig`，以及它交給 undici
//! `EnvHttpProxyAgent` 的路由規則，undici 7.x lib/dispatcher/env-http-proxy-agent.js）。
//!
//! - 小寫優先於大寫（`http_proxy` > `HTTP_PROXY`），`ALL_PROXY` 是 http 的最後退路，https 沒設時用 http 的。
//! - 值去掉前後空白與成對的引號；空字串等於沒設。
//! - `NO_PROXY`：逗號或空白分隔；`host:port` 只排除那個 port；開頭的 `.` 或 `*.` 去掉後比對主機本身與
//!   子網域；整串恰好是 `*` 才是全部直連。不支援 CIDR（undici 也不支援）。
//! - proxy 網址必須是 `http://` 或 `https://`（undici `ProxyAgent` 的要求）；設了卻不合法時**不退回直連**，
//!   所有請求都失敗（上游：設定錯誤不能悄悄繞過 proxy）。`proxy.corp:8080` 這種沒寫 scheme 的值也算不合法。

use url::Url;

use super::{Decision, Route, Source};

/// 上游 `cleanProxyUrl`。
pub fn clean_proxy_url(value: Option<&str>) -> String {
    let raw = value.unwrap_or("").trim();
    if raw.is_empty() {
        return String::new();
    }
    let quoted = (raw.starts_with('"') && raw.ends_with('"'))
        || (raw.starts_with('\'') && raw.ends_with('\''));
    if quoted {
        // 只有一個引號字元時 JS 的 slice(1, -1) 是空字串。
        return if raw.len() >= 2 {
            raw[1..raw.len() - 1].trim().to_string()
        } else {
            String::new()
        };
    }
    raw.to_string()
}

/// 上游 `resolveProxyConfig` 的結果；空字串 = 沒設。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EnvConfig {
    pub http_proxy: String,
    pub https_proxy: String,
    pub no_proxy: String,
}

impl EnvConfig {
    /// `lookup` 讀一個環境變數（測試注入，正式是 `std::env::var`）。
    pub fn resolve(lookup: impl Fn(&str) -> Option<String>) -> EnvConfig {
        let value = |lower: &str, upper: &str| {
            let v = clean_proxy_url(lookup(lower).as_deref());
            if v.is_empty() {
                clean_proxy_url(lookup(upper).as_deref())
            } else {
                v
            }
        };
        let all = value("all_proxy", "ALL_PROXY");
        let mut http_proxy = value("http_proxy", "HTTP_PROXY");
        if http_proxy.is_empty() {
            http_proxy = all;
        }
        let mut https_proxy = value("https_proxy", "HTTPS_PROXY");
        if https_proxy.is_empty() {
            https_proxy = http_proxy.clone();
        }
        EnvConfig {
            http_proxy,
            https_proxy,
            no_proxy: value("no_proxy", "NO_PROXY"),
        }
    }

    pub fn from_process() -> EnvConfig {
        EnvConfig::resolve(|name| std::env::var(name).ok())
    }

    /// 上游 `createOutboundFetch`：兩個都沒設才走預設（這裡是系統設定或直連）。
    pub fn is_active(&self) -> bool {
        !self.http_proxy.is_empty() || !self.https_proxy.is_empty()
    }
}

/// 解析一個 proxy 網址；只收 http / https（undici `ProxyAgent`）。
pub fn parse_proxy_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|e| format!("not a valid URL ({e})"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("the URL must start with http:// or https://".into());
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("the URL has no host".into());
    }
    Ok(url)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NoProxyEntry {
    hostname: String,
    /// 0 = 任何 port；超過 65535 的值永遠比不到（JS 的 parseInt 不設上限）。
    port: u32,
}

/// undici `#parseNoProxy` / `#shouldProxy`。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NoProxy {
    value: String,
    entries: Vec<NoProxyEntry>,
}

impl NoProxy {
    pub fn parse(value: &str) -> NoProxy {
        let entries = value
            .split(|c: char| c == ',' || c.is_whitespace())
            .filter(|e| !e.is_empty())
            .map(|entry| {
                // `^(.+):(\d+)$`：最後一個冒號後面全是數字才算 port。
                let (host, port) = match entry.rsplit_once(':') {
                    Some((h, p))
                        if !h.is_empty()
                            && !p.is_empty()
                            && p.bytes().all(|b| b.is_ascii_digit()) =>
                    {
                        (h, p.parse::<u32>().unwrap_or(u32::MAX))
                    }
                    _ => (entry, 0),
                };
                // `^\*?\.`：去掉開頭的 `.` 或 `*.`。
                let host = host
                    .strip_prefix("*.")
                    .or_else(|| host.strip_prefix('.'))
                    .unwrap_or(host);
                NoProxyEntry {
                    hostname: host.to_lowercase(),
                    port,
                }
            })
            .collect();
        NoProxy {
            value: value.to_string(),
            entries,
        }
    }

    /// `hostname` 已是小寫、IPv6 帶方括號（WHATWG / url crate 的 host 字串）；`port` 已補上預設值。
    pub fn should_proxy(&self, hostname: &str, port: u16) -> bool {
        if self.entries.is_empty() {
            return true;
        }
        if self.value == "*" {
            return false;
        }
        !self.entries.iter().any(|entry| {
            if entry.port != 0 && entry.port != u32::from(port) {
                return false;
            }
            hostname == entry.hostname
                || hostname
                    .strip_suffix(entry.hostname.as_str())
                    .is_some_and(|rest| rest.ends_with('.'))
        })
    }
}

/// 環境變數的 proxy 政策（上游 `EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy })`）。
#[derive(Debug, Clone)]
pub struct EnvProxy {
    http: Option<Url>,
    https: Option<Url>,
    no_proxy: NoProxy,
    /// 設了但不合法：哪個變數、為什麼。有值時所有請求都擋下。
    invalid: Option<String>,
}

impl EnvProxy {
    /// 沒有設定 http / https proxy 時是 `None`（上游不建 agent）。
    pub fn from_config(cfg: &EnvConfig) -> Option<EnvProxy> {
        if !cfg.is_active() {
            return None;
        }
        let mut invalid = None;
        let mut parse = |raw: &str, name: &str| -> Option<Url> {
            if raw.is_empty() {
                return None;
            }
            match parse_proxy_url(raw) {
                Ok(url) => Some(url),
                Err(e) => {
                    invalid.get_or_insert_with(|| format!("{name} proxy: {e}"));
                    None
                }
            }
        };
        let http = parse(&cfg.http_proxy, "http");
        let https = parse(&cfg.https_proxy, "https");
        Some(EnvProxy {
            // https 沒設時 undici 用 http 的 agent（`resolve` 已把 http 帶進 https，這裡只是保險）。
            https: https.or_else(|| http.clone()),
            http,
            no_proxy: NoProxy::parse(&cfg.no_proxy),
            invalid,
        })
    }

    pub fn invalid_reason(&self) -> Option<&str> {
        self.invalid.as_deref()
    }

    /// undici `#getProxyAgentForUrl`。
    pub fn decide(&self, url: &Url) -> Decision {
        if let Some(reason) = &self.invalid {
            return Decision::new(Route::Blocked, Source::Env).with_note(reason.clone());
        }
        let host = url.host_str().unwrap_or("").to_lowercase();
        let port = url.port_or_known_default().unwrap_or(0);
        if !self.no_proxy.should_proxy(&host, port) {
            return Decision::new(Route::Direct, Source::NoProxy);
        }
        let proxy = if url.scheme() == "https" {
            &self.https
        } else {
            &self.http
        };
        match proxy {
            Some(p) => Decision::new(Route::Proxy(p.clone()), Source::Env),
            // 只設了 HTTPS_PROXY 時，http 請求直連（undici 的 http agent 就是 no-proxy agent）。
            None => Decision::new(Route::Direct, Source::Env),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn cfg(pairs: &[(&str, &str)]) -> EnvConfig {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        EnvConfig::resolve(|name| map.get(name).cloned())
    }

    fn route(pairs: &[(&str, &str)], url: &str) -> Route {
        EnvProxy::from_config(&cfg(pairs))
            .expect("proxy env is set")
            .decide(&Url::parse(url).unwrap())
            .route
    }

    fn proxy(s: &str) -> Route {
        Route::Proxy(Url::parse(s).unwrap())
    }

    #[test]
    fn clean_proxy_url_trims_and_strips_matching_quotes() {
        assert_eq!(clean_proxy_url(None), "");
        assert_eq!(clean_proxy_url(Some("  ")), "");
        assert_eq!(clean_proxy_url(Some(" http://p:1 ")), "http://p:1");
        assert_eq!(clean_proxy_url(Some("\" http://p:1 \"")), "http://p:1");
        assert_eq!(clean_proxy_url(Some("'http://p:1'")), "http://p:1");
        assert_eq!(clean_proxy_url(Some("\"")), "");
        assert_eq!(clean_proxy_url(Some("\"http://p:1'")), "\"http://p:1'");
    }

    #[test]
    fn lowercase_wins_and_all_proxy_is_the_last_fallback() {
        let c = cfg(&[
            ("http_proxy", "http://lower:1"),
            ("HTTP_PROXY", "http://upper:1"),
            ("ALL_PROXY", "http://all:1"),
        ]);
        assert_eq!(c.http_proxy, "http://lower:1");
        assert_eq!(c.https_proxy, "http://lower:1");

        let c = cfg(&[("HTTP_PROXY", "http://upper:1"), ("https_proxy", "  ")]);
        assert_eq!(c.http_proxy, "http://upper:1");
        assert_eq!(c.https_proxy, "http://upper:1");

        let c = cfg(&[("all_proxy", "http://all:1"), ("HTTPS_PROXY", "http://s:2")]);
        assert_eq!(c.http_proxy, "http://all:1");
        assert_eq!(c.https_proxy, "http://s:2");

        let c = cfg(&[("no_proxy", "a"), ("NO_PROXY", "b")]);
        assert_eq!(c.no_proxy, "a");
        assert!(!c.is_active());
        assert!(EnvProxy::from_config(&c).is_none());
    }

    #[test]
    fn routes_by_scheme_like_env_http_proxy_agent() {
        let both = [("HTTP_PROXY", "http://h:1"), ("HTTPS_PROXY", "http://s:2")];
        assert_eq!(route(&both, "http://x.com/a"), proxy("http://h:1"));
        assert_eq!(route(&both, "https://x.com/a"), proxy("http://s:2"));
        // 只有 HTTPS_PROXY：http 直連。
        assert_eq!(
            route(&[("HTTPS_PROXY", "http://s:2")], "http://x.com"),
            Route::Direct
        );
        assert_eq!(
            route(&[("HTTPS_PROXY", "http://s:2")], "https://x.com"),
            proxy("http://s:2")
        );
        // TLS 到 proxy 本身也可以。
        assert_eq!(
            route(&[("HTTPS_PROXY", "https://s:443")], "https://x.com"),
            proxy("https://s:443")
        );
    }

    #[test]
    fn invalid_proxy_urls_fail_closed() {
        for bad in [
            "proxy.corp:8080",
            "socks5://127.0.0.1:1080",
            "not a url",
            "http://",
        ] {
            let decision = EnvProxy::from_config(&cfg(&[("HTTPS_PROXY", bad)]))
                .unwrap()
                .decide(&Url::parse("https://x.com").unwrap());
            assert_eq!(decision.route, Route::Blocked, "{bad}");
            assert!(decision.note.is_some());
        }
        // 另一個變數壞掉也整個擋下（undici 在建構時就丟錯）。
        let d = EnvProxy::from_config(&cfg(&[
            ("HTTP_PROXY", "bogus:1"),
            ("HTTPS_PROXY", "http://s:2"),
            ("NO_PROXY", "x.com"),
        ]))
        .unwrap()
        .decide(&Url::parse("https://x.com").unwrap());
        assert_eq!(d.route, Route::Blocked);
    }

    #[test]
    fn no_proxy_matches_hosts_subdomains_and_ports() {
        let np = NoProxy::parse(
            "corp.com, .internal *.svc.local  10.0.0.1:8080,[::1]:9000,Upper.Example",
        );
        assert!(!np.should_proxy("corp.com", 443));
        assert!(!np.should_proxy("a.b.corp.com", 443));
        assert!(np.should_proxy("notcorp.com", 443));
        assert!(!np.should_proxy("internal", 80));
        assert!(!np.should_proxy("x.internal", 80));
        assert!(!np.should_proxy("api.svc.local", 80));
        assert!(!np.should_proxy("10.0.0.1", 8080));
        assert!(np.should_proxy("10.0.0.1", 80));
        assert!(!np.should_proxy("[::1]", 9000));
        assert!(np.should_proxy("[::1]", 443));
        assert!(!np.should_proxy("upper.example", 443));

        assert!(NoProxy::parse("").should_proxy("x", 1));
        assert!(!NoProxy::parse("*").should_proxy("anything.com", 443));
        // `*` 只有整串恰好是它時才是全部直連。
        assert!(NoProxy::parse("*,foo.com").should_proxy("anything.com", 443));
        assert!(!NoProxy::parse("*,foo.com").should_proxy("foo.com", 443));
    }

    #[test]
    fn no_proxy_applies_before_the_scheme_choice() {
        let env = [
            ("HTTPS_PROXY", "http://s:2"),
            ("no_proxy", "api.github.com:443"),
        ];
        assert_eq!(route(&env, "https://api.github.com/x"), Route::Direct);
        assert_eq!(
            route(&env, "https://api.github.com:8443/x"),
            proxy("http://s:2")
        );
        assert_eq!(route(&env, "https://github.com/x"), proxy("http://s:2"));
    }
}
