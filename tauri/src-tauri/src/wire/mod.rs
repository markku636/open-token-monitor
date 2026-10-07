//! 與 hub 相容的 wire 型別。全部 camelCase，形狀以上游 `docs/API.md` 與
//! `normalizeDeviceRecord()` 為準；改動任何欄位前先跑 `npm run test:compat`。

pub mod limits;
pub mod period;
pub mod record;
pub mod time;

pub use limits::{
    LimitProvider, LimitWindow, LimitsSummary, ProviderStatus, ResetCredits, ResetGrant, WindowKind,
};
pub use period::{Capabilities, CostMap, CountMap, Period, Project, Session};
pub use record::{ClientStatus, DeviceRecord, Envelope, UsageSummary};
pub use time::{PeriodWindow, PeriodWindows};
