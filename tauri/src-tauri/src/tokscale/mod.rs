//! tokscale：真正讀取各 AI 工具本機紀錄的 Rust 掃描程式。我們隨附上游 token-monitor 釘選的
//! fork build（`scripts/vendor/tokscale.json`，由 `npm run ensure:tokscale` 下載並驗 sha256），
//! 以子程序呼叫；它只回報 token 數與金額，從不回報 prompt 或原始碼。

pub mod locate;
pub mod scan;
pub mod spawn;

pub use locate::{locate, TokscaleBinary};
pub use scan::{ScanPeriod, Scanner};
