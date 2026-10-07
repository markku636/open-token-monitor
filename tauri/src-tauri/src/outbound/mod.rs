//! 對外 HTTP 的 proxy：所有 reqwest client 都由 [`builder`] 起頭（上游 src/shared/outboundFetch.js 與
//! src/electron/limitsFetch.js）。
//!
//! 1. 有 proxy 環境變數（`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`，小寫優先）時照上游
//!    undici `EnvHttpProxyAgent` 的規則（`env.rs`），不看系統設定；設了卻不合法時所有請求都失敗，
//!    不悄悄直連。
//! 2. 否則在 Windows 上照系統設定（上游 Electron 的 limits 走 Chromium，跟著 OS proxy，含 PAC / WPAD）：
//!    `system.rs` 逐個主機以 WinHTTP 決定並快取。
//! 3. 其他平台沒有環境變數就直連。
//!
//! reqwest 自己的系統 proxy（hyper-util 讀環境變數與 Internet Settings 的 `ProxyServer`）一律不用：
//! 它不讀 PAC / WPAD，`http=…;https=…` 也解錯，而且只靠別的套件的 feature 統一才編進來。
//! 環境變數在建 client 時讀（程序的環境變數執行中不會變）；系統設定每次連線時查（有快取）。
//! 決定只在建立新連線時做，已經在連線池裡的連線照舊用到閒置逾時。

mod env;
mod rules;
mod system;
#[cfg(windows)]
mod winhttp;

use std::fmt;
use std::sync::Arc;

use serde::Serialize;
use url::Url;

pub use env::{EnvConfig, EnvProxy};

/// 一個網址怎麼連。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    Direct,
    Proxy(Url),
    /// proxy 環境變數設錯：不連（上游 fail closed）。
    Blocked,
}

/// 決定是從哪一條規則來的（診斷用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    /// 沒有任何 proxy 設定。
    None,
    /// proxy 環境變數。
    Env,
    /// `NO_PROXY` 排除。
    NoProxy,
    /// loopback / link-local 一律直連（系統設定時）。
    Loopback,
    /// 系統的手動 proxy。
    Manual,
    /// 系統的排除清單。
    Bypass,
    /// 系統的 PAC / WPAD。
    Pac,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub route: Route,
    pub source: Source,
    /// 退回的原因等補充說明。
    pub note: Option<String>,
}

impl Decision {
    pub fn new(route: Route, source: Source) -> Decision {
        Decision {
            route,
            source,
            note: None,
        }
    }

    pub fn with_note(mut self, note: String) -> Decision {
        self.note = Some(note);
        self
    }

    pub fn route_kind(&self) -> &'static str {
        match self.route {
            Route::Direct => "direct",
            Route::Proxy(_) => "proxy",
            Route::Blocked => "blocked",
        }
    }

    /// 交給只收一個固定 proxy 的 client（updater plugin、reqwest 的 proxy callback）：`None` = 直連；
    /// 設錯的環境變數給一個一定連不上的位址（fail closed）。
    pub fn fixed_proxy(&self) -> Option<Url> {
        match &self.route {
            Route::Direct => None,
            Route::Proxy(proxy) => Some(proxy.clone()),
            Route::Blocked => Some(blocked_target()),
        }
    }

    /// proxy 網址（帳密遮掉），給 log、診斷與 CLI。
    pub fn proxy_display(&self) -> Option<String> {
        match &self.route {
            Route::Proxy(url) => Some(redacted(url)),
            _ => None,
        }
    }
}

/// `scheme://host:port`，帳密換成 `***`。proxy 網址裡的密碼絕不進 log 或前端。
fn redacted(url: &Url) -> String {
    let auth = if url.username().is_empty() && url.password().is_none() {
        ""
    } else {
        "***@"
    };
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    format!(
        "{}://{auth}{}{port}",
        url.scheme(),
        url.host_str().unwrap_or("")
    )
}

impl fmt::Display for Decision {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let why = match self.source {
            Source::None => "no proxy configured",
            Source::Env => "proxy environment variables",
            Source::NoProxy => "NO_PROXY",
            Source::Loopback => "loopback",
            Source::Manual => "system proxy",
            Source::Bypass => "system proxy bypass list",
            Source::Pac => "system PAC/WPAD",
        };
        match self.proxy_display() {
            Some(p) => write!(f, "{p} ({why})")?,
            None => write!(f, "{} ({why})", self.route_kind())?,
        }
        if let Some(note) = &self.note {
            write!(f, "; {note}")?;
        }
        Ok(())
    }
}

/// 一個程序裡所有 client 的政策。
#[derive(Clone)]
enum Policy {
    Env(Arc<EnvProxy>),
    #[cfg(windows)]
    System,
    /// 其他平台沒有環境變數時（Windows 一律有系統設定可查）。
    #[cfg_attr(windows, allow(dead_code))]
    Direct,
}

impl Policy {
    fn current() -> Policy {
        let cfg = EnvConfig::from_process();
        if let Some(env) = EnvProxy::from_config(&cfg) {
            if let Some(reason) = env.invalid_reason() {
                warn_invalid_env(reason);
            }
            return Policy::Env(Arc::new(env));
        }
        #[cfg(windows)]
        {
            Policy::System
        }
        #[cfg(not(windows))]
        {
            Policy::Direct
        }
    }

    /// 連線當下（同步）的決定。
    fn decide_now(&self, url: &Url) -> Decision {
        match self {
            Policy::Env(env) => env.decide(url),
            #[cfg(windows)]
            Policy::System => system_resolver().decide_now(url),
            Policy::Direct => Decision::new(Route::Direct, Source::None),
        }
    }
}

