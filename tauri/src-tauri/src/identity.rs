//! 裝置身分與 envelope（hostname、platform、OS、版本）。
//!
//! deviceId 規則：
//! 1. 官方 Electron 版的 `%APPDATA%\Token Monitor\settings.json` 有 `deviceId` → 沿用，hub 上維持同一台。
//! 2. 該檔存在但沒有 `deviceId`（官方版預設用 hostname）→ 用上游的 hostname 規則，同樣維持同一台。
//! 3. 否則產生 GUID。重灌或改名後就是新裝置，由管理者在 dashboard 重新對應員工。
//!
//! 產生後寫進我們自己的 settings.json，之後永不改變。

use std::path::Path;

use crate::baked::AGENT_VERSION;
use crate::wire::Envelope;

pub const RUNTIME_WIDGET: &str = "tauri-widget";
pub const RUNTIME_AGENT: &str = "tauri-agent";

/// 官方 Electron 版的 userData 目錄名稱（productName）。
const ELECTRON_USER_DATA_DIR: &str = "Token Monitor";

pub fn hostname() -> String {
    gethostname::gethostname().to_string_lossy().into_owned()
}

/// 上游 `defaultDeviceId()`（src/shared/config.js）：hostname 小寫、非 `[a-z0-9_-]` 換 `-`、去頭尾 `-`。
pub fn hostname_device_id(hostname: &str) -> String {
    let lower = hostname.to_lowercase();
    let mut out = String::new();
    let mut in_run = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-' {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "device".into()
    } else {
        trimmed.to_string()
    }
}

/// 依 D9 規則決定第一次啟動的 deviceId。`electron_dir` 是官方版 userData 目錄（可注入測試）。
pub fn initial_device_id_in(electron_dir: Option<&Path>, hostname: &str) -> (String, &'static str) {
    if let Some(dir) = electron_dir {
        let file = dir.join("settings.json");
        if file.exists() {
            let adopted = std::fs::read(&file)
                .ok()
                .and_then(|b| {
                    let text = b
                        .strip_prefix(b"\xEF\xBB\xBF")
                        .map(<[u8]>::to_vec)
                        .unwrap_or(b);
                    serde_json::from_slice::<serde_json::Value>(&text).ok()
                })
                .and_then(|v| {
                    v.get("deviceId")
                        .and_then(|d| d.as_str())
                        .map(str::trim)
                        .map(str::to_string)
                })
                .filter(|d| !d.is_empty());
            return match adopted {
                Some(id) => (id, "electron-settings"),
                None => (hostname_device_id(hostname), "electron-hostname"),
            };
        }
    }
    (uuid::Uuid::new_v4().to_string(), "generated")
}

pub fn initial_device_id() -> (String, &'static str) {
    let electron_dir = dirs::config_dir().map(|d| d.join(ELECTRON_USER_DATA_DIR));
    initial_device_id_in(electron_dir.as_deref(), &hostname())
}

/// Node 的 `${process.platform}-${process.arch}`。
pub fn platform() -> String {
    let os = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    };
    format!("{os}-{arch}")
}

/// `(osName, osVersion)`，上限 64 / 128 字（hub 的 normalizeDeviceOs*）。
pub fn os_info() -> (String, String) {
    let (name, version) = detect_os();
    (
        name.trim().chars().take(64).collect(),
        version.trim().chars().take(128).collect(),
    )
}

#[cfg(windows)]
fn detect_os() -> (String, String) {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion");
    let get = |name: &str| -> String {
        key.as_ref()
            .ok()
            .and_then(|k| k.get_value::<String, _>(name).ok())
            .unwrap_or_default()
    };
    let build: u32 = {
        let b = get("CurrentBuildNumber");
        let b = if b.is_empty() { get("CurrentBuild") } else { b };
        b.trim().parse().unwrap_or(0)
    };
    let name = windows_product_name(&get("ProductName"), build);
    let display = {
        let d = get("DisplayVersion");
        if d.is_empty() {
            get("ReleaseId")
        } else {
            d
        }
    };
    let version = if !display.trim().is_empty() {
        display
    } else if build > 0 {
        format!("build {build}")
    } else {
        String::new()
    };
    (name, version)
}

