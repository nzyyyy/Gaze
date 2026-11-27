use super::*;

pub(super) fn extract_locations(value: &Value, links: bool) -> Vec<RawLocation> {
    match value {
        Value::Null => Vec::new(),
        Value::Array(values) => values
            .iter()
            .flat_map(|value| extract_locations(value, links))
            .collect(),
        Value::Object(_) if links && value.get("targetUri").is_some() => {
            let Some(uri) = value.get("targetUri").and_then(Value::as_str) else {
                return Vec::new();
            };
            let range = value
                .get("targetRange")
                .or_else(|| value.get("targetSelectionRange"));
            let Some(range) = range.and_then(parse_range) else {
                return Vec::new();
            };
            vec![RawLocation {
                uri: uri.to_string(),
                range,
            }]
        }
        Value::Object(_) => {
            let Some(uri) = value.get("uri").and_then(Value::as_str) else {
                return Vec::new();
            };
            let Some(range) = value.get("range").and_then(parse_range) else {
                return Vec::new();
            };
            vec![RawLocation {
                uri: uri.to_string(),
                range,
            }]
        }
        _ => Vec::new(),
    }
}

fn parse_range(value: &Value) -> Option<LspRange> {
    Some(LspRange {
        start: parse_position(value.get("start")?)?,
        end: parse_position(value.get("end")?)?,
    })
}

fn parse_position(value: &Value) -> Option<LspPosition> {
    Some(LspPosition {
        line: value.get("line")?.as_u64()? as u32,
        character: value.get("character")?.as_u64()? as u32,
    })
}

#[derive(Clone)]
pub(super) struct RawLocation {
    pub(super) uri: String,
    pub(super) range: LspRange,
}

pub(super) async fn normalize_locations(
    raw: Vec<RawLocation>,
    projects: &[Project],
    encoding: PositionEncoding,
    source: &str,
    name: &str,
    limit: usize,
) -> GazeResult<NavigationResult> {
    let mut locations = Vec::new();
    let mut canonical_paths = HashMap::new();
    let mut text_cache: HashMap<PathBuf, Arc<String>> = HashMap::new();
    for raw_location in raw.into_iter().take(limit) {
        let Ok(url) = Url::parse(&raw_location.uri) else {
            continue;
        };
        if url.host_str().is_some_and(|host| host != "localhost") {
            continue;
        }
        let Ok(path) = url.to_file_path() else {
            continue;
        };
        let path = canonical_paths
            .entry(path.clone())
            .or_insert_with(|| path.canonicalize().unwrap_or(path));
        let Some((project, relative)) = project_for_path(projects, path) else {
            let Some(path) = path
                .to_str()
                .filter(|path| !path.chars().any(char::is_control))
            else {
                continue;
            };
            locations.push(SymbolLocation {
                project_id: String::new(),
                path: path.to_string(),
                name: name.to_string(),
                kind: "reference".to_string(),
                line: raw_location.range.start.line,
                character: raw_location.range.start.character,
                end_line: raw_location.range.end.line,
                end_character: raw_location.range.end.character,
                source: source.to_string(),
                external_encoding: Some(encoding),
            });
            continue;
        };
        let (start, end) = if encoding == PositionEncoding::Utf16 {
            (
                TextPosition {
                    line: raw_location.range.start.line,
                    character: raw_location.range.start.character,
                },
                TextPosition {
                    line: raw_location.range.end.line,
                    character: raw_location.range.end.character,
                },
            )
        } else {
            let text = if let Some(text) = text_cache.get(path) {
                Arc::clone(text)
            } else {
                let project_copy = project.clone();
                let relative_copy = relative.clone();
                let content =
                    tokio::task::spawn_blocking(move || read_file(&project_copy, &relative_copy))
                        .await
                        .map_err(GazeError::Join)??;
                let FileContent::Text { content, .. } = content else {
                    continue;
                };
                let text = Arc::new(content);
                text_cache.insert(path.clone(), Arc::clone(&text));
                text
            };
            let index = TextIndex::new(&text);
            (
                index.lsp_to_utf16(&text, raw_location.range.start, encoding)?,
                index.lsp_to_utf16(&text, raw_location.range.end, encoding)?,
            )
        };
        locations.push(SymbolLocation {
            project_id: project.id.clone(),
            path: relative,
            name: name.to_string(),
            kind: "reference".to_string(),
            line: start.line,
            character: start.character,
            end_line: end.line,
            end_character: end.character,
            source: source.to_string(),
            external_encoding: None,
        });
    }
    Ok(NavigationResult {
        locations,
        source: source.to_string(),
        message: None,
    })
}

