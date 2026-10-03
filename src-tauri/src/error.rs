use serde::{Serialize, Serializer};

/// A serializable error surfaced to the frontend through Tauri commands.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Http(String),
    #[error("规则解析失败: {0}")]
    Rule(String),
    #[error("脚本执行失败: {0}")]
    Script(String),
    #[error("网络请求失败: {0}")]
    Network(String),
    #[error("未找到源: {0}")]
    NotFound(String),
    #[error("存储错误: {0}")]
    Storage(String),
    #[error("导入失败: {0}")]
    Import(String),
    #[error("{0}")]
    Other(String),
}

impl AppError {
    pub fn other(msg: impl Into<String>) -> Self {
        AppError::Other(msg.into())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::Network(e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Storage(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Import(e.to_string())
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;