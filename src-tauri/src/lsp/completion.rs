use super::*;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionResult {
    items: Vec<CompletionItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompletionItem {
    label: String,
    detail: Option<String>,
    documentation: Option<String>,
    kind: Option<u64>,
    filter_text: Option<String>,
    insert_text: String,
    edit: Option<CompletionEdit>,
    additional_edits: Vec<CompletionEdit>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompletionEdit {
    from: usize,
    to: usize,
    insert: String,
}

impl LspSession {
    pub(super) async fn complete(
        &self,
        relative_path: &str,
        content: &str,
        position: TextPosition,
        trigger: Option<&str>,
    ) -> GazeResult<CompletionResult> {
        if !self.capabilities.completion {
            return Ok(CompletionResult::default());
        }
        if trigger
            .is_some_and(|trigger| !self.completion_triggers.iter().any(|item| item == trigger))
        {
            return Ok(CompletionResult::default());
        }
        self.sync_buffer(relative_path, content).await?;
        let uri = Url::from_file_path(Path::new(&self.project.root).join(relative_path))
            .map_err(|_| GazeError::InvalidPath("无法将文件路径转换为 LSP URI。".to_string()))?;
        let index = TextIndex::new(content);
        let position = index.utf16_to_lsp(content, position, self.encoding)?;
        let result = self.client.request(
            "textDocument/completion",
            json!({
                "textDocument": { "uri": uri },
                "position": position,
                "context": match trigger {
                    Some(character) => json!({ "triggerKind": 2, "triggerCharacter": character }),
                    None => json!({ "triggerKind": 1 }),
                }
            }),
            Duration::from_secs(3),
        ).await?;
        Ok(normalize(&result, content, &index, self.encoding))
    }
}

fn normalize(
    result: &Value,
    text: &str,
    index: &TextIndex,
    encoding: PositionEncoding,
) -> CompletionResult {
    let items = result
        .as_array()
        .or_else(|| result.get("items").and_then(Value::as_array));
    CompletionResult {
        items: items
            .into_iter()
            .flatten()
            .take(1000)
            .filter_map(|item| {
                // shortcut: request plain text completions; add a full LSP snippet parser before advertising snippets.
                if item.get("insertTextFormat").and_then(Value::as_u64) == Some(2) {
                    return None;
                }
                let label = item.get("label")?.as_str()?.to_string();
                let edit = item
                    .get("textEdit")
                    .map(|edit| parse_edit(edit, text, index, encoding))
                    .transpose()
                    .ok()?;
                let additional_edits = item
                    .get("additionalTextEdits")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|edit| parse_edit(edit, text, index, encoding))
                    .collect::<GazeResult<Vec<_>>>()
                    .ok()?;
                Some(CompletionItem {
                    insert_text: item
                        .get("insertText")
                        .and_then(Value::as_str)
                        .unwrap_or(&label)
                        .to_string(),
                    label,
                    detail: item
                        .get("detail")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    documentation: item
                        .get("documentation")
                        .and_then(|value| {
                            value
                                .as_str()
                                .or_else(|| value.get("value").and_then(Value::as_str))
                        })
                        .map(str::to_string),
                    kind: item.get("kind").and_then(Value::as_u64),
                    filter_text: item
                        .get("filterText")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    edit,
                    additional_edits,
                })
            })
            .collect(),
    }
}

fn parse_edit(
    edit: &Value,
    text: &str,
    index: &TextIndex,
    encoding: PositionEncoding,
) -> GazeResult<CompletionEdit> {
    let invalid = || GazeError::Message("语言服务器返回了无效的补全范围。".to_string());
    let range: LspRange = serde_json::from_value(
        edit.get("range")
            .or_else(|| edit.get("replace"))
            .cloned()
            .ok_or_else(invalid)?,
    )
    .map_err(|_| invalid())?;
    let from = index.lsp_to_byte(text, range.start, encoding)?;
    let to = index.lsp_to_byte(text, range.end, encoding)?;
    if from > to
        || index.byte_to_lsp(text, from, encoding)? != range.start
        || index.byte_to_lsp(text, to, encoding)? != range.end
    {
        return Err(invalid());
    }
    Ok(CompletionEdit {
        from: text[..from].encode_utf16().count(),
        to: text[..to].encode_utf16().count(),
        insert: edit
            .get("newText")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?
            .to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_lists_edits_unicode_and_rejects_invalid_ranges() {
        let text = "😀\n名字.fo";
        let range =
            json!({ "start": { "line": 1, "character": 7 }, "end": { "line": 1, "character": 9 } });
        let result = normalize(
            &json!({"isIncomplete": true, "items": [
                { "label": "foo", "textEdit": { "replace": range, "insert": range, "newText": "foo" },
                  "additionalTextEdits": [{ "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 0 } }, "newText": "import foo\n" }] },
                { "label": "bad", "textEdit": { "range": { "start": { "line": 99, "character": 0 }, "end": { "line": 99, "character": 1 } }, "newText": "bad" } },
                { "label": "snippet", "insertTextFormat": 2, "insertText": "${1:x}" }
            ]}),
            text,
            &TextIndex::new(text),
            PositionEncoding::Utf8,
        );
        assert_eq!(result.items.len(), 1);
        let edit = result.items[0].edit.as_ref().unwrap();
        assert_eq!((edit.from, edit.to), (6, 8));
        assert_eq!(result.items[0].additional_edits.len(), 1);
        let result = normalize(
            &json!([{ "label": "hello" }]),
            text,
            &TextIndex::new(text),
            PositionEncoding::Utf16,
        );
        assert_eq!(result.items[0].insert_text, "hello");
        assert!(normalize(
            &Value::Null,
            text,
            &TextIndex::new(text),
            PositionEncoding::Utf16
        )
        .items
        .is_empty());
    }
}
