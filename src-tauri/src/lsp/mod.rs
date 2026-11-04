mod client;
mod completion;
mod hover;
mod positions;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use url::Url;

pub use completion::CompletionResult;
pub use hover::HoverContent;
pub use positions::{LspPosition, LspRange, PositionEncoding, TextIndex};

use crate::error::{GazeError, GazeResult};
use crate::files::{path_to_relative, read_file};
use crate::models::{
    DocumentSymbol, FileContent, FileFingerprint, NavigationResult, OutlineResult, Project,
    SymbolLocation, TextPosition,
};
use crate::symbols::word_at;
use crate::tools::{ResolvedLspServer, Tools};

use self::client::LspClient;

const MAX_REFERENCES: usize = 1_000;
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(20);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspStatus {
    pub project_id: String,
    pub server_id: String,
    pub state: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy)]
struct ServerCapabilities {
    definition: bool,
    references: bool,
    implementation: bool,
    document_symbol: bool,
    completion: bool,
    hover: bool,
}

struct OpenDocument {
    version: i64,
    fingerprint: FileFingerprint,
    text: Arc<String>,
    dirty: bool,
}

struct LoadedDocument {
    uri: String,
    text: Arc<String>,
    index: TextIndex,
}

struct LspSession {
    project: Project,
    server_id: String,
    client: LspClient,
    encoding: PositionEncoding,
    capabilities: ServerCapabilities,
    documents: tokio::sync::Mutex<HashMap<String, OpenDocument>>,
    completion_triggers: Vec<String>,
}

impl LspSession {
    async fn start(
        project: Project,
        server: &ResolvedLspServer,
        root_uri: &Url,
    ) -> GazeResult<Self> {
        let executable = server.executable.as_ref().ok_or_else(|| {
            GazeError::ToolMissing(format!(
                "语言服务器 {}（{}）未安装或不可执行。",
                server.config.id, server.config.command
            ))
        })?;
        let client = LspClient::spawn(
            executable,
            &server.config.args,
            Path::new(&project.root),
            root_uri.as_str(),
            &project.name,
        )
        .await?;
        let initialize = json!({
            "processId": std::process::id(),
            "clientInfo": { "name": "Gaze", "version": env!("CARGO_PKG_VERSION") },
            "rootUri": root_uri.as_str(),
            "workspaceFolders": [{ "uri": root_uri.as_str(), "name": project.name }],
            "capabilities": {
                "workspace": {
                    "workspaceFolders": true,
                    "configuration": true,
                    "applyEdit": false
                },
                "textDocument": {
                    "synchronization": {
                        "dynamicRegistration": false,
                        "willSave": false,
                        "willSaveWaitUntil": false,
                        "didSave": false
                    },
                    "definition": { "linkSupport": true },
                    "references": {},
                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                    "implementation": { "linkSupport": true },
                    "completion": {
                        "contextSupport": true,
                        "completionItem": {
                            "snippetSupport": false,
                            "documentationFormat": ["plaintext"],
                            "insertReplaceSupport": true
                        }
                    },
                    "documentSymbol": {
                        "hierarchicalDocumentSymbolSupport": true,
                        "symbolKind": { "valueSet": (1..=26).collect::<Vec<_>>() }
                    }
                },
                "general": {
                    "positionEncodings": ["utf-16", "utf-8", "utf-32"]
                },
                "window": { "workDoneProgress": true }
            },
            "initializationOptions": server.config.initialization_options,
        });
        let result = match client
            .request("initialize", initialize, INITIALIZE_TIMEOUT)
            .await
        {
            Ok(result) => result,
            Err(error) => {
                let _ = client.kill().await;
                return Err(error);
            }
        };
        let server_capabilities = result.get("capabilities").cloned().unwrap_or(Value::Null);
        let encoding = PositionEncoding::parse(
            server_capabilities
                .get("positionEncoding")
                .and_then(Value::as_str),
        );
        let capabilities = ServerCapabilities {
            definition: capability_enabled(&server_capabilities, "definitionProvider"),
            references: capability_enabled(&server_capabilities, "referencesProvider"),
            implementation: capability_enabled(&server_capabilities, "implementationProvider"),
            document_symbol: capability_enabled(&server_capabilities, "documentSymbolProvider"),
            completion: capability_enabled(&server_capabilities, "completionProvider"),
            hover: capability_enabled(&server_capabilities, "hoverProvider"),
        };
        let completion_triggers = server_capabilities
            .pointer("/completionProvider/triggerCharacters")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        client.notify("initialized", json!({}));
        Ok(Self {
            project,
            server_id: server.config.id.clone(),
            client,
            encoding,
            capabilities,
            documents: tokio::sync::Mutex::new(HashMap::new()),
            completion_triggers,
        })
    }

