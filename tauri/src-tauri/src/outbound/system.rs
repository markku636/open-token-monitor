//! Windows 的系統 proxy：逐個主機決定、快取，慢的 PAC / WPAD 查詢不放在 async 執行緒上。
//!
//! 順序照 Chromium（上游 Electron 的 limits 走它）：loopback 一律直連 → 自動偵測（WPAD）/ 自動設定
//! 指令碼（PAC）→ 失敗時退回手動 proxy → 都沒有就直連。
//!
//! - IE 設定（`WinHttpGetIEProxyConfigForCurrentUser`，讀登錄檔，很快）快取 15 秒；內容變了就清掉
//!   主機快取與 PAC 失敗紀錄，改完系統設定最多 15 秒生效。
//! - 手動 proxy 與排除清單是純字串比對，不快取。
//! - PAC / WPAD（`WinHttpGetProxyForUrl`，第一次要下載指令碼或做 DHCP / DNS 探索，可能好幾秒）在專用
//!   執行緒上跑，結果以 `scheme://host:port` 快取 5 分鐘；過期後一小時內先用舊的、背景重查。
//!   沒有快取時等最多 5 秒（`block_in_place`，同一個 worker 上的其他 task 移到別的執行緒）；逾時就先用
//!   手動 proxy / 直連，查到的結果留給下一次連線。
//! - 找不到或下載不了指令碼（沒有 WPAD 的家用網路很常見）記成整體失敗，5 分鐘內所有主機直接用手動
//!   proxy / 直連，不再等；之後背景重試。

// 只有 Windows 的系統 proxy 用得到；其他平台只編不用。
#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use url::Url;

use super::rules::{is_implicit_bypass, pick_pac_proxy, pick_proxy, BypassRules};
use super::{Decision, Route, Source};

/// IE / WinINet 的 proxy 設定（`WINHTTP_CURRENT_USER_IE_PROXY_CONFIG`）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IeConfig {
    pub auto_detect: bool,
    pub auto_config_url: Option<String>,
    pub proxy: Option<String>,
    pub bypass: Option<String>,
}

impl IeConfig {
    fn is_automatic(&self) -> bool {
        self.auto_detect || self.auto_config_url.is_some()
    }
}

/// PAC / WPAD 對一個網址的答案。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PacAnswer {
    Direct,
    Proxy {
        list: String,
        bypass: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PacError {
    pub message: String,
    /// 指令碼層級的失敗（找不到、下載不了、執行錯誤）：對所有主機都一樣，整體記下來。
    pub script_failed: bool,
}

/// 系統設定的來源；正式是 WinHTTP（`winhttp.rs`），測試注入假的。
pub trait SystemSource: Send + Sync + 'static {
    fn ie_config(&self) -> Result<IeConfig, String>;
    /// 可能要好幾秒；只會在專用執行緒上呼叫。
    fn pac(&self, url: &str, config: &IeConfig) -> Result<PacAnswer, PacError>;
}

#[derive(Debug, Clone, Copy)]
pub struct Timing {
    pub ie_ttl: Duration,
    pub fresh: Duration,
    pub stale_max: Duration,
    pub pac_retry: Duration,
    pub miss_wait: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            ie_ttl: Duration::from_secs(15),
            fresh: Duration::from_secs(5 * 60),
            stale_max: Duration::from_secs(60 * 60),
            pac_retry: Duration::from_secs(5 * 60),
            miss_wait: Duration::from_secs(5),
        }
    }
}

/// 主機快取的上限；超過就丟掉過期的，還是太多就整個清掉（實際只有十幾個主機）。
const HOST_CACHE_MAX: usize = 256;

#[derive(Default)]
struct State {
    ie: Option<(Instant, Arc<IeConfig>)>,
    /// IE 設定每變一次加一；舊設定查到的結果不寫進快取。
    generation: u64,
    hosts: HashMap<String, (Instant, Decision)>,
    pac_failure: Option<(Instant, String)>,
    inflight: HashMap<String, Arc<Pending>>,
}

#[derive(Default)]
struct Pending {
    slot: Mutex<Option<Decision>>,
    done: Condvar,
}

impl Pending {
    fn complete(&self, decision: Decision) {
        *lock(&self.slot) = Some(decision);
        self.done.notify_all();
    }

