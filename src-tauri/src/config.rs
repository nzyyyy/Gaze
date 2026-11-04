use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{GazeError, GazeResult};

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppConfig {
    pub tools: ToolConfig,
    pub lsp: Vec<LspServerConfig>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ToolConfig {
    pub git: Option<PathBuf>,
    pub rg: Option<PathBuf>,
    pub ctags: Option<PathBuf>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerConfig {
    pub id: String,
    pub languages: Vec<String>,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub extensions: Vec<String>,
    #[serde(default)]
    pub initialization_options: Option<serde_json::Value>,
}

impl AppConfig {
    pub fn load(path: &Path) -> GazeResult<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let content = std::fs::read_to_string(path).map_err(|error| {
            GazeError::Message(format!("无法读取配置文件 {}: {error}", path.display()))
        })?;
        serde_json::from_str(&content).map_err(|error| {
            GazeError::Message(format!(
                "配置文件 {} 不是有效 JSON: {error}",
                path.display()
            ))
        })
    }

    pub fn servers(&self) -> Vec<LspServerConfig> {
        let mut servers = self.lsp.clone();
        for mut builtin in builtin_servers() {
            builtin.extensions.retain(|extension| {
                !self.lsp.iter().any(|server| {
                    server.extensions.iter().any(|claimed| {
                        claimed
                            .trim_start_matches('.')
                            .eq_ignore_ascii_case(extension)
                    })
                })
            });
            if !builtin.extensions.is_empty()
                && !servers.iter().any(|server| server.id == builtin.id)
            {
                servers.push(builtin);
            }
        }
        servers
    }
}

fn builtin_typescript() -> LspServerConfig {
    LspServerConfig {
        id: "typescript".to_string(),
        languages: [
            "typescript",
            "typescriptreact",
            "javascript",
            "javascriptreact",
        ]
        .into_iter()
        .map(str::to_string)
        .collect(),
        command: "typescript-language-server".to_string(),
        args: vec!["--stdio".to_string()],
        extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"]
            .into_iter()
            .map(str::to_string)
            .collect(),
        initialization_options: None,
    }
}

fn builtin_servers() -> Vec<LspServerConfig> {
    let mut servers = vec![builtin_typescript()];
    for (id, languages, command, args, extensions) in [
        (
            "python",
            "python",
            "pyright-langserver",
            "--stdio",
            "py pyi pyw",
        ),
        ("rust", "rust", "rust-analyzer", "", "rs"),
        ("go", "go", "gopls", "", "go"),
        (
            "clangd",
            "c cpp objective-c objective-cpp",
            "clangd",
            "",
            "c h cc hh cpp hpp cxx hxx m mm",
        ),
        ("java", "java", "jdtls", "", "java"),
        ("csharp", "csharp", "csharp-ls", "", "cs"),
        ("php", "php", "intelephense", "--stdio", "php phtml"),
        ("ruby", "ruby", "solargraph", "stdio", "rb rake gemspec"),
        ("lua", "lua", "lua-language-server", "", "lua"),
        (
            "bash",
            "shellscript",
            "bash-language-server",
            "start",
            "sh bash",
        ),
        ("swift", "swift", "sourcekit-lsp", "", "swift"),
        ("kotlin", "kotlin", "kotlin-lsp", "--stdio", "kt kts"),
        (
            "dart",
            "dart",
            "dart",
            "language-server --protocol=lsp",
            "dart",
        ),
        (
            "r",
            "r",
            "R",
            "--vanilla --slave -e languageserver::run()",
            "r",
        ),
        ("sql", "sql", "sqls", "", "sql"),
        (
            "html",
            "html",
            "vscode-html-language-server",
            "--stdio",
            "html htm",
        ),
        (
            "css",
            "css scss less",
            "vscode-css-language-server",
            "--stdio",
            "css scss less",
        ),
        (
            "json",
            "json jsonc",
            "vscode-json-language-server",
            "--stdio",
            "json jsonc",
        ),
        (
            "yaml",
            "yaml",
            "yaml-language-server",
            "--stdio",
            "yaml yml",
        ),
        ("vue", "vue", "vue-language-server", "--stdio", "vue"),
        ("svelte", "svelte", "svelteserver", "--stdio", "svelte"),
    ] {
        servers.push(LspServerConfig {
            id: id.to_string(),
            languages: languages.split_whitespace().map(str::to_string).collect(),
            command: command.to_string(),
            args: args.split_whitespace().map(str::to_string).collect(),
            extensions: extensions.split_whitespace().map(str::to_string).collect(),
            initialization_options: None,
        });
    }
    servers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_typescript_is_added_but_user_language_claims_win() {
        let mut config = AppConfig::default();
        assert!(config
            .servers()
            .iter()
            .any(|server| server.id == "typescript"));

        config.lsp.push(LspServerConfig {
            id: "custom-ts".to_string(),
            languages: vec!["typescript".to_string()],
            command: "custom".to_string(),
            args: vec![],
            extensions: vec!["ts".to_string()],
            initialization_options: None,
        });
        let servers = config.servers();
        assert_eq!(servers[0].id, "custom-ts");
        assert!(!servers
            .iter()
            .find(|server| server.id == "typescript")
            .unwrap()
            .extensions
            .contains(&"ts".to_string()));
    }

    #[test]
    fn common_languages_have_unique_default_extensions_and_ids() {
        let servers = AppConfig::default().servers();
        let mut extensions = std::collections::HashSet::new();
        let mut ids = std::collections::HashSet::new();
        for server in &servers {
            assert!(ids.insert(&server.id));
            for extension in &server.extensions {
                assert!(extensions.insert(extension));
            }
        }
        for extension in [
            "tsx", "py", "rs", "go", "cpp", "java", "cs", "php", "rb", "lua", "sh", "swift", "kt",
            "dart", "r", "sql", "html", "css", "json", "yaml", "vue", "svelte",
        ] {
            assert!(
                extensions.contains(&extension.to_string()),
                "missing {extension}"
            );
        }
    }

    #[test]
    fn custom_server_ids_do_not_start_duplicate_builtin_sessions() {
        let mut config = AppConfig::default();
        config.lsp.push(LspServerConfig {
            id: "python".to_string(),
            languages: vec!["python".to_string()],
            command: "my-python-server".to_string(),
            args: vec![],
            extensions: vec![".PY".to_string()],
            initialization_options: None,
        });
        assert_eq!(
            config
                .servers()
                .iter()
                .filter(|server| server.id == "python")
                .count(),
            1
        );
    }
}
