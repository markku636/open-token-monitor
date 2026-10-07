//! 額度（limits）：Claude Code、Codex、Cursor、Antigravity 與 GitHub Copilot 的用量上限。
//!
//! - `claude.rs` / `codex.rs` / `cursor.rs`：各自的憑證、API 與對應（上游 src/shared/providers/）。
//! - `antigravity.rs`：本機 language server 的 RPC；`antigravity_os.rs` 列程序與監聽的 port。
//! - `normalize.rs`：輸出收斂成上游 core.js 正規化後的形狀（hub 會再正規化一次）。
//! - `plan.rs`：方案名稱。`hash.rs`：與上游位元相同的帳號雜湊。
//! - `runtime.rs`：逐一探測、保留上一次成功的數字、退避。由 device/runtime.rs 定時驅動，
//!   **絕不**因本機用量變動而觸發。

pub mod antigravity;
pub mod antigravity_os;
pub mod claude;
pub mod codex;
pub mod copilot;
pub mod cursor;
pub mod hash;
pub mod http;
pub mod normalize;
pub mod plan;
pub mod runtime;
