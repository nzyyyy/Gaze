use super::*;

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

    pub(super) async fn session_for(
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

    pub(super) fn open_session(&self, key: &str) -> Option<Arc<LspSession>> {
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

    pub(super) fn server_for_path(&self, relative_path: &str) -> Option<&ResolvedLspServer> {
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
        let organize = is_python_path(relative_path)
            && kinds.iter().any(|kind| kind == "source.organizeImports");
        let mut result = match self.session_for(app, project, relative_path).await {
            Ok(session) => {
                session
                    .code_action(relative_path, content, range, kinds)
                    .await?
            }
            Err(GazeError::ToolMissing(_) | GazeError::Unsupported(_)) if organize => {
                self.ensure_python_enabled()?;
                CodeActionResult::default()
            }
            Err(error) => return Err(error),
        };
        if organize
            && !result.actions.iter().any(|action| {
                action.disabled_reason.is_none()
                    && action
                        .kind
                        .as_deref()
                        .is_some_and(|kind| kind.starts_with("source.organizeImports"))
            })
        {
            let output = self
                .run_ruff(
                    project,
                    relative_path,
                    content,
                    &[
                        "check",
                        "--extend-select",
                        "I",
                        "--fixable",
                        "I,F401",
                        "--fix",
                        "--no-unsafe-fixes",
                        "--exit-zero",
                        "--quiet",
                    ],
                )
                .await?;
            let edits = diff_text_edits(content, &output);
            result.source = "ruff".to_string();
            result.message = None;
            result.revision = None;
            if !edits.is_empty() {
                result.actions.push(CodeAction {
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
                });
            }
        }
        Ok(result)
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

    pub(super) async fn run_ruff(
        &self,
        project: &Project,
        path: &str,
        content: &str,
        args: &[&str],
    ) -> GazeResult<String> {
        use tokio::io::AsyncWriteExt;

        if content.len() as u64 > crate::files::MAX_FILE_BYTES {
            return Err(GazeError::Unsupported(
                "文件过大，无法运行 Ruff。".to_string(),
            ));
        }
        let root = PathBuf::from(&project.root);
        let path = path.to_string();
        let full_path =
            tokio::task::spawn_blocking(move || crate::files::resolve_within_root(&root, &path))
                .await
                .map_err(GazeError::Join)??;
        let ruff = self.find_ruff(project).await.ok_or_else(|| {
            GazeError::ToolMissing("请安装 Ruff 以处理此 Python 文件。".to_string())
        })?;
        let mut command = tokio::process::Command::new(ruff);
        command
            .args(args)
            .arg("--stdin-filename")
            .arg(&full_path)
            .arg("-")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        if let Some(parent) = full_path.parent() {
            command.current_dir(parent);
        }
        let error = |message: &str| GazeError::Message(message.to_string());
        let mut child = command.spawn().map_err(|_| error("无法启动 Ruff。"))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| error("无法向 Ruff 写入源码。"))?;
        let write = async move { stdin.write_all(content.as_bytes()).await };
        let output = tokio::time::timeout(REQUEST_TIMEOUT, async {
            let (written, output) = tokio::join!(write, child.wait_with_output());
            (written, output)
        })
        .await
        .map_err(|_| error("Ruff 请求超时。"))?;
        let (written, output) = output;
        let output = output.map_err(|_| error("无法读取 Ruff 的结果。"))?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            return Err(GazeError::Message(format!(
                "Ruff 执行失败：{}",
                detail.lines().take(3).collect::<Vec<_>>().join(" ")
            )));
        }
        written.map_err(|_| error("无法向 Ruff 写入源码。"))?;
        if output.stdout.len() as u64 > crate::files::MAX_FILE_BYTES {
            return Err(error("Ruff 返回的内容过大。"));
        }
        String::from_utf8(output.stdout).map_err(|_| error("Ruff 返回了无效的 UTF-8。"))
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let buffer = "def draw(width: int, height: int):\n    pass\n\ndraw(1, 2)\n";
        let signature = session
            .signature_help(
                "main.py",
                buffer,
                TextPosition {
                    line: 3,
                    character: 8,
                },
            )
            .await
            .unwrap()
            .unwrap();
        let value = serde_json::to_value(signature).unwrap();
        assert!(
            value["signatures"][0]["label"]
                .as_str()
                .unwrap()
                .contains("height: int"),
            "{value}"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("main.py")).unwrap(),
            document
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
        let signature = session
            .signature_help(
                "src/你好.ts",
                &hover_text,
                TextPosition {
                    line: hover_text.lines().count() as u32 - 1,
                    character: character + 9,
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert!(serde_json::to_string(&signature)
            .unwrap()
            .contains("id: number"));
        let unformatted = "const value={x:1,y:2};\n";
        for range in [
            None,
            Some(LspRange {
                start: LspPosition {
                    line: 0,
                    character: 0,
                },
                end: LspPosition {
                    line: 0,
                    character: 22,
                },
            }),
        ] {
            let format_options =
                serde_json::from_value(json!({"tabSize": 2, "insertSpaces": true})).unwrap();
            let formatted = session
                .format("src/你好.ts", unformatted, range, format_options)
                .await
                .unwrap();
            assert!(!serde_json::to_value(formatted).unwrap()["edits"]
                .as_array()
                .unwrap()
                .is_empty());
        }
        let imports = "import { exportedWidget as z } from './dependency';\n\
                       import { exportedWidget as a } from './dependency';\n\
                       export const values = [a('a'), z('z')];\n";
        let organized = session
            .code_action(
                "src/你好.ts",
                imports,
                LspRange {
                    start: LspPosition {
                        line: 0,
                        character: 0,
                    },
                    end: LspPosition {
                        line: 3,
                        character: 0,
                    },
                },
                &["source.organizeImports".to_string()],
            )
            .await
            .unwrap();
        assert!(organized.actions.iter().any(|action| action.edit.is_some()));
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

        let invalid = format!(
            "{edited}\nconst wrong: number = \"text\";\nconst missing = exportedWidget('name');\n"
        );
        let sync = session.sync_buffer("src/你好.ts", &invalid).await.unwrap();
        tokio::time::timeout(Duration::from_secs(12), async {
            while let Some(batch) = diagnostics_rx.recv().await {
                if batch["version"] == sync.version
                    && batch["path"] == "src/你好.ts"
                    && batch["items"].as_array().unwrap().iter().any(|item| {
                        item["severity"] == 1
                            && item["message"].as_str().unwrap().contains("not assignable")
                    })
                    && batch["items"].as_array().unwrap().iter().any(|item| {
                        item["message"]
                            .as_str()
                            .unwrap()
                            .contains("Cannot find name 'exportedWidget'")
                    })
                {
                    return;
                }
            }
            panic!("TypeScript diagnostics channel closed");
        })
        .await
        .expect("TypeScript should publish a type error for the unsaved buffer");

        let line = invalid.lines().count() as u32 - 1;
        let position = LspPosition {
            line,
            character: "const missing = ".len() as u32,
        };
        let fixes = session
            .code_action(
                "src/你好.ts",
                &invalid,
                LspRange {
                    start: position,
                    end: position,
                },
                &["quickfix".to_string()],
            )
            .await
            .unwrap();
        let revision = fixes.revision.unwrap();
        assert!(
            fixes
                .actions
                .iter()
                .any(|action| action.title.contains("import") && action.edit.is_some()),
            "{:?}",
            fixes.actions
        );
        let fixed = session.sync_buffer("src/你好.ts", &edited).await.unwrap();
        assert!(
            !session
                .document_matches(
                    &session.document_uri("src/你好.ts").unwrap(),
                    &revision,
                    &invalid
                )
                .await
        );
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
}
