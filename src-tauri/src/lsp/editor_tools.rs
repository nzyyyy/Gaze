use super::*;
use serde::Deserialize;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DocumentRevision {
    session: String,
    pub(super) version: i64,
}

impl From<DiagnosticSync> for DocumentRevision {
    fn from(value: DiagnosticSync) -> Self {
        Self {
            session: value.session,
            version: value.version,
        }
    }
}

pub(super) struct RequestDocument {
    pub(super) uri: Url,
    pub(super) index: TextIndex,
    pub(super) revision: DocumentRevision,
}

#[derive(Deserialize, Serialize)]
#[serde(untagged)]
enum ParameterLabel {
    Text(String),
    Offsets([usize; 2]),
}

#[derive(Deserialize, Serialize)]
struct ParameterInformation {
    label: ParameterLabel,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SignatureInformation {
    label: String,
    #[serde(default)]
    parameters: Vec<ParameterInformation>,
    active_parameter: Option<usize>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureHelp {
    signatures: Vec<SignatureInformation>,
    active_signature: Option<usize>,
    active_parameter: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormattingOptions {
    tab_size: u8,
    insert_spaces: bool,
}

#[derive(Serialize)]
pub struct FormatResult {
    edits: Vec<CompletionEdit>,
    revision: Option<DocumentRevision>,
}

pub(super) fn encoded_range(
    index: &TextIndex,
    content: &str,
    range: LspRange,
    encoding: PositionEncoding,
) -> GazeResult<LspRange> {
    let encode = |p: LspPosition| {
        index.utf16_to_lsp(
            content,
            TextPosition {
                line: p.line,
                character: p.character,
            },
            encoding,
        )
    };
    let start = encode(range.start)?;
    let end = encode(range.end)?;
    if (start.line, start.character) > (end.line, end.character) {
        return Err(GazeError::Message("编辑器请求的文本范围无效。".to_string()));
    }
    Ok(LspRange { start, end })
}

impl LspSession {
    pub(super) fn document_uri(&self, path: &str) -> GazeResult<Url> {
        Url::from_file_path(Path::new(&self.project.root).join(path))
            .map_err(|_| GazeError::InvalidPath("无法将文件路径转换为 LSP URI。".to_string()))
    }

    pub(super) async fn request_document(
        &self,
        path: &str,
        content: &str,
    ) -> GazeResult<RequestDocument> {
        let revision = self.sync_buffer(path, content).await?.into();
        Ok(RequestDocument {
            uri: self.document_uri(path)?,
            index: TextIndex::new(content),
            revision,
        })
    }

    pub(super) async fn document_matches(
        &self,
        uri: &Url,
        revision: &DocumentRevision,
        content: &str,
    ) -> bool {
        revision.session == self.id
            && !self.client.is_closed()
            && self
                .documents
                .lock()
                .await
                .get(uri.as_str())
                .is_some_and(|document| {
                    document.version == revision.version && document.text.as_str() == content
                })
    }

    pub(super) async fn ensure_current(
        &self,
        doc: &RequestDocument,
        content: &str,
    ) -> GazeResult<()> {
        if self
            .document_matches(&doc.uri, &doc.revision, content)
            .await
        {
            Ok(())
        } else {
            Err(GazeError::Conflict(
                "语言服务文档已更改，请重试。".to_string(),
            ))
        }
    }

    pub(super) async fn diagnostics_in_range(
        &self,
        doc: &RequestDocument,
        range: LspRange,
    ) -> Vec<Value> {
        self.documents
            .lock()
            .await
            .get(doc.uri.as_str())
            .filter(|document| document.version == doc.revision.version)
            .map(|document| {
                document
                    .raw_diagnostics
                    .iter()
                    .filter(|item| {
                        serde_json::from_value::<LspRange>(item["range"].clone()).is_ok_and(
                            |item| {
                                (item.start.line, item.start.character)
                                    <= (range.end.line, range.end.character)
                                    && (range.start.line, range.start.character)
                                        <= (item.end.line, item.end.character)
                            },
                        )
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(super) async fn signature_help(
        &self,
        path: &str,
        content: &str,
        position: TextPosition,
    ) -> GazeResult<Option<SignatureHelp>> {
        if !self.capabilities.signature_help {
            return Err(GazeError::Unsupported(
                "当前语言服务器不支持参数提示。".to_string(),
            ));
        }
        let doc = self.request_document(path, content).await?;
        let position = doc.index.utf16_to_lsp(content, position, self.encoding)?;
        let value = self
            .client
            .request(
                "textDocument/signatureHelp",
                json!({
                    "textDocument": { "uri": doc.uri },
                    "position": position,
                }),
                REQUEST_TIMEOUT,
            )
            .await?;
        self.ensure_current(&doc, content).await?;
        serde_json::from_value(value)
            .map_err(|_| GazeError::Message("语言服务器返回了无效的参数提示。".to_string()))
    }

    pub(super) async fn format(
        &self,
        path: &str,
        content: &str,
        range: Option<LspRange>,
        options: FormattingOptions,
    ) -> GazeResult<FormatResult> {
        let doc = self.request_document(path, content).await?;
        let mut params = json!({
            "textDocument": { "uri": doc.uri },
            "options": { "tabSize": options.tab_size, "insertSpaces": options.insert_spaces },
        });
        let method = if let Some(range) = range {
            params["range"] = json!(encoded_range(&doc.index, content, range, self.encoding)?);
            "textDocument/rangeFormatting"
        } else {
            "textDocument/formatting"
        };
        let value = self.client.request(method, params, REQUEST_TIMEOUT).await?;
        self.ensure_current(&doc, content).await?;
        let edits = if value.is_null() {
            Vec::new()
        } else {
            code_action::parse_edits_array(&value, content, &doc.index, self.encoding).ok_or_else(
                || GazeError::Message("语言服务器返回了无效的格式化编辑。".to_string()),
            )?
        };
        Ok(FormatResult {
            edits,
            revision: Some(doc.revision),
        })
    }
}

impl LspManager {
    pub async fn editor_revision_matches(
        &self,
        project: &Project,
        path: &str,
        content: &str,
        revision: &DocumentRevision,
    ) -> GazeResult<bool> {
        let Some(server) = self.server_for_path(path) else {
            return Ok(false);
        };
        let key = format!("{}\u{0000}{}", project.id, server.config.id);
        let Some(session) = self.open_session(&key) else {
            return Ok(false);
        };
        let uri = session.document_uri(path)?;
        Ok(session.document_matches(&uri, revision, content).await)
    }

    pub async fn signature_help(
        &self,
        app: &AppHandle,
        project: &Project,
        path: &str,
        content: &str,
        position: TextPosition,
    ) -> GazeResult<Option<SignatureHelp>> {
        self.session_for(app, project, path)
            .await?
            .signature_help(path, content, position)
            .await
    }

    pub async fn format(
        &self,
        app: &AppHandle,
        project: &Project,
        path: &str,
        content: &str,
        range: Option<LspRange>,
        options: FormattingOptions,
    ) -> GazeResult<FormatResult> {
        let can_fallback = range.is_none() && is_python_path(path);
        match self.session_for(app, project, path).await {
            Ok(session)
                if if range.is_some() {
                    session.capabilities.range_formatting
                } else {
                    session.capabilities.formatting
                } =>
            {
                return session.format(path, content, range, options).await;
            }
            Ok(_) if range.is_some() => {
                return Err(GazeError::Unsupported(
                    "当前语言服务器不支持选区格式化。".to_string(),
                ));
            }
            Ok(_) if !can_fallback => {
                return Err(GazeError::Unsupported(
                    "当前语言服务器不支持格式化。".to_string(),
                ));
            }
            Err(error)
                if !can_fallback
                    || !matches!(error, GazeError::ToolMissing(_) | GazeError::Unsupported(_)) =>
            {
                return Err(error)
            }
            _ => {}
        }
        self.ensure_python_enabled()?;
        let output = self.run_ruff(project, path, content, &["format"]).await?;
        Ok(FormatResult {
            edits: diff_text_edits(content, &output),
            revision: None,
        })
    }
}
