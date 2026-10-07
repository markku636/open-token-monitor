//! 編譯時內建的常數。
//!
//! hub 位置與 client secret 由 build-installer.ps1 以環境變數 `TM_HUB_URL` /
//! `TM_CLIENT_SECRET` 在編譯時打進 binary（刻意接受 secret 可被解出，因為 client
//! 角色只能上傳與讀取）。secret 刻意不放 tauri.conf.json、不進前端 bundle。
//! 沒有這兩個值的建置（`npm run tauri dev`、CI）是 `dev` 通道：只做本機統計，不上傳、不更新。

/// 與 `tauri.conf.json` 的 `identifier` 必須一致：它同時是設定目錄名稱。
pub const APP_IDENTIFIER: &str = "io.github.markku636.tokenmonitor";

/// 回報給 hub 的 `agentVersion`；版本單一事實來源是 tauri.conf.json，打包腳本同步 Cargo.toml。
pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// `corp`（內建公司 secret）或 `dev`。由 build.rs 依 `TM_CLIENT_SECRET` 是否存在決定。
pub const BUILD_CHANNEL: &str = env!("TM_BUILD_CHANNEL");

const HUB_URL: Option<&str> = option_env!("TM_HUB_URL");
const CLIENT_SECRET: Option<&str> = option_env!("TM_CLIENT_SECRET");

/// 內建的 hub 網址（去掉尾端斜線）；未內建時為 `None`。
pub fn hub_url() -> Option<&'static str> {
    HUB_URL
        .map(|s| s.trim().trim_end_matches('/'))
        .filter(|s| !s.is_empty())
}

/// 內建的 client secret；未內建時為 `None`。
pub fn client_secret() -> Option<&'static str> {
    CLIENT_SECRET.map(str::trim).filter(|s| !s.is_empty())
}

pub fn is_corp_build() -> bool {
    BUILD_CHANNEL == "corp"
}
