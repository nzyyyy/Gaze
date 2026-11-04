use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use nucleo::pattern::{CaseMatching, Normalization, Pattern};
use nucleo::{Config, Matcher, Utf32Str};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

use crate::cache::{Cache, CachedFile, CachedSymbol};
use crate::error::{GazeError, GazeResult};
use crate::files::{fingerprint, path_to_relative, read_file, resolve_within_root};
use crate::models::{
    DocumentSymbol, FileContent, Project, SymbolLocation, SymbolSearchResult, TextPosition,
};

const CTAGS_BATCH_SIZE: usize = 64;
const MAX_SYMBOL_RESULTS: usize = 200;
const MAX_DEFINITION_CANDIDATES: usize = 60;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolIndexStatus {
    pub project_id: String,
    pub indexing: bool,
    pub indexed_files: usize,
    pub total_files: usize,
    pub message: Option<String>,
}

struct TaskState {
    cancel: Arc<AtomicBool>,
    done_tx: watch::Sender<bool>,
}

#[derive(Default)]
pub struct SymbolService {
    tasks: Mutex<HashMap<String, TaskState>>,
    indexed: RwLock<HashSet<String>>,
    revisions: Mutex<HashMap<String, u64>>,
    status: RwLock<HashMap<String, SymbolIndexStatus>>,
}

