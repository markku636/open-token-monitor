//! tray 與 tooltip 的字串（前端的字串在 src/locales/）。
//!
//! 「自動」要看系統語言，而前端已經用 navigator.language 解析過；為了兩邊一致，前端啟動後以
//! `ui_language` 指令告訴 Rust 目前的語言，tray 跟著換字。繁中原文就是 key。

use std::sync::atomic::{AtomicBool, Ordering};

static ENGLISH: AtomicBool = AtomicBool::new(false);

pub fn set_english(en: bool) {
    ENGLISH.store(en, Ordering::SeqCst);
}

pub fn is_english() -> bool {
    ENGLISH.load(Ordering::SeqCst)
}

const EN: &[(&str, &str)] = &[
    ("顯示／隱藏", "Show / hide"),
    ("立即重新掃描", "Rescan now"),
    ("正在重新掃描…", "Rescanning…"),
    ("重新掃描失敗", "Rescan failed"),
    ("收集程序沒有在執行", "The collector is not running"),
    ("邊緣額度條", "Edge limits dock"),
    ("顯示邊緣額度條", "Show edge limits dock"),
    ("自動隱藏", "Auto-hide"),
    ("永遠顯示", "Always visible"),
    ("左側", "Left"),
    ("右側", "Right"),
    ("設定…", "Settings…"),
    ("用量儀表板…", "Usage dashboard…"),
    ("開啟日誌資料夾", "Open log folder"),
    ("結束 Token Monitor", "Quit Token Monitor"),
    ("自動更新未啟用", "Automatic updates are off"),
    ("正在檢查更新…", "Checking for updates…"),
    ("檢查更新", "Check for updates"),
    ("正在下載 v{v}…", "Downloading v{v}…"),
    ("下載更新（v{v}）", "Download update (v{v})"),
    ("重新啟動以更新（v{v}）", "Restart to update (v{v})"),
    ("正在安裝 v{v}…", "Installing v{v}…"),
    ("今日 {n} tokens · {c}", "Today {n} tokens · {c}"),
    ("開啟", "Open"),
    ("本機", "This PC"),
    ("全公司", "Company"),
    ("額度", "Limits"),
    ("趨勢", "Trends"),
    ("視窗模式", "Window mode"),
    ("浮動", "Floating"),
    ("標準", "Standard"),
    ("桌面", "Desktop"),
    ("系統匣", "Tray"),
    ("系統匣顯示", "Tray display"),
    ("圖示", "Icon"),
    ("額度長條", "Limit bars"),
    ("各工具 5 小時", "5-hour per tool"),
    ("5 小時", "5h"),
    ("每日", "daily"),
    ("每週", "weekly"),
    ("帳單", "billing"),
    ("{name} 已用：{parts}", "{name} used: {parts}"),
];

/// 翻譯並代入 `{name}`。
pub fn tr(source: &str, vars: &[(&str, &str)]) -> String {
    let text = if is_english() {
        EN.iter()
            .find(|(zh, _)| *zh == source)
            .map(|(_, en)| *en)
            .unwrap_or(source)
    } else {
        source
    };
    vars.iter().fold(text.to_string(), |acc, (k, v)| {
        acc.replace(&format!("{{{k}}}"), v)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_and_fills_placeholders() {
        set_english(true);
        assert_eq!(
            tr("重新啟動以更新（v{v}）", &[("v", "0.2.0")]),
            "Restart to update (v0.2.0)"
        );
        set_english(false);
        assert_eq!(
            tr("重新啟動以更新（v{v}）", &[("v", "0.2.0")]),
            "重新啟動以更新（v0.2.0）"
        );
    }
}