fn project_for_path<'a>(projects: &'a [Project], path: &Path) -> Option<(&'a Project, String)> {
    projects
        .iter()
        .filter_map(|project| {
            let root = Path::new(&project.root);
            path.strip_prefix(root)
                .ok()
                .and_then(|_| path_to_relative(root, path).ok())
                .filter(|relative| !relative.is_empty())
                .map(|relative| (project, relative, root.components().count()))
        })
        .max_by_key(|(_, _, depth)| *depth)
        .map(|(project, relative, _)| (project, relative))
}

pub(super) fn normalize_document_symbols(
    value: &Value,
    text: &str,
    index: &TextIndex,
    encoding: PositionEncoding,
    current_uri: &str,
) -> GazeResult<Vec<DocumentSymbol>> {
    let Some(values) = value.as_array() else {
        return Ok(Vec::new());
    };
    let mut result = Vec::new();
    for value in values {
        if value.get("location").is_some() {
            if let Some(symbol) =
                parse_symbol_information(value, text, index, encoding, current_uri)?
            {
                result.push(symbol);
            }
        } else if let Some(symbol) = parse_document_symbol(value, text, index, encoding)? {
            result.push(symbol);
        }
    }
    Ok(result)
}

fn parse_document_symbol(
    value: &Value,
    text: &str,
    index: &TextIndex,
    encoding: PositionEncoding,
) -> GazeResult<Option<DocumentSymbol>> {
    let Some(name) = value.get("name").and_then(Value::as_str) else {
        return Ok(None);
    };
    let kind = value.get("kind").and_then(Value::as_u64).unwrap_or(13);
    let Some(selection) = value.get("selectionRange").and_then(parse_range) else {
        return Ok(None);
    };
    let range = value
        .get("range")
        .and_then(parse_range)
        .unwrap_or(selection);
    let start = index.lsp_to_utf16(text, selection.start, encoding)?;
    let end = index.lsp_to_utf16(text, range.end, encoding)?;
    let mut children = Vec::new();
    if let Some(items) = value.get("children").and_then(Value::as_array) {
        for child in items {
            if let Some(child) = parse_document_symbol(child, text, index, encoding)? {
                children.push(child);
            }
        }
    }
    Ok(Some(DocumentSymbol {
        name: name.to_string(),
        detail: value
            .get("detail")
            .and_then(Value::as_str)
            .map(str::to_string),
        kind: symbol_kind_name(kind).to_string(),
        line: start.line,
        character: start.character,
        end_line: end.line,
        end_character: end.character,
        children,
    }))
}

fn parse_symbol_information(
    value: &Value,
    text: &str,
    index: &TextIndex,
    encoding: PositionEncoding,
    current_uri: &str,
) -> GazeResult<Option<DocumentSymbol>> {
    let Some(name) = value.get("name").and_then(Value::as_str) else {
        return Ok(None);
    };
    let Some(location) = value.get("location") else {
        return Ok(None);
    };
    let location_uri = location.get("uri").and_then(Value::as_str);
    let same_uri = match (location_uri, Url::parse(current_uri)) {
        (Some(uri), Ok(current)) => Url::parse(uri).map(|uri| uri == current).unwrap_or(false),
        (Some(uri), Err(_)) => Some(uri) == Some(current_uri),
        _ => false,
    };
    if !same_uri {
        return Ok(None);
    }
    let Some(range) = location.get("range").and_then(parse_range) else {
        return Ok(None);
    };
    let start = index.lsp_to_utf16(text, range.start, encoding)?;
    let end = index.lsp_to_utf16(text, range.end, encoding)?;
    Ok(Some(DocumentSymbol {
        name: name.to_string(),
        detail: value
            .get("containerName")
            .and_then(Value::as_str)
            .map(str::to_string),
        kind: symbol_kind_name(value.get("kind").and_then(Value::as_u64).unwrap_or(13)).to_string(),
        line: start.line,
        character: start.character,
        end_line: end.line,
        end_character: end.character,
        children: Vec::new(),
    }))
}