    fn wait(&self, timeout: Duration) -> Option<Decision> {
        let guard = lock(&self.slot);
        let (guard, _) = self
            .done
            .wait_timeout_while(guard, timeout, |slot| slot.is_none())
            .unwrap_or_else(|e| e.into_inner());
        guard.clone()
    }
}

/// 這一次查詢該怎麼做。
#[derive(Debug, Clone, PartialEq)]
enum Plan {
    /// 已經有答案。
    Ready(Decision),
    /// 先用這個答案，背景重查。
    Refresh(Decision),
    /// 沒有答案，要查 PAC；等不到時用 `fallback`。
    Resolve { fallback: Decision },
}

struct Planned {
    plan: Plan,
    config: Arc<IeConfig>,
    generation: u64,
}

pub struct Resolver<S: SystemSource> {
    source: S,
    timing: Timing,
    state: Mutex<State>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // connector 裡不能 panic：中毒的鎖照樣用（裡面只有快取）。
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// `scheme://host:port`：reqwest 交給 proxy 選擇的網址本來就只有這些。
fn host_key(url: &Url) -> String {
    format!(
        "{}://{}:{}",
        url.scheme(),
        url.host_str().unwrap_or(""),
        url.port_or_known_default().unwrap_or(0)
    )
}

/// 手動 proxy（`ProxyServer` + `ProxyOverride`），也是 PAC / WPAD 失敗時的退路。
fn manual_decision(config: &IeConfig, url: &Url) -> Decision {
    let Some(list) = config.proxy.as_deref() else {
        return Decision::new(Route::Direct, Source::None);
    };
    let bypass = BypassRules::parse(config.bypass.as_deref().unwrap_or(""));
    if bypass.matches(url) {
        return Decision::new(Route::Direct, Source::Bypass);
    }
    match pick_proxy(list, url.scheme()) {
        Some(proxy) => Decision::new(Route::Proxy(proxy), Source::Manual),
        None => Decision::new(Route::Direct, Source::Manual),
    }
}

fn pac_note(message: &str) -> String {
    format!("PAC/WPAD unavailable: {message}")
}

impl<S: SystemSource> Resolver<S> {
    pub fn new(source: S, timing: Timing) -> Resolver<S> {
        Resolver {
            source,
            timing,
            state: Mutex::new(State::default()),
        }
    }

    /// IE 設定（過期才重讀）；內容變了就清掉依賴它的快取。
    fn config(&self, state: &mut State, now: Instant) -> Arc<IeConfig> {
        if let Some((at, cfg)) = &state.ie {
            if now.saturating_duration_since(*at) < self.timing.ie_ttl {
                return cfg.clone();
            }
        }
        let fresh = match self.source.ie_config() {
            Ok(cfg) => cfg,
            Err(e) => {
                tracing::debug!(error = %e, "cannot read the system proxy settings; going direct");
                IeConfig::default()
            }
        };
        let changed = state.ie.as_ref().is_none_or(|(_, old)| **old != fresh);
        if changed {
            state.generation += 1;
            state.hosts.clear();
            state.pac_failure = None;
        }
        let fresh = Arc::new(fresh);
        state.ie = Some((now, fresh.clone()));
        fresh
    }

    fn plan(&self, url: &Url, now: Instant) -> Planned {
        let mut state = lock(&self.state);
        let config = self.config(&mut state, now);
        let generation = state.generation;
        let done = |plan| Planned {
            plan,
            config: config.clone(),
            generation,
        };
        let bypass = BypassRules::parse(config.bypass.as_deref().unwrap_or(""));
        if bypass.implicit_loopback() && is_implicit_bypass(url) {
            return done(Plan::Ready(Decision::new(Route::Direct, Source::Loopback)));
        }
        let manual = manual_decision(&config, url);
        if !config.is_automatic() {
            return done(Plan::Ready(manual));
        }
        if let Some((at, message)) = &mut state.pac_failure {
            let fallback = manual.with_note(pac_note(message));
            if now.saturating_duration_since(*at) < self.timing.pac_retry {
                return done(Plan::Ready(fallback));
            }
            // 重試：只讓這一次連線去背景重查，其他主機在下一個重試間隔內照舊用退路。
            *at = now;
            return done(Plan::Refresh(fallback));
        }
        if let Some((at, decision)) = state.hosts.get(&host_key(url)) {
            let age = now.saturating_duration_since(*at);
            if age < self.timing.fresh {
                return done(Plan::Ready(decision.clone()));
            }
            if age < self.timing.stale_max {
                return done(Plan::Refresh(decision.clone()));
            }
        }
        done(Plan::Resolve { fallback: manual })
    }

