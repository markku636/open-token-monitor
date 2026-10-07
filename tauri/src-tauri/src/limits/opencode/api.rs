//! OpenCode Go 的官方用量 API（上游 providers/opencode/goApi.js，逐條移植）。
//!
//! `GET https://opencode.ai/zen/go/v1/usage`，`Authorization: Bearer <key>`。key 不必設定：`opencode`
//! 連線時把 Go 訂閱的 key 寫進自己的 auth.json（provider id `opencode-go`），所以這條路徑零設定，
//! 也是唯一以真實訂閱月份為準的來源。沒有 Zen 餘額的 endpoint，餘額只能靠 cookie（web.rs）。

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::transport::{clean_secret, js_date_parse, js_iso, js_to_number, HttpRequest, Transport};
use super::OpencodeEnv;
use crate::wire::{LimitWindow, ProviderStatus, WindowKind};

pub const GO_USAGE_URL: &str = "https://opencode.ai/zen/go/v1/usage";
/// OpenCode 存 Go 訂閱 key 用的 provider id。Zen 的 key 存在 `opencode` 下，刻意不試：這個 endpoint
/// 沒有餘額，Zen 帳號每次都只會拿到 403。
pub const GO_AUTH_PROVIDER_ID: &str = "opencode-go";

/// [payload 的鍵, 窗口種類, windowMinutes]。rolling 的長度其實由伺服器設定、不在回應裡，300 是假設
/// （與 web 路徑相同）。`monthly` 在 wire 上正規化成 `billing`。
const WINDOW_MAP: [(&str, WindowKind, f64); 3] = [
    ("rolling", WindowKind::Session, 300.0),
    ("weekly", WindowKind::Weekly, 10080.0),
    ("monthly", WindowKind::Billing, 43200.0),
];

/// 上游 `resolveDataDir`（goLimits.js）：`$XDG_DATA_HOME/opencode`，否則 `~/.local/share/opencode`
/// （Windows 上 OpenCode 也用這個位置）。
pub fn data_dir(env: &OpencodeEnv) -> std::path::PathBuf {
    let xdg = env.var("XDG_DATA_HOME");
    if !xdg.is_empty() {
        return std::path::Path::new(xdg).join("opencode");
    }
    let home = [env.var("HOME"), env.var("USERPROFILE")]
        .into_iter()
        .find(|v| !v.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| env.home.clone());
    home.join(".local").join("share").join("opencode")
}

/// 上游 `readGoAuthDocument`：`OPENCODE_AUTH_CONTENT` 能解析就用它（**取代**檔案，不合併），
/// 否則讀 auth.json。回傳 (文件, 是否需要檢查格式)：只有檔案要檢查（上游 `Auth.all()` 的不對稱）。
fn read_auth_document(env: &OpencodeEnv) -> Option<(Value, bool)> {
    let inline = env
        .var("OPENCODE_AUTH_CONTENT")
        .trim_matches(super::transport::js_space);
    if !inline.is_empty() {
        if let Ok(doc) = serde_json::from_str::<Value>(inline) {
            return Some((doc, false));
        }
    }
    let raw = std::fs::read_to_string(data_dir(env).join("auth.json")).ok()?;
    serde_json::from_str::<Value>(&raw)
        .ok()
        .map(|doc| (doc, true))
}

fn clean_value(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => clean_secret(s),
        _ => String::new(),
    }
}

/// 上游 `readGoApiKey`：`TOKEN_MONITOR_OPENCODE_API_KEY` → `OPENCODE_AUTH_CONTENT` → auth.json 的
/// `opencode-go`（type 必須是 `api`）。沒有就是空字串。
pub fn read_go_api_key(env: &OpencodeEnv) -> String {
    let explicit = clean_secret(env.var("TOKEN_MONITOR_OPENCODE_API_KEY"));
    if !explicit.is_empty() {
        return explicit;
    }
    let Some((doc, validated)) = read_auth_document(env) else {
        return String::new();
    };
    let Some(entry) = doc.as_object().and_then(|o| o.get(GO_AUTH_PROVIDER_ID)) else {
        return String::new();
    };
    let Some(obj) = entry.as_object() else {
        return String::new();
    };
    if validated {
        let is_api = obj.get("type") == Some(&Value::String("api".into()))
            && matches!(obj.get("key"), Some(Value::String(_)));
        return if is_api {
            clean_value(obj.get("key"))
        } else {
            String::new()
        };
    }
    let kind = match obj.get("type") {
        Some(v) if crate::usage::js::truthy(v) => crate::usage::js::to_js_string(v).to_lowercase(),
        _ => String::new(),
    };
    if !kind.is_empty() && kind != "api" {
        return String::new();
    }
    clean_value(obj.get("key"))
}

