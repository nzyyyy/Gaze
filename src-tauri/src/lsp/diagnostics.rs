use super::*;
use serde::Deserialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeDiagnostic {
    start: TextPosition,
    end: TextPosition,
    severity: u8,
    message: String,
    source: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct DiagnosticSync {
    pub session: String,
    pub version: i64,
    pub items: Option<Vec<CodeDiagnostic>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsUpdate {
    project_id: String,
    path: String,
    #[serde(flatten)]
    snapshot: DiagnosticSync,
}

pub(super) struct Publisher<F> {
    pub project: Project,
    pub session: String,
    pub documents: Arc<tokio::sync::Mutex<HashMap<String, OpenDocument>>>,
    pub encoding: Arc<OnceLock<PositionEncoding>>,
    pub publish: F,
}

impl<F: Fn(DiagnosticsUpdate)> Publisher<F> {
    pub(super) async fn receive(&self, params: Value) {
        let Some((uri, encoding)) = params["uri"].as_str().zip(self.encoding.get().copied()) else {
            return;
        };
        let Some(path) = Url::parse(uri).ok().and_then(|url| url.to_file_path().ok()) else {
            return;
        };
        let Ok(path) = path_to_relative(Path::new(&self.project.root), &path) else {
            return;
        };
        let Some(items) = params["diagnostics"].as_array() else {
            return;
        };
        let mut documents = self.documents.lock().await;
        let Some(document) = documents.get_mut(uri) else {
            return;
        };
        // Some servers omit versions. Their next publication replaces the previous batch.
        if params["version"]
            .as_i64()
            .is_some_and(|version| version != document.version)
        {
            return;
        }
        let index = TextIndex::new(&document.text);
        let items = items
            .iter()
            .take(1_000)
            .filter_map(|item| normalize(item, &document.text, &index, encoding))
            .collect::<Vec<_>>();
        document.diagnostics = Some(items.clone());
        let update = DiagnosticsUpdate {
            project_id: self.project.id.clone(),
            path,
            snapshot: DiagnosticSync {
                session: self.session.clone(),
                version: document.version,
                items: Some(items),
            },
        };
        (self.publish)(update);
    }
}

#[derive(Deserialize)]
struct RawDiagnostic {
    range: LspRange,
    severity: Option<u8>,
    source: Option<String>,
    message: String,
}

fn normalize(
    value: &Value,
    text: &str,
    index: &TextIndex,
    encoding: PositionEncoding,
) -> Option<CodeDiagnostic> {
    let item = RawDiagnostic::deserialize(value).ok()?;
    let start = index.lsp_to_utf16(text, item.range.start, encoding).ok()?;
    let end = index.lsp_to_utf16(text, item.range.end, encoding).ok()?;
    if (start.line, start.character) > (end.line, end.character) {
        return None;
    }
    Some(CodeDiagnostic {
        start,
        end,
        severity: item.severity.unwrap_or(2),
        message: item.message,
        source: item.source,
    })
}