impl SymbolService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn remove_project(&self, project_id: &str) {
        self.bump_revision(project_id);
        if let Ok(mut tasks) = self.tasks.lock() {
            if let Some(task) = tasks.remove(project_id) {
                task.cancel.store(true, Ordering::Relaxed);
            }
        }
        if let Ok(mut indexed) = self.indexed.write() {
            indexed.remove(project_id);
        }
        if let Ok(mut status) = self.status.write() {
            status.remove(project_id);
        }
    }

    pub fn invalidate(self: &Arc<Self>, project_id: &str) {
        self.bump_revision(project_id);
        if let Ok(mut indexed) = self.indexed.write() {
            indexed.remove(project_id);
        }
    }

    fn bump_revision(&self, project_id: &str) {
        if let Ok(mut revisions) = self.revisions.lock() {
            *revisions.entry(project_id.to_string()).or_insert(0) += 1;
        }
    }

    fn revision(&self, project_id: &str) -> u64 {
        self.revisions
            .lock()
            .ok()
            .and_then(|revisions| revisions.get(project_id).copied())
            .unwrap_or(0)
    }

    pub fn status(&self, project_id: &str) -> Option<SymbolIndexStatus> {
        self.status
            .read()
            .ok()
            .and_then(|status| status.get(project_id).cloned())
    }

    pub async fn ensure_project_index(
        self: &Arc<Self>,
        app: AppHandle,
        cache: Cache,
        ctags: PathBuf,
        project: Project,
    ) -> GazeResult<()> {
        if self
            .indexed
            .read()
            .map(|indexed| indexed.contains(&project.id))
            .unwrap_or(false)
        {
            return Ok(());
        }

        enum TaskAction {
            Start(Arc<AtomicBool>, watch::Sender<bool>),
            Wait(watch::Receiver<bool>),
        }

        let action = {
            let mut tasks = self
                .tasks
                .lock()
                .map_err(|_| GazeError::Message("符号索引任务锁已损坏。".to_string()))?;
            if let Some(task) = tasks.get(&project.id) {
                TaskAction::Wait(task.done_tx.subscribe())
            } else {
                let cancel = Arc::new(AtomicBool::new(false));
                let (done_tx, _) = watch::channel(false);
                tasks.insert(
                    project.id.clone(),
                    TaskState {
                        cancel: Arc::clone(&cancel),
                        done_tx: done_tx.clone(),
                    },
                );
                TaskAction::Start(cancel, done_tx)
            }
        };

        match action {
            TaskAction::Start(cancel, done_tx) => {
                return self
                    .run_index(app, cache, ctags, project, cancel, done_tx)
                    .await;
            }
            TaskAction::Wait(mut waiter) => {
                let _ = waiter.wait_for(|value| *value).await;
            }
        }

        let indexed = self
            .indexed
            .read()
            .map(|indexed| indexed.contains(&project.id))
            .unwrap_or(false);
        if indexed {
            return Ok(());
        }
        let message = self.status(&project.id).and_then(|status| status.message);
        Err(match message {
            Some(message) => GazeError::Message(message),
            None => GazeError::Cancelled,
        })
    }

    async fn run_index(
        self: &Arc<Self>,
        app: AppHandle,
        cache: Cache,
        ctags: PathBuf,
        project: Project,
        cancel: Arc<AtomicBool>,
        done_tx: watch::Sender<bool>,
    ) -> GazeResult<()> {
        let project_id = project.id.clone();
        let started = std::time::Instant::now();
        tracing::info!(project = %project.name, "symbol indexing started");
        self.set_status(SymbolIndexStatus {
            project_id: project_id.clone(),
            indexing: true,
            indexed_files: 0,
            total_files: 0,
            message: None,
        });
        emit_status(&app, self.status(&project_id));

        let mut result = Ok(());
        let mut stable = false;
        let mut completed_revision = 0;
        // Continuous changes get a bounded retry; a stale run never becomes the latest index.
        for attempt in 0..3 {
            completed_revision = self.revision(&project_id);
            result = self
                .index_project_files(&app, &cache, &ctags, &project, &cancel)
                .await;
            stable = self.revision(&project_id) == completed_revision;
            if result.is_err() || stable || attempt == 2 {
                break;
            }
        }
        let result = if result.is_ok() {
            let revisions = self.revisions.lock();
            if stable
                && revisions
                    .as_ref()
                    .ok()
                    .and_then(|revisions| revisions.get(&project_id))
                    .copied()
                    .unwrap_or(0)
                    == completed_revision
            {
                if let Ok(mut indexed) = self.indexed.write() {
                    indexed.insert(project_id.clone());
                }
                Ok(())
            } else {
                Err(GazeError::Cancelled)
            }
        } else {
            result
        };
        match &result {
            Ok(()) => {}
            Err(error) if !matches!(error, GazeError::Cancelled) => {
                if let Some(mut status) = self
                    .status
                    .write()
                    .ok()
                    .and_then(|mut status| status.remove(&project_id))
                {
                    status.indexing = false;
                    status.message = Some(error.message());
                    self.set_status(status);
                }
            }
            Err(_) => {}
        }
        if let Ok(mut tasks) = self.tasks.lock() {
            tasks.remove(&project_id);
        }
        let _ = done_tx.send(true);
        if let Ok(mut status) = self.status.write() {
            if let Some(status) = status.get_mut(&project_id) {
                status.indexing = false;
            }
        }
        emit_status(&app, self.status(&project_id));
        if result.is_ok() {
            tracing::info!(
                project = %project.name,
                elapsed_ms = started.elapsed().as_millis(),
                "symbol indexing complete"
            );
        }
        result
    }

    async fn index_project_files(
        &self,
        app: &AppHandle,
        cache: &Cache,
        ctags: &Path,
        project: &Project,
        cancel: &AtomicBool,
    ) -> GazeResult<()> {
        let files = cache.cached_files(&project.id).await?;
        let existing = cache.symbol_file_fingerprints(&project.id).await?;
        let current_paths: HashSet<&str> =
            files.iter().map(|file| file.rel_path.as_str()).collect();
        for path in existing.keys() {
            if !current_paths.contains(path.as_str()) {
                cache.remove_symbols_for_file(&project.id, path).await?;
            }
        }
        let stale = stale_files(&files, &existing);
        let total = stale.len();
        if total == 0 {
            return Ok(());
        }
        let root = PathBuf::from(&project.root);
        let mut indexed = 0usize;
        for batch in stale.chunks(CTAGS_BATCH_SIZE) {
            if cancel.load(Ordering::Relaxed) {
                return Err(GazeError::Cancelled);
            }
            let paths: Vec<String> = batch.iter().map(|file| file.rel_path.clone()).collect();
            let ctags_path = ctags.to_path_buf();
            let root_copy = root.clone();
            let symbols = tokio::task::spawn_blocking(move || {
                run_ctags_batch(&ctags_path, &root_copy, &paths)
            })
            .await
            .map_err(GazeError::Join)??;
            for file in batch {
                let file_symbols = symbols.get(&file.rel_path).cloned().unwrap_or_default();
                cache
                    .replace_symbols_for_file(&project.id, &file.rel_path, file, &file_symbols)
                    .await?;
                indexed += 1;
            }
            self.set_status(SymbolIndexStatus {
                project_id: project.id.clone(),
                indexing: true,
                indexed_files: indexed,
                total_files: total,
                message: None,
            });
            emit_status(app, self.status(&project.id));
        }
        self.set_status(SymbolIndexStatus {
            project_id: project.id.clone(),
            indexing: true,
            indexed_files: indexed,
            total_files: total,
            message: None,
        });
        Ok(())
    }

    fn set_status(&self, status: SymbolIndexStatus) {
        if let Ok(mut statuses) = self.status.write() {
            statuses.insert(status.project_id.clone(), status);
        }
    }

    pub async fn index_file(
        &self,
        cache: &Cache,
        ctags: &Path,
        project: &Project,
        relative_path: &str,
    ) -> GazeResult<()> {
        let root = PathBuf::from(&project.root);
        let full_path = resolve_within_root(&root, relative_path)?;
        let metadata = std::fs::metadata(&full_path)?;
        if metadata.is_dir() {
            return Err(GazeError::InvalidPath("目录没有文件符号。".to_string()));
        }
        let file = CachedFile {
            rel_path: relative_path.to_string(),
            fingerprint: fingerprint(&metadata),
        };
        let existing = cache.symbol_file_fingerprints(&project.id).await?;
        if existing.get(relative_path) == Some(&file.fingerprint) {
            return Ok(());
        }
        let ctags_path = ctags.to_path_buf();
        let root_copy = root.clone();
        let path_copy = relative_path.to_string();
        let symbols = tokio::task::spawn_blocking(move || {
            run_ctags_batch(&ctags_path, &root_copy, &[path_copy])
        })
        .await
        .map_err(GazeError::Join)??;
        cache
            .replace_symbols_for_file(
                &project.id,
                relative_path,
                &file,
                symbols.get(relative_path).map(Vec::as_slice).unwrap_or(&[]),
            )
            .await
    }

    pub async fn outline(
        &self,
        cache: &Cache,
        project: &Project,
        relative_path: &str,
    ) -> GazeResult<Vec<DocumentSymbol>> {
        let symbols = cache.symbols_for_file(&project.id, relative_path).await?;
        Ok(symbols
            .into_iter()
            .map(|symbol| {
                let detail = symbol_detail(&symbol);
                DocumentSymbol {
                    name: symbol.name,
                    detail,
                    kind: symbol.kind,
                    line: symbol.line,
                    character: symbol.character,
                    end_line: symbol.line,
                    end_character: symbol.character,
                    children: Vec::new(),
                }
            })
            .collect())
    }

    pub async fn search(
        &self,
        cache: &Cache,
        project: &Project,
        query: &str,
    ) -> GazeResult<SymbolSearchResult> {
        let symbols = cache.symbols_for_project(&project.id).await?;
        let mut converted: Vec<SymbolLocation> = symbols
            .into_iter()
            .map(|symbol| to_location(project, symbol))
            .collect();
        let trimmed = query.trim();
        if !trimmed.is_empty() {
            converted = fuzzy_filter_symbols(converted, trimmed);
        } else {
            converted.sort_by(|left, right| {
                left.path
                    .cmp(&right.path)
                    .then_with(|| left.line.cmp(&right.line))
            });
            converted.truncate(MAX_SYMBOL_RESULTS);
        }
        let indexing = self
            .status(&project.id)
            .is_some_and(|status| status.indexing);
        Ok(SymbolSearchResult {
            symbols: converted,
            indexing,
            message: None,
        })
    }

    pub async fn definition_candidates(
        &self,
        cache: &Cache,
        project: &Project,
        position: TextPosition,
        relative_path: &str,
    ) -> GazeResult<Vec<SymbolLocation>> {
        let project_copy = project.clone();
        let path_copy = relative_path.to_string();
        let content = tokio::task::spawn_blocking(move || read_file(&project_copy, &path_copy))
            .await
            .map_err(GazeError::Join)??;
        let FileContent::Text { content, .. } = content else {
            return Ok(Vec::new());
        };
        let Some(word) = word_at(&content, position) else {
            return Ok(Vec::new());
        };
        let symbols = cache.symbols_for_project(&project.id).await?;
        let mut locations: Vec<SymbolLocation> = symbols
            .into_iter()
            .filter(|symbol| {
                symbol.name == word
                    || symbol
                        .name
                        .rsplit('.')
                        .next()
                        .is_some_and(|name| name == word)
            })
            .map(|symbol| to_location(project, symbol))
            .collect();
        locations.sort_by(|left, right| {
            left.path
                .cmp(&right.path)
                .then_with(|| left.line.cmp(&right.line))
                .then_with(|| left.name.cmp(&right.name))
        });
        locations.dedup_by(|left, right| {
            left.path == right.path && left.line == right.line && left.name == right.name
        });
        locations.truncate(MAX_DEFINITION_CANDIDATES);
        Ok(locations)
    }
}

