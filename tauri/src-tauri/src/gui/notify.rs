//! 系統匣操作失敗的通知（上游 main.js `showTrayRefreshError`：OS 通知，不支援時改用錯誤對話框）。
//!
//! Windows：在我們自己的 tray 圖示上跳氣球提示（`Shell_NotifyIconW` + `NIF_INFO`），Windows 10/11
//! 會把它顯示成一般的通知。不必註冊 AppUserModelID（WinRT toast 要），dev 建置也看得到，也不需要
//! 另外的通知 plugin。tray-icon 不公開圖示的 `uID`（內部計數器，從 1 起），所以對 tray 的視窗
//! 逐一試：`NIM_MODIFY` 對不存在的 (hWnd, uID) 只會失敗、沒有副作用，那個視窗只有一個圖示。
//! 找不到圖示（或不是 Windows）時改用對話框（tauri-plugin-dialog，不阻塞）。

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// 氣球提示標題與內文的長度上限（含結尾的 NUL，`NOTIFYICONDATAW::szInfoTitle` / `szInfo`）。
#[cfg_attr(not(windows), allow(dead_code))]
const TITLE_LEN: usize = 64;
#[cfg_attr(not(windows), allow(dead_code))]
const BODY_LEN: usize = 256;

/// 把字串寫成以 NUL 結尾的 UTF-16，太長就截斷（不切開代理對）。
#[cfg_attr(not(windows), allow(dead_code))]
fn fill_wide(dst: &mut [u16], text: &str) {
    let Some(room) = dst.len().checked_sub(1) else {
        return;
    };
    let mut n = 0;
    for ch in text.chars() {
        let mut buf = [0u16; 2];
        let units = ch.encode_utf16(&mut buf);
        if n + units.len() > room {
            break;
        }
        dst[n..n + units.len()].copy_from_slice(units);
        n += units.len();
    }
    dst[n] = 0;
}

#[cfg(windows)]
fn balloon(app: &AppHandle, title: &str, body: &str) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::{
        Shell_NotifyIconW, NIF_INFO, NIIF_ERROR, NIM_MODIFY, NOTIFYICONDATAW,
    };
    /// tray-icon 的計數器從 1 起，app 只建一個圖示；多試幾個以防 Tauri 自己也用了計數器。
    const MAX_ID: u32 = 32;

    let Some(tray) = app.tray_by_id(super::tray::TRAY_ID) else {
        return false;
    };
    let Ok(hwnd) = tray.with_inner_tray_icon(|t| t.window_handle() as isize) else {
        return false;
    };
    let mut nid = NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: HWND(hwnd as *mut core::ffi::c_void),
        uFlags: NIF_INFO,
        dwInfoFlags: NIIF_ERROR,
        ..Default::default()
    };
    fill_wide(&mut nid.szInfoTitle[..TITLE_LEN], title);
    fill_wide(&mut nid.szInfo[..BODY_LEN], body);
    (0..=MAX_ID).any(|id| {
        nid.uID = id;
        unsafe { Shell_NotifyIconW(NIM_MODIFY, &nid) }.as_bool()
    })
}

#[cfg(not(windows))]
fn balloon(_app: &AppHandle, _title: &str, _body: &str) -> bool {
    false
}

/// 顯示錯誤通知；不阻塞呼叫端。
pub fn error(app: &AppHandle, title: &str, body: &str) {
    if balloon(app, title, body) {
        return;
    }
    app.dialog()
        .message(body)
        .title(title)
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(buf: &[u16]) -> String {
        let end = buf.iter().position(|&u| u == 0).unwrap();
        String::from_utf16(&buf[..end]).unwrap()
    }

    #[test]
    fn fills_nul_terminated_utf16_and_truncates() {
        let mut buf = [0xFFFFu16; 8];
        fill_wide(&mut buf, "掃描失敗");
        assert_eq!(read(&buf), "掃描失敗");
        fill_wide(&mut buf, "0123456789");
        assert_eq!(read(&buf), "0123456", "room for the NUL");
        assert_eq!(buf[7], 0);
    }

    #[test]
    fn never_splits_a_surrogate_pair() {
        let mut buf = [0xFFFFu16; 4];
        // 兩個 BMP 字元 + 一個需要兩個 UTF-16 單位的字：放不下的那個整個丟掉。
        fill_wide(&mut buf, "ab😀");
        assert_eq!(read(&buf), "ab");
        let mut empty: [u16; 0] = [];
        fill_wide(&mut empty, "x");
    }
}
