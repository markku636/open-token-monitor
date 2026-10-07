//! Token Monitor 員工端（Tauri 2 + Rust）。
//!
//! 分層：核心模組（收集、wire record、hub client、設定）完全不依賴 Tauri，
//! 由 GUI（`gui` feature）與無頭代理程式 `tm-agent` 共用；GUI 專屬的指令、tray、視窗
//! 行為全部收在 `gui` 模組，以 `#[cfg(feature = "gui")]` 一次隔開。
//! 驗證門檻：`cargo test --no-default-features --lib` 必須在不編 Tauri 的情況下通過。

pub mod baked;
pub mod cli;
pub mod collector;
pub mod currency;
pub mod detail;
pub mod device;
pub mod display;
pub mod error;
pub mod export;
pub mod hub;
pub mod identity;
pub mod limits;
pub mod logging;
pub mod ranges;
pub mod secrets;
pub mod service_status;
pub mod session_detail;
pub mod settings;
pub mod store;
pub mod tokscale;
pub mod trends;
pub mod update;
pub mod usage;
pub mod view_prefs;
pub mod wire;

#[cfg(feature = "gui")]
mod gui;

#[cfg(feature = "gui")]
pub use gui::run;