fn emit_status(app: &AppHandle, status: Option<SymbolIndexStatus>) {
    if let Some(status) = status {
        let _ = app.emit("gaze://symbol-index", status);
    }
}

fn symbol_detail(symbol: &CachedSymbol) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(scope) = &symbol.scope {
        parts.push(scope.clone());
    }
    if let Some(signature) = &symbol.signature {
        parts.push(signature.clone());
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" · "))
    }
}

fn to_location(project: &Project, symbol: CachedSymbol) -> SymbolLocation {
    let character = symbol.character;
    let name_width = symbol.name.encode_utf16().count() as u32;
    SymbolLocation {
        project_id: project.id.clone(),
        path: symbol.path,
        name: symbol.name,
        kind: symbol.kind,
        line: symbol.line,
        character,
        end_line: symbol.line,
        end_character: character + name_width,
        source: "ctags".to_string(),
    }
}

fn fuzzy_filter_symbols(symbols: Vec<SymbolLocation>, query: &str) -> Vec<SymbolLocation> {
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::new(Config::DEFAULT);
    let mut buffer = Vec::new();
    let mut scored: Vec<(u32, SymbolLocation)> = symbols
        .into_iter()
        .filter_map(|symbol| {
            let score = pattern.score(Utf32Str::new(&symbol.name, &mut buffer), &mut matcher)?;
            Some((score, symbol))
        })
        .collect();
    scored.sort_by(|(left_score, left), (right_score, right)| {
        right_score
            .cmp(left_score)
            .then_with(|| left.path.cmp(&right.path))
            .then_with(|| left.line.cmp(&right.line))
    });
    scored
        .into_iter()
        .take(MAX_SYMBOL_RESULTS)
        .map(|(_, symbol)| symbol)
        .collect()
}

