use super::*;

#[derive(Debug, Serialize)]
pub struct HoverContent {
    value: String,
    kind: &'static str,
    language: Option<String>,
}

impl LspSession {
    pub(super) async fn hover(
        &self,
        relative_path: &str,
        content: &str,
        position: TextPosition,
    ) -> GazeResult<Vec<HoverContent>> {
        if !self.capabilities.hover {
            return Ok(Vec::new());
        }
        self.sync_buffer(relative_path, content).await?;
        let uri = Url::from_file_path(Path::new(&self.project.root).join(relative_path))
            .map_err(|_| GazeError::InvalidPath("无法将文件路径转换为 LSP URI。".to_string()))?;
        let position = TextIndex::new(content).utf16_to_lsp(content, position, self.encoding)?;
        let result = self
            .client
            .request(
                "textDocument/hover",
                json!({ "textDocument": { "uri": uri }, "position": position }),
                Duration::from_secs(3),
            )
            .await?;
        Ok(normalize(&result["contents"]))
    }
}

fn normalize(contents: &Value) -> Vec<HoverContent> {
    let values = match contents {
        Value::Array(values) => values.as_slice(),
        value => std::slice::from_ref(value),
    };
    values
        .iter()
        .filter_map(|value| {
            let text = value.as_str().or_else(|| value.get("value")?.as_str())?;
            if text.trim().is_empty() {
                return None;
            }
            Some(HoverContent {
                value: text.to_string(),
                kind: if value.get("kind").and_then(Value::as_str) == Some("plaintext") {
                    "plaintext"
                } else {
                    "markdown"
                },
                language: value
                    .get("language")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_markup_marked_strings_and_empty_results() {
        let blocks = normalize(&json!([
            {"language": "typescript", "value": "const user: User"},
            "**User** documentation",
            {"kind": "plaintext", "value": "<literal>"},
            {"kind": "markdown", "value": "### Heading"},
            null, {"value": "  "}
        ]));
        assert_eq!(blocks.len(), 4);
        assert_eq!(blocks[0].language.as_deref(), Some("typescript"));
        assert_eq!(blocks[1].kind, "markdown");
        assert_eq!(blocks[2].kind, "plaintext");
        assert_eq!(
            normalize(&json!({"kind": "markdown", "value": "docs"})).len(),
            1
        );
        assert!(normalize(&Value::Null).is_empty());
    }
}
