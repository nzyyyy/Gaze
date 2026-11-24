use super::*;

use super::completion::{parse_edit, CompletionEdit};

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeActionResult {
    pub actions: Vec<CodeAction>,
    pub source: String,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeAction {
    pub title: String,
    pub kind: Option<String>,
    pub disabled_reason: Option<String>,
    pub is_preferred: bool,
    pub edit: Option<WorkspaceEdit>,
    /// Opaque payload for `codeAction/resolve` when the server deferred the edit.
    pub resolve: Option<CodeActionResolve>,
}

#[derive(Debug, Serialize, serde::Deserialize)]
pub struct CodeActionResolve {
    pub session: String,
    pub action: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEdit {
    pub files: Vec<FileEdit>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEdit {
    /// Project-relative path when the file belongs to the session's project,
    /// otherwise the absolute path (external files, library sources).
    pub path: String,
    pub edits: Vec<CompletionEdit>,
}

impl LspSession {
    pub(super) async fn code_action(
        &self,
        relative_path: &str,
        content: &str,
        range: LspRange,
        kinds: &[String],
    ) -> GazeResult<Vec<CodeAction>> {
        if !self.capabilities.code_action {
            return Ok(Vec::new());
        }
        self.sync_buffer(relative_path, content).await?;
        let uri = Url::from_file_path(Path::new(&self.project.root).join(relative_path))
            .map_err(|_| GazeError::InvalidPath("无法将文件路径转换为 LSP URI。".to_string()))?;
        let index = TextIndex::new(content);
        let start = index.utf16_to_lsp(
            content,
            TextPosition {
                line: range.start.line,
                character: range.start.character,
            },
            self.encoding,
        )?;
        let end = index.utf16_to_lsp(
            content,
            TextPosition {
                line: range.end.line,
                character: range.end.character,
            },
            self.encoding,
        )?;
        let params = json!({
            "textDocument": { "uri": uri },
            "range": { "start": start, "end": end },
            "context": {
                "diagnostics": [],
                "only": kinds,
                "triggerKind": 1,
            },
        });
        let result = self
            .client
            .request("textDocument/codeAction", params, REQUEST_TIMEOUT)
            .await?;
        let items = result.as_array().cloned().unwrap_or_default();
        let mut actions = Vec::new();
        for item in items {
            if let Some(action) = self.normalize_action(&item, content, &index) {
                actions.push(action);
            }
        }
        Ok(actions)
    }

    pub(super) async fn resolve_code_action(
        &self,
        relative_path: &str,
        content: &str,
        resolve: CodeActionResolve,
    ) -> GazeResult<Option<CodeAction>> {
        if !self.capabilities.code_action_resolve || resolve.session != self.id {
            return Ok(None);
        }
        let resolved = self
            .client
            .request("codeAction/resolve", resolve.action, REQUEST_TIMEOUT)
            .await?;
        let index = TextIndex::new(content);
        // Re-sync so the index matches the server's view of the document.
        self.sync_buffer(relative_path, content).await?;
        Ok(self.normalize_action(&resolved, content, &index))
    }

    fn normalize_action(
        &self,
        item: &Value,
        content: &str,
        index: &TextIndex,
    ) -> Option<CodeAction> {
        // LSP allows `Command` entries in the response; we only surface full CodeActions.
        if item.get("command").is_some_and(|c| c.is_string()) && item.get("title").is_some() {
            // A bare Command has `command: string`; a CodeAction's `command` is an object.
            // We skip bare commands because they have no edit to apply.
            if item.get("command").unwrap().is_string() {
                return None;
            }
        }
        let title = item.get("title")?.as_str()?.to_string();
        let kind = item.get("kind").and_then(Value::as_str).map(str::to_string);
        let disabled_reason = item
            .pointer("/disabled/reason")
            .and_then(Value::as_str)
            .map(str::to_string);
        let is_preferred = item
            .get("isPreferred")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let edit = item
            .get("edit")
            .and_then(|edit| self.normalize_workspace_edit(edit, content, index));
        // When the server deferred the edit via `data`, offer a resolve handle.
        let resolve = if edit.is_none() && item.get("data").is_some() {
            self.capabilities
                .code_action_resolve
                .then(|| CodeActionResolve {
                    session: self.id.clone(),
                    action: item.clone(),
                })
        } else {
            None
        };
        // Skip actions that carry neither an edit nor a resolvable payload nor a command:
        // there is nothing we can apply on the user's behalf.
        if edit.is_none() && resolve.is_none() && item.get("command").is_none() {
            return None;
        }
        Some(CodeAction {
            title,
            kind,
            disabled_reason,
            is_preferred,
            edit,
            resolve,
        })
    }

    fn normalize_workspace_edit(
        &self,
        edit: &Value,
        content: &str,
        index: &TextIndex,
    ) -> Option<WorkspaceEdit> {
        let mut files: Vec<FileEdit> = Vec::new();
        // `changes`: map of uri → TextEdit[]. All edits in one file share the buffer.
        if let Some(changes) = edit.get("changes").and_then(Value::as_object) {
            for (uri, edits) in changes {
                let path = self.uri_to_path(uri)?;
                let text = self.text_for_uri(uri, content);
                let file_index = TextIndex::new(&text);
                let parsed = parse_edits_array(edits, &text, &file_index, self.encoding)?;
                files.push(FileEdit {
                    path,
                    edits: parsed,
                });
            }
        }
        // `documentChanges`: ordered TextDocumentEdit[] (may also carry file ops, which we skip).
        if let Some(document_changes) = edit.get("documentChanges").and_then(Value::as_array) {
            for change in document_changes {
                let Some(text_document) = change.get("textDocument") else {
                    continue;
                };
                let Some(uri) = text_document.get("uri").and_then(Value::as_str) else {
                    continue;
                };
                let path = self.uri_to_path(uri)?;
                let text = self.text_for_uri(uri, content);
                let file_index = TextIndex::new(&text);
                let edits_value = change.get("edits")?;
                let parsed = parse_edits_array(edits_value, &text, &file_index, self.encoding)?;
                files.push(FileEdit {
                    path,
                    edits: parsed,
                });
            }
        }
        let _ = (content, index);
        if files.is_empty() {
            None
        } else {
            Some(WorkspaceEdit { files })
        }
    }

    fn uri_to_path(&self, uri: &str) -> Option<String> {
        let url = Url::parse(uri).ok()?;
        let path = url.to_file_path().ok()?;
        let root = Path::new(&self.project.root);
        match path.strip_prefix(root) {
            Ok(relative) => Some(relative.to_string_lossy().replace('\\', "/")),
            Err(_) => Some(path.to_string_lossy().into_owned()),
        }
    }

    /// Returns the buffer for `uri` if it matches the current document, otherwise
    /// reads from the session's open documents or falls back to the on-disk text.
    fn text_for_uri(&self, uri: &str, current_content: &str) -> String {
        let current_uri = Url::from_file_path(Path::new(&self.project.root).join(""))
            .ok()
            .map(|u| u.to_string());
        let _ = current_uri;
        // The common case for auto-import is that all edits target the current file.
        // For other files we fall back to reading from disk; cross-file edits that
        // touch unsaved buffers are rare and out of scope for this first pass.
        if let Ok(url) = Url::parse(uri) {
            if let Ok(path) = url.to_file_path() {
                let root = Path::new(&self.project.root);
                if let Ok(relative) = path.strip_prefix(root) {
                    let relative_str = relative.to_string_lossy().replace('\\', "/");
                    // Try the open document cache first.
                    if let Ok(documents) = self.documents.try_lock() {
                        if let Some(doc) = documents.get(uri) {
                            return doc.text.as_str().to_string();
                        }
                    }
                    let _ = relative_str;
                }
                if let Ok(text) = std::fs::read_to_string(&path) {
                    return text;
                }
            }
        }
        current_content.to_string()
    }
}

fn parse_edits_array(
    edits: &Value,
    text: &str,
    index: &TextIndex,
    encoding: PositionEncoding,
) -> Option<Vec<CompletionEdit>> {
    let items = edits.as_array()?;
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        // `documentChanges` entries may wrap edits in `textEdit` (AnnotatedTextEdit).
        let edit_value = item.get("textEdit").unwrap_or(item);
        let edit = parse_edit(edit_value, text, index, encoding).ok()?;
        out.push(edit);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_changes_map() {
        let text = "import os\n";
        let index = TextIndex::new(text);
        let edit = json!({
            "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 0 } },
            "newText": "import sys\n"
        });
        let parsed = parse_edit(&edit, text, &index, PositionEncoding::Utf16).unwrap();
        assert_eq!(parsed.from, 0);
        assert_eq!(parsed.to, 0);
        assert_eq!(parsed.insert, "import sys\n");
    }

    #[test]
    fn parses_annotated_text_edit() {
        let text = "hello\n";
        let index = TextIndex::new(text);
        let edits = json!([
            {
                "textEdit": {
                    "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 5 } },
                    "newText": "world"
                },
                "annotationId": "x"
            }
        ]);
        let parsed = parse_edits_array(&edits, text, &index, PositionEncoding::Utf16).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].insert, "world");
        assert_eq!(parsed[0].to, 5);
    }
}
