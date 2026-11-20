use super::*;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionResult {
    items: Vec<CompletionItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionItem {
    label: String,
    detail: Option<String>,
    documentation: Option<String>,
    kind: Option<u64>,
    filter_text: Option<String>,
    sort_text: Option<String>,
    description: Option<String>,
    snippet: bool,
    resolve: Option<CompletionResolve>,
    insert_text: String,
    edit: Option<CompletionEdit>,
    additional_edits: Vec<CompletionEdit>,
}

#[derive(Debug, Serialize, serde::Deserialize)]
pub struct CompletionResolve {
    session: String,
    generation: u64,
    item: Value,
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
        let mut generation = self.completion_generation.lock().await;
        self.sync_buffer(relative_path, content).await?;
        *generation += 1;
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
        let offset = index.lsp_to_byte(content, position, self.encoding)?;
        let prefix = content[..offset]
            .rsplit(|ch: char| !ch.is_alphanumeric() && ch != '_' && ch != '$')
            .next()
            .unwrap_or_default();
        Ok(normalize(
            &result,
            content,
            &index,
            self.encoding,
            self.capabilities
                .completion_resolve
                .then_some((self.id.as_str(), *generation)),
            prefix,
        ))
    }

    pub(super) async fn resolve_completion(
        &self,
        path: &str,
        content: &str,
        resolve: CompletionResolve,
    ) -> GazeResult<Option<CompletionItem>> {
        if !self.capabilities.completion_resolve || resolve.session != self.id {
            return Ok(None);
        }
        // Some servers invalidate their opaque completion data on the next completion request.
        let generation = self.completion_generation.lock().await;
        if *generation != resolve.generation {
            return Ok(None);
        }
        let uri = Url::from_file_path(Path::new(&self.project.root).join(path))
            .map_err(|_| GazeError::InvalidPath("无法将文件路径转换为 LSP URI。".to_string()))?;
        if !self
            .documents
            .lock()
            .await
            .get(uri.as_str())
            .is_some_and(|doc| doc.text.as_str() == content)
        {
            return Ok(None);
        }
        let result = self
            .client
            .request(
                "completionItem/resolve",
                resolve.item,
                Duration::from_secs(2),
            )
            .await?;
        Ok(normalize_item(
            &result,
            content,
            &TextIndex::new(content),
            self.encoding,
            None,
        ))
    }
}

fn normalize(
    result: &Value,
    text: &str,
    index: &TextIndex,
    encoding: PositionEncoding,
    resolve_session: Option<(&str, u64)>,
    prefix: &str,
) -> CompletionResult {
    let mut items = result
        .as_array()
        .or_else(|| result["items"].as_array())
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    if items.len() > 1_000 && !prefix.is_empty() {
        let prefix = prefix.to_lowercase();
        // Keep matching auto-imports even when a server returns thousands of global symbols first.
        items.sort_by_cached_key(|item| {
            let label = item["filterText"]
                .as_str()
                .or_else(|| item["label"].as_str())
                .unwrap_or_default();
            !label.to_lowercase().starts_with(&prefix)
        });
    }
    CompletionResult {
        items: items
            .into_iter()
            .filter_map(|item| normalize_item(item, text, index, encoding, resolve_session))
            .take(1_000)
            .collect(),
    }
}

fn normalize_item(
    item: &Value,
    text: &str,
    index: &TextIndex,
    encoding: PositionEncoding,
    resolve_session: Option<(&str, u64)>,
) -> Option<CompletionItem> {
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
            .or_else(|| item.pointer("/labelDetails/detail").and_then(Value::as_str))
            .map(str::to_string),
        description: item
            .pointer("/labelDetails/description")
            .and_then(Value::as_str)
            .map(str::to_string),
        sort_text: item
            .get("sortText")
            .and_then(Value::as_str)
            .map(str::to_string),
        snippet: item.get("insertTextFormat").and_then(Value::as_u64) == Some(2),
        resolve: resolve_session.map(|(session, generation)| CompletionResolve {
            session: session.to_string(),
            generation,
            item: item.clone(),
        }),
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
            None,
            "",
        );
        assert_eq!(result.items.len(), 2);
        assert!(result.items[1].snippet);
        let edit = result.items[0].edit.as_ref().unwrap();
        assert_eq!((edit.from, edit.to), (6, 8));
        assert_eq!(result.items[0].additional_edits.len(), 1);
        let result = normalize(
            &json!([{ "label": "hello" }]),
            text,
            &TextIndex::new(text),
            PositionEncoding::Utf16,
            None,
            "",
        );
        assert_eq!(result.items[0].insert_text, "hello");
        assert!(normalize(
            &Value::Null,
            text,
            &TextIndex::new(text),
            PositionEncoding::Utf16,
            None,
            "",
        )
        .items
        .is_empty());
    }
}