fn stale_files(
    files: &[CachedFile],
    existing: &HashMap<String, crate::models::FileFingerprint>,
) -> Vec<CachedFile> {
    files
        .iter()
        .filter(|file| existing.get(&file.rel_path) != Some(&file.fingerprint))
        .cloned()
        .collect()
}

fn run_ctags_batch(
    ctags: &Path,
    root: &Path,
    relative_paths: &[String],
) -> GazeResult<HashMap<String, Vec<CachedSymbol>>> {
    let mut command = std::process::Command::new(ctags);
    command
        .current_dir(root)
        .arg("--options=NONE")
        .arg("--output-format=json")
        .arg("--fields=+nKzS")
        .arg("--extras=+q")
        .arg("--sort=no")
        .arg("--map-TypeScript=+.tsx")
        .arg("-f")
        .arg("-");
    for relative in relative_paths {
        command.arg(root.join(relative));
    }
    let output = command.output().map_err(|error| {
        GazeError::ToolMissing(format!(
            "无法运行 universal-ctags（{}）：{error}",
            ctags.display()
        ))
    })?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr);
        return Err(GazeError::Message(format!(
            "universal-ctags 执行失败：{}",
            message.lines().take(3).collect::<Vec<_>>().join("\n")
        )));
    }
    let mut result: HashMap<String, Vec<CachedSymbol>> = HashMap::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("_type").and_then(|value| value.as_str()) != Some("tag") {
            continue;
        }
        let Some(name) = value.get("name").and_then(|value| value.as_str()) else {
            continue;
        };
        let Some(raw_path) = value.get("path").and_then(|value| value.as_str()) else {
            continue;
        };
        let path = PathBuf::from(raw_path);
        let absolute = if path.is_absolute() {
            path
        } else {
            root.join(path)
        };
        let Ok(relative) = path_to_relative(root, &absolute) else {
            continue;
        };
        let line = value
            .get("line")
            .and_then(|value| value.as_u64())
            .map(|line| line.saturating_sub(1) as u32)
            .unwrap_or(0);
        let kind = value
            .get("kind")
            .and_then(|value| value.as_str())
            .unwrap_or("tag")
            .to_string();
        let scope = value
            .get("scope")
            .and_then(|value| value.as_str())
            .map(str::to_string);
        let signature = value
            .get("signature")
            .and_then(|value| value.as_str())
            .map(str::to_string);
        result
            .entry(relative.clone())
            .or_default()
            .push(CachedSymbol {
                path: relative,
                name: name.to_string(),
                kind,
                line,
                character: 0,
                scope,
                signature,
            });
    }
    for symbols in result.values_mut() {
        symbols.sort_by(|left, right| {
            left.line
                .cmp(&right.line)
                .then_with(|| left.character.cmp(&right.character))
                .then_with(|| left.name.cmp(&right.name))
        });
        symbols.dedup_by(|left, right| {
            left.line == right.line && left.name == right.name && left.kind == right.kind
        });
    }
    Ok(result)
}