    async fn load_document(&self, relative_path: &str) -> GazeResult<LoadedDocument> {
        let project = self.project.clone();
        let relative_path = relative_path.to_string();
        let full_path = Path::new(&project.root).join(&relative_path);
        let uri = Url::from_file_path(&full_path)
            .map_err(|_| GazeError::InvalidPath("无法将文件路径转换为 LSP URI。".to_string()))?
            .to_string();
        let content = tokio::task::spawn_blocking(move || read_file(&project, &relative_path))
            .await
            .map_err(GazeError::Join)??;
        let FileContent::Text {
            content,
            fingerprint,
            ..
        } = content
        else {
            return Err(GazeError::Unsupported(
                "二进制文件不能交给语言服务器。".to_string(),
            ));
        };
        let disk_text = Arc::new(content);
        let language_id = language_id_for_path(&full_path, self.server_id.as_str());
        let mut documents = self.documents.lock().await;
        let text = match documents.get(&uri) {
            Some(document) if document.dirty => {
                if document.fingerprint == fingerprint {
                    Arc::clone(&document.text)
                } else {
                    let version = document.version + 1;
                    let unchanged = document.text.as_str() == disk_text.as_str();
                    documents.insert(
                        uri.clone(),
                        OpenDocument {
                            version,
                            fingerprint,
                            text: Arc::clone(&disk_text),
                            dirty: false,
                        },
                    );
                    if !unchanged {
                        self.client.notify(
                            "textDocument/didChange",
                            json!({
                                "textDocument": { "uri": uri, "version": version },
                                "contentChanges": [{ "text": disk_text.as_str() }]
                            }),
                        );
                    }
                    disk_text
                }
            }
            Some(document)
                if document.fingerprint == fingerprint
                    && document.text.as_str() == disk_text.as_str() =>
            {
                Arc::clone(&document.text)
            }
            Some(document) => {
                let version = document.version + 1;
                documents.insert(
                    uri.clone(),
                    OpenDocument {
                        version,
                        fingerprint,
                        text: Arc::clone(&disk_text),
                        dirty: false,
                    },
                );
                self.client.notify(
                    "textDocument/didChange",
                    json!({
                        "textDocument": { "uri": uri, "version": version },
                        "contentChanges": [{ "text": disk_text.as_str() }]
                    }),
                );
                disk_text
            }
            None => {
                let version = 1;
                documents.insert(
                    uri.clone(),
                    OpenDocument {
                        version,
                        fingerprint,
                        text: Arc::clone(&disk_text),
                        dirty: false,
                    },
                );
                self.client.notify(
                    "textDocument/didOpen",
                    json!({
                        "textDocument": {
                            "uri": uri,
                            "languageId": language_id,
                            "version": version,
                            "text": disk_text.as_str()
                        }
                    }),
                );
                disk_text
            }
        };
        drop(documents);
        let index = TextIndex::new(&text);
        Ok(LoadedDocument { uri, text, index })
    }

    async fn sync_buffer(&self, relative_path: &str, content: &str) -> GazeResult<()> {
        if content.len() as u64 > crate::files::MAX_FILE_BYTES {
            return Err(GazeError::Unsupported(
                "文件过大，不能同步到语言服务器。".to_string(),
            ));
        }
        let project = self.project.clone();
        let relative_path = relative_path.to_string();
        let full_path = Path::new(&project.root).join(&relative_path);
        let uri = Url::from_file_path(&full_path)
            .map_err(|_| GazeError::InvalidPath("无法将文件路径转换为 LSP URI。".to_string()))?
            .to_string();
        let language_id = language_id_for_path(&full_path, self.server_id.as_str());
        let fingerprint = tokio::task::spawn_blocking(move || {
            let path = crate::files::resolve_within_root(Path::new(&project.root), &relative_path)?;
            let metadata = std::fs::metadata(path)?;
            Ok::<_, GazeError>(crate::files::fingerprint(&metadata))
        })
        .await
        .map_err(GazeError::Join)??;
        let text = Arc::new(content.to_string());
        let mut documents = self.documents.lock().await;
        match documents.get(&uri) {
            Some(document) => {
                if document.text.as_str() == text.as_str() && document.fingerprint == fingerprint {
                    return Ok(());
                }
                let version = document.version + 1;
                documents.insert(
                    uri.clone(),
                    OpenDocument {
                        version,
                        fingerprint,
                        text: Arc::clone(&text),
                        dirty: true,
                    },
                );
                self.client.notify(
                    "textDocument/didChange",
                    json!({
                        "textDocument": { "uri": uri, "version": version },
                        "contentChanges": [{ "text": text.as_str() }]
                    }),
                );
            }
            None => {
                let version = 1;
                documents.insert(
                    uri.clone(),
                    OpenDocument {
                        version,
                        fingerprint,
                        text: Arc::clone(&text),
                        dirty: true,
                    },
                );
                self.client.notify(
                    "textDocument/didOpen",
                    json!({
                        "textDocument": {
                            "uri": uri,
                            "languageId": language_id,
                            "version": version,
                            "text": text.as_str()
                        }
                    }),
                );
            }
        }
        Ok(())
    }

    async fn definition(&self, relative_path: &str, position: TextPosition) -> GazeResult<Value> {
        if !self.capabilities.definition {
            return Err(GazeError::Unsupported(
                "当前语言服务器不支持定义跳转。".to_string(),
            ));
        }
        let loaded = self.load_document(relative_path).await?;
        let lsp_position = loaded
            .index
            .utf16_to_lsp(&loaded.text, position, self.encoding)?;
        self.client
            .request(
                "textDocument/definition",
                json!({
                    "textDocument": { "uri": loaded.uri },
                    "position": lsp_position
                }),
                REQUEST_TIMEOUT,
            )
            .await
    }

