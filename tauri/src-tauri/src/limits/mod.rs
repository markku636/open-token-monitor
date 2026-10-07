//! 額度（limits）：Claude Code、Codex、Cursor 與 GitHub Copilot 的用量上限。
//!
//! - `claude.rs` / `codex.rs` / `cursor.rs`：各自的憑證、API 與對應（上游 src/shared/providers/）。
//! - `normalize.rs`：輸出收斂成上游 core.js 正規化後的形狀（hub 會再正規化一次）。
//! - `plan.rs`：方案名稱。`hash.rs`：與上游位元相同的帳號雜湊。
//! - `runtime.rs`：逐一探測、保留上一次成功的數字、退避、重置點與自適應的提早探測。由 device/runtime.rs
//!   驅動，**絕不**因本機用量變動而觸發。
//! - `burn_rate.rs`：自適應模式的消耗速度估計（上游 burnRate.js）。
//! - `seed.rs`：全新安裝時依偵測到的工具決定要查哪些額度（上游 initialLimitProviderSeed.js）。

pub mod burn_rate;
pub mod claude;
pub mod codex;
pub mod copilot;
pub mod cursor;
pub mod hash;
pub mod http;
pub mod normalize;
pub mod plan;
pub mod runtime;
pub mod seed;
