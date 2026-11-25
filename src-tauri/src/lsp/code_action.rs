use super::*;

use super::completion::{parse_edit, CompletionEdit};
use super::editor_tools::{encoded_range, DocumentRevision, RequestDocument};

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeActionResult {
    pub actions: Vec<CodeAction>,
    pub source: String,
    pub message: Option<String>,
    pub revision: Option<DocumentRevision>,
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
    path: String,
    revision: DocumentRevision,
    action: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEdit {
    pub files: Vec<FileEdit>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEdit {
    pub path: String,
    pub edits: Vec<CompletionEdit>,
}

impl LspSession {
    pub(super) async fn code_action(
        &self,
        path: &str,
        content: &str,
        range: LspRange,
        kinds: &[String],
    ) -> GazeResult<CodeActionResult> {
        if !self.capabilities.code_action {
            return Ok(CodeActionResult {
                source: "lsp".to_string(),
                message: Some("当前语言服务器不支持代码操作。".to_string()),
                ..Default::default()
            });
        }
        let doc = self.request_document(path, content).await?;
        let range = encoded_range(&doc.index, content, range, self.encoding)?;
        let diagnostics = self.diagnostics_in_range(&doc, range).await;
        self.ensure_current(&doc, content).await?;
        let result = self
            .client
            .request(
                "textDocument/codeAction",
                json!({
                    "textDocument": { "uri": doc.uri },
                    "range": range,
                    "context": { "diagnostics": diagnostics, "only": kinds, "triggerKind": 1 },
                }),
                REQUEST_TIMEOUT,
            )
            .await?;
        self.ensure_current(&doc, content).await?;
        let actions = result
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| self.normalize_action(item, path, content, &doc))
            .collect();
        Ok(CodeActionResult {
            actions,
            source: "lsp".to_string(),
            message: None,
            revision: Some(doc.revision),
        })
    }

    pub(super) async fn resolve_code_action(
        &self,
        path: &str,
        content: &str,
        resolve: CodeActionResolve,
    ) -> GazeResult<Option<CodeAction>> {
        if !self.capabilities.code_action_resolve || path != resolve.path {
            return Ok(None);
        }
        let doc = RequestDocument {
            uri: self.document_uri(path)?,
            index: TextIndex::new(content),
            revision: resolve.revision,
        };
        self.ensure_current(&doc, content).await?;
        let item = self
            .client
            .request("codeAction/resolve", resolve.action, REQUEST_TIMEOUT)
            .await?;
        self.ensure_current(&doc, content).await?;
        Ok(self
            .normalize_action(&item, path, content, &doc)
            .filter(|action| action.edit.is_some()))
    }

    fn normalize_action(
        &self,
        item: &Value,
        path: &str,
        content: &str,
        doc: &RequestDocument,
    ) -> Option<CodeAction> {
        if item.get("command").is_some_and(|command| {
            !(command.is_null()
                || self.server_id == "typescript" && typescript_noop_command(command))
        }) {
            return None;
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
        let edit = match item.get("edit").filter(|value| !value.is_null()) {
            Some(edit) => Some(WorkspaceEdit {
                files: vec![FileEdit {
                    path: path.to_string(),
                    edits: single_document_edits(edit, doc, content, self.encoding)?,
                }],
            }),
            None => None,
        };
        let resolve =
            (edit.is_none() && item.get("data").is_some() && self.capabilities.code_action_resolve)
                .then(|| CodeActionResolve {
                    path: path.to_string(),
                    revision: doc.revision.clone(),
                    action: item.clone(),
                });
        if edit.is_none() && resolve.is_none() && disabled_reason.is_none() {
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
}

fn typescript_noop_command(command: &Value) -> bool {
    // typescript-language-server's ApplyCodeActionCommand only forwards action.commands.
    command["command"] == "_typescript.applyCodeActionCommand"
        && command
            .pointer("/arguments/0/action")
            .is_some_and(|action| {
                action.is_object()
                    && action.get("commands").is_none_or(|commands| {
                        commands.is_null() || commands.as_array().is_some_and(Vec::is_empty)
                    })
            })
}

fn single_document_edits(
    edit: &Value,
    doc: &RequestDocument,
    content: &str,
    encoding: PositionEncoding,
) -> Option<Vec<CompletionEdit>> {
    // Both representations are valid, but combining them could apply edits twice.
    let edits = match (edit.get("changes"), edit.get("documentChanges")) {
        (Some(changes), None) => {
            let files = changes.as_object()?;
            if files.len() != 1 {
                return None;
            }
            files.get(doc.uri.as_str())?
        }
        (None, Some(changes)) => {
            let [change] = changes.as_array()?.as_slice() else {
                return None;
            };
            if change.pointer("/textDocument/uri")?.as_str()? != doc.uri.as_str()
                || change
                    .pointer("/textDocument/version")
                    .is_some_and(|version| {
                        !version.is_null() && version.as_i64() != Some(doc.revision.version)
                    })
            {
                return None;
            }
            change.get("edits")?
        }
        _ => return None,
    };
    if edits.as_array()?.iter().any(|text_edit| {
        text_edit
            .get("annotationId")
            .and_then(Value::as_str)
            .is_some_and(|id| {
                edit["changeAnnotations"][id]["needsConfirmation"].as_bool() == Some(true)
            })
    }) {
        return None;
    }
    parse_edits_array(edits, content, &doc.index, encoding)
}

pub(super) fn parse_edits_array(
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
    fn workspace_edit_rejects_a_second_file_resource_op_or_previous_version() {
        let text = "let x = 1;";
        let doc = RequestDocument {
            uri: Url::parse("file:///main.ts").unwrap(),
            index: TextIndex::new(text),
            revision: DiagnosticSync {
                session: "test".to_string(),
                version: 3,
                items: None,
            }
            .into(),
        };
        let edit = json!({
            "range": { "start": { "line": 0, "character": 4 }, "end": { "line": 0, "character": 5 } },
            "newText": "y",
        });
        let target = |version| {
            json!({
                "textDocument": { "uri": doc.uri, "version": version },
                "edits": [edit]
            })
        };
        let parse = |value| single_document_edits(&value, &doc, text, PositionEncoding::Utf8);
        assert_eq!(
            parse(json!({ "documentChanges": [target(3)] })).unwrap()[0].insert,
            "y"
        );
        assert!(parse(json!({ "documentChanges": [target(2)] })).is_none());
        assert!(parse(json!({ "documentChanges": [target(3), { "kind": "delete", "uri": "file:///other.ts" }] })).is_none());
        assert!(parse(
            json!({ "changes": { "file:///main.ts": [edit], "file:///other.ts": [edit] } })
        )
        .is_none());
    }

    #[test]
    fn typescript_quick_fix_only_accepts_a_noop_command_wrapper() {
        let mut command = json!({
            "command": "_typescript.applyCodeActionCommand",
            "arguments": [{ "action": { "changes": [] } }]
        });
        assert!(typescript_noop_command(&command));
        command["arguments"][0]["action"]["commands"] = json!([{ "type": "install package" }]);
        assert!(!typescript_noop_command(&command));
        assert!(!typescript_noop_command(&json!(
            "_typescript.applyCodeActionCommand"
        )));
    }

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
