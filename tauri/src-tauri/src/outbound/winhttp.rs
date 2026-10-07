//! WinHTTP 的系統 proxy 來源（Windows）。
//!
//! - `WinHttpGetIEProxyConfigForCurrentUser`：目前使用者的「自動偵測設定」、「自動設定指令碼」、手動
//!   proxy 與排除清單（與 Chromium / Edge 讀的是同一份）。
//! - `WinHttpGetProxyForUrl`：PAC / WPAD。預設交給 WinHTTP Auto-Proxy 服務（系統共用指令碼快取）；
//!   PAC 伺服器要求登入時照 Microsoft 的建議，先不帶、失敗再以目前使用者的認證重試一次。
//!   回傳的字串以 `GlobalFree` 釋放。

use std::ffi::c_void;
use std::sync::OnceLock;

use windows::core::{BOOL, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{GlobalFree, HGLOBAL};
use windows::Win32::Networking::WinHttp::{
    WinHttpGetIEProxyConfigForCurrentUser, WinHttpGetProxyForUrl, WinHttpOpen, WinHttpSetTimeouts,
    WINHTTP_ACCESS_TYPE_NAMED_PROXY, WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_AUTOPROXY_AUTO_DETECT,
    WINHTTP_AUTOPROXY_CONFIG_URL, WINHTTP_AUTOPROXY_OPTIONS, WINHTTP_AUTO_DETECT_TYPE_DHCP,
    WINHTTP_AUTO_DETECT_TYPE_DNS_A, WINHTTP_CURRENT_USER_IE_PROXY_CONFIG, WINHTTP_PROXY_INFO,
};

use super::system::{IeConfig, PacAnswer, PacError, SystemSource};

const ERROR_WINHTTP_TIMEOUT: u32 = 12002;
const ERROR_WINHTTP_INVALID_URL: u32 = 12005;
const ERROR_WINHTTP_UNRECOGNIZED_SCHEME: u32 = 12006;
const ERROR_WINHTTP_LOGIN_FAILURE: u32 = 12015;
const ERROR_WINHTTP_BAD_AUTO_PROXY_SCRIPT: u32 = 12166;
const ERROR_WINHTTP_UNABLE_TO_DOWNLOAD_SCRIPT: u32 = 12167;
const ERROR_WINHTTP_AUTO_PROXY_SERVICE_ERROR: u32 = 12178;
const ERROR_WINHTTP_AUTODETECTION_FAILED: u32 = 12180;

pub struct WinHttpSource;

/// PAC 查詢用的 session（同步模式、本身不走 proxy）；整個程序共用，不關閉。
struct Session(*mut c_void);

// WinHTTP 的 session handle 可以跨執行緒使用。
unsafe impl Send for Session {}
unsafe impl Sync for Session {}

fn session() -> Result<*mut c_void, PacError> {
    static SESSION: OnceLock<Option<Session>> = OnceLock::new();
    SESSION
        .get_or_init(|| {
            let agent = HSTRING::from("TokenMonitor-ProxyResolver");
            let handle = unsafe {
                WinHttpOpen(
                    &agent,
                    WINHTTP_ACCESS_TYPE_NO_PROXY,
                    PCWSTR::null(),
                    PCWSTR::null(),
                    0,
                )
            };
            if handle.is_null() {
                return None;
            }
            // 下載 PAC 指令碼的逾時（程序內解析時才用得到）：解析、連線、送出各 5 秒，接收 10 秒。
            let _ = unsafe { WinHttpSetTimeouts(handle, 5_000, 5_000, 5_000, 10_000) };
            Some(Session(handle))
        })
        .as_ref()
        .map(|s| s.0)
        .ok_or_else(|| PacError {
            message: "WinHttpOpen failed".into(),
            script_failed: true,
        })
}

/// 讀出 WinHTTP 配置的字串並釋放；空字串視為沒有。
fn take(p: PWSTR) -> Option<String> {
    if p.is_null() {
        return None;
    }
    let s = unsafe { p.to_string() }.ok();
    unsafe {
        let _ = GlobalFree(Some(HGLOBAL(p.0 as *mut c_void)));
    }
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// `HRESULT_FROM_WIN32(code)` → WinHTTP 的錯誤碼。
fn win32_code(e: &windows::core::Error) -> u32 {
    let h = e.code().0 as u32;
    if h & 0xFFFF_0000 == 0x8007_0000 {
        h & 0xFFFF
    } else {
        h
    }
}

fn describe(code: u32) -> &'static str {
    match code {
        ERROR_WINHTTP_AUTODETECTION_FAILED => "WPAD found no proxy auto-config script",
        ERROR_WINHTTP_UNABLE_TO_DOWNLOAD_SCRIPT => {
            "the proxy auto-config script could not be downloaded"
        }
        ERROR_WINHTTP_BAD_AUTO_PROXY_SCRIPT => "the proxy auto-config script failed to run",
        ERROR_WINHTTP_AUTO_PROXY_SERVICE_ERROR => "the WinHTTP auto-proxy service failed",
        ERROR_WINHTTP_LOGIN_FAILURE => "the proxy auto-config server refused the login",
        ERROR_WINHTTP_TIMEOUT => "the proxy auto-config lookup timed out",
        ERROR_WINHTTP_INVALID_URL | ERROR_WINHTTP_UNRECOGNIZED_SCHEME => "invalid URL",
        _ => "WinHTTP error",
    }
}

impl SystemSource for WinHttpSource {
    fn ie_config(&self) -> Result<IeConfig, String> {
        let mut raw = WINHTTP_CURRENT_USER_IE_PROXY_CONFIG::default();
        unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut raw) }
            .map_err(|e| format!("WinHttpGetIEProxyConfigForCurrentUser: {e}"))?;
        Ok(IeConfig {
            auto_detect: raw.fAutoDetect.as_bool(),
            auto_config_url: take(raw.lpszAutoConfigUrl),
            proxy: take(raw.lpszProxy),
            bypass: take(raw.lpszProxyBypass),
        })
    }

    fn pac(&self, url: &str, config: &IeConfig) -> Result<PacAnswer, PacError> {
        let session = session()?;
        let script = config.auto_config_url.as_deref().map(HSTRING::from);
        let mut options = WINHTTP_AUTOPROXY_OPTIONS::default();
        if config.auto_detect {
            options.dwFlags |= WINHTTP_AUTOPROXY_AUTO_DETECT;
            options.dwAutoDetectFlags =
                WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A;
        }
        if let Some(script) = &script {
            options.dwFlags |= WINHTTP_AUTOPROXY_CONFIG_URL;
            options.lpszAutoConfigUrl = PCWSTR(script.as_ptr());
        }
        let target = HSTRING::from(url);
        let mut info = WINHTTP_PROXY_INFO::default();
        let mut result =
            unsafe { WinHttpGetProxyForUrl(session, &target, &mut options, &mut info) };
        if matches!(&result, Err(e) if win32_code(e) == ERROR_WINHTTP_LOGIN_FAILURE) {
            options.fAutoLogonIfChallenged = BOOL::from(true);
            info = WINHTTP_PROXY_INFO::default();
            result = unsafe { WinHttpGetProxyForUrl(session, &target, &mut options, &mut info) };
        }
        match result {
            Ok(()) => {
                let list = take(info.lpszProxy);
                let bypass = take(info.lpszProxyBypass);
                match list {
                    Some(list) if info.dwAccessType == WINHTTP_ACCESS_TYPE_NAMED_PROXY => {
                        Ok(PacAnswer::Proxy { list, bypass })
                    }
                    _ => Ok(PacAnswer::Direct),
                }
            }
            Err(e) => {
                let code = win32_code(&e);
                Err(PacError {
                    message: format!("{} (WinHTTP {code})", describe(code)),
                    script_failed: !matches!(
                        code,
                        ERROR_WINHTTP_INVALID_URL | ERROR_WINHTTP_UNRECOGNIZED_SCHEME
                    ),
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hresults_map_back_to_winhttp_codes() {
        let e = windows::core::Error::from_hresult(windows::core::HRESULT(0x8007_2F94_u32 as i32));
        assert_eq!(win32_code(&e), ERROR_WINHTTP_AUTODETECTION_FAILED);
        assert_eq!(describe(12180), "WPAD found no proxy auto-config script");
    }
}
