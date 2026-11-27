mod client;
mod code_action;
mod completion;
mod diagnostics;
mod editor_tools;
mod hover;
mod manager;
mod navigation;
mod positions;
mod session;

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
pub use editor_tools::{DocumentRevision, FormatResult, FormattingOptions, SignatureHelp};
pub use hover::HoverContent;
pub use manager::LspManager;
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
use self::navigation::{
    extract_locations, normalize_document_symbols, normalize_locations, RawLocation,
};
use self::session::{LspSession, OpenDocument};

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

fn is_python_extension(extension: &str) -> bool {
    ["py", "pyi", "pyw"]
        .iter()
        .any(|item| extension.eq_ignore_ascii_case(item))
}

fn is_python_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|ext| is_python_extension(&ext.to_ascii_lowercase()))
}

/// Replaces the span between the first and last differing lines.
fn diff_text_edits(original: &str, formatted: &str) -> Vec<CompletionEdit> {
    if original == formatted {
        return Vec::new();
    }
    let old_lines: Vec<&str> = original.split_inclusive('\n').collect();
    let new_lines: Vec<&str> = formatted.split_inclusive('\n').collect();
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
        .map(|l| l.encode_utf16().count())
        .sum();
    let to: usize = old_lines[..old_end]
        .iter()
        .map(|l| l.encode_utf16().count())
        .sum();
    let insert = new_lines[start..new_end].concat();
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

fn emit_status(app: &AppHandle, status: LspStatus) {
    let _ = app.emit("gaze://lsp-status", status);
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn diff_text_edits_handles_a_missing_final_newline() {
        let edits = diff_text_edits("print('😀')", "print(\"😀\")\n");
        assert_eq!(edits[0].to, "print('😀')".encode_utf16().count());
        assert_eq!(edits[0].insert, "print(\"😀\")\n");
    }
}