    async fn references(&self, relative_path: &str, position: TextPosition) -> GazeResult<Value> {
        if !self.capabilities.references {
            return Err(GazeError::Unsupported(
                "当前语言服务器不支持查找引用。".to_string(),
            ));
        }
        let loaded = self.load_document(relative_path).await?;
        let lsp_position = loaded
            .index
            .utf16_to_lsp(&loaded.text, position, self.encoding)?;
        self.client
            .request(
                "textDocument/references",
                json!({
                    "textDocument": { "uri": loaded.uri },
                    "position": lsp_position,
                    "context": { "includeDeclaration": true }
                }),
                REQUEST_TIMEOUT,
            )
            .await
    }

    async fn implementation(
        &self,
        relative_path: &str,
        position: TextPosition,
    ) -> GazeResult<Value> {
        if !self.capabilities.implementation {
            return Err(GazeError::Unsupported(
                "当前语言服务器不支持查找实现。".to_string(),
            ));
        }
        let loaded = self.load_document(relative_path).await?;
        let lsp_position = loaded
            .index
            .utf16_to_lsp(&loaded.text, position, self.encoding)?;
        self.client
            .request(
                "textDocument/implementation",
                json!({
                    "textDocument": { "uri": loaded.uri },
                    "position": lsp_position
                }),
                REQUEST_TIMEOUT,
            )
            .await
    }

    async fn document_symbols(&self, relative_path: &str) -> GazeResult<OutlineResult> {
        if !self.capabilities.document_symbol {
            return Err(GazeError::Unsupported(
                "当前语言服务器不支持文档符号。".to_string(),
            ));
        }
        let loaded = self.load_document(relative_path).await?;
        let result = self
            .client
            .request(
                "textDocument/documentSymbol",
                json!({ "textDocument": { "uri": loaded.uri } }),
                REQUEST_TIMEOUT,
            )
            .await?;
        let symbols = normalize_document_symbols(
            &result,
            &loaded.text,
            &loaded.index,
            self.encoding,
            &loaded.uri,
        )?;
        Ok(OutlineResult {
            symbols,
            source: "lsp".to_string(),
            message: None,
        })
    }

    async fn shutdown(&self) {
        self.client.shutdown().await;
    }
}

pub struct LspManager {
    servers: Vec<ResolvedLspServer>,
    sessions: Arc<Mutex<HashMap<String, Arc<LspSession>>>>,
    start_lock: tokio::sync::Mutex<()>,
}

impl LspManager {
    pub fn new(tools: &Tools) -> Self {
        Self {
            servers: tools.lsp.clone(),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            start_lock: tokio::sync::Mutex::new(()),
        }
    }

    async fn session_for(
        &self,
        app: &AppHandle,
        project: &Project,
        relative_path: &str,
    ) -> GazeResult<Arc<LspSession>> {
        let server = self.server_for_path(relative_path).ok_or_else(|| {
            GazeError::Unsupported(format!(
                "没有为 {} 配置可用的 LSP 语言服务器。",
                Path::new(relative_path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(relative_path)
            ))
        })?;
        let key = format!("{}\u{0000}{}", project.id, server.config.id);
        if let Some(session) = self
            .sessions
            .lock()
            .ok()
            .and_then(|sessions| sessions.get(&key).cloned())
        {
            if !session.client.is_closed() {
                return Ok(session);
            }
            if let Ok(mut sessions) = self.sessions.lock() {
                sessions.remove(&key);
            }
            session.client.kill().await;
        }

        let _start_guard = self.start_lock.lock().await;
        if let Some(session) = self
            .sessions
            .lock()
            .ok()
            .and_then(|sessions| sessions.get(&key).cloned())
        {
            if !session.client.is_closed() {
                return Ok(session);
            }
        }
        emit_status(
            app,
            LspStatus {
                project_id: project.id.clone(),
                server_id: server.config.id.clone(),
                state: "starting".to_string(),
                message: None,
            },
        );
        tracing::info!(
            project = %project.name,
            server = %server.config.id,
            "starting language server"
        );
        let root_uri = Url::from_directory_path(&project.root)
            .map_err(|_| GazeError::InvalidPath("项目根目录无法转换为 LSP URI。".to_string()))?;
        let session = match LspSession::start(project.clone(), server, &root_uri).await {
            Ok(session) => Arc::new(session),
            Err(error) => {
                tracing::warn!(
                    project = %project.name,
                    server = %server.config.id,
                    %error,
                    "language server failed to initialize"
                );
                emit_status(
                    app,
                    LspStatus {
                        project_id: project.id.clone(),
                        server_id: server.config.id.clone(),
                        state: "error".to_string(),
                        message: Some(error.message()),
                    },
                );
                return Err(error);
            }
        };
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.insert(key, Arc::clone(&session));
        }
        tracing::info!(
            project = %project.name,
            server = %server.config.id,
            "language server ready"
        );
        emit_status(
            app,
            LspStatus {
                project_id: project.id.clone(),
                server_id: server.config.id.clone(),
                state: "ready".to_string(),
                message: None,
            },
        );
        Ok(session)
    }