#[cfg(not(windows))]
fn detect_os() -> (String, String) {
    // v1 只打包 Windows；其他平台不送（hub 接受缺欄位）。
    (String::new(), String::new())
}

/// 上游 osVersion.js `windowsProductName`：登錄檔在 Windows 11 上仍寫 "Windows 10"，靠 build ≥ 22000 更正。
pub fn windows_product_name(product_name: &str, build: u32) -> String {
    let raw = product_name.trim();
    let raw = raw
        .strip_prefix("Microsoft ")
        .or_else(|| raw.strip_prefix("microsoft "))
        .unwrap_or(raw);
    let lower = raw.to_lowercase();
    if let Some(pos) = lower.find("windows server ") {
        let year: String = raw[pos + 15..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if year.len() == 4 {
            return format!("Windows Server {year}");
        }
    }
    if let Some(pos) = lower.find("windows ") {
        let num: String = raw[pos + 8..]
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        let num = num.trim_end_matches('.');
        if !num.is_empty() {
            if num == "10" && build >= 22000 {
                return "Windows 11".into();
            }
            return format!("Windows {num}");
        }
    }
    "Windows".into()
}

pub fn envelope(device_id: &str, runtime: &str) -> Envelope {
    let (os_name, os_version) = os_info();
    Envelope {
        device_id: device_id.to_string(),
        hostname: hostname(),
        platform: platform(),
        os_name,
        os_version,
        agent_version: AGENT_VERSION.to_string(),
        agent_runtime: runtime.to_string(),
        // 由呼叫端以 with_owner_email() 帶入（設定頁、環境變數或 tm-agent 的 --owner-email）。
        owner_email: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hostname_slug_matches_upstream() {
        assert_eq!(hostname_device_id("PC-LAPTOP-064"), "pc-laptop-064");
        assert_eq!(
            hostname_device_id("Mark's MacBook Pro"),
            "mark-s-macbook-pro"
        );
        assert_eq!(hostname_device_id("--"), "device");
    }

    #[test]
    fn d9_rules() {
        let dir = tempfile::tempdir().unwrap();
        // 沒有官方版 → GUID
        let (id, how) = initial_device_id_in(Some(&dir.path().join("none")), "PC-1");
        assert_eq!(how, "generated");
        assert_eq!(uuid::Uuid::parse_str(&id).unwrap().get_version_num(), 4);
        // 官方版有設定但沒有 deviceId → hostname 規則
        std::fs::write(dir.path().join("settings.json"), r#"{"hubMode":"client"}"#).unwrap();
        assert_eq!(
            initial_device_id_in(Some(dir.path()), "PC-1"),
            ("pc-1".into(), "electron-hostname")
        );
        // 官方版有 deviceId → 沿用
        std::fs::write(
            dir.path().join("settings.json"),
            "\u{feff}{\"deviceId\":\"abc-123\"}",
        )
        .unwrap();
        assert_eq!(
            initial_device_id_in(Some(dir.path()), "PC-1"),
            ("abc-123".into(), "electron-settings")
        );
    }

    #[test]
    fn windows_names() {
        assert_eq!(windows_product_name("Windows 10 Pro", 26200), "Windows 11");
        assert_eq!(
            windows_product_name("Windows 10 Enterprise", 19045),
            "Windows 10"
        );
        assert_eq!(
            windows_product_name("Microsoft Windows Server 2022 Datacenter", 20348),
            "Windows Server 2022"
        );
        assert_eq!(windows_product_name("", 0), "Windows");
    }

    #[test]
    fn platform_is_node_style() {
        let p = platform();
        assert!(p.contains('-'));
        #[cfg(all(windows, target_arch = "x86_64"))]
        assert_eq!(p, "win32-x64");
    }
}
