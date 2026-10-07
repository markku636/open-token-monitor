use serde::Serialize;

use crate::hub::HubError;

/// 統一錯誤型別。對前端序列化成 `{ kind, code, message }`。
///
/// `#[error(...)]` 為中性英文，供 log / CLI stderr；使用者可見的 `message()` 是繁中。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("storage error: {0}")]
    Storage(String),

    #[error("invalid settings: {0}")]
    Settings(String),

    #[error("tokscale binary not found (searched: {})", .0.join(", "))]
    TokscaleMissing(Vec<String>),

    #[error("tokscale failed to start: {0}")]
    TokscaleSpawn(String),

    #[error("tokscale timed out after {0} ms")]
    TokscaleTimeout(u64),

    #[error("tokscale exited with code {code:?}: {stderr}")]
    TokscaleExit { code: Option<i32>, stderr: String },

    #[error("tokscale output is not JSON: {0}")]
    TokscaleOutput(String),

    #[error("hub is not configured")]
    HubNotConfigured,

    #[error("hub request failed: {0}")]
    Hub(#[from] HubError),

    #[error("secret store error: {0}")]
    Secret(String),

    #[error("invalid argument: {0}")]
    InvalidArgument(String),

    #[error("stopped")]
    Stopped,

    #[error("{0}")]
    Internal(String),
}

impl AppError {
    /// 錯誤大類（snake_case），前端 switch 用。
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::Storage(_) => "storage",
            AppError::Settings(_) => "settings",
            AppError::TokscaleMissing(_)
            | AppError::TokscaleSpawn(_)
            | AppError::TokscaleTimeout(_)
            | AppError::TokscaleExit { .. }
            | AppError::TokscaleOutput(_) => "tokscale",
            AppError::HubNotConfigured | AppError::Hub(_) => "hub",
            AppError::Secret(_) => "secret",
            AppError::InvalidArgument(_) => "invalid_argument",
            AppError::Stopped => "stopped",
            AppError::Internal(_) => "internal",
        }
    }

    /// 穩定的機器可讀錯誤碼（與語言無關）。
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Storage(_) => "ERR_STORAGE",
            AppError::Settings(_) => "ERR_SETTINGS",
            AppError::TokscaleMissing(_) => "ERR_TOKSCALE_MISSING",
            AppError::TokscaleSpawn(_) => "ERR_TOKSCALE_SPAWN",
            AppError::TokscaleTimeout(_) => "ERR_TOKSCALE_TIMEOUT",
            AppError::TokscaleExit { .. } => "ERR_TOKSCALE_EXIT",
            AppError::TokscaleOutput(_) => "ERR_TOKSCALE_OUTPUT",
            AppError::HubNotConfigured => "ERR_HUB_NOT_CONFIGURED",
            AppError::Hub(e) => e.code(),
            AppError::Secret(_) => "ERR_SECRET",
            AppError::InvalidArgument(_) => "ERR_INVALID_ARGUMENT",
            AppError::Stopped => "ERR_STOPPED",
            AppError::Internal(_) => "ERR_INTERNAL",
        }
    }

    /// 使用者可見訊息（繁中）。
    pub fn message(&self) -> String {
        match self {
            AppError::Storage(s) => format!("儲存失敗：{s}"),
            AppError::Settings(s) => format!("設定不正確：{s}"),
            AppError::TokscaleMissing(_) => {
                "找不到 tokscale 掃描程式，請重新安裝 Token Monitor".into()
            }
            AppError::TokscaleSpawn(s) => format!("無法啟動 tokscale：{s}"),
            AppError::TokscaleTimeout(ms) => format!("tokscale 掃描逾時（{ms} ms）"),
            AppError::TokscaleExit { code, stderr } => {
                let code = code.map(|c| c.to_string()).unwrap_or_else(|| "?".into());
                format!("tokscale 結束碼 {code}：{}", truncate(stderr, 300))
            }
            AppError::TokscaleOutput(s) => format!("tokscale 輸出無法解析：{}", truncate(s, 300)),
            AppError::HubNotConfigured => "尚未設定公司 hub".into(),
            AppError::Hub(e) => e.message(),
            AppError::Secret(s) => format!("金鑰存取失敗：{s}"),
            AppError::InvalidArgument(s) => format!("參數不正確：{s}"),
            AppError::Stopped => "已停止".into(),
            AppError::Internal(s) => s.clone(),
        }
    }
}

pub(crate) fn truncate(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max_chars).collect();
    out.push('…');
    out
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AppError", 3)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.message())?;
        s.end()
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Storage(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