fn warn_invalid_env(reason: &str) {
    static WARNED: std::sync::Once = std::sync::Once::new();
    WARNED.call_once(|| {
        tracing::warn!(
            reason,
            "the proxy environment variable is not a valid http(s) URL; outbound requests fail until it is fixed"
        );
    });
}

#[cfg(windows)]
fn system_resolver() -> &'static Arc<system::Resolver<winhttp::WinHttpSource>> {
    static RESOLVER: std::sync::OnceLock<Arc<system::Resolver<winhttp::WinHttpSource>>> =
        std::sync::OnceLock::new();
    RESOLVER.get_or_init(|| {
        Arc::new(system::Resolver::new(
            winhttp::WinHttpSource,
            system::Timing::default(),
        ))
    })
}

/// 設錯的 proxy 環境變數：把連線導到一個一定連不上的位址（reqwest 的 proxy callback 沒有「拒絕」
/// 這個選項，回 `None` 會變成直連）。0.0.0.0:0 在本機就失敗，不送出任何封包。
fn blocked_target() -> Url {
    Url::parse("http://0.0.0.0:0").expect("static url")
}

fn apply(builder: reqwest::ClientBuilder, policy: Policy) -> reqwest::ClientBuilder {
    if let Policy::Direct = policy {
        return builder.no_proxy();
    }
    builder.proxy(reqwest::Proxy::custom(move |url: &Url| {
        policy.decide_now(url).fixed_proxy()
    }))
}

/// 所有對外 client 的起點：`reqwest::Client::builder()` 加上 proxy 政策。逾時、user-agent、gzip 等
/// 由呼叫端照舊設定。
pub fn builder() -> reqwest::ClientBuilder {
    apply(reqwest::Client::builder(), Policy::current())
}

/// 這個網址現在會怎麼連（診斷、tm-agent doctor / proxy、updater）。系統 PAC / WPAD 沒有快取時等它
/// 查完，最多 `limit`（逾時就回退路並註明）；查詢在 blocking 執行緒上。
#[cfg_attr(not(windows), allow(unused_variables))]
pub async fn decide(url: &str, limit: std::time::Duration) -> Decision {
    let Ok(url) = Url::parse(url) else {
        return Decision::new(Route::Direct, Source::None).with_note("invalid URL".into());
    };
    let policy = Policy::current();
    match policy {
        #[cfg(windows)]
        Policy::System => {
            let resolver = system_resolver().clone();
            tokio::task::spawn_blocking(move || resolver.decide_blocking(&url, limit))
                .await
                .unwrap_or_else(|e| {
                    Decision::new(Route::Direct, Source::None)
                        .with_note(format!("lookup failed: {e}"))
                })
        }
        other => other.decide_now(&url),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn env_policy(pairs: &[(&str, &str)]) -> Policy {
        let map: HashMap<&str, &str> = pairs.iter().copied().collect();
        let cfg = EnvConfig::resolve(|name| map.get(name).map(|v| v.to_string()));
        Policy::Env(Arc::new(EnvProxy::from_config(&cfg).unwrap()))
    }

    #[test]
    fn descriptions_hide_proxy_credentials() {
        let d = Decision::new(
            Route::Proxy(Url::parse("http://user:secret@proxy.corp:8080").unwrap()),
            Source::Env,
        );
        let text = d.to_string();
        assert_eq!(
            text,
            "http://***@proxy.corp:8080 (proxy environment variables)"
        );
        assert!(!text.contains("secret"));
        assert_eq!(
            Decision::new(Route::Direct, Source::Pac)
                .with_note("x".into())
                .to_string(),
            "direct (system PAC/WPAD); x"
        );
        assert_eq!(
            Decision::new(
                Route::Proxy(Url::parse("https://p").unwrap()),
                Source::Manual
            )
            .proxy_display()
            .as_deref(),
            Some("https://p")
        );
    }

    #[test]
    fn builder_builds_without_touching_the_network() {
        builder()
            .connect_timeout(Duration::from_secs(1))
            .build()
            .expect("client");
        apply(reqwest::Client::builder(), Policy::Direct)
            .build()
            .expect("client");
    }

    /// 本機假 proxy：收一個請求、回 200，把請求行交回來。
    async fn fake_proxy() -> (u16, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = sock.read(&mut buf).await.unwrap();
            let head = String::from_utf8_lossy(&buf[..n]).to_string();
            sock.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok")
                .await
                .unwrap();
            head.lines().next().unwrap_or("").to_string()
        });
        (port, task)
    }

    #[tokio::test]
    async fn env_proxy_routes_requests_through_the_proxy() {
        let (port, seen) = fake_proxy().await;
        let proxy = format!("http://127.0.0.1:{port}");
        let client = apply(
            reqwest::Client::builder(),
            env_policy(&[("HTTP_PROXY", &proxy), ("NO_PROXY", "skip.invalid")]),
        )
        .build()
        .unwrap();
        let body = client
            .get("http://hub.example.invalid/api/health")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(body, "ok");
        assert_eq!(
            seen.await.unwrap(),
            "GET http://hub.example.invalid/api/health HTTP/1.1"
        );
    }

    #[tokio::test]
    async fn invalid_env_proxy_fails_instead_of_going_direct() {
        let client = apply(
            reqwest::Client::builder(),
            env_policy(&[("HTTP_PROXY", "proxy.corp:8080")]),
        )
        .connect_timeout(Duration::from_secs(5))
        .build()
        .unwrap();
        // 目標是本機真的在聽的 port：直連就會成功，所以失敗代表沒有繞過 proxy 設定。
        let (port, _server) = fake_proxy().await;
        let err = client
            .get(format!("http://127.0.0.1:{port}/"))
            .send()
            .await
            .expect_err("must not connect directly");
        assert!(err.is_connect() || err.is_request(), "{err}");
    }
}
