//! 額度（limits）：Claude Code、Codex、Cursor 與 GitHub Copilot 的用量上限。
//!
//! - `claude.rs` / `codex.rs` / `cursor.rs`：各自的憑證、API 與對應（上游 src/shared/providers/）。
//! - `normalize.rs`：輸出收斂成上游 core.js 正規化後的形狀（hub 會再正規化一次）；
//!   `reset_credits.rs` 是其中額度重置券（Claude 的 reset grants、Codex 的 reset credits）那一段。
//! - `plan.rs`：方案名稱。`hash.rs`：與上游位元相同的帳號雜湊。
//! - `runtime.rs`：逐一探測、保留上一次成功的數字、退避。由 device/runtime.rs 定時驅動，
//!   **絕不**因本機用量變動而觸發。

pub mod claude;
pub mod codex;
pub mod copilot;
pub mod cursor;
pub mod hash;
pub mod http;
pub mod normalize;
pub mod plan;
pub mod reset_credits;
pub mod runtime;