    fn server_for_path(&self, relative_path: &str) -> Option<&ResolvedLspServer> {
        let extension = Path::new(relative_path)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_lowercase)?;
        self.servers.iter().find(|server| {
            server.config.extensions.iter().any(|item| {
                item.trim_start_matches('.')
                    .eq_ignore_ascii_case(&extension)
            })
        })
    }

    pub async fn definition(
        &self,
        app: &AppHandle,
        projects: &[Project],
        project: &Project,
        relative_path: &str,
        position: TextPosition,
    ) -> GazeResult<NavigationResult> {
        let session = self.session_for(app, project, relative_path).await?;
        let name = session
            .load_document(relative_path)
            .await
            .ok()
            .and_then(|loaded| word_at(&loaded.text, position))
            .unwrap_or_else(|| "定义".to_string());
        let result = session.definition(relative_path, position).await?;
        let raw = extract_locations(&result, true);
        let mut navigation = normalize_locations(
            raw,
            projects,
            session.encoding,
            "lsp",
            &name,
            MAX_REFERENCES,
        )
        .await?;
        if navigation.locations.is_empty() && navigation.message.is_none() {
            navigation.message = Some("LSP 未找到定义。".to_string());
        }
        Ok(navigation)
    }

    pub async fn references(
        &self,
        app: &AppHandle,
        projects: &[Project],
        project: &Project,
        relative_path: &str,
        position: TextPosition,
    ) -> GazeResult<NavigationResult> {
        let session = self.session_for(app, project, relative_path).await?;
        let name = session
            .load_document(relative_path)
            .await
            .ok()
            .and_then(|loaded| word_at(&loaded.text, position))
            .unwrap_or_else(|| "引用".to_string());
        let result = session.references(relative_path, position).await?;
        let mut raw = extract_locations(&result, false);
        let total = raw.len();
        raw.truncate(MAX_REFERENCES);
        let mut navigation = normalize_locations(
            raw,
            projects,
            session.encoding,
            "lsp",
            &name,
            MAX_REFERENCES,
        )
        .await?;
        if total > MAX_REFERENCES {
            navigation.message = Some(format!(
                "共找到 {total} 处引用，仅显示前 {MAX_REFERENCES} 处。"
            ));
        } else if navigation.locations.is_empty() && navigation.message.is_none() {
            navigation.message = Some("LSP 未找到引用。".to_string());
        }
        Ok(navigation)
    }

    pub async fn implementations(
        &self,
        app: &AppHandle,
        projects: &[Project],
        project: &Project,
        relative_path: &str,
        position: TextPosition,
    ) -> GazeResult<NavigationResult> {
        let session = self.session_for(app, project, relative_path).await?;
        let name = session
            .load_document(relative_path)
            .await
            .ok()
            .and_then(|loaded| word_at(&loaded.text, position))
            .unwrap_or_else(|| "实现".to_string());
        let result = session.implementation(relative_path, position).await?;
        let raw = extract_locations(&result, true);
        let mut navigation = normalize_locations(
            raw,
            projects,
            session.encoding,
            "lsp",
            &name,
            MAX_REFERENCES,
        )
        .await?;
        if navigation.locations.is_empty() && navigation.message.is_none() {
            navigation.message = Some("LSP 未找到实现。".to_string());
        }
        Ok(navigation)
    }

    pub async fn document_symbols(
        &self,
        app: &AppHandle,
        project: &Project,
        relative_path: &str,
    ) -> GazeResult<OutlineResult> {
        let session = self.session_for(app, project, relative_path).await?;
        session.document_symbols(relative_path).await
    }

    pub async fn sync_document(
        &self,
        app: &AppHandle,
        project: &Project,
        relative_path: &str,
        content: &str,
    ) -> GazeResult<()> {
        let session = self.session_for(app, project, relative_path).await?;
        session.sync_buffer(relative_path, content).await
    }

    pub async fn complete(
        &self,
        app: &AppHandle,
        project: &Project,
        relative_path: &str,
        content: &str,
        position: TextPosition,
        trigger: Option<&str>,
    ) -> GazeResult<CompletionResult> {
        let session = self.session_for(app, project, relative_path).await?;
        session
            .complete(relative_path, content, position, trigger)
            .await
    }

    pub async fn hover(
        &self,
        app: &AppHandle,
        project: &Project,
        relative_path: &str,
        content: &str,
        position: TextPosition,
    ) -> GazeResult<Vec<HoverContent>> {
        self.session_for(app, project, relative_path)
            .await?
            .hover(relative_path, content, position)
            .await
    }

    pub fn has_server_for(&self, relative_path: &str) -> bool {
        self.server_for_path(relative_path).is_some()
    }

    pub async fn remove_project(&self, project_id: &str) {
        let sessions = self
            .sessions
            .lock()
            .map(|mut sessions| {
                let keys: Vec<String> = sessions
                    .keys()
                    .filter(|key| key.starts_with(&format!("{project_id}\u{0000}")))
                    .cloned()
                    .collect();
                keys.into_iter()
                    .filter_map(|key| sessions.remove(&key))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for session in sessions {
            session.shutdown().await;
        }
    }

    pub async fn forget_documents(&self, source: &Path) {
        let sessions: Vec<_> = self
            .sessions
            .lock()
            .map(|sessions| sessions.values().cloned().collect())
            .unwrap_or_default();
        for session in sessions {
            let mut documents = session.documents.lock().await;
            documents.retain(|uri, _| {
                let affected = Url::parse(uri)
                    .ok()
                    .and_then(|uri| uri.to_file_path().ok())
                    .is_some_and(|path| path.starts_with(source));
                if affected {
                    session.client.notify(
                        "textDocument/didClose",
                        json!({ "textDocument": { "uri": uri } }),
                    );
                }
                !affected
            });
        }
    }

    pub async fn shutdown(&self) {
        let sessions = self
            .sessions
            .lock()
            .map(|mut sessions| {
                sessions
                    .drain()
                    .map(|(_, session)| session)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut tasks = tokio::task::JoinSet::new();
        for session in sessions {
            tasks.spawn(async move {
                session.shutdown().await;
            });
        }
        while tasks.join_next().await.is_some() {}
    }
}

fn language_id_for_path(path: &Path, server_id: &str) -> String {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("ts") | Some("mts") | Some("cts") => "typescript".to_string(),
        Some("tsx") => "typescriptreact".to_string(),
        Some("js") | Some("mjs") | Some("cjs") => "javascript".to_string(),
        Some("jsx") => "javascriptreact".to_string(),
        Some("py" | "pyi" | "pyw") => "python".to_string(),
        Some("rs") => "rust".to_string(),
        Some("go") => "go".to_string(),
        Some("c" | "h") => "c".to_string(),
        Some("cc" | "hh" | "cpp" | "hpp" | "cxx" | "hxx") => "cpp".to_string(),
        Some("m") => "objective-c".to_string(),
        Some("mm") => "objective-cpp".to_string(),
        Some("java") => "java".to_string(),
        Some("cs") => "csharp".to_string(),
        Some("php" | "phtml") => "php".to_string(),
        Some("rb" | "rake" | "gemspec") => "ruby".to_string(),
        Some("lua") => "lua".to_string(),
        Some("sh" | "bash") => "shellscript".to_string(),
        Some("swift") => "swift".to_string(),
        Some("kt" | "kts") => "kotlin".to_string(),
        Some("dart") => "dart".to_string(),
        Some("r") => "r".to_string(),
        Some("sql") => "sql".to_string(),
        Some("html" | "htm") => "html".to_string(),
        Some("css") => "css".to_string(),
        Some("scss") => "scss".to_string(),
        Some("less") => "less".to_string(),
        Some("json") => "json".to_string(),
        Some("jsonc") => "jsonc".to_string(),
        Some("yaml" | "yml") => "yaml".to_string(),
        Some("vue") => "vue".to_string(),
        Some("svelte") => "svelte".to_string(),
        _ if server_id == "typescript" => "typescript".to_string(),
        _ => server_id.to_string(),
    }
}

fn capability_enabled(capabilities: &Value, key: &str) -> bool {
    match capabilities.get(key) {
        Some(Value::Bool(value)) => *value,
        Some(Value::Object(_)) => true,
        _ => false,
    }
}

fn extract_locations(value: &Value, links: bool) -> Vec<RawLocation> {
    match value {
        Value::Null => Vec::new(),
        Value::Array(values) => values
            .iter()
            .flat_map(|value| extract_locations(value, links))
            .collect(),
        Value::Object(_) if links && value.get("targetUri").is_some() => {
            let Some(uri) = value.get("targetUri").and_then(Value::as_str) else {
                return Vec::new();
            };
            let range = value
                .get("targetSelectionRange")
                .or_else(|| value.get("targetRange"));
            let Some(range) = range.and_then(parse_range) else {
                return Vec::new();
            };
            vec![RawLocation {
                uri: uri.to_string(),
                range,
            }]
        }
        Value::Object(_) => {
            let Some(uri) = value.get("uri").and_then(Value::as_str) else {
                return Vec::new();
            };
            let Some(range) = value.get("range").and_then(parse_range) else {
                return Vec::new();
            };
            vec![RawLocation {
                uri: uri.to_string(),
                range,
            }]
        }
        _ => Vec::new(),
    }
}

fn parse_range(value: &Value) -> Option<LspRange> {
    Some(LspRange {
        start: parse_position(value.get("start")?)?,
        end: parse_position(value.get("end")?)?,
    })
}

fn parse_position(value: &Value) -> Option<LspPosition> {
    Some(LspPosition {
        line: value.get("line")?.as_u64()? as u32,
        character: value.get("character")?.as_u64()? as u32,
    })
}

struct RawLocation {
    uri: String,
    range: LspRange,
}

async fn normalize_locations(
    raw: Vec<RawLocation>,
    projects: &[Project],
    encoding: PositionEncoding,
    source: &str,
    name: &str,
    limit: usize,
) -> GazeResult<NavigationResult> {
    let mut locations = Vec::new();
    let mut skipped_outside = 0usize;
    let mut text_cache: HashMap<PathBuf, Arc<String>> = HashMap::new();
    for raw_location in raw.into_iter().take(limit) {
        let Ok(url) = Url::parse(&raw_location.uri) else {
            continue;
        };
        let Ok(path) = url.to_file_path() else {
            continue;
        };
        let mapped = project_for_path(projects, &path).or_else(|| {
            path.canonicalize()
                .ok()
                .and_then(|canonical| project_for_path(projects, &canonical))
        });
        let Some((project, relative)) = mapped else {
            skipped_outside += 1;
            continue;
        };
        let (start, end) = if encoding == PositionEncoding::Utf16 {
            (
                TextPosition {
                    line: raw_location.range.start.line,
                    character: raw_location.range.start.character,
                },
                TextPosition {
                    line: raw_location.range.end.line,
                    character: raw_location.range.end.character,
                },
            )
        } else {
            let text = if let Some(text) = text_cache.get(&path) {
                Arc::clone(text)
            } else {
                let project_copy = project.clone();
                let relative_copy = relative.clone();
                let content =
                    tokio::task::spawn_blocking(move || read_file(&project_copy, &relative_copy))
                        .await
                        .map_err(GazeError::Join)??;
                let FileContent::Text { content, .. } = content else {
                    continue;
                };
                let text = Arc::new(content);
                text_cache.insert(path.clone(), Arc::clone(&text));
                text
            };
            let index = TextIndex::new(&text);
            (
                index.lsp_to_utf16(&text, raw_location.range.start, encoding)?,
                index.lsp_to_utf16(&text, raw_location.range.end, encoding)?,
            )
        };
        locations.push(SymbolLocation {
            project_id: project.id.clone(),
            path: relative,
            name: name.to_string(),
            kind: "reference".to_string(),
            line: start.line,
            character: start.character,
            end_line: end.line,
            end_character: end.character,
            source: source.to_string(),
        });
    }
    let message = (skipped_outside > 0)
        .then(|| format!("{skipped_outside} 个结果位于未导入的项目中，已跳过。"));
    Ok(NavigationResult {
        locations,
        source: source.to_string(),
        message,
    })
}

fn project_for_path<'a>(projects: &'a [Project], path: &Path) -> Option<(&'a Project, String)> {
    projects
        .iter()
        .filter_map(|project| {
            let root = Path::new(&project.root);
            path.strip_prefix(root)
                .ok()
                .and_then(|_| path_to_relative(root, path).ok())
                .filter(|relative| !relative.is_empty())
                .map(|relative| (project, relative, root.components().count()))
        })
        .max_by_key(|(_, _, depth)| *depth)
        .map(|(project, relative, _)| (project, relative))
}

fn normalize_document_symbols(
    value: &Value,
    text: &str,
    index: &TextIndex,
    encoding: PositionEncoding,
    current_uri: &str,
) -> GazeResult<Vec<DocumentSymbol>> {
    let Some(values) = value.as_array() else {
        return Ok(Vec::new());
    };
    let mut result = Vec::new();
    for value in values {
        if value.get("location").is_some() {
            if let Some(symbol) =
                parse_symbol_information(value, text, index, encoding, current_uri)?
            {
                result.push(symbol);
            }
        } else if let Some(symbol) = parse_document_symbol(value, text, index, encoding)? {
            result.push(symbol);
        }
    }
    Ok(result)
}

fn parse_document_symbol(
    value: &Value,
    text: &str,
    index: &TextIndex,
    encoding: PositionEncoding,
) -> GazeResult<Option<DocumentSymbol>> {
    let Some(name) = value.get("name").and_then(Value::as_str) else {
        return Ok(None);
    };
    let kind = value.get("kind").and_then(Value::as_u64).unwrap_or(13);
    let Some(selection) = value.get("selectionRange").and_then(parse_range) else {
        return Ok(None);
    };
    let range = value
        .get("range")
        .and_then(parse_range)
        .unwrap_or(selection);
    let start = index.lsp_to_utf16(text, selection.start, encoding)?;
    let end = index.lsp_to_utf16(text, range.end, encoding)?;
    let mut children = Vec::new();
    if let Some(items) = value.get("children").and_then(Value::as_array) {
        for child in items {
            if let Some(child) = parse_document_symbol(child, text, index, encoding)? {
                children.push(child);
            }
        }
    }
    Ok(Some(DocumentSymbol {
        name: name.to_string(),
        detail: value
            .get("detail")
            .and_then(Value::as_str)
            .map(str::to_string),
        kind: symbol_kind_name(kind).to_string(),
        line: start.line,
        character: start.character,
        end_line: end.line,
        end_character: end.character,
        children,
    }))
}

fn parse_symbol_information(
    value: &Value,
    text: &str,
    index: &TextIndex,
    encoding: PositionEncoding,
    current_uri: &str,
) -> GazeResult<Option<DocumentSymbol>> {
    let Some(name) = value.get("name").and_then(Value::as_str) else {
        return Ok(None);
    };
    let Some(location) = value.get("location") else {
        return Ok(None);
    };
    let location_uri = location.get("uri").and_then(Value::as_str);
    let same_uri = match (location_uri, Url::parse(current_uri)) {
        (Some(uri), Ok(current)) => Url::parse(uri).map(|uri| uri == current).unwrap_or(false),
        (Some(uri), Err(_)) => Some(uri) == Some(current_uri),
        _ => false,
    };
    if !same_uri {
        return Ok(None);
    }
    let Some(range) = location.get("range").and_then(parse_range) else {
        return Ok(None);
    };
    let start = index.lsp_to_utf16(text, range.start, encoding)?;
    let end = index.lsp_to_utf16(text, range.end, encoding)?;
    Ok(Some(DocumentSymbol {
        name: name.to_string(),
        detail: value
            .get("containerName")
            .and_then(Value::as_str)
            .map(str::to_string),
        kind: symbol_kind_name(value.get("kind").and_then(Value::as_u64).unwrap_or(13)).to_string(),
        line: start.line,
        character: start.character,
        end_line: end.line,
        end_character: end.character,
        children: Vec::new(),
    }))
}

fn symbol_kind_name(kind: u64) -> &'static str {
    match kind {
        1 => "file",
        2 => "module",
        3 => "namespace",
        4 => "package",
        5 => "class",
        6 => "method",
        7 => "property",
        8 => "field",
        9 => "constructor",
        10 => "enum",
        11 => "interface",
        12 => "function",
        13 => "variable",
        14 => "constant",
        15 => "string",
        16 => "number",
        17 => "boolean",
        18 => "array",
        19 => "object",
        20 => "key",
        21 => "null",
        22 => "enumMember",
        23 => "struct",
        24 => "event",
        25 => "operator",
        26 => "typeParameter",
        _ => "symbol",
    }
}

