use super::*;

#[derive(Debug, Clone, Copy)]
pub(super) struct ServerCapabilities {
    pub(super) definition: bool,
    references: bool,
    implementation: bool,
    document_symbol: bool,
    pub(super) completion: bool,
    pub(super) completion_resolve: bool,
    pub(super) hover: bool,
    pub(super) code_action: bool,
    pub(super) code_action_resolve: bool,
    pub(super) signature_help: bool,
    pub(super) formatting: bool,
    pub(super) range_formatting: bool,
}

pub(super) struct OpenDocument {
    pub(super) version: i64,
    fingerprint: FileFingerprint,
    pub(super) text: Arc<String>,
    dirty: bool,
    pub(super) diagnostics: Option<Vec<diagnostics::CodeDiagnostic>>,
    pub(super) raw_diagnostics: Vec<Value>,
}

pub(super) struct LoadedDocument {
    uri: String,
    pub(super) text: Arc<String>,
    index: TextIndex,
}

pub(super) struct LspSession {
    pub(super) project: Project,
    pub(super) server_id: String,
    pub(super) client: LspClient,
    pub(super) encoding: PositionEncoding,
    pub(super) capabilities: ServerCapabilities,
    pub(super) documents: Arc<tokio::sync::Mutex<HashMap<String, OpenDocument>>>,
    pub(super) id: String,
    pub(super) completion_triggers: Vec<String>,
    pub(super) completion_generation: tokio::sync::Mutex<u64>,
    incremental_sync: bool,
}

impl LspSession {
    pub(super) async fn start(
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
                    "publishDiagnostics": { "versionSupport": true, "dataSupport": true },
                    "signatureHelp": { "signatureInformation": {
                        "parameterInformation": { "labelOffsetSupport": true },
                        "activeParameterSupport": true
                    } },
                    "codeAction": {
                        "codeActionLiteralSupport": { "codeActionKind": {
                            "valueSet": ["", "quickfix", "source", "source.organizeImports"]
                        } },
                        "dataSupport": true,
                        "disabledSupport": true,
                        "resolveSupport": { "properties": ["edit"] }
                    },
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
            signature_help: capability_enabled(&server_capabilities, "signatureHelpProvider"),
            formatting: capability_enabled(&server_capabilities, "documentFormattingProvider"),
            range_formatting: capability_enabled(
                &server_capabilities,
                "documentRangeFormattingProvider",
            ),
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

    pub(super) async fn load_document(&self, relative_path: &str) -> GazeResult<LoadedDocument> {
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
                        raw_diagnostics: Vec::new(),
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

    pub(super) async fn sync_buffer(
        &self,
        relative_path: &str,
        content: &str,
    ) -> GazeResult<DiagnosticSync> {
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
                        raw_diagnostics: Vec::new(),
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
        document.raw_diagnostics.clear();
        self.client.notify(
            "textDocument/didChange",
            json!({
                "textDocument": { "uri": uri, "version": document.version },
                "contentChanges": [change]
            }),
        );
    }

    pub(super) async fn definition(
        &self,
        relative_path: &str,
        position: TextPosition,
    ) -> GazeResult<Value> {
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

    pub(super) async fn references(
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

    pub(super) async fn implementation(
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

    pub(super) async fn document_symbols(&self, relative_path: &str) -> GazeResult<OutlineResult> {
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

    pub(super) async fn shutdown(&self) {
        self.client.shutdown().await;
    }
}
