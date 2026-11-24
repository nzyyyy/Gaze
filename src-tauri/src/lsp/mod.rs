mod client;
mod code_action;
mod completion;
mod diagnostics;
mod hover;
mod positions;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use url::Url;

pub use code_action::{CodeAction, CodeActionResolve, CodeActionResult, FileEdit, WorkspaceEdit};
pub use completion::{CompletionItem, CompletionResolve, CompletionResult};
pub use diagnostics::{DiagnosticSync, DiagnosticsUpdate};
pub use hover::HoverContent;
pub use positions::{LspPosition, LspRange, PositionEncoding, TextIndex};

use crate::cache::Cache;
use crate::config::TYPESCRIPT_EXTENSIONS;
use crate::error::{GazeError, GazeResult};
use crate::files::{path_to_relative, read_file};
use crate::models::{
    DocumentSymbol, FileContent, FileFingerprint, NavigationResult, OutlineResult, Project,
    SymbolLocation, TextPosition,
};
use crate::path_index::IgnoreCache;
use crate::python::{self, PythonEnvironmentStatus};
use crate::symbols::word_at;
use crate::tools::{ResolvedLspServer, Tools};

use self::client::LspClient;
use self::completion::CompletionEdit;

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
    completion_resolve: bool,
    hover: bool,
    code_action: bool,
    code_action_resolve: bool,
}

struct OpenDocument {
    version: i64,
    fingerprint: FileFingerprint,
    text: Arc<String>,
    dirty: bool,
    diagnostics: Option<Vec<diagnostics::CodeDiagnostic>>,
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
    documents: Arc<tokio::sync::Mutex<HashMap<String, OpenDocument>>>,
    id: String,
    completion_triggers: Vec<String>,
    completion_generation: tokio::sync::Mutex<u64>,
    incremental_sync: bool,
}