    /// 真正查 PAC / WPAD 並寫進快取。會阻塞，只在專用執行緒上跑。
    fn resolve_pac(&self, url: &Url, config: &IeConfig, generation: u64) -> Decision {
        let answer = self.source.pac(url.as_str(), config);
        let now = Instant::now();
        let mut state = lock(&self.state);
        let current = state.generation == generation;
        let decision = match answer {
            Ok(answer) => {
                if current {
                    state.pac_failure = None;
                }
                match answer {
                    PacAnswer::Direct => Decision::new(Route::Direct, Source::Pac),
                    PacAnswer::Proxy { list, bypass } => {
                        let bypassed = bypass
                            .as_deref()
                            .is_some_and(|b| BypassRules::parse(b).matches(url));
                        match pick_pac_proxy(&list, url.scheme()) {
                            Some(proxy) if !bypassed => {
                                Decision::new(Route::Proxy(proxy), Source::Pac)
                            }
                            _ => Decision::new(Route::Direct, Source::Pac),
                        }
                    }
                }
            }
            Err(e) => {
                let fallback = manual_decision(config, url).with_note(pac_note(&e.message));
                // 沒有 WPAD 的網路每 5 分鐘重試都會失敗：原因沒變就不再記 info。
                let repeated = state
                    .pac_failure
                    .as_ref()
                    .is_some_and(|(_, m)| *m == e.message);
                if e.script_failed && !repeated {
                    tracing::info!(error = %e.message, "PAC/WPAD is unavailable; using the manual proxy or going direct");
                } else {
                    tracing::debug!(url = %url, error = %e.message, "PAC/WPAD lookup failed");
                }
                if e.script_failed {
                    if current {
                        state.pac_failure = Some((now, e.message));
                    }
                    return fallback;
                }
                fallback
            }
        };
        if current {
            if state.hosts.len() >= HOST_CACHE_MAX {
                let stale_max = self.timing.stale_max;
                state
                    .hosts
                    .retain(|_, (at, _)| now.saturating_duration_since(*at) < stale_max);
                if state.hosts.len() >= HOST_CACHE_MAX {
                    state.hosts.clear();
                }
            }
            state.hosts.insert(host_key(url), (now, decision.clone()));
        }
        decision
    }

    /// 開一個（同一主機只會有一個）背景查詢。
    fn start(self: &Arc<Self>, url: &Url, planned: &Planned, fallback: &Decision) -> Arc<Pending> {
        let key = host_key(url);
        let pending = {
            let mut state = lock(&self.state);
            if let Some(p) = state.inflight.get(&key) {
                return p.clone();
            }
            // plan 之後、這裡之前剛好有人查完：直接用，不再查一次。
            if let Some((at, d)) = state.hosts.get(&key) {
                if at.elapsed() < self.timing.fresh {
                    let done = Arc::new(Pending::default());
                    done.complete(d.clone());
                    return done;
                }
            }
            let p = Arc::new(Pending::default());
            state.inflight.insert(key.clone(), p.clone());
            p
        };
        let this = self.clone();
        let job_pending = pending.clone();
        let job_url = url.clone();
        let job_key = key.clone();
        let config = planned.config.clone();
        let generation = planned.generation;
        let spawned = std::thread::Builder::new()
            .name("tm-proxy-pac".into())
            .spawn(move || {
                let decision = this.resolve_pac(&job_url, &config, generation);
                lock(&this.state).inflight.remove(&job_key);
                job_pending.complete(decision);
            });
        if let Err(e) = spawned {
            tracing::warn!(error = %e, "cannot start the PAC/WPAD lookup thread");
            lock(&self.state).inflight.remove(&key);
            pending.complete(fallback.clone());
        }
        pending
    }