fn emit_status(app: &AppHandle, status: LspStatus) {
    let _ = app.emit("gaze://lsp-status", status);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_location_links_and_locations() {
        let value = json!([
            {
                "targetUri": "file:///tmp/a.ts",
                "targetRange": {"start":{"line":1,"character":2},"end":{"line":3,"character":4}},
                "targetSelectionRange": {"start":{"line":2,"character":0},"end":{"line":2,"character":5}}
            },
            {
                "uri": "file:///tmp/b.ts",
                "range": {"start":{"line":0,"character":0},"end":{"line":0,"character":2}}
            }
        ]);
        let locations = extract_locations(&value, true);
        assert_eq!(locations.len(), 2);
        assert_eq!(locations[0].range.start.line, 2);
        assert_eq!(locations[1].range.end.character, 2);
    }

    #[test]
    fn longest_project_root_wins_for_cross_project_results() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let inner = root.join("packages/app");
        std::fs::create_dir_all(inner.join("src")).unwrap();
        std::fs::write(inner.join("src/a.ts"), "export {}").unwrap();
        let projects = vec![
            Project {
                id: "outer".to_string(),
                name: "Outer".to_string(),
                root: root.display().to_string(),
            },
            Project {
                id: "inner".to_string(),
                name: "Inner".to_string(),
                root: inner.display().to_string(),
            },
        ];
        let (project, relative) = project_for_path(&projects, &inner.join("src/a.ts")).unwrap();
        assert_eq!(project.id, "inner");
        assert_eq!(relative, "src/a.ts");
    }

    #[test]
    fn normalizes_hierarchical_and_flat_document_symbols() {
        let text = "export interface Shape {}\nexport class Square implements Shape {}\n";
        let index = TextIndex::new(text);
        let uri = "file:///tmp/sample.ts";
        let value = json!([
            {
                "name": "Square",
                "kind": 5,
                "range": {"start":{"line":1,"character":0},"end":{"line":1,"character":52}},
                "selectionRange": {"start":{"line":1,"character":13},"end":{"line":1,"character":19}},
                "children": []
            },
            {
                "name": "Shape",
                "kind": 11,
                "location": {
                    "uri": uri,
                    "range": {"start":{"line":0,"character":0},"end":{"line":0,"character":31}}
                }
            }
        ]);
        let symbols =
            normalize_document_symbols(&value, text, &index, PositionEncoding::Utf16, uri).unwrap();
        assert_eq!(symbols.len(), 2);
        assert_eq!(symbols[0].name, "Square");
        assert_eq!(symbols[0].kind, "class");
        assert_eq!(symbols[0].line, 1);
        assert_eq!(symbols[1].name, "Shape");
    }

    fn language_server_path() -> Option<PathBuf> {
        if let Ok(path) = which::which("typescript-language-server") {
            return Some(path);
        }
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        [
            manifest
                .parent()
                .map(|path| path.join("node_modules/.bin/typescript-language-server")),
            Some(manifest.join("../node_modules/.bin/typescript-language-server")),
        ]
        .into_iter()
        .flatten()
        .find(|path| path.is_file())
    }

    fn utf16_position(line: &str, needle: &str) -> (u32, u32) {
        let byte = line.find(needle).unwrap();
        (
            line[..byte].encode_utf16().count() as u32,
            needle.encode_utf16().count() as u32,
        )
    }

    #[tokio::test]
    async fn real_typescript_lsp_definition_references_implementation_and_symbols() {
        let Some(executable) = language_server_path() else {
            eprintln!("typescript-language-server not installed; skipping real LSP test");
            return;
        };
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(
            root.join("tsconfig.json"),
            r#"{"compilerOptions":{"target":"ES2022","strict":true},"include":["src"]}"#,
        )
        .unwrap();
        let source = "export interface Shape {\n  area(): number;\n}\n\nexport class Square implements Shape {\n  area(): number { return 4; }\n}\n\nexport function useShape(shape: Shape): number {\n  return shape.area();\n}\n\n// 😀 emoji before the usage must not shift UTF-16 positions\nconst square = new Square();\nconst area = useShape(square);\n";
        std::fs::write(root.join("src/你好.ts"), source).unwrap();
        let project = Project {
            id: "lsp-test".to_string(),
            name: "LSP Test".to_string(),
            root: root.display().to_string(),
        };
        let tsserver_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("node_modules/typescript/lib/tsserver.js");
        let server = ResolvedLspServer {
            config: crate::config::LspServerConfig {
                id: "typescript".to_string(),
                languages: vec!["typescript".to_string()],
                command: executable.display().to_string(),
                args: vec!["--stdio".to_string()],
                extensions: vec!["ts".to_string()],
                initialization_options: Some(json!({
                    "tsserver": { "path": tsserver_path }
                })),
            },
            executable: Some(executable),
        };
        let root_uri = Url::from_directory_path(&root).unwrap();
        let session = LspSession::start(project, &server, &root_uri)
            .await
            .expect("TypeScript language server should initialize");

        let symbols = session
            .document_symbols("src/你好.ts")
            .await
            .unwrap()
            .symbols;
        assert!(symbols.iter().any(|symbol| symbol.name == "Shape"));
        assert!(symbols.iter().any(|symbol| symbol.name == "Square"));
        assert!(symbols.iter().any(|symbol| symbol.name == "useShape"));

        let (definition_character, _) =
            utf16_position("const area = useShape(square);", "useShape");
        let definition = session
            .definition(
                "src/你好.ts",
                TextPosition {
                    line: 14,
                    character: definition_character,
                },
            )
            .await
            .unwrap();
        let locations = extract_locations(&definition, true);
        assert!(!locations.is_empty());

        let (shape_character, _) = utf16_position("export interface Shape {", "Shape");
        let implementations = session
            .implementation(
                "src/你好.ts",
                TextPosition {
                    line: 0,
                    character: shape_character,
                },
            )
            .await
            .unwrap();
        assert!(!extract_locations(&implementations, true).is_empty());

        let references = session
            .references(
                "src/你好.ts",
                TextPosition {
                    line: 4,
                    character: 13,
                },
            )
            .await
            .unwrap();
        assert!(extract_locations(&references, false).len() >= 2);

        let edited = format!("{source}\nexport function addedInBuffer(): number {{ return 1; }}\n");
        session.sync_buffer("src/你好.ts", &edited).await.unwrap();
        let symbols = session
            .document_symbols("src/你好.ts")
            .await
            .unwrap()
            .symbols;
        assert!(symbols.iter().any(|symbol| symbol.name == "addedInBuffer"));

        let completion_text = format!(
            "{edited}\nconst unsavedThing = {{ helloFromBuffer: 1 }};\n/* 😀 */ unsavedThing.hel"
        );
        let last_line = completion_text.lines().last().unwrap();
        let completions = session
            .complete(
                "src/你好.ts",
                &completion_text,
                TextPosition {
                    line: completion_text.lines().count() as u32 - 1,
                    character: last_line.encode_utf16().count() as u32,
                },
                None,
            )
            .await
            .unwrap();
        let hover_text = format!("{edited}\n/** Finds a user by ID. */\nfunction findUser(id: number): string {{ return String(id); }}\n/* 😀 */ findUser(123);");
        let last_line = hover_text.lines().last().unwrap();
        let (character, _) = utf16_position(last_line, "findUser");
        let hover = session
            .hover(
                "src/你好.ts",
                &hover_text,
                TextPosition {
                    line: hover_text.lines().count() as u32 - 1,
                    character,
                },
            )
            .await
            .unwrap();
        let hover = serde_json::to_string(&hover).unwrap();
        assert!(hover.contains("findUser"), "{hover}");
        assert!(hover.contains("Finds a user by ID"), "{hover}");
        let completions = serde_json::to_value(completions).unwrap();
        assert!(completions["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["label"] == "helloFromBuffer"));
        assert_eq!(
            std::fs::read_to_string(root.join("src/你好.ts")).unwrap(),
            source
        );
        assert!(session
            .sync_buffer("../outside.ts", "private")
            .await
            .is_err());
        session.sync_buffer("src/你好.ts", &edited).await.unwrap();

        std::fs::create_dir(root.join("src2")).unwrap();
        std::fs::write(root.join("src2/keep.ts"), "export const keep = 1;").unwrap();
        session.load_document("src2/keep.ts").await.unwrap();
        let session = Arc::new(session);
        let manager = LspManager {
            servers: Vec::new(),
            sessions: Arc::new(Mutex::new(HashMap::from([(
                "lsp-test\0typescript".to_string(),
                Arc::clone(&session),
            )]))),
            start_lock: tokio::sync::Mutex::new(()),
        };
        manager.forget_documents(&root.join("src")).await;
        let documents = session.documents.lock().await;
        assert_eq!(documents.len(), 1);
        assert!(documents.keys().next().unwrap().ends_with("/src2/keep.ts"));
        drop(documents);
        std::fs::rename(root.join("src"), root.join("moved")).unwrap();
        let moved_symbols = session
            .document_symbols("moved/你好.ts")
            .await
            .unwrap()
            .symbols;
        assert!(moved_symbols.iter().any(|symbol| symbol.name == "Shape"));
        assert!(!moved_symbols
            .iter()
            .any(|symbol| symbol.name == "addedInBuffer"));
        manager.forget_documents(&root.join("moved/你好.ts")).await;
        assert_eq!(session.documents.lock().await.len(), 1);

        session.shutdown().await;
    }
}
