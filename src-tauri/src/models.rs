use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub root: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub language: crate::preferences::Language,
    pub projects: Vec<Project>,
    pub active_project_id: Option<String>,
    pub theme: String,
    pub preferences: crate::preferences::Preferences,
    pub color_schemes: crate::color_schemes::ColorSchemes,
    pub fonts: crate::fonts::FontSettings,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub ignored: bool,
    pub size: u64,
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub project_id: String,
    pub path: String,
    pub entries: Vec<DirEntry>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileFingerprint {
    pub size: u64,
    #[serde(with = "i64_string")]
    pub modified_ns: i64,
}

/// JS 的 number 只有 53 位整数精度，纳秒时间戳（约 1.8e18）经 JSON 往返必然失真，
/// 导致每次保存都被误判为磁盘冲突。用字符串原样传递。
mod i64_string {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &i64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileMode {
    Normal,
    Large,
    LongLine,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TextEncodingKind {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    LossyUtf8,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LineEnding {
    Lf,
    Crlf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FileContent {
    Text {
        project_id: String,
        path: String,
        content: String,
        encoding: String,
        encoding_kind: TextEncodingKind,
        line_ending: LineEnding,
        mode: FileMode,
        editable: bool,
        edit_blocked_reason: Option<String>,
        fingerprint: FileFingerprint,
        size: u64,
        warnings: Vec<String>,
    },
    Binary {
        project_id: String,
        path: String,
        fingerprint: FileFingerprint,
        size: u64,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub fingerprint: FileFingerprint,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathSearchHit {
    pub project_id: String,
    pub project_name: String,
    pub path: String,
    pub score: u32,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub include_ignored: bool,
    #[serde(default)]
    pub include_hidden: bool,
    #[serde(default)]
    pub project_ids: Vec<String>,
    #[serde(default)]
    pub include_globs: Vec<String>,
    #[serde(default)]
    pub exclude_globs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRange {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub project_id: String,
    pub project_name: String,
    pub path: String,
    pub line: u32,
    pub preview: String,
    pub ranges: Vec<SearchRange>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SearchEvent {
    Batch {
        request_id: String,
        matches: Vec<SearchHit>,
        received: u64,
    },
    Paused {
        request_id: String,
        received: u64,
        has_more: bool,
    },
    Done {
        request_id: String,
        received: u64,
        truncated: bool,
    },
    Error {
        request_id: String,
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TextPosition {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolLocation {
    pub project_id: String,
    pub path: String,
    pub name: String,
    pub kind: String,
    pub line: u32,
    pub character: u32,
    pub end_line: u32,
    pub end_character: u32,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_encoding: Option<crate::lsp::PositionEncoding>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSymbol {
    pub name: String,
    pub detail: Option<String>,
    pub kind: String,
    pub line: u32,
    pub character: u32,
    pub end_line: u32,
    pub end_character: u32,
    pub children: Vec<DocumentSymbol>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineResult {
    pub symbols: Vec<DocumentSymbol>,
    pub source: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolSearchResult {
    pub symbols: Vec<SymbolLocation>,
    pub indexing: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationResult {
    pub locations: Vec<SymbolLocation>,
    pub source: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChangeEvent {
    pub project_id: String,
    pub rescan: bool,
    pub changed_files: Vec<String>,
    pub removed_paths: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_file_content_matches_typescript_contract() {
        let value = serde_json::to_value(FileContent::Text {
            project_id: "project-1".to_string(),
            path: "src/main.ts".to_string(),
            content: "const answer = 42;\n".to_string(),
            encoding: "UTF-16LE".to_string(),
            encoding_kind: TextEncodingKind::Utf16Le,
            line_ending: LineEnding::Crlf,
            mode: FileMode::LongLine,
            editable: false,
            edit_blocked_reason: Some("Line exceeds the editing limit".to_string()),
            fingerprint: FileFingerprint {
                size: 4096,
                modified_ns: 1_761_500_000_123_456_789,
            },
            size: 4096,
            warnings: vec!["Long lines are read-only".to_string()],
        })
        .unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "kind": "text",
                "projectId": "project-1",
                "path": "src/main.ts",
                "content": "const answer = 42;\n",
                "encoding": "UTF-16LE",
                "encodingKind": "utf16Le",
                "lineEnding": "crlf",
                "mode": "longLine",
                "editable": false,
                "editBlockedReason": "Line exceeds the editing limit",
                "fingerprint": {
                    "size": 4096,
                    "modifiedNs": "1761500000123456789"
                },
                "size": 4096,
                "warnings": ["Long lines are read-only"]
            })
        );
    }

    #[test]
    fn binary_file_content_matches_typescript_contract() {
        let value = serde_json::to_value(FileContent::Binary {
            project_id: "project-2".to_string(),
            path: "assets/logo.png".to_string(),
            fingerprint: FileFingerprint {
                size: 2048,
                modified_ns: i64::MAX,
            },
            size: 2048,
        })
        .unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "kind": "binary",
                "projectId": "project-2",
                "path": "assets/logo.png",
                "fingerprint": {
                    "size": 2048,
                    "modifiedNs": "9223372036854775807"
                },
                "size": 2048
            })
        );
    }

    #[test]
    fn fingerprint_nanoseconds_survive_json_round_trip() {
        let fingerprint = FileFingerprint {
            size: 7,
            modified_ns: 1_761_500_000_123_456_789,
        };
        let json = serde_json::to_string(&fingerprint).unwrap();
        assert_eq!(json, r#"{"size":7,"modifiedNs":"1761500000123456789"}"#);
        assert_eq!(
            serde_json::from_str::<FileFingerprint>(&json).unwrap(),
            fingerprint
        );
    }

    #[test]
    fn search_event_variants_match_typescript_contract() {
        assert_eq!(
            serde_json::to_value(SearchEvent::Batch {
                request_id: "request-batch".to_string(),
                matches: vec![SearchHit {
                    project_id: "project-1".to_string(),
                    project_name: "Gaze".to_string(),
                    path: "src/lib/types.ts".to_string(),
                    line: 147,
                    preview: "export interface SearchHit {".to_string(),
                    ranges: vec![
                        SearchRange { start: 18, end: 27 },
                        SearchRange { start: 30, end: 38 },
                    ],
                }],
                received: 1,
            })
            .unwrap(),
            serde_json::json!({
                "type": "batch",
                "requestId": "request-batch",
                "matches": [{
                    "projectId": "project-1",
                    "projectName": "Gaze",
                    "path": "src/lib/types.ts",
                    "line": 147,
                    "preview": "export interface SearchHit {",
                    "ranges": [
                        { "start": 18, "end": 27 },
                        { "start": 30, "end": 38 }
                    ]
                }],
                "received": 1
            })
        );

        assert_eq!(
            serde_json::to_value(SearchEvent::Paused {
                request_id: "request-paused".to_string(),
                received: 200,
                has_more: true,
            })
            .unwrap(),
            serde_json::json!({
                "type": "paused",
                "requestId": "request-paused",
                "received": 200,
                "hasMore": true
            })
        );

        assert_eq!(
            serde_json::to_value(SearchEvent::Done {
                request_id: "request-done".to_string(),
                received: 500,
                truncated: true,
            })
            .unwrap(),
            serde_json::json!({
                "type": "done",
                "requestId": "request-done",
                "received": 500,
                "truncated": true
            })
        );

        assert_eq!(
            serde_json::to_value(SearchEvent::Error {
                request_id: "request-error".to_string(),
                code: "invalid_regex".to_string(),
                message: "Invalid regular expression".to_string(),
            })
            .unwrap(),
            serde_json::json!({
                "type": "error",
                "requestId": "request-error",
                "code": "invalid_regex",
                "message": "Invalid regular expression"
            })
        );
    }
}