    /// 連線當下的決定（reqwest 的 proxy callback 是同步的）。有快取就不等；沒有時最多等 `miss_wait`。
    pub fn decide_now(self: &Arc<Self>, url: &Url) -> Decision {
        let planned = self.plan(url, Instant::now());
        match &planned.plan {
            Plan::Ready(d) => d.clone(),
            Plan::Refresh(d) => {
                self.start(url, &planned, d);
                d.clone()
            }
            Plan::Resolve { fallback } => {
                let pending = self.start(url, &planned, fallback);
                let wait = self.timing.miss_wait;
                match wait_blocking(|| pending.wait(wait)) {
                    Some(d) => d,
                    None => {
                        tracing::info!(url = %url, "PAC/WPAD lookup is still running; not waiting for it on this connection");
                        fallback
                            .clone()
                            .with_note("PAC/WPAD lookup still running".into())
                    }
                }
            }
        }
    }

    /// 診斷用：一定查到目前的答案（最多等 `limit`）。會阻塞，呼叫端放在 `spawn_blocking`。
    pub fn decide_blocking(self: &Arc<Self>, url: &Url, limit: Duration) -> Decision {
        let planned = self.plan(url, Instant::now());
        match &planned.plan {
            Plan::Ready(d) => d.clone(),
            Plan::Refresh(fallback) | Plan::Resolve { fallback } => self
                .start(url, &planned, fallback)
                .wait(limit)
                .unwrap_or_else(|| {
                    fallback
                        .clone()
                        .with_note("PAC/WPAD lookup still running".into())
                }),
        }
    }
}

/// 在 async 執行緒上等：多執行緒 runtime 用 `block_in_place` 讓出 worker；current-thread runtime 或
/// 不在 runtime 裡時直接等（`block_in_place` 在那裡會 panic）。
fn wait_blocking<R>(f: impl FnOnce() -> R) -> R {
    use tokio::runtime::{Handle, RuntimeFlavor};
    match Handle::try_current() {
        Ok(h) if h.runtime_flavor() == RuntimeFlavor::MultiThread => tokio::task::block_in_place(f),
        _ => f(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Fake {
        config: Mutex<IeConfig>,
        answer: Mutex<Result<PacAnswer, PacError>>,
        delay: Duration,
        ie_reads: AtomicUsize,
        pac_calls: AtomicUsize,
    }

    impl Fake {
        fn new(config: IeConfig, answer: Result<PacAnswer, PacError>) -> Fake {
            Fake {
                config: Mutex::new(config),
                answer: Mutex::new(answer),
                delay: Duration::ZERO,
                ie_reads: AtomicUsize::new(0),
                pac_calls: AtomicUsize::new(0),
            }
        }
    }

    impl SystemSource for Arc<Fake> {
        fn ie_config(&self) -> Result<IeConfig, String> {
            self.ie_reads.fetch_add(1, Ordering::SeqCst);
            Ok(self.config.lock().unwrap().clone())
        }
        fn pac(&self, _url: &str, _config: &IeConfig) -> Result<PacAnswer, PacError> {
            self.pac_calls.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(self.delay);
            self.answer.lock().unwrap().clone()
        }
    }

    fn resolver(fake: &Arc<Fake>, timing: Timing) -> Arc<Resolver<Arc<Fake>>> {
        Arc::new(Resolver::new(fake.clone(), timing))
    }

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn proxy(s: &str) -> Route {
        Route::Proxy(u(s))
    }

    fn pac_config() -> IeConfig {
        IeConfig {
            auto_config_url: Some("http://wpad.corp/proxy.pac".into()),
            proxy: Some("manual:3128".into()),
            ..IeConfig::default()
        }
    }

    fn pac_proxy(list: &str) -> Result<PacAnswer, PacError> {
        Ok(PacAnswer::Proxy {
            list: list.into(),
            bypass: None,
        })
    }

    fn script_failure() -> Result<PacAnswer, PacError> {
        Err(PacError {
            message: "no script".into(),
            script_failed: true,
        })
    }

    #[test]
    fn manual_proxy_and_bypass_list_never_touch_pac() {
        let fake = Arc::new(Fake::new(
            IeConfig {
                proxy: Some("http=web:80;https=secure:8443".into()),
                bypass: Some("*.corp.example;<local>".into()),
                ..IeConfig::default()
            },
            script_failure(),
        ));
        let r = resolver(&fake, Timing::default());
        let d = r.decide_now(&u("https://api.anthropic.com/"));
        assert_eq!(
            (d.route, d.source),
            (proxy("http://secure:8443"), Source::Manual)
        );
        assert_eq!(
            r.decide_now(&u("http://example.com/")).route,
            proxy("http://web")
        );
        let d = r.decide_now(&u("https://git.corp.example/"));
        assert_eq!((d.route, d.source), (Route::Direct, Source::Bypass));
        assert_eq!(r.decide_now(&u("https://intranet/")).source, Source::Bypass);
        let d = r.decide_now(&u("http://127.0.0.1:17321/"));
        assert_eq!((d.route, d.source), (Route::Direct, Source::Loopback));
        assert_eq!(fake.pac_calls.load(Ordering::SeqCst), 0);
        // IE 設定在 TTL 內只讀一次。
        assert_eq!(fake.ie_reads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn no_system_proxy_goes_direct() {
        let fake = Arc::new(Fake::new(IeConfig::default(), script_failure()));
        let d = resolver(&fake, Timing::default()).decide_now(&u("https://x.example/"));
        assert_eq!((d.route, d.source), (Route::Direct, Source::None));
    }

    #[test]
    fn loopback_bypass_can_be_turned_off() {
        let fake = Arc::new(Fake::new(
            IeConfig {
                proxy: Some("p:1".into()),
                bypass: Some("<-loopback>".into()),
                ..IeConfig::default()
            },
            script_failure(),
        ));
        let d = resolver(&fake, Timing::default()).decide_now(&u("http://localhost:8080/"));
        assert_eq!(d.route, proxy("http://p:1"));
    }

    #[test]
    fn pac_answers_are_cached_per_host() {
        let fake = Arc::new(Fake::new(pac_config(), pac_proxy("pac-proxy:8080;other:1")));
        let r = resolver(&fake, Timing::default());
        let d = r.decide_now(&u("https://api.anthropic.com/"));
        assert_eq!(
            (d.route, d.source),
            (proxy("http://pac-proxy:8080"), Source::Pac)
        );
        r.decide_now(&u("https://api.anthropic.com/"));
        assert_eq!(fake.pac_calls.load(Ordering::SeqCst), 1);
        r.decide_now(&u("https://chatgpt.com/"));
        r.decide_now(&u("http://chatgpt.com/"));
        assert_eq!(fake.pac_calls.load(Ordering::SeqCst), 3);

        *fake.answer.lock().unwrap() = Ok(PacAnswer::Direct);
        let d = r.decide_now(&u("https://direct.example/"));
        assert_eq!((d.route, d.source), (Route::Direct, Source::Pac));
    }

    #[test]
    fn stale_entries_are_served_while_refreshing_then_expire() {
        let fake = Arc::new(Fake::new(pac_config(), pac_proxy("p:1")));
        let timing = Timing {
            ie_ttl: Duration::from_secs(3600 * 24),
            ..Timing::default()
        };
        let r = resolver(&fake, timing);
        let url = u("https://api.anthropic.com/");
        r.decide_now(&url);
        let t0 = Instant::now();
        assert!(matches!(r.plan(&url, t0).plan, Plan::Ready(_)));
        let later = t0 + timing.fresh + Duration::from_secs(1);
        assert_eq!(
            r.plan(&url, later).plan,
            Plan::Refresh(Decision::new(proxy("http://p:1"), Source::Pac))
        );
        let much_later = t0 + timing.stale_max + Duration::from_secs(1);
        assert!(matches!(
            r.plan(&url, much_later).plan,
            Plan::Resolve { .. }
        ));
    }

    #[test]
    fn a_config_change_drops_cached_answers() {
        let fake = Arc::new(Fake::new(pac_config(), pac_proxy("p:1")));
        let timing = Timing {
            ie_ttl: Duration::ZERO,
            ..Timing::default()
        };
        let r = resolver(&fake, timing);
        let url = u("https://api.anthropic.com/");
        r.decide_now(&url);
        r.decide_now(&url);
        assert_eq!(fake.pac_calls.load(Ordering::SeqCst), 1);
        // 使用者關掉自動設定、改成手動 proxy。
        *fake.config.lock().unwrap() = IeConfig {
            proxy: Some("manual:3128".into()),
            ..IeConfig::default()
        };
        let d = r.decide_now(&url);
        assert_eq!(
            (d.route, d.source),
            (proxy("http://manual:3128"), Source::Manual)
        );
        // 再改回 PAC：舊答案已經丟掉，重查。
        *fake.config.lock().unwrap() = pac_config();
        r.decide_now(&url);
        assert_eq!(fake.pac_calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn script_failures_fall_back_for_every_host_until_retry() {
        let fake = Arc::new(Fake::new(pac_config(), script_failure()));
        let timing = Timing {
            ie_ttl: Duration::from_secs(3600 * 24),
            ..Timing::default()
        };
        let r = resolver(&fake, timing);
        let d = r.decide_now(&u("https://a.example/"));
        assert_eq!(
            (d.route.clone(), d.source),
            (proxy("http://manual:3128"), Source::Manual)
        );
        assert!(d.note.as_deref().unwrap().contains("no script"));
        // 其他主機不再等 PAC。
        let d = r.decide_now(&u("https://b.example/"));
        assert_eq!(d.route, proxy("http://manual:3128"));
        assert_eq!(fake.pac_calls.load(Ordering::SeqCst), 1);
        // 重試時間到了：先用退路、背景重查。
        let later = Instant::now() + timing.pac_retry + Duration::from_secs(1);
        assert!(matches!(
            r.plan(&u("https://b.example/"), later).plan,
            Plan::Refresh(_)
        ));
    }

    #[test]
    fn url_level_failures_are_cached_as_the_fallback() {
        let fake = Arc::new(Fake::new(
            IeConfig {
                auto_detect: true,
                ..IeConfig::default()
            },
            Err(PacError {
                message: "bad url".into(),
                script_failed: false,
            }),
        ));
        let r = resolver(&fake, Timing::default());
        let d = r.decide_now(&u("https://a.example/"));
        assert_eq!((d.route, d.source), (Route::Direct, Source::None));
        r.decide_now(&u("https://a.example/"));
        assert_eq!(fake.pac_calls.load(Ordering::SeqCst), 1);
        // 不是整體失敗：別的主機照查。
        r.decide_now(&u("https://b.example/"));
        assert_eq!(fake.pac_calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn pac_bypass_lists_are_honoured() {
        let fake = Arc::new(Fake::new(
            pac_config(),
            Ok(PacAnswer::Proxy {
                list: "p:1".into(),
                bypass: Some("*.corp.example".into()),
            }),
        ));
        let r = resolver(&fake, Timing::default());
        assert_eq!(
            r.decide_now(&u("https://git.corp.example/")).route,
            Route::Direct
        );
        assert_eq!(
            r.decide_now(&u("https://x.example/")).route,
            proxy("http://p:1")
        );
    }

    #[test]
    fn a_slow_lookup_does_not_hold_the_connection_past_the_wait() {
        let mut fake = Fake::new(pac_config(), pac_proxy("pac:1"));
        fake.delay = Duration::from_millis(300);
        let fake = Arc::new(fake);
        let r = resolver(
            &fake,
            Timing {
                miss_wait: Duration::from_millis(20),
                ..Timing::default()
            },
        );
        let url = u("https://slow.example/");
        let started = Instant::now();
        let d = r.decide_now(&url);
        assert!(started.elapsed() < Duration::from_millis(250));
        assert_eq!(d.route, proxy("http://manual:3128"));
        assert!(d.note.is_some());
        // 查到的結果留給下一次連線。
        let d = r.decide_blocking(&url, Duration::from_secs(5));
        assert_eq!(d.route, proxy("http://pac:1"));
        assert_eq!(r.decide_now(&url).route, proxy("http://pac:1"));
        assert_eq!(fake.pac_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn concurrent_misses_share_one_lookup() {
        let mut fake = Fake::new(pac_config(), pac_proxy("pac:1"));
        fake.delay = Duration::from_millis(100);
        let fake = Arc::new(fake);
        let r = resolver(&fake, Timing::default());
        let threads: Vec<_> = (0..4)
            .map(|_| {
                let r = r.clone();
                std::thread::spawn(move || r.decide_now(&u("https://api.anthropic.com/")).route)
            })
            .collect();
        for t in threads {
            assert_eq!(t.join().unwrap(), proxy("http://pac:1"));
        }
        assert_eq!(fake.pac_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn waiting_inside_a_multi_thread_runtime_does_not_panic() {
        let mut fake = Fake::new(pac_config(), pac_proxy("pac:1"));
        fake.delay = Duration::from_millis(50);
        let fake = Arc::new(fake);
        let r = resolver(&fake, Timing::default());
        let d = tokio::spawn(async move { r.decide_now(&u("https://api.anthropic.com/")) })
            .await
            .unwrap();
        assert_eq!(d.route, proxy("http://pac:1"));
    }
}
