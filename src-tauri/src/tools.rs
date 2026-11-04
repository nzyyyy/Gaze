use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::config::{AppConfig, LspServerConfig};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCapabilities {
    pub rg_available: bool,
    pub ctags_available: bool,
    pub ctags_message: Option<String>,
    pub config_message: Option<String>,
    pub lsp_servers: Vec<LspCapability>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCapability {
    pub id: String,
    pub languages: Vec<String>,
    pub available: bool,
}

#[derive(Clone)]
pub struct Tools {
    pub rg: Option<PathBuf>,
    pub ctags: Option<PathBuf>,
    pub lsp: Vec<ResolvedLspServer>,
    pub config_message: Option<String>,
}

#[derive(Clone)]
pub struct ResolvedLspServer {
    pub config: LspServerConfig,
    pub executable: Option<PathBuf>,
}

impl Tools {
    pub fn detect(config: &AppConfig) -> Self {
        let rg = resolve_executable(config.tools.rg.as_deref(), "rg", &["/opt/homebrew/bin/rg"]);
        let ctags = resolve_ctags(config.tools.ctags.as_deref());
        let lsp = config
            .servers()
            .into_iter()
            .map(|server| {
                let executable =
                    resolve_executable(Some(Path::new(&server.command)), &server.command, &[]);
                ResolvedLspServer {
                    config: server,
                    executable,
                }
            })
            .collect();
        Self {
            rg,
            ctags,
            lsp,
            config_message: None,
        }
    }

    pub fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities {
            rg_available: self.rg.is_some(),
            ctags_available: self.ctags.is_some(),
            ctags_message: if self.ctags.is_some() {
                None
            } else {
                Some("未找到 universal-ctags；文件大纲和符号搜索不可用。".to_string())
            },
            config_message: self.config_message.clone(),
            lsp_servers: self
                .lsp
                .iter()
                .map(|server| LspCapability {
                    id: server.config.id.clone(),
                    languages: server.config.languages.clone(),
                    available: server.executable.is_some(),
                })
                .collect(),
        }
    }
}

pub fn resolve_executable(
    configured: Option<&Path>,
    command: &str,
    fallbacks: &[&str],
) -> Option<PathBuf> {
    if let Some(path) = configured {
        if path.components().count() > 1 {
            return executable_file(path);
        }
        return which::which(path).ok();
    }
    if let Ok(path) = which::which(command) {
        return Some(path);
    }
    fallbacks
        .iter()
        .map(PathBuf::from)
        .find_map(|path| executable_file(&path))
}

fn executable_file(path: &Path) -> Option<PathBuf> {
    if path.is_file() {
        Some(path.to_path_buf())
    } else {
        None
    }
}

fn resolve_ctags(configured: Option<&Path>) -> Option<PathBuf> {
    let candidates: Vec<PathBuf> = if let Some(path) = configured {
        vec![path.to_path_buf()]
    } else {
        ["uctags", "ctags"]
            .iter()
            .filter_map(|name| which::which(name).ok())
            .chain(std::iter::once(PathBuf::from("/opt/homebrew/bin/ctags")))
            .collect()
    };

    candidates.into_iter().find(|path| is_universal_ctags(path))
}

fn is_universal_ctags(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    Command::new(path)
        .arg("--version")
        .output()
        .map(|output| {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            stdout.contains("Universal Ctags") || stderr.contains("Universal Ctags")
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_missing_tool_is_reported_missing() {
        assert!(
            resolve_executable(Some(Path::new("/definitely/not/a/tool")), "tool", &[]).is_none()
        );
    }
}