fn symbol_kind_name(kind: u64) -> &'static str {
    match kind {
        1 => "file",
        2 => "module",
        3 => "namespace",
        4 => "package",
        5 => "class",
        6 => "method",
        7 => "property",
        8 => "field",
        9 => "constructor",
        10 => "enum",
        11 => "interface",
        12 => "function",
        13 => "variable",
        14 => "constant",
        15 => "string",
        16 => "number",
        17 => "boolean",
        18 => "array",
        19 => "object",
        20 => "key",
        21 => "null",
        22 => "enumMember",
        23 => "struct",
        24 => "event",
        25 => "operator",
        26 => "typeParameter",
        _ => "symbol",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_location_links_and_locations() {
        let value = json!([
            {
                "targetUri": "file:///tmp/a.ts",
                "targetRange": {"start":{"line":1,"character":2},"end":{"line":3,"character":4}},
                "targetSelectionRange": {"start":{"line":2,"character":0},"end":{"line":2,"character":5}}
            },
            {
                "uri": "file:///tmp/b.ts",
                "range": {"start":{"line":0,"character":0},"end":{"line":0,"character":2}}
            }
        ]);
        let locations = extract_locations(&value, true);
        assert_eq!(locations.len(), 2);
        assert_eq!(locations[0].range.start.line, 1);
        assert_eq!(locations[1].range.end.character, 2);
    }

    #[test]
    fn longest_project_root_wins_for_cross_project_results() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let inner = root.join("packages/app");
        std::fs::create_dir_all(inner.join("src")).unwrap();
        std::fs::write(inner.join("src/a.ts"), "export {}").unwrap();
        let projects = vec![
            Project {
                id: "outer".to_string(),
                name: "Outer".to_string(),
                root: root.display().to_string(),
            },
            Project {
                id: "inner".to_string(),
                name: "Inner".to_string(),
                root: inner.display().to_string(),
            },
        ];
        let (project, relative) = project_for_path(&projects, &inner.join("src/a.ts")).unwrap();
        assert_eq!(project.id, "inner");
        assert_eq!(relative, "src/a.ts");
    }

    #[test]
    fn normalizes_hierarchical_and_flat_document_symbols() {
        let text = "export interface Shape {}\nexport class Square implements Shape {}\n";
        let index = TextIndex::new(text);
        let uri = "file:///tmp/sample.ts";
        let value = json!([
            {
                "name": "Square",
                "kind": 5,
                "range": {"start":{"line":1,"character":0},"end":{"line":1,"character":52}},
                "selectionRange": {"start":{"line":1,"character":13},"end":{"line":1,"character":19}},
                "children": []
            },
            {
                "name": "Shape",
                "kind": 11,
                "location": {
                    "uri": uri,
                    "range": {"start":{"line":0,"character":0},"end":{"line":0,"character":31}}
                }
            }
        ]);
        let symbols =
            normalize_document_symbols(&value, text, &index, PositionEncoding::Utf16, uri).unwrap();
        assert_eq!(symbols.len(), 2);
        assert_eq!(symbols[0].name, "Square");
        assert_eq!(symbols[0].kind, "class");
        assert_eq!(symbols[0].line, 1);
        assert_eq!(symbols[1].name, "Shape");
    }

    #[tokio::test]
    async fn returns_external_local_locations_without_reading_them() {
        let outside = tempfile::tempdir().unwrap();
        let missing = outside.path().canonicalize().unwrap().join("unopened.d.ts");
        let uri = Url::from_file_path(&missing).unwrap().to_string();
        let range = LspRange {
            start: LspPosition {
                line: 10,
                character: 8,
            },
            end: LspPosition {
                line: 10,
                character: 12,
            },
        };
        let result = normalize_locations(
            vec![
                RawLocation { uri, range },
                RawLocation {
                    uri: "https://example.com/a.ts".to_string(),
                    range,
                },
                RawLocation {
                    uri: "file://example.com/share/a.ts".to_string(),
                    range,
                },
            ],
            &[],
            PositionEncoding::Utf8,
            "lsp",
            "example",
            10,
        )
        .await
        .unwrap();
        assert_eq!(result.locations.len(), 1);
        assert_eq!(
            result.locations[0].external_encoding,
            Some(PositionEncoding::Utf8)
        );
        assert_eq!(result.locations[0].path, missing.to_str().unwrap());
        assert_eq!(result.locations[0].character, 8);
    }
}