pub fn word_at(content: &str, position: TextPosition) -> Option<String> {
    let line = content.split('\n').nth(position.line as usize)?;
    let target = position.character as usize;
    let mut utf16_units = 0usize;
    let mut byte_index = line.len();
    for (index, character) in line.char_indices() {
        let width = character.len_utf16();
        if utf16_units + width > target {
            byte_index = index;
            break;
        }
        utf16_units += width;
        byte_index = index + character.len_utf8();
    }

    let is_identifier =
        |character: char| character.is_alphanumeric() || character == '_' || character == '$';
    let mut start = byte_index;
    for (index, character) in line[..byte_index].char_indices().rev() {
        if is_identifier(character) {
            start = index;
        } else {
            break;
        }
    }
    if start == byte_index && byte_index < line.len() {
        let at_cursor = line[byte_index..].chars().next()?;
        if !is_identifier(at_cursor) {
            return None;
        }
    }
    let mut end = byte_index;
    for (offset, character) in line[byte_index..].char_indices() {
        if is_identifier(character) {
            end = byte_index + offset + character.len_utf8();
        } else {
            break;
        }
    }
    if start == end {
        return None;
    }
    let word = &line[start..end];
    if word.chars().all(|character| !is_identifier(character)) {
        None
    } else {
        Some(word.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalidation_advances_only_the_target_project_revision() {
        let service = SymbolService::new();
        assert_eq!(service.revision("p1"), 0);
        service.bump_revision("p1");
        service.bump_revision("p1");
        assert_eq!(service.revision("p1"), 2);
        assert_eq!(service.revision("p2"), 0);
    }

    #[test]
    fn extracts_unicode_word_at_utf16_position() {
        let content = "const 😀 = 1; const 名字 = 2;";
        let position = TextPosition {
            line: 0,
            character: "const 😀 = 1; const ".encode_utf16().count() as u32 + 1,
        };
        assert_eq!(word_at(content, position).as_deref(), Some("名字"));
    }

    #[test]
    fn extracts_identifier_after_cursor_at_word_end() {
        let content = "fn main() {}\n";
        assert_eq!(
            word_at(
                content,
                TextPosition {
                    line: 0,
                    character: 2
                }
            )
            .as_deref(),
            Some("fn")
        );
    }

    #[test]
    fn parses_ctags_json_fixture() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let file = root.join("sample.ts");
        std::fs::write(
            &file,
            "export interface Shape { area(): number }\nexport class Square implements Shape {\n  area() { return 1 }\n}\nconst value = 2;\n",
        )
        .unwrap();
        let ctags = match crate::tools::Tools::detect(&crate::config::AppConfig::default()).ctags {
            Some(path) => path,
            None => return,
        };
        let symbols = run_ctags_batch(&ctags, &root, &["sample.ts".to_string()]).unwrap();
        let file_symbols = symbols.get("sample.ts").unwrap();
        assert!(file_symbols.iter().any(|symbol| symbol.name == "Shape"));
        assert!(file_symbols.iter().any(|symbol| symbol.name == "Square"));
    }

    #[test]
    fn maps_tsx_to_typescript_for_ctags() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        std::fs::write(
            root.join("View.tsx"),
            "export default function View() { return <div>Hello</div>; }\n",
        )
        .unwrap();
        let ctags = match crate::tools::Tools::detect(&crate::config::AppConfig::default()).ctags {
            Some(path) => path,
            None => return,
        };
        let symbols = run_ctags_batch(&ctags, &root, &["View.tsx".to_string()]).unwrap();
        assert!(symbols
            .get("View.tsx")
            .unwrap()
            .iter()
            .any(|symbol| symbol.name == "View"));
    }

    #[test]
    fn only_changed_or_missing_symbol_files_are_reindexed() {
        use crate::models::FileFingerprint;
        let files = vec![
            CachedFile {
                rel_path: "a.ts".to_string(),
                fingerprint: FileFingerprint {
                    size: 1,
                    modified_ns: 1,
                },
            },
            CachedFile {
                rel_path: "b.ts".to_string(),
                fingerprint: FileFingerprint {
                    size: 2,
                    modified_ns: 2,
                },
            },
        ];
        let mut existing = HashMap::new();
        existing.insert(
            "a.ts".to_string(),
            FileFingerprint {
                size: 1,
                modified_ns: 1,
            },
        );
        existing.insert(
            "deleted.ts".to_string(),
            FileFingerprint {
                size: 3,
                modified_ns: 3,
            },
        );
        assert_eq!(
            stale_files(&files, &existing)
                .into_iter()
                .map(|file| file.rel_path)
                .collect::<Vec<_>>(),
            vec!["b.ts"]
        );
    }

    #[tokio::test]
    async fn ctags_fallback_returns_all_definition_candidates() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        std::fs::write(
            root.join("usage.ts"),
            "export const value = inspect(\"x\");\n",
        )
        .unwrap();
        let project = Project {
            id: "p".to_string(),
            name: "Demo".to_string(),
            root: root.display().to_string(),
        };
        let cache = crate::cache::Cache::open_in_memory().unwrap();
        cache.insert_project(&project).await.unwrap();
        let fingerprint = crate::models::FileFingerprint {
            size: 1,
            modified_ns: 1,
        };
        for path in ["src/alpha.ts", "src/beta.ts"] {
            cache
                .replace_symbols_for_file(
                    "p",
                    path,
                    &CachedFile {
                        rel_path: path.to_string(),
                        fingerprint,
                    },
                    &[CachedSymbol {
                        path: path.to_string(),
                        name: "inspect".to_string(),
                        kind: "function".to_string(),
                        line: 0,
                        character: 0,
                        scope: None,
                        signature: Some("(value: string)".to_string()),
                    }],
                )
                .await
                .unwrap();
        }
        let service = SymbolService::new();
        let locations = service
            .definition_candidates(
                &cache,
                &project,
                TextPosition {
                    line: 0,
                    character: 22,
                },
                "usage.ts",
            )
            .await
            .unwrap();
        assert_eq!(locations.len(), 2);
        assert_eq!(locations[0].source, "ctags");
        assert_eq!(locations[0].path, "src/alpha.ts");
        assert_eq!(locations[1].path, "src/beta.ts");
    }
}