impl LspSession {
    async fn start(
        project: Project,
        server: &ResolvedLspServer,
        root_uri: &Url,
        python_path: Option<String>,
        publish_diagnostics: impl Fn(DiagnosticsUpdate) + Send + Sync + 'static,
    ) -> GazeResult<Self> {
        let executable = server.executable.as_ref().ok_or_else(|| {
            GazeError::ToolMissing(format!(
                "语言服务器 {}（{}）未安装或不可执行。",
                server.config.id, server.config.command
            ))
        })?;
        let id = uuid::Uuid::new_v4().to_string();
        let documents = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let encoding = Arc::new(OnceLock::new());
        let diagnostics = {
            let context = Arc::new(diagnostics::Publisher {
                project: project.clone(),
                session: id.clone(),
                documents: Arc::clone(&documents),
                encoding: Arc::clone(&encoding),
                publish: publish_diagnostics,
            });
            move |params| {
                let context = Arc::clone(&context);
                async move { context.receive(params).await }
            }
        };
        let client = LspClient::spawn(
            executable,
            &server.config.args,
            Path::new(&project.root),
            root_uri.as_str(),
            &project.name,
            python_path,
            diagnostics,
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
                    "publishDiagnostics": { "versionSupport": true },
                    "definition": { "linkSupport": true },
                    "references": {},
                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                    "implementation": { "linkSupport": true },
                    "completion": {
                        "contextSupport": true,
                        "completionItem": {
                            "snippetSupport": true,
                            "labelDetailsSupport": true,
                            "resolveSupport": { "properties": ["documentation", "detail", "additionalTextEdits"] },
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
        let negotiated_encoding = PositionEncoding::parse(
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
            completion_resolve: server_capabilities
                .pointer("/completionProvider/resolveProvider")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            hover: capability_enabled(&server_capabilities, "hoverProvider"),
            code_action: capability_enabled(&server_capabilities, "codeActionProvider"),
            code_action_resolve: server_capabilities
                .pointer("/codeActionProvider/resolveProvider")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        };
        let sync = &server_capabilities["textDocumentSync"];
        let incremental_sync = sync.as_u64().or_else(|| sync["change"].as_u64()) == Some(2);
        let completion_triggers = server_capabilities
            .pointer("/completionProvider/triggerCharacters")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        let _ = encoding.set(negotiated_encoding);
        client.notify("initialized", json!({}));
        if server.config.id == "typescript" {
            client.notify(
                "workspace/didChangeConfiguration",
                json!({
                    "settings": { "completions": { "completeFunctionCalls": true } }
                }),
            );
        }
        Ok(Self {
            project,
            server_id: server.config.id.clone(),
            client,
            encoding: negotiated_encoding,
            capabilities,
            documents,
            id,
            completion_triggers,
            completion_generation: tokio::sync::Mutex::new(0),
            incremental_sync,
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
        let disk_text = Arc::new(if content.contains('\r') {
            content.replace("\r\n", "\n").replace('\r', "\n")
        } else {
            content
        });
        let language_id = language_id_for_path(&full_path, self.server_id.as_str());
        let mut documents = self.documents.lock().await;
        let text = match documents.get_mut(&uri) {
            Some(document) if document.text.as_str() == disk_text.as_str() => {
                document.fingerprint = fingerprint;
                document.dirty = false;
                Arc::clone(&document.text)
            }
            Some(document) if document.dirty && document.fingerprint == fingerprint => {
                Arc::clone(&document.text)
            }
            Some(document) => {
                self.change_document(&uri, document, fingerprint, Arc::clone(&disk_text), false);
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
                        diagnostics: None,
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

    async fn sync_buffer(&self, relative_path: &str, content: &str) -> GazeResult<DiagnosticSync> {
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
        let version = match documents.get_mut(&uri) {
            Some(document) => {
                if document.text.as_str() == text.as_str() {
                    document.fingerprint = fingerprint;
                    return Ok(DiagnosticSync {
                        session: self.id.clone(),
                        version: document.version,
                        items: document.diagnostics.clone(),
                    });
                }
                self.change_document(&uri, document, fingerprint, text, true);
                document.version
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
                        diagnostics: None,
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
                version
            }
        };
        Ok(DiagnosticSync {
            session: self.id.clone(),
            version,
            items: None,
        })
    }

    fn change_document(
        &self,
        uri: &str,
        document: &mut OpenDocument,
        fingerprint: FileFingerprint,
        text: Arc<String>,
        dirty: bool,
    ) {
        let mut change = json!({ "text": text.as_str() });
        if self.incremental_sync {
            let original = document.text.as_str();
            let end = TextIndex::new(original)
                .byte_to_lsp(original, original.len(), self.encoding)
                .expect("the end of a document is a valid position");
            change["range"] = json!({ "start": { "line": 0, "character": 0 }, "end": end });
        }
        document.version += 1;
        document.fingerprint = fingerprint;
        document.text = text;
        document.dirty = dirty;
        document.diagnostics = None;
        self.client.notify(
            "textDocument/didChange",
            json!({
                "textDocument": { "uri": uri, "version": document.version },
                "contentChanges": [change]
            }),
        );
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

    async fn references(
        &self,
        relative_path: &str,
        position: TextPosition,
        include_declaration: bool,
    ) -> GazeResult<Value> {
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
                    "context": { "includeDeclaration": include_declaration }
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
    cache: Cache,
    servers: Vec<ResolvedLspServer>,
    sessions: Arc<Mutex<HashMap<String, Arc<LspSession>>>>,
    start_lock: tokio::sync::Mutex<()>,
    python_enabled: AtomicBool,
    typescript_enabled: AtomicBool,
    declaration_cache: Mutex<Vec<DeclarationCacheEntry>>,
}

#[derive(Clone, PartialEq, Eq)]
struct DeclarationCacheKey {
    project: String,
    session: String,
    uri: String,
    version: i64,
    target_uri: String,
    start: LspPosition,
    end: LspPosition,
}

struct DeclarationCacheEntry {
    key: DeclarationCacheKey,
    snippet: String,
    at: Instant,
}

const DECLARATION_CACHE_SIZE: usize = 32;
const DECLARATION_CACHE_TTL: Duration = Duration::from_secs(30);

impl LspManager {
    pub fn new(tools: &Tools, cache: Cache) -> Self {
        Self {
            cache,
            servers: tools.lsp.clone(),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            start_lock: tokio::sync::Mutex::new(()),
            python_enabled: AtomicBool::new(true),
            typescript_enabled: AtomicBool::new(true),
            declaration_cache: Mutex::new(Vec::new()),
        }
    }

    async fn session_for(
        &self,
        app: &AppHandle,
        project: &Project,
        relative_path: &str,
    ) -> GazeResult<Arc<LspSession>> {
        let resolve_server = || {
            self.server_for_path(relative_path).ok_or_else(|| {
                GazeError::Unsupported(format!(
                    "没有为 {} 配置可用的 LSP 语言服务器。",
                    Path::new(relative_path)
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or(relative_path)
                ))
            })
        };
        let server = resolve_server()?;
        let key = format!("{}\u{0000}{}", project.id, server.config.id);
        if let Some(session) = self.open_session(&key) {
            return Ok(session);
        }

        let _start_guard = self.start_lock.lock().await;
        resolve_server()?;
        if let Some(session) = self.open_session(&key) {
            return Ok(session);
        }
        let previous = self
            .sessions
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(&key));
        if let Some(previous) = previous {
            previous.client.kill().await;
        }
        let python_path = if self.python_enabled.load(Ordering::Acquire) && serves_python(server) {
            self.python_environment(project)
                .await?
                .environment
                .map(|environment| environment.path)
        } else {
            None
        };
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
        let diagnostics_app = app.clone();
        let session = match LspSession::start(
            project.clone(),
            server,
            &root_uri,
            python_path,
            move |update| {
                let _ = diagnostics_app.emit("gaze://diagnostics", update);
            },
        )
        .await
        {
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

    fn open_session(&self, key: &str) -> Option<Arc<LspSession>> {
        self.sessions
            .lock()
            .ok()?
            .get(key)
            .filter(|session| !session.client.is_closed())
            .cloned()
    }

    pub async fn python_environment(
        &self,
        project: &Project,
    ) -> GazeResult<PythonEnvironmentStatus> {
        self.ensure_python_enabled()?;
        let selected = self
            .cache
            .setting(&python::setting_key(&project.id))
            .await?
            .filter(|value| !value.is_empty());
        let root = PathBuf::from(&project.root);
        tokio::task::spawn_blocking(move || python::status(&root, selected))
            .await
            .map_err(GazeError::Join)
    }

    pub async fn set_python_environment(
        &self,
        project: &Project,
        interpreter: Option<String>,
    ) -> GazeResult<PythonEnvironmentStatus> {
        let _start_guard = self.start_lock.lock().await;
        self.ensure_python_enabled()?;
        let root = PathBuf::from(&project.root);
        let status = tokio::task::spawn_blocking(move || {
            if let Some(path) = &interpreter {
                python::validate_interpreter(Path::new(path))?;
            }
            Ok::<_, GazeError>(python::status(&root, interpreter))
        })
        .await??;
        self.cache
            .set_setting(
                &python::setting_key(&project.id),
                status.selected.as_deref().unwrap_or_default(),
            )
            .await?;
        shutdown_sessions(self.take_language_sessions(Some(&project.id), serves_python)?).await;
        Ok(status)
    }

    pub fn ensure_python_enabled(&self) -> GazeResult<()> {
        if !self.python_enabled.load(Ordering::Acquire) {
            return Err(GazeError::Unsupported("Python 语义支持已停用。".into()));
        }
        Ok(())
    }

    pub async fn set_python_enabled(&self, enabled: bool) {
        self.set_language_enabled(&self.python_enabled, enabled, serves_python)
            .await;
    }

    pub async fn set_typescript_enabled(&self, enabled: bool) {
        self.set_language_enabled(&self.typescript_enabled, enabled, serves_typescript)
            .await;
    }

    async fn set_language_enabled(
        &self,
        flag: &AtomicBool,
        enabled: bool,
        serves_language: fn(&ResolvedLspServer) -> bool,
    ) {
        if flag.load(Ordering::Acquire) == enabled {
            return;
        }
        let _start_guard = self.start_lock.lock().await;
        if flag.swap(enabled, Ordering::AcqRel) && !enabled {
            match self.take_language_sessions(None, serves_language) {
                Ok(sessions) => shutdown_sessions(sessions).await,
                Err(error) => {
                    tracing::warn!(message = %error.message(), "could not stop plugin LSP sessions")
                }
            }
        }
    }

    fn take_language_sessions(
        &self,
        project_id: Option<&str>,
        serves_language: fn(&ResolvedLspServer) -> bool,
    ) -> GazeResult<Vec<Arc<LspSession>>> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| GazeError::Message("语言服务器会话锁已损坏。".into()))?;
        let keys: Vec<_> = sessions
            .keys()
            .filter(|key| {
                key.split_once('\0').is_some_and(|(project, id)| {
                    project_id.is_none_or(|wanted| wanted == project)
                        && self
                            .servers
                            .iter()
                            .any(|server| server.config.id == id && serves_language(server))
                })
            })
            .cloned()
            .collect();
        Ok(keys
            .into_iter()
            .filter_map(|key| sessions.remove(&key))
            .collect())
    }

    fn server_for_path(&self, relative_path: &str) -> Option<&ResolvedLspServer> {
        let extension = Path::new(relative_path)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_lowercase)?;
        if is_python_extension(&extension) && self.ensure_python_enabled().is_err() {
            return None;
        }
        if is_typescript_extension(&extension) && !self.typescript_enabled.load(Ordering::Acquire) {
            return None;
        }
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

    pub(crate) async fn inline_declarations(
        &self,
        project: &Project,
        path: &str,
        cursor: TextPosition,
        context: (&str, &str),
        snapshot: (&str, i64),
    ) -> Vec<String> {
        self.inline_declarations_inner(project, path, cursor, context, snapshot)
            .await
            .unwrap_or_default()
    }

    async fn inline_declarations_inner(
        &self,
        project: &Project,
        path: &str,
        cursor: TextPosition,
        (prefix, suffix): (&str, &str),
        (session_id, expected_version): (&str, i64),
    ) -> Option<Vec<String>> {
        static IDENTIFIER: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
            regex::Regex::new(r"[_\p{XID_Start}][_\p{XID_Continue}]*").expect("identifier pattern")
        });
        let server = self.server_for_path(path)?;
        let session = self.open_session(&format!("{}\u{0000}{}", project.id, server.config.id))?;
        if !session.capabilities.definition || session.id != session_id {
            return None;
        }
        let uri = Url::from_file_path(Path::new(&project.root).join(path))
            .ok()?
            .to_string();
        let (text, version) = {
            let documents = session.documents.lock().await;
            let doc = documents.get(&uri)?;
            if doc.version != expected_version {
                return None;
            }
            (Arc::clone(&doc.text), doc.version)
        };
        let index = TextIndex::new(&text);
        let offset = index.utf16_to_byte(&text, cursor).ok()?;
        if !text[..offset].ends_with(prefix) || !text[offset..].starts_with(suffix) {
            return None;
        }
        let mut positions = Vec::with_capacity(2);
        let mut seen = HashSet::new();
        for (distance, line) in prefix.rsplit('\n').take(3).enumerate() {
            let line_number = cursor.line.checked_sub(distance as u32)?;
            let line_width = line.encode_utf16().count() as u32;
            let column = if distance == 0 {
                cursor.character.checked_sub(line_width)?
            } else {
                0
            };
            let targets = IDENTIFIER.find_iter(line).collect::<Vec<_>>();
            for target in targets.into_iter().rev() {
                let symbol = target.as_str();
                if matches!(
                    symbol,
                    "return"
                        | "const"
                        | "let"
                        | "var"
                        | "await"
                        | "async"
                        | "new"
                        | "if"
                        | "else"
                        | "fn"
                        | "def"
                        | "pub"
                        | "function"
                        | "export"
                ) || !seen.insert(symbol)
                {
                    continue;
                }
                let character = column + line[..target.start()].encode_utf16().count() as u32;
                if let Ok(position) = index.utf16_to_lsp(
                    &text,
                    TextPosition {
                        line: line_number,
                        character,
                    },
                    session.encoding,
                ) {
                    positions.push(position);
                }
                if positions.len() == 2 {
                    break;
                }
            }
            if positions.len() == 2 {
                break;
            }
        }
        let first = positions.first().copied()?;
        let definition = |position| {
            session.client.request(
                "textDocument/definition",
                json!({ "textDocument": { "uri": uri }, "position": position }),
                Duration::from_millis(50),
            )
        };
        let (first, second) = if let Some(second) = positions.get(1).copied() {
            let (first, second) = tokio::join!(definition(first), definition(second));
            (first.ok(), second.ok())
        } else {
            (definition(first).await.ok(), None)
        };
        let locations = first
            .iter()
            .chain(second.iter())
            .flat_map(|value| extract_locations(value, true))
            .collect::<Vec<_>>();
        let source_key = (
            project.id.clone(),
            session_id.to_owned(),
            uri.clone(),
            version,
        );
        let snippets = self
            .declaration_snippets(project, source_key, locations)
            .into_iter()
            .filter(|snippet| !prefix.contains(snippet) && !suffix.contains(snippet))
            .take(2)
            .collect();
        let documents = session.documents.lock().await;
        (documents.get(&uri)?.version == version).then_some(snippets)
    }

    fn declaration_snippets(
        &self,
        project: &Project,
        (project_id, session, uri, version): (String, String, String, i64),
        locations: Vec<RawLocation>,
    ) -> Vec<String> {
        let mut found = Vec::new();
        let mut cached_hit = false;
        for location in locations {
            if found.len() >= 2 {
                break;
            }
            let key = DeclarationCacheKey {
                project: project_id.clone(),
                session: session.clone(),
                uri: uri.clone(),
                version,
                target_uri: location.uri.clone(),
                start: location.range.start,
                end: location.range.end,
            };
            if let Ok(mut cache) = self.declaration_cache.lock() {
                cache.retain(|entry| entry.at.elapsed() < DECLARATION_CACHE_TTL);
                if let Some(index) = cache.iter().position(|entry| entry.key == key) {
                    cached_hit = true;
                    let entry = cache.remove(index);
                    let snippet = entry.snippet.clone();
                    cache.push(entry);
                    let eligible = Url::parse(&location.uri)
                        .ok()
                        .and_then(|uri| uri.to_file_path().ok())
                        .and_then(|path| {
                            path.strip_prefix(Path::new(&project.root))
                                .ok()
                                .and_then(Path::to_str)
                                .and_then(|relative| {
                                    crate::ai_completion::eligible_path(project, relative)
                                })
                        });
                    if eligible.is_none() {
                        continue;
                    }
                    if !found.contains(&snippet) {
                        found.push(snippet);
                    }
                    continue;
                }
            }
            let root = Path::new(&project.root);
            let mut ignores = IgnoreCache::new(root);
            let Some(path) = Url::parse(&location.uri)
                .ok()
                .and_then(|uri| uri.to_file_path().ok())
            else {
                continue;
            };
            let Some(relative) = path.strip_prefix(root).ok().and_then(Path::to_str) else {
                continue;
            };
            let Some(path) =
                crate::ai_completion::eligible_path_with(project, relative, &mut ignores)
            else {
                continue;
            };
            let Some(snippet) = declaration_excerpt(&path, location.range) else {
                continue;
            };
            if let Ok(mut cache) = self.declaration_cache.lock() {
                cache.retain(|entry| entry.key != key);
                cache.push(DeclarationCacheEntry {
                    key,
                    snippet: snippet.clone(),
                    at: Instant::now(),
                });
                let excess = cache.len().saturating_sub(DECLARATION_CACHE_SIZE);
                cache.drain(..excess);
            }
            if !found.contains(&snippet) {
                found.push(snippet);
            }
        }
        tracing::debug!(cached_hit, count = found.len(), "AI related declarations");
        found
    }

    pub async fn references(
        &self,
        app: &AppHandle,
        projects: &[Project],
        project: &Project,
        relative_path: &str,
        position: TextPosition,
        include_declaration: bool,
    ) -> GazeResult<NavigationResult> {
        let session = self.session_for(app, project, relative_path).await?;
        let name = session
            .load_document(relative_path)
            .await
            .ok()
            .and_then(|loaded| word_at(&loaded.text, position))
            .unwrap_or_else(|| "引用".to_string());
        let result = session
            .references(relative_path, position, include_declaration)
            .await?;
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

    pub async fn code_actions(
        &self,
        app: &AppHandle,
        project: &Project,
        relative_path: &str,
        content: &str,
        range: LspRange,
        kinds: &[String],
    ) -> GazeResult<CodeActionResult> {
        let session = self.session_for(app, project, relative_path).await?;
        let mut actions = session
            .code_action(relative_path, content, range, kinds)
            .await?;
        // Ruff fallback: pyright has no `source.organizeImports`; use Ruff's CLI
        // to sort and remove unused imports when the server didn't offer one.
        if is_python_extension(
            Path::new(relative_path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or(""),
        ) && kinds.iter().any(|k| k == "source.organizeImports")
            && !actions.iter().any(|a| {
                a.kind
                    .as_deref()
                    .is_some_and(|k| k.starts_with("source.organizeImports"))
            })
        {
            if let Some(action) = self
                .ruff_organize_imports(project, relative_path, content)
                .await
            {
                actions.push(action);
            }
        }
        Ok(CodeActionResult {
            actions,
            source: "lsp".to_string(),
            message: None,
        })
    }

    pub async fn resolve_code_action(
        &self,
        app: &AppHandle,
        project: &Project,
        relative_path: &str,
        content: &str,
        resolve: CodeActionResolve,
    ) -> GazeResult<Option<CodeAction>> {
        let session = self.session_for(app, project, relative_path).await?;
        session
            .resolve_code_action(relative_path, content, resolve)
            .await
    }

    /// Optimize Imports with Ruff's CLI for a Python file no language server
    /// organizes. Returns `None` when Ruff is not installed or the file has no
    /// import changes to make.
    async fn ruff_organize_imports(
        &self,
        project: &Project,
        relative_path: &str,
        content: &str,
    ) -> Option<CodeAction> {
        let ruff = self.find_ruff(project).await?;
        let full_path = Path::new(&project.root).join(relative_path);
        let original = content.to_string();
        let stdin_text = original.clone();
        let output = tokio::task::spawn_blocking(move || {
            let mut command = std::process::Command::new(&ruff);
            command.args([
                "check",
                "--extend-select",
                "I",
                "--fixable",
                "I,F401",
                "--fix",
                "--exit-zero",
                "--quiet",
                "--stdin-filename",
            ]);
            command.arg(&full_path);
            command.arg("-");
            command.stdin(std::process::Stdio::piped());
            command.stdout(std::process::Stdio::piped());
            command.stderr(std::process::Stdio::piped());
            if let Some(dir) = full_path.parent() {
                command.current_dir(dir);
            }
            let mut child = command.spawn().ok()?;
            use std::io::Write;
            child.stdin.take()?.write_all(stdin_text.as_bytes()).ok()?;
            let output = child.wait_with_output().ok()?;
            if output.status.success() {
                Some(String::from_utf8_lossy(&output.stdout).into_owned())
            } else {
                None
            }
        })
        .await
        .ok()??;
        let edits = diff_text_edits(&original, &output);
        if edits.is_empty() {
            return None;
        }
        Some(CodeAction {
            title: "Optimize Imports (Ruff)".to_string(),
            kind: Some("source.organizeImports.ruff".to_string()),
            disabled_reason: None,
            is_preferred: true,
            edit: Some(WorkspaceEdit {
                files: vec![FileEdit {
                    path: relative_path.to_string(),
                    edits,
                }],
            }),
            resolve: None,
        })
    }

    /// Finds the `ruff` binary: first in the project's Python environment,
    /// then on `PATH`.
    async fn find_ruff(&self, project: &Project) -> Option<PathBuf> {
        // Try the project's Python environment first.
        if let Ok(status) = self.python_environment(project).await {
            if let Some(env) = status.environment {
                let interpreter = PathBuf::from(&env.path);
                if let Some(prefix) = python::prefix_of(&interpreter) {
                    let ruff = prefix.join("bin").join("ruff");
                    if ruff.is_file() {
                        return Some(ruff);
                    }
                    // Windows: Scripts/ruff.exe
                    let ruff = prefix.join("Scripts").join("ruff.exe");
                    if ruff.is_file() {
                        return Some(ruff);
                    }
                }
            }
        }
        // Fall back to PATH.
        which::which("ruff").ok()
    }

    pub async fn sync_document(
        &self,
        app: &AppHandle,
        project: &Project,
        relative_path: &str,
        content: &str,
    ) -> GazeResult<DiagnosticSync> {
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

    pub async fn resolve_completion(
        &self,
        app: &AppHandle,
        project: &Project,
        path: &str,
        content: &str,
        resolve: CompletionResolve,
    ) -> GazeResult<Option<CompletionItem>> {
        self.session_for(app, project, path)
            .await?
            .resolve_completion(path, content, resolve)
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
        shutdown_sessions(sessions).await;
    }
}

async fn shutdown_sessions(sessions: Vec<Arc<LspSession>>) {
    let mut tasks = tokio::task::JoinSet::new();
    for session in sessions {
        tasks.spawn(async move {
            session.shutdown().await;
        });
    }
    while tasks.join_next().await.is_some() {}
}

fn is_python_extension(extension: &str) -> bool {
    ["py", "pyi", "pyw"]
        .iter()
        .any(|item| extension.eq_ignore_ascii_case(item))
}

/// Computes the minimal text edits that transform `original` into `formatted`.
/// Uses a simple line-based diff: finds the first and last differing lines and
/// replaces that span. Suitable for import organization where changes are
/// typically confined to the file's header.
fn diff_text_edits(original: &str, formatted: &str) -> Vec<CompletionEdit> {
    if original == formatted {
        return Vec::new();
    }
    let old_lines: Vec<&str> = original.lines().collect();
    let new_lines: Vec<&str> = formatted.lines().collect();
    // Find the first differing line.
    let mut start = 0;
    while start < old_lines.len() && start < new_lines.len() && old_lines[start] == new_lines[start]
    {
        start += 1;
    }
    // Find the last differing line (from the end).
    let mut old_end = old_lines.len();
    let mut new_end = new_lines.len();
    while old_end > start && new_end > start && old_lines[old_end - 1] == new_lines[new_end - 1] {
        old_end -= 1;
        new_end -= 1;
    }
    // Compute UTF-16 offsets for the edit range.
    let from: usize = old_lines[..start]
        .iter()
        .map(|l| l.encode_utf16().count() + 1)
        .sum();
    let to: usize = old_lines[..old_end]
        .iter()
        .map(|l| l.encode_utf16().count() + 1)
        .sum();
    let insert = if new_end > start {
        let mut text = new_lines[start..new_end].join("\n");
        // The replaced span in the original always ends with a newline
        // (each line in `lines()` is followed by `\n` in the source).
        text.push('\n');
        text
    } else {
        String::new()
    };
    vec![CompletionEdit { from, to, insert }]
}

fn serves_python(server: &ResolvedLspServer) -> bool {
    server
        .config
        .extensions
        .iter()
        .any(|ext| is_python_extension(ext.trim_start_matches('.')))
}

fn is_typescript_extension(extension: &str) -> bool {
    TYPESCRIPT_EXTENSIONS
        .iter()
        .any(|item| extension.eq_ignore_ascii_case(item))
}

fn serves_typescript(server: &ResolvedLspServer) -> bool {
    server
        .config
        .extensions
        .iter()
        .any(|ext| is_typescript_extension(ext.trim_start_matches('.')))
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

/// Reads a bounded declaration, using LSP's full range to exclude a body.
fn declaration_excerpt(path: &Path, range: LspRange) -> Option<String> {
    use std::io::Read as _;
    const MAX_BYTES: u64 = 256 * 1024;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_BYTES {
        return None;
    }
    let text = String::from_utf8(bytes).ok()?;
    let start = range.start.line as usize;
    let end = range.end.line as usize;
    if start > end {
        return None;
    }
    let lines = text
        .lines()
        .skip(start)
        .take(end - start + 1)
        .collect::<Vec<_>>();
    let excerpt = if start == end {
        lines.first()?.trim().to_owned()
    } else if range.end.character == 0 {
        lines[..lines.len() - 1].join("\n")
    } else {
        let mut depth = 0_usize;
        let mut braces = 0_usize;
        let mut signature = Vec::new();
        for line in lines {
            let mut closes = false;
            for ch in line.chars() {
                match ch {
                    '(' | '[' => depth += 1,
                    ')' | ']' => depth = depth.saturating_sub(1),
                    '{' => {
                        if depth == 0 && braces == 0 && line.trim_end().ends_with('{') {
                            closes = true;
                        }
                        braces += 1;
                    }
                    '}' => braces = braces.saturating_sub(1),
                    ':' if depth == 0
                        && braces == 0
                        && !signature.is_empty()
                        && line.trim_end().ends_with(':') =>
                    {
                        closes = true
                    }
                    _ => {}
                }
            }
            if signature.len() >= 8 || closes {
                signature.push(line);
                break;
            }
            signature.push(line);
            if signature.len() >= 8 {
                break;
            }
        }
        signature.join("\n")
    };
    let excerpt = excerpt.trim();
    (!excerpt.is_empty() && excerpt.chars().count() <= 500).then(|| excerpt.to_owned())
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
                .get("targetRange")
                .or_else(|| value.get("targetSelectionRange"));
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

#[derive(Clone)]
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
    let mut canonical_paths = HashMap::new();
    let mut text_cache: HashMap<PathBuf, Arc<String>> = HashMap::new();
    for raw_location in raw.into_iter().take(limit) {
        let Ok(url) = Url::parse(&raw_location.uri) else {
            continue;
        };
        if url.host_str().is_some_and(|host| host != "localhost") {
            continue;
        }
        let Ok(path) = url.to_file_path() else {
            continue;
        };
        let path = canonical_paths
            .entry(path.clone())
            .or_insert_with(|| path.canonicalize().unwrap_or(path));
        let Some((project, relative)) = project_for_path(projects, path) else {
            let Some(path) = path
                .to_str()
                .filter(|path| !path.chars().any(char::is_control))
            else {
                continue;
            };
            locations.push(SymbolLocation {
                project_id: String::new(),
                path: path.to_string(),
                name: name.to_string(),
                kind: "reference".to_string(),
                line: raw_location.range.start.line,
                character: raw_location.range.start.character,
                end_line: raw_location.range.end.line,
                end_character: raw_location.range.end.character,
                source: source.to_string(),
                external_encoding: Some(encoding),
            });
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
            let text = if let Some(text) = text_cache.get(path) {
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
            external_encoding: None,
        });
    }
    Ok(NavigationResult {
        locations,
        source: source.to_string(),
        message: None,
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
        assert_eq!(locations[0].range.start.line, 1);
        assert_eq!(locations[1].range.end.character, 2);
    }

    #[test]
    fn extracts_bounded_multiline_declarations_without_bodies() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("declaration.ts");
        std::fs::write(
            &path,
            "export function loadProfile(\n  options: {\n    accountId: string\n  }\n): Promise<Profile> {\n  return fetchProfile(options)\n}\n",
        )
        .unwrap();
        let excerpt = declaration_excerpt(
            &path,
            LspRange {
                start: LspPosition {
                    line: 0,
                    character: 0,
                },
                end: LspPosition {
                    line: 6,
                    character: 1,
                },
            },
        )
        .unwrap();
        assert_eq!(
            excerpt,
            "export function loadProfile(\n  options: {\n    accountId: string\n  }\n): Promise<Profile> {"
        );
        assert!(!excerpt.contains("return fetchProfile"));
        let python = temp.path().join("declaration.py");
        std::fs::write(&python, "def lookup(\n    *,\n    account_id: str,\n) -> Profile:\n    return Profile(account_id)\n")
            .unwrap();
        assert_eq!(
            declaration_excerpt(
                &python,
                LspRange {
                    start: LspPosition {
                        line: 0,
                        character: 0
                    },
                    end: LspPosition {
                        line: 4,
                        character: 33
                    },
                },
            )
            .as_deref(),
            Some("def lookup(\n    *,\n    account_id: str,\n) -> Profile:")
        );
    }

    #[test]
    fn declaration_cache_is_bounded_and_rechecks_path_security() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let project = Project {
            id: "p".into(),
            name: "example".into(),
            root: root.display().to_string(),
        };
        std::fs::write(root.join("target.ts"), "export const target = 1").unwrap();
        let manager = LspManager::new(
            &Tools {
                rg: None,
                ctags: None,
                lsp: Vec::new(),
                config_message: None,
            },
            Cache::open_in_memory().unwrap(),
        );
        let location = RawLocation {
            uri: Url::from_file_path(root.join("target.ts"))
                .unwrap()
                .to_string(),
            range: LspRange {
                start: LspPosition {
                    line: 0,
                    character: 0,
                },
                end: LspPosition {
                    line: 0,
                    character: 23,
                },
            },
        };
        let source = ("p".into(), "session".into(), "file:///source.ts".into(), 1);
        assert_eq!(
            manager.declaration_snippets(&project, source.clone(), vec![location.clone()]),
            vec!["export const target = 1"]
        );
        std::fs::write(root.join(".gitignore"), "target.ts\n").unwrap();
        assert!(manager
            .declaration_snippets(&project, source.clone(), vec![location.clone()])
            .is_empty());
        std::fs::remove_file(root.join(".gitignore")).unwrap();
        std::fs::write(root.join("target.ts"), "export const changed = 2").unwrap();
        assert_eq!(
            manager.declaration_snippets(&project, source.clone(), vec![location.clone()]),
            vec!["export const target = 1"]
        );
        std::fs::remove_file(root.join("target.ts")).unwrap();
        assert!(manager
            .declaration_snippets(&project, source, vec![location])
            .is_empty());
        assert!(manager.declaration_cache.lock().unwrap().len() <= 1);
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

    #[tokio::test]
    async fn returns_external_local_locations_without_reading_them() {
        let outside = tempfile::tempdir().unwrap();
        let missing = outside.path().canonicalize().unwrap().join("unopened.d.ts");
        let uri = Url::from_file_path(&missing).unwrap().to_string();
        let range = LspRange {
            start: LspPosition {
                line: 10,
                character: 8,
            },
            end: LspPosition {
                line: 10,
                character: 12,
            },
        };
        let result = normalize_locations(
            vec![
                RawLocation { uri, range },
                RawLocation {
                    uri: "https://example.com/a.ts".to_string(),
                    range,
                },
                RawLocation {
                    uri: "file://example.com/share/a.ts".to_string(),
                    range,
                },
            ],
            &[],
            PositionEncoding::Utf8,
            "lsp",
            "example",
            10,
        )
        .await
        .unwrap();
        assert_eq!(result.locations.len(), 1);
        assert_eq!(
            result.locations[0].external_encoding,
            Some(PositionEncoding::Utf8)
        );
        assert_eq!(result.locations[0].path, missing.to_str().unwrap());
        assert_eq!(result.locations[0].character, 8);
    }

    #[tokio::test]
    async fn saving_python_interpreter_is_project_scoped_and_survives_reload() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let project = Project {
            id: "project".into(),
            name: "project".into(),
            root: root.to_str().unwrap().into(),
        };
        let other = Project {
            id: "other".into(),
            ..project.clone()
        };
        let executable = root.join(if cfg!(windows) {
            "python.exe"
        } else {
            "python3"
        });
        std::fs::write(&executable, "").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let database = root.join("cache.sqlite3");
        let cache = Cache::open(&database).unwrap();
        cache.insert_project(&project).await.unwrap();
        let tools = Tools {
            rg: None,
            ctags: None,
            lsp: crate::config::AppConfig::default()
                .servers()
                .into_iter()
                .map(|config| ResolvedLspServer {
                    config,
                    executable: None,
                })
                .collect(),
            config_message: None,
        };
        let manager = LspManager::new(&tools, cache);
        let interpreter = executable.to_str().unwrap().to_string();
        assert!(manager
            .set_python_environment(&project, Some("relative/python".into()))
            .await
            .is_err());
        manager
            .set_python_environment(&project, Some(interpreter.clone()))
            .await
            .unwrap();
        let cache = Cache::open(&database).unwrap();
        let reopened = LspManager::new(&tools, cache.clone());
        assert!(reopened.has_server_for("main.py"));
        reopened.set_python_enabled(false).await;
        assert!(!reopened.has_server_for("main.py"));
        assert!(reopened.has_server_for("main.ts"));
        assert!(reopened.python_environment(&project).await.is_err());
        reopened.set_python_enabled(true).await;
        assert!(reopened.has_server_for("main.py"));
        reopened.set_typescript_enabled(false).await;
        assert!(reopened.has_server_for("main.py"));
        for extension in TYPESCRIPT_EXTENSIONS {
            assert!(!reopened.has_server_for(&format!("main.{extension}")));
        }
        reopened.set_typescript_enabled(true).await;
        assert!(reopened.has_server_for("main.tsx"));
        assert_eq!(
            reopened
                .python_environment(&project)
                .await
                .unwrap()
                .selected,
            Some(interpreter)
        );
        assert!(reopened
            .python_environment(&other)
            .await
            .unwrap()
            .selected
            .is_none());
        reopened
            .set_python_environment(&project, None)
            .await
            .unwrap();
        assert!(reopened
            .python_environment(&project)
            .await
            .unwrap()
            .selected
            .is_none());
        cache.delete_project(&project.id).await.unwrap();
        assert!(cache
            .setting(&python::setting_key(&project.id))
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn real_pyright_uses_the_automatically_discovered_project_environment() {
        let (Ok(pyright), Ok(python_executable)) =
            (which::which("pyright-langserver"), which::which("python3"))
        else {
            eprintln!("Pyright or Python unavailable; skipping real integration test");
            return;
        };
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let prefix = root.join(".venv");
        assert!(std::process::Command::new(python_executable)
            .args(["-m", "venv", "--without-pip"])
            .arg(&prefix)
            .status()
            .unwrap()
            .success());
        let environment = python::status(&root, None).environment.unwrap();
        let python_path = environment.path;
        let site = std::process::Command::new(&python_path)
            .args([
                "-I",
                "-c",
                "import sysconfig; print(sysconfig.get_path('purelib'))",
            ])
            .output()
            .unwrap();
        assert!(site.status.success());
        let site = PathBuf::from(String::from_utf8(site.stdout).unwrap().trim());
        assert!(site.starts_with(&prefix));
        std::fs::write(site.join("gaze_fixture_dependency.py"), "value: int = 42\n").unwrap();
        let document = "from gaze_fixture_dependency import value\nresult: int = \"wrong\"\n";
        std::fs::write(root.join("main.py"), document).unwrap();
        let project = Project {
            id: "test".into(),
            name: "test".into(),
            root: root.to_str().unwrap().into(),
        };
        let server = ResolvedLspServer {
            config: crate::config::LspServerConfig {
                id: "python".into(),
                languages: vec!["python".into()],
                command: pyright.to_str().unwrap().into(),
                args: vec!["--stdio".into()],
                extensions: vec!["py".into()],
                initialization_options: None,
            },
            executable: Some(pyright),
        };
        let uri = Url::from_directory_path(&root).unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let session = LspSession::start(project, &server, &uri, Some(python_path), move |update| {
            let _ = tx.send(serde_json::to_value(update).unwrap());
        })
        .await
        .unwrap();
        session.sync_buffer("main.py", document).await.unwrap();
        let diagnostics = tokio::time::timeout(Duration::from_secs(12), async {
            while let Some(message) = rx.recv().await {
                let items = message["items"].as_array().unwrap();
                if items
                    .iter()
                    .any(|item| item["severity"] == 1 && item["start"]["line"] == 1)
                {
                    return message;
                }
            }
            panic!("Pyright stopped publishing diagnostics");
        })
        .await
        .expect("Pyright should analyze the actual virtual environment");
        assert!(
            diagnostics["items"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["severity"] != 1 || item["start"]["line"] != 0),
            "{diagnostics}"
        );
        let tools = Tools {
            rg: None,
            ctags: None,
            lsp: vec![server],
            config_message: None,
        };
        let manager = LspManager::new(&tools, Cache::open_in_memory().unwrap());
        let session = Arc::new(session);
        manager
            .sessions
            .lock()
            .unwrap()
            .insert("test\0python".into(), Arc::clone(&session));
        manager.set_python_enabled(false).await;
        assert!(manager.sessions.lock().unwrap().is_empty());
        tokio::time::timeout(Duration::from_secs(2), async {
            while !session.client.is_closed() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("disabled Python language server should exit");
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
    async fn real_typescript_lsp_semantics_for_open_and_unsaved_documents() {
        let Some(executable) = language_server_path() else {
            eprintln!("typescript-language-server not installed; skipping real LSP test");
            return;
        };
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(
            root.join("tsconfig.json"),
            r#"{"compilerOptions":{"target":"ES2022","strict":true,"module":"ESNext","moduleResolution":"Bundler"},"include":["src"]}"#,
        )
        .unwrap();
        std::fs::write(
            root.join("src/dependency.ts"),
            "export function exportedWidget(name: string): string { return name; }",
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
                    "tsserver": { "path": tsserver_path, "useSyntaxServer": "never" }
                })),
            },
            executable: Some(executable),
        };
        let root_uri = Url::from_directory_path(&root).unwrap();
        let (diagnostics_tx, mut diagnostics_rx) = tokio::sync::mpsc::unbounded_channel();
        let session = LspSession::start(project.clone(), &server, &root_uri, None, move |update| {
            let _ = diagnostics_tx.send(serde_json::to_value(update).unwrap());
        })
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
                true,
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

        let import_text = format!("{edited}\nconst widget = exportedWidg");
        let import_candidates = session
            .complete(
                "src/你好.ts",
                &import_text,
                TextPosition {
                    line: import_text.lines().count() as u32 - 1,
                    character: "const widget = exportedWidg".len() as u32,
                },
                None,
            )
            .await
            .unwrap();
        let import_candidates = serde_json::to_value(import_candidates).unwrap();
        let widget = import_candidates["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["label"] == "exportedWidget")
            .expect("completion should include an exported function from another file");
        let resolve = serde_json::from_value(widget["resolve"].clone()).unwrap();
        let completion = session
            .resolve_completion("src/你好.ts", &import_text, resolve)
            .await
            .unwrap()
            .unwrap();
        let completion = serde_json::to_value(completion).unwrap();
        assert!(completion["additionalEdits"][0]["insert"]
            .as_str()
            .unwrap()
            .contains("import { exportedWidget }"));

        assert_eq!(completion["snippet"], true);
        assert!(completion["insertText"]
            .as_str()
            .unwrap()
            .contains("${1:name}"));

        let invalid = format!("{edited}\nconst wrong: number = \"text\";\n");
        let sync = session.sync_buffer("src/你好.ts", &invalid).await.unwrap();
        tokio::time::timeout(Duration::from_secs(12), async {
            while let Some(batch) = diagnostics_rx.recv().await {
                if batch["version"] == sync.version
                    && batch["path"] == "src/你好.ts"
                    && batch["items"].as_array().unwrap().iter().any(|item| {
                        item["severity"] == 1
                            && item["message"].as_str().unwrap().contains("not assignable")
                    })
                {
                    return;
                }
            }
            panic!("TypeScript diagnostics channel closed");
        })
        .await
        .expect("TypeScript should publish a type error for the unsaved buffer");

        let fixed = session.sync_buffer("src/你好.ts", &edited).await.unwrap();
        tokio::time::timeout(Duration::from_secs(12), async {
            while let Some(batch) = diagnostics_rx.recv().await {
                if batch["version"] == fixed.version
                    && batch["path"] == "src/你好.ts"
                    && !batch["items"].as_array().unwrap().iter().any(|item| {
                        item["severity"] == 1
                            && item["message"].as_str().unwrap().contains("not assignable")
                    })
                {
                    return;
                }
            }
            panic!("TypeScript diagnostics channel closed");
        })
        .await
        .expect("TypeScript should clear the error after the unsaved buffer is corrected");

        std::fs::create_dir(root.join("src2")).unwrap();
        std::fs::write(root.join("src2/keep.ts"), "export const keep = 1;").unwrap();
        session.load_document("src2/keep.ts").await.unwrap();
        let session = Arc::new(session);
        let manager = LspManager {
            cache: Cache::open_in_memory().unwrap(),
            servers: vec![server],
            sessions: Arc::new(Mutex::new(HashMap::from([(
                "lsp-test\0typescript".to_string(),
                Arc::clone(&session),
            )]))),
            start_lock: tokio::sync::Mutex::new(()),
            python_enabled: AtomicBool::new(true),
            typescript_enabled: AtomicBool::new(true),
            declaration_cache: Mutex::new(Vec::new()),
        };
        let recorded = format!(
            "{edited}\nimport {{ exportedWidget }} from './dependency';\nconst widget = exportedWidget("
        );
        let buffer = format!("{recorded});\n");
        let cursor = TextPosition {
            line: recorded.lines().count() as u32 - 1,
            character: "const widget = exportedWidget(".len() as u32,
        };
        let sync = session.sync_buffer("src/你好.ts", &buffer).await.unwrap();
        assert!(manager
            .inline_declarations(
                &project,
                "src/你好.ts",
                cursor,
                (&recorded, ");"),
                (&sync.session, sync.version - 1)
            )
            .await
            .is_empty());
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let declarations = manager
                    .inline_declarations(
                        &project,
                        "src/你好.ts",
                        cursor,
                        (&recorded, ");"),
                        (&sync.session, sync.version),
                    )
                    .await;
                if declarations
                    .iter()
                    .any(|declaration| declaration.contains("exportedWidget(name: string)"))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("AI context should extract a declaration from the warmed language server");
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

        manager.set_typescript_enabled(false).await;
        assert!(manager.sessions.lock().unwrap().is_empty());
        tokio::time::timeout(Duration::from_secs(2), async {
            while !session.client.is_closed() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("disabled TypeScript language server should exit");
    }

    #[test]
    fn diff_text_edits_identical() {
        assert!(diff_text_edits("import os\n", "import os\n").is_empty());
    }

    #[test]
    fn diff_text_edits_single_line_change() {
        let old = "import os\nimport sys\n";
        let new = "import sys\nimport os\n";
        let edits = diff_text_edits(old, new);
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0].from, 0);
        assert_eq!(edits[0].insert, "import sys\nimport os\n");
    }

    #[test]
    fn diff_text_edits_removes_unused_import() {
        let old = "import os\nimport sys\nimport json\n\nprint(os)\n";
        let new = "import os\nimport json\n\nprint(os)\n";
        let edits = diff_text_edits(old, new);
        assert_eq!(edits.len(), 1);
        // The edit deletes the `import sys` line (replaces it with empty).
        // `import os` is before the diff; `import json` is in the common suffix.
        assert!(edits[0].insert.is_empty());
        assert!(edits[0].from > 0);
        assert!(edits[0].to > edits[0].from);
    }

    #[test]
    fn diff_text_edits_appends_at_end() {
        let old = "import os\n";
        let new = "import os\nimport sys\n";
        let edits = diff_text_edits(old, new);
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0].insert, "import sys\n");
    }

    #[test]
    fn diff_text_edits_utf16_offsets() {
        // "你好" is 2 UTF-16 code units per character.
        let old = "你好\nimport os\n";
        let new = "你好\nimport sys\nimport os\n";
        let edits = diff_text_edits(old, new);
        assert_eq!(edits.len(), 1);
        // "你好\n" = 2 UTF-16 units + 1 for newline = 3.
        assert_eq!(edits[0].from, 3);
    }
}