/// 上游 `goApiIdentity`：endpoint 不回 workspace id，所以 key 本身就是身分（完整的 SHA-256）。
pub fn go_api_identity(api_key: &str) -> String {
    let digest = Sha256::digest(api_key.as_bytes());
    let mut out = String::with_capacity(7 + 64);
    out.push_str("go-api:");
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn normalize_resets_at(v: Option<&Value>) -> Option<String> {
    let text = match v {
        Some(v) if crate::usage::js::truthy(v) => crate::usage::js::to_js_string(v),
        _ => return None,
    };
    js_date_parse(&text).and_then(js_iso)
}

/// 上游 `windowPercent`：`Number(entry.percent)`（null 是 0），沒有數字但狀態是 `rate-limited` 算 100。
fn window_percent(entry: Option<&Value>) -> Option<f64> {
    let obj = entry?.as_object()?;
    let raw = js_to_number(obj.get("percent"));
    if !raw.is_finite() {
        let status = match obj.get("status") {
            Some(v) if crate::usage::js::truthy(v) => crate::usage::js::to_js_string(v),
            _ => String::new(),
        };
        return (status == "rate-limited").then_some(100.0);
    }
    Some(raw.clamp(0.0, 100.0))
}

/// 上游 goApi.js `parseGoUsage`：5 小時與每週缺一個就是上游改了格式，整個不算。
/// used / limit 刻意留空：金額上限在伺服器端，不在回應裡。
pub fn parse_go_usage(payload: &Value) -> Vec<LimitWindow> {
    let Some(usage) = payload.get("usage").filter(|u| u.is_object()) else {
        return Vec::new();
    };
    let mut windows = Vec::new();
    for (key, kind, minutes) in WINDOW_MAP {
        let entry = usage.get(key);
        let Some(used_percent) = window_percent(entry) else {
            continue;
        };
        windows.push(LimitWindow {
            used_percent: Some(used_percent),
            resets_at: normalize_resets_at(entry.and_then(|e| e.get("resetsAt"))),
            window_minutes: Some(minutes),
            ..LimitWindow::new(kind)
        });
    }
    let has = |k: WindowKind| windows.iter().any(|w| w.kind == k);
    if !has(WindowKind::Session) || !has(WindowKind::Weekly) {
        return Vec::new();
    }
    windows
}

/// `collectGoApi` 的結果。`entitled: Some(false)` 是伺服器明確說這個帳號沒有 Go 方案，本機估算不能補。
#[derive(Debug, Clone, PartialEq)]
pub struct GoApi {
    pub status: ProviderStatus,
    pub entitled: Option<bool>,
    pub windows: Vec<LimitWindow>,
    /// key 的身分（`go-api:<sha256>`）；沒有 key 時是空字串。探測失敗也帶著，帳號才不會失去身分。
    pub identity: String,
    pub retry_after: Option<std::time::Duration>,
}

impl GoApi {
    fn status(status: ProviderStatus) -> GoApi {
        GoApi {
            status,
            entitled: None,
            windows: Vec::new(),
            identity: String::new(),
            retry_after: None,
        }
    }
}

/// 上游 `fetchGoApi`。
pub async fn fetch_go_api<T: Transport>(t: &T, api_key: &str) -> GoApi {
    let key = clean_secret(api_key);
    if key.is_empty() {
        return GoApi::status(ProviderStatus::NotConfigured);
    }
    let Ok(resp) = t
        .send(HttpRequest {
            method: "GET",
            url: GO_USAGE_URL.into(),
            headers: vec![
                ("Authorization", format!("Bearer {key}")),
                ("Accept", "application/json".into()),
            ],
            body: None,
        })
        .await
    else {
        return GoApi::status(ProviderStatus::Unavailable);
    };
    let json = || serde_json::from_str::<Value>(&resp.text).ok();
    match resp.status {
        // 403 只有在應用程式明確回 EntitlementError 時才算「沒有 Go 方案」：proxy、WAF 的 403
        // 對帳號一無所知，當成方案答案會把本機估算也一起擋掉。
        403 => {
            let entitlement = json()
                .and_then(|b| b.get("error")?.get("type").cloned())
                .is_some_and(|t| t == "EntitlementError");
            if entitlement {
                GoApi {
                    entitled: Some(false),
                    ..GoApi::status(ProviderStatus::NotConfigured)
                }
            } else {
                GoApi::status(ProviderStatus::Unavailable)
            }
        }
        401 => GoApi::status(ProviderStatus::Unauthorized),
        429 => GoApi {
            retry_after: resp.retry_after,
            ..GoApi::status(ProviderStatus::SourceRateLimited)
        },
        200 => {
            let Some(payload) = json().filter(crate::usage::js::truthy) else {
                return GoApi::status(ProviderStatus::Unavailable);
            };
            let windows = parse_go_usage(&payload);
            if windows.is_empty() {
                return GoApi::status(ProviderStatus::Unavailable);
            }
            GoApi {
                windows,
                ..GoApi::status(ProviderStatus::Ok)
            }
        }
        _ => GoApi::status(ProviderStatus::Unavailable),
    }
}

/// 上游 `collectGoApi`：空的 key 就是「這個帳號沒有自己的 API 憑證」，不去讀 auth.json。
pub async fn collect_go_api<T: Transport>(t: &T, api_key: &str) -> GoApi {
    if api_key.is_empty() {
        return GoApi::status(ProviderStatus::NotConfigured);
    }
    let result = fetch_go_api(t, api_key).await;
    GoApi {
        identity: go_api_identity(api_key),
        ..result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn env(pairs: &[(&str, &str)], home: &std::path::Path) -> OpencodeEnv {
        OpencodeEnv::from_pairs(pairs, home)
    }

    #[test]
    fn usage_maps_rolling_weekly_and_monthly() {
        let w = parse_go_usage(&json!({
            "usage": {
                "rolling": { "percent": 42.5, "resetsAt": "2026-01-01T03:00:00Z", "status": "ok" },
                "weekly": { "percent": null },
                "monthly": { "status": "rate-limited", "resetsAt": "nope" }
            }
        }));
        assert_eq!(w.len(), 3);
        assert_eq!(w[0].used_percent, Some(42.5));
        assert_eq!(w[0].resets_at.as_deref(), Some("2026-01-01T03:00:00.000Z"));
        assert_eq!(w[1].used_percent, Some(0.0), "Number(null) is 0");
        assert_eq!(w[2].used_percent, Some(100.0));
        assert_eq!(w[2].resets_at, None);
        assert!(
            parse_go_usage(&json!({ "usage": { "rolling": { "percent": 1 } } })).is_empty(),
            "weekly is required"
        );
    }

    #[test]
    fn identity_is_the_full_key_digest() {
        // node -e "console.log(require('crypto').createHash('sha256').update('sk-test').digest('hex'))"
        assert_eq!(
            go_api_identity("sk-test"),
            "go-api:f3abf2a6cc4f00987743db5f544ba345b4899ae31f326d8ee9c4816de153c9e0"
        );
    }

    #[test]
    fn the_key_comes_from_env_then_inline_auth_then_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let data = home.join(".local").join("share").join("opencode");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(
            data.join("auth.json"),
            r#"{"opencode-go":{"type":"api","key":" 'sk-file' "},"opencode":{"type":"api","key":"sk-zen"}}"#,
        )
        .unwrap();
        let home_s = home.to_str().unwrap();
        assert_eq!(read_go_api_key(&env(&[("HOME", home_s)], home)), "sk-file");
        assert_eq!(
            read_go_api_key(&env(
                &[
                    ("HOME", home_s),
                    ("TOKEN_MONITOR_OPENCODE_API_KEY", " sk-env ")
                ],
                home
            )),
            "sk-env"
        );
        assert_eq!(
            read_go_api_key(&env(
                &[
                    ("HOME", home_s),
                    (
                        "OPENCODE_AUTH_CONTENT",
                        r#"{"opencode-go":{"key":"sk-inline"}}"#
                    )
                ],
                home
            )),
            "sk-inline",
            "the variable replaces the file and is not schema-checked"
        );
        assert_eq!(
            read_go_api_key(&env(
                &[
                    ("HOME", home_s),
                    (
                        "OPENCODE_AUTH_CONTENT",
                        r#"{"opencode-go":{"type":"oauth","key":"x"}}"#
                    )
                ],
                home
            )),
            ""
        );
        assert_eq!(
            read_go_api_key(&env(
                &[("HOME", home_s), ("OPENCODE_AUTH_CONTENT", "{broken")],
                home
            )),
            "sk-file",
            "unparseable content falls through to the file"
        );
        std::fs::write(
            data.join("auth.json"),
            r#"{"opencode-go":{"key":"sk-untyped"}}"#,
        )
        .unwrap();
        assert_eq!(
            read_go_api_key(&env(&[("HOME", home_s)], home)),
            "",
            "the file entry must say type api"
        );
    }
}
