use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum GazeError {
    #[error("{0}")]
    Message(String),
    #[error("{0}")]
    InvalidPath(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Permission(String),
    #[error("{0}")]
    TooLarge(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    ToolMissing(String),
    #[error("{0}")]
    Unsupported(String),
    #[error("操作已取消")]
    Cancelled,
    #[error("文件或数据库操作失败: {0}")]
    Io(#[from] std::io::Error),
    #[error("数据库操作失败: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("数据格式错误: {0}")]
    Json(#[from] serde_json::Error),
    #[error("后台任务失败: {0}")]
    Join(#[from] tokio::task::JoinError),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl GazeError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidPath(_) => "invalidPath",
            Self::NotFound(_) => "notFound",
            Self::Permission(_) => "permissionDenied",
            Self::TooLarge(_) => "tooLarge",
            Self::Conflict(_) => "conflict",
            Self::ToolMissing(_) => "toolMissing",
            Self::Unsupported(_) => "unsupported",
            Self::Cancelled => "cancelled",
            Self::Io(error) => match error.kind() {
                std::io::ErrorKind::NotFound => "notFound",
                std::io::ErrorKind::PermissionDenied => "permissionDenied",
                _ => "ioError",
            },
            Self::Database(_) => "databaseError",
            Self::Json(_) => "invalidData",
            Self::Join(_) => "internalError",
            Self::Message(_) => "error",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Io(error) if error.kind() == std::io::ErrorKind::NotFound => {
                "文件不存在或已被移动。".to_string()
            }
            Self::Io(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                "没有权限访问该文件。".to_string()
            }
            other => other.to_string(),
        }
    }
}

impl From<GazeError> for CommandError {
    fn from(value: GazeError) -> Self {
        Self {
            code: value.code().to_string(),
            message: value.message(),
        }
    }
}

pub type GazeResult<T> = Result<T, GazeError>;
