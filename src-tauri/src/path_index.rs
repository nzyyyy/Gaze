use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::WalkBuilder;
use nucleo::pattern::{CaseMatching, Normalization, Pattern};
use nucleo::{Config, Matcher, Utf32Str};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::cache::{Cache, CachedFile};
use crate::error::{GazeError, GazeResult};
use crate::files::{fingerprint, path_to_relative};
use crate::models::{PathSearchHit, Project};

const MAX_PATH_RESULTS: usize = 120;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathIndexStatus {
    pub project_id: String,
    pub entry_count: usize,
    pub indexing: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathSearchResponse {
    pub hits: Vec<PathSearchHit>,
    pub indexing: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone)]
struct PathEntry {
    project_id: String,
    project_name: String,
    path: String,
}

#[derive(Debug, Default)]
struct IndexedProject {
    entries: Arc<Vec<PathEntry>>,
    indexing: bool,
    message: Option<String>,
}

#[derive(Default)]
pub struct PathIndex {
    projects: RwLock<HashMap<String, IndexedProject>>,
    tasks: Mutex<HashMap<String, PathTask>>,
}

struct PathTask {
    cancel: Arc<AtomicBool>,
    done_tx: tokio::sync::watch::Sender<bool>,
}

impl PathIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn load_cached(&self, cache: &Cache, projects: &[Project]) -> GazeResult<()> {
        for project in projects {
            let cached = cache.cached_files(&project.id).await?;
            let entries = Arc::new(
                cached
                    .into_iter()
                    .map(|file| PathEntry {
                        project_id: project.id.clone(),
                        project_name: project.name.clone(),
                        path: file.rel_path,
                    })
                    .collect(),
            );
            if let Ok(mut index) = self.projects.write() {
                index.entry(project.id.clone()).or_insert(IndexedProject {
                    entries,
                    indexing: false,
                    message: None,
                });
            }
        }
        Ok(())
    }

    pub fn has_project(&self, project_id: &str) -> bool {
        self.projects
            .read()
            .map(|projects| projects.contains_key(project_id))
            .unwrap_or(false)
    }

    pub fn is_indexing(&self, project_id: &str) -> bool {
        self.projects
            .read()
            .map(|projects| {
                projects
                    .get(project_id)
                    .is_some_and(|project| project.indexing)
            })
            .unwrap_or(false)
    }

    pub async fn wait_for_index(&self, project_id: &str) {
        let receiver = self
            .tasks
            .lock()
            .ok()
            .and_then(|tasks| tasks.get(project_id).map(|task| task.done_tx.subscribe()));
        if let Some(mut receiver) = receiver {
            let _ = receiver.wait_for(|value| *value).await;
        }
    }

    pub fn statuses(&self) -> Vec<PathIndexStatus> {
        self.projects
            .read()
            .map(|projects| {
                projects
                    .iter()
                    .map(|(project_id, index)| PathIndexStatus {
                        project_id: project_id.clone(),
                        entry_count: index.entries.len(),
                        indexing: index.indexing,
                        message: index.message.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn remove_project(&self, project_id: &str) {
        if let Ok(mut tasks) = self.tasks.lock() {
            if let Some(task) = tasks.remove(project_id) {
                task.cancel.store(true, Ordering::Relaxed);
                let _ = task.done_tx.send(true);
            }
        }
        if let Ok(mut projects) = self.projects.write() {
            projects.remove(project_id);
        }
    }

    pub async fn index_project(
        self: Arc<Self>,
        app: AppHandle,
        cache: Cache,
        project: Project,
    ) -> GazeResult<()> {
        let cancel = Arc::new(AtomicBool::new(false));
        enum TaskAction {
            Start(tokio::sync::watch::Sender<bool>),
            Wait(tokio::sync::watch::Receiver<bool>),
        }
        let action = {
            let mut tasks = self
                .tasks
                .lock()
                .map_err(|_| GazeError::Message("路径索引任务锁已损坏。".to_string()))?;
            if let Some(task) = tasks.get(&project.id) {
                TaskAction::Wait(task.done_tx.subscribe())
            } else {
                let (done_tx, _) = tokio::sync::watch::channel(false);
                tasks.insert(
                    project.id.clone(),
                    PathTask {
                        cancel: Arc::clone(&cancel),
                        done_tx: done_tx.clone(),
                    },
                );
                TaskAction::Start(done_tx)
            }
        };
        let done_tx = match action {
            TaskAction::Wait(mut receiver) => {
                let _ = receiver.wait_for(|value| *value).await;
                return Ok(());
            }
            TaskAction::Start(done_tx) => done_tx,
        };
        self.set_indexing(&project, true, None);
        emit_status(&app, self.status_for(&project.id));
        let started = std::time::Instant::now();
        tracing::info!(project = %project.name, "path indexing started");

        let scan_project = project.clone();
        let scan_cancel = Arc::clone(&cancel);
        let scan =
            tokio::task::spawn_blocking(move || scan_paths(&scan_project, &scan_cancel)).await;

        let result = match scan {
            Ok(Ok(outcome)) => {
                if cancel.load(Ordering::Relaxed) {
                    finish_task(&self.tasks, &project.id, &done_tx);
                    return Err(GazeError::Cancelled);
                }
                match cache.replace_file_index(&project.id, &outcome.cached).await {
                    Ok(()) => {
                        let file_count = outcome.files.len();
                        let entries = Arc::new(
                            outcome
                                .files
                                .into_iter()
                                .map(|path| PathEntry {
                                    project_id: project.id.clone(),
                                    project_name: project.name.clone(),
                                    path,
                                })
                                .collect(),
                        );
                        if let Ok(mut projects) = self.projects.write() {
                            projects.insert(
                                project.id.clone(),
                                IndexedProject {
                                    entries,
                                    indexing: false,
                                    message: outcome.warning,
                                },
                            );
                        }
                        tracing::info!(
                            project = %project.name,
                            files = file_count,
                            elapsed_ms = started.elapsed().as_millis(),
                            "path indexing complete"
                        );
                        Ok(())
                    }
                    Err(error) => Err(error),
                }
            }
            Ok(Err(error)) => Err(error),
            Err(error) => Err(error.into()),
        };

        finish_task(&self.tasks, &project.id, &done_tx);
        if let Err(error) = &result {
            self.set_indexing(&project, false, Some(error.message()));
            tracing::warn!(project = %project.name, %error, "path index failed");
        }
        emit_status(&app, self.status_for(&project.id));
        result
    }

    fn set_indexing(&self, project: &Project, indexing: bool, message: Option<String>) {
        if let Ok(mut projects) = self.projects.write() {
            let entry = projects
                .entry(project.id.clone())
                .or_insert_with(IndexedProject::default);
            entry.indexing = indexing;
            entry.message = message;
        }
    }

    fn status_for(&self, project_id: &str) -> Option<PathIndexStatus> {
        self.projects.read().ok().and_then(|projects| {
            projects.get(project_id).map(|index| PathIndexStatus {
                project_id: project_id.to_string(),
                entry_count: index.entries.len(),
                indexing: index.indexing,
                message: index.message.clone(),
            })
        })
    }

    pub async fn search(&self, query: String) -> GazeResult<PathSearchResponse> {
        let (entries, indexing, message) = self
            .projects
            .read()
            .map(|projects| {
                let mut entries = Vec::new();
                let mut indexing = false;
                let mut message = None;
                for index in projects.values() {
                    entries.push(Arc::clone(&index.entries));
                    indexing |= index.indexing;
                    if message.is_none() {
                        message = index.message.clone();
                    }
                }
                (entries, indexing, message)
            })
            .map_err(|_| GazeError::Message("路径索引读取锁已损坏。".to_string()))?;

        let hits = tokio::task::spawn_blocking(move || match_paths(&query, entries))
            .await
            .map_err(GazeError::Join)?;
        Ok(PathSearchResponse {
            hits,
            indexing,
            message,
        })
    }
}

fn finish_task(
    tasks: &Mutex<HashMap<String, PathTask>>,
    project_id: &str,
    done_tx: &tokio::sync::watch::Sender<bool>,
) {
    if let Ok(mut tasks) = tasks.lock() {
        tasks.remove(project_id);
    }
    let _ = done_tx.send(true);
}

fn emit_status(app: &AppHandle, status: Option<PathIndexStatus>) {
    if let Some(status) = status {
        let _ = app.emit("gaze://path-index", status);
    }
}

struct ScanOutcome {
    files: Vec<String>,
    cached: Vec<CachedFile>,
    warning: Option<String>,
}

fn scan_paths(project: &Project, cancel: &AtomicBool) -> GazeResult<ScanOutcome> {
    let root = Path::new(&project.root);
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .follow_links(false)
        .parents(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false);
    builder.filter_entry(|entry| {
        entry.file_name() != ".git"
            && !crate::files::is_internal_temp_name(&entry.file_name().to_string_lossy())
    });

    let mut files = Vec::new();
    let mut cached = Vec::new();
    let mut warning_count = 0usize;
    let mut first_warning = None;
    for result in builder.build() {
        if cancel.load(Ordering::Relaxed) {
            return Err(GazeError::Cancelled);
        }
        let entry = match result {
            Ok(entry) => entry,
            Err(error) => {
                warning_count += 1;
                if first_warning.is_none() {
                    first_warning = Some(error.to_string());
                }
                continue;
            }
        };
        if entry.file_type().is_some_and(|kind| kind.is_dir()) {
            continue;
        }
        let path = entry.path();
        let metadata = match std::fs::metadata(path) {
            Ok(metadata) if metadata.is_file() => metadata,
            Ok(_) => continue,
            Err(error) => {
                warning_count += 1;
                if first_warning.is_none() {
                    first_warning = Some(error.to_string());
                }
                continue;
            }
        };
        let relative = match path_to_relative(root, path) {
            Ok(relative) if !relative.is_empty() => relative,
            Ok(_) => continue,
            Err(error) => {
                warning_count += 1;
                if first_warning.is_none() {
                    first_warning = Some(error.message());
                }
                continue;
            }
        };
        cached.push(CachedFile {
            rel_path: relative.clone(),
            fingerprint: fingerprint(&metadata),
        });
        files.push(relative);
    }

    let warning = first_warning.map(|first| {
        if warning_count > 1 {
            format!("索引时有 {warning_count} 个路径无法读取；{first}")
        } else {
            format!("索引时有路径无法读取：{first}")
        }
    });
    Ok(ScanOutcome {
        files,
        cached,
        warning,
    })
}

fn match_paths(query: &str, entries: Vec<Arc<Vec<PathEntry>>>) -> Vec<PathSearchHit> {
    let trimmed = query.trim();
    let mut matcher = Matcher::new(Config::DEFAULT);
    let pattern = Pattern::parse(trimmed, CaseMatching::Smart, Normalization::Smart);
    let mut utf32_buffer = Vec::new();
    let mut hits: Vec<(u32, &PathEntry)> = entries
        .iter()
        .flat_map(|entries| entries.iter())
        .filter_map(|entry| {
            let score = if trimmed.is_empty() {
                0
            } else {
                pattern.score(Utf32Str::new(&entry.path, &mut utf32_buffer), &mut matcher)?
            };
            Some((score, entry))
        })
        .collect();
    hits.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.path.len().cmp(&right.1.path.len()))
            .then_with(|| left.1.path.cmp(&right.1.path))
            .then_with(|| left.1.project_id.cmp(&right.1.project_id))
    });
    hits.truncate(MAX_PATH_RESULTS);
    hits.into_iter()
        .map(|(score, entry)| PathSearchHit {
            project_id: entry.project_id.clone(),
            project_name: entry.project_name.clone(),
            path: entry.path.clone(),
            score,
        })
        .collect()
}

#[derive(Debug, Clone)]
pub enum PathChange {
    Removed(String),
    File(String),
    Directory(String),
}

struct ChangeUpdate {
    remove_under: Option<String>,
    files: Vec<CachedFile>,
    warning: Option<String>,
}

impl PathIndex {
    pub async fn apply_changes(
        &self,
        cache: &Cache,
        project: &Project,
        changes: Vec<PathChange>,
    ) -> GazeResult<()> {
        if !self.has_project(&project.id) || changes.is_empty() {
            return Ok(());
        }
        let project_copy = project.clone();
        let updates = tokio::task::spawn_blocking(move || {
            let mut ignores = IgnoreCache::new(Path::new(&project_copy.root));
            changes
                .into_iter()
                .map(|change| compute_change(&project_copy, change, &mut ignores))
                .collect::<GazeResult<Vec<_>>>()
        })
        .await
        .map_err(GazeError::Join)??;

        for update in updates {
            if let Some(prefix) = &update.remove_under {
                if update.files.is_empty() {
                    cache.remove_files_under(&project.id, prefix).await?;
                } else {
                    cache
                        .replace_files_under(&project.id, prefix, &update.files)
                        .await?;
                }
            } else if let Some(file) = update.files.first() {
                cache.upsert_file(&project.id, file).await?;
            }

            if let Ok(mut projects) = self.projects.write() {
                if let Some(index) = projects.get_mut(&project.id) {
                    let entries = Arc::make_mut(&mut index.entries);
                    if let Some(prefix) = &update.remove_under {
                        entries.retain(|entry| {
                            entry.path != *prefix && !entry.path.starts_with(&format!("{prefix}/"))
                        });
                    }
                    for file in &update.files {
                        if !entries.iter().any(|entry| entry.path == file.rel_path) {
                            entries.push(PathEntry {
                                project_id: project.id.clone(),
                                project_name: project.name.clone(),
                                path: file.rel_path.clone(),
                            });
                        }
                    }
                    if update.warning.is_some() {
                        index.message = update.warning.clone();
                    }
                }
            }
        }
        Ok(())
    }
}

fn compute_change(
    project: &Project,
    change: PathChange,
    ignores: &mut IgnoreCache,
) -> GazeResult<ChangeUpdate> {
    let root = Path::new(&project.root);
    match change {
        PathChange::Removed(relative) => Ok(removed_change(relative)),
        PathChange::File(relative) => {
            let absolute = root.join(&relative);
            let Ok(symlink) = std::fs::symlink_metadata(&absolute) else {
                return Ok(removed_change(relative));
            };
            if symlink.file_type().is_symlink() {
                let Ok(target) = std::fs::metadata(&absolute) else {
                    return Ok(removed_change(relative));
                };
                if target.is_dir() {
                    return Ok(ChangeUpdate {
                        remove_under: Some(relative),
                        files: Vec::new(),
                        warning: Some("符号链接目录未加入索引。".to_string()),
                    });
                }
            }
            let metadata = std::fs::metadata(&absolute)?;
            if !metadata.is_file() {
                return Ok(removed_change(relative));
            }
            if is_ignored(&absolute, false, ignores)? {
                return Ok(removed_change(relative));
            }
            Ok(ChangeUpdate {
                remove_under: None,
                files: vec![CachedFile {
                    rel_path: relative,
                    fingerprint: fingerprint(&metadata),
                }],
                warning: None,
            })
        }
        PathChange::Directory(relative) => {
            let absolute = root.join(&relative);
            if !absolute.is_dir() {
                return Ok(removed_change(relative));
            }
            if is_ignored(&absolute, true, ignores)? {
                return Ok(removed_change(relative));
            }
            let (files, warning) = scan_subtree(root, &absolute)?;
            Ok(ChangeUpdate {
                remove_under: Some(relative),
                files,
                warning,
            })
        }
    }
}

fn removed_change(relative: String) -> ChangeUpdate {
    ChangeUpdate {
        remove_under: Some(relative),
        files: Vec::new(),
        warning: None,
    }
}

pub(crate) struct IgnoreCache {
    root: PathBuf,
    global: Gitignore,
    matchers: HashMap<PathBuf, Gitignore>,
}

impl IgnoreCache {
    pub(crate) fn new(root: &Path) -> Self {
        let (global, _) = GitignoreBuilder::new(root).build_global();
        Self {
            root: root.to_path_buf(),
            global,
            matchers: HashMap::new(),
        }
    }
}

pub(crate) fn is_ignored(path: &Path, is_dir: bool, cache: &mut IgnoreCache) -> GazeResult<bool> {
    let root = cache.root.clone();
    let global = cache.global.matched_path_or_any_parents(path, is_dir);
    let mut ignored = global.is_ignore();
    let Some(parent) = path.parent() else {
        return Ok(ignored);
    };
    let mut directories = Vec::new();
    let mut current = Some(parent);
    while let Some(directory) = current {
        directories.push(directory.to_path_buf());
        if directory == root {
            break;
        }
        current = directory.parent();
    }
    directories.reverse();

    for directory in directories {
        let matcher = if let Some(matcher) = cache.matchers.get(&directory) {
            matcher.clone()
        } else {
            let matcher = build_ignore_matcher(&root, &directory)?;
            cache.matchers.insert(directory.clone(), matcher.clone());
            matcher
        };
        let matched = matcher.matched_path_or_any_parents(path, is_dir);
        if matched.is_ignore() {
            ignored = true;
        } else if matched.is_whitelist() {
            ignored = false;
        }
    }
    Ok(ignored)
}

fn build_ignore_matcher(root: &Path, directory: &Path) -> GazeResult<Gitignore> {
    let mut builder = GitignoreBuilder::new(directory);
    if directory == root {
        let exclude = root.join(".git/info/exclude");
        if exclude.is_file() {
            let _ = builder.add(exclude);
        }
    }
    for name in [".gitignore", ".ignore"] {
        let file = directory.join(name);
        if file.is_file() {
            let _ = builder.add(file);
        }
    }
    builder
        .build()
        .map_err(|error| GazeError::Message(format!("无法读取忽略规则：{error}")))
}

fn scan_subtree(root: &Path, start: &Path) -> GazeResult<(Vec<CachedFile>, Option<String>)> {
    let mut builder = WalkBuilder::new(start);
    builder
        .hidden(false)
        .follow_links(false)
        .parents(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false);
    builder.filter_entry(|entry| {
        entry.file_name() != ".git"
            && !crate::files::is_internal_temp_name(&entry.file_name().to_string_lossy())
    });
    let mut files = Vec::new();
    let mut first_warning = None;
    for result in builder.build() {
        let entry = match result {
            Ok(entry) => entry,
            Err(error) => {
                first_warning.get_or_insert_with(|| error.to_string());
                continue;
            }
        };
        if entry.file_type().is_some_and(|kind| kind.is_dir()) {
            continue;
        }
        let path = entry.path();
        let metadata = match std::fs::metadata(path) {
            Ok(metadata) if metadata.is_file() => metadata,
            _ => continue,
        };
        let Ok(relative) = path_to_relative(root, path) else {
            continue;
        };
        if relative.is_empty() {
            continue;
        }
        files.push(CachedFile {
            rel_path: relative,
            fingerprint: fingerprint(&metadata),
        });
    }
    let warning = first_warning.map(|warning| format!("增量索引有路径无法读取：{warning}"));
    Ok((files, warning))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    #[test]
    fn fuzzy_matching_prefers_compact_filename_match() {
        let entries = vec![
            PathEntry {
                project_id: "a".to_string(),
                project_name: "A".to_string(),
                path: "src/components/deep/navigation/main.tsx".to_string(),
            },
            PathEntry {
                project_id: "a".to_string(),
                project_name: "A".to_string(),
                path: "src/main.tsx".to_string(),
            },
        ];
        let hits = match_paths("main", vec![Arc::new(entries)]);
        assert_eq!(hits[0].path, "src/main.tsx");
    }

    #[test]
    fn fuzzy_matching_handles_unicode() {
        let entries = vec![PathEntry {
            project_id: "a".to_string(),
            project_name: "项目".to_string(),
            path: "src/你好.ts".to_string(),
        }];
        let hits = match_paths("你好", vec![Arc::new(entries)]);
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn scan_respects_gitignore_and_excludes_git_directory() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("ignored")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("src/main.ts"), "export {}").unwrap();
        std::fs::write(root.join("ignored/secret.ts"), "no").unwrap();
        std::fs::write(root.join(".git/config"), "no").unwrap();
        let mut ignore_file = std::fs::File::create(root.join(".gitignore")).unwrap();
        writeln!(ignore_file, "ignored/").unwrap();
        let project = Project {
            id: "p".to_string(),
            name: "demo".to_string(),
            root: root.display().to_string(),
        };
        let outcome = scan_paths(&project, &AtomicBool::new(false)).unwrap();
        assert!(outcome.files.contains(&"src/main.ts".to_string()));
        assert!(!outcome.files.contains(&"ignored/secret.ts".to_string()));
        assert!(!outcome.files.iter().any(|path| path.starts_with(".git/")));
    }

    #[test]
    fn cancellation_aborts_scan() {
        let temporary = tempfile::tempdir().unwrap();
        let project = Project {
            id: "p".to_string(),
            name: "demo".to_string(),
            root: temporary
                .path()
                .canonicalize()
                .unwrap()
                .display()
                .to_string(),
        };
        let cancel = AtomicBool::new(true);
        assert!(matches!(
            scan_paths(&project, &cancel),
            Err(GazeError::Cancelled)
        ));
    }

    #[test]
    fn empty_query_is_stable_and_bounded() {
        let entries = (0..300)
            .map(|index| PathEntry {
                project_id: "a".to_string(),
                project_name: "A".to_string(),
                path: format!("src/{index:03}.ts"),
            })
            .collect();
        let hits = match_paths("", vec![Arc::new(entries)]);
        assert_eq!(hits.len(), MAX_PATH_RESULTS);
        assert_eq!(hits[0].path, "src/000.ts");
    }

    #[test]
    fn path_buf_import_is_used_for_portable_paths() {
        let root = PathBuf::from("/tmp/project");
        assert_eq!(
            path_to_relative(&root, &root.join("src/app.ts")).unwrap(),
            "src/app.ts"
        );
    }

    #[test]
    fn incremental_ignore_rules_apply_nested_gitignore() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("src/generated")).unwrap();
        std::fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
        std::fs::write(root.join("src/.gitignore"), "*.gen.ts\n").unwrap();
        std::fs::write(root.join("src/main.ts"), "export {}").unwrap();
        std::fs::write(root.join("src/thing.gen.ts"), "no").unwrap();
        let mut cache = IgnoreCache::new(&root);
        assert!(!is_ignored(&root.join("src/main.ts"), false, &mut cache).unwrap());
        assert!(is_ignored(&root.join("src/thing.gen.ts"), false, &mut cache).unwrap());
        assert!(is_ignored(&root.join("src/generated"), true, &mut cache).is_ok());
    }

    #[tokio::test]
    async fn incremental_changes_update_quick_open_memory_and_database() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/main.ts"), "export {}").unwrap();
        let project = Project {
            id: "p".to_string(),
            name: "Demo".to_string(),
            root: root.display().to_string(),
        };
        let cache = Cache::open_in_memory().unwrap();
        cache.insert_project(&project).await.unwrap();
        let index = PathIndex::new();
        index
            .load_cached(&cache, std::slice::from_ref(&project))
            .await
            .unwrap();

        index
            .apply_changes(
                &cache,
                &project,
                vec![PathChange::File("src/main.ts".to_string())],
            )
            .await
            .unwrap();
        assert_eq!(
            index.search("main".to_string()).await.unwrap().hits.len(),
            1
        );
        assert_eq!(cache.cached_files("p").await.unwrap().len(), 1);

        std::fs::remove_file(root.join("src/main.ts")).unwrap();
        index
            .apply_changes(
                &cache,
                &project,
                vec![PathChange::Removed("src/main.ts".to_string())],
            )
            .await
            .unwrap();
        assert!(index
            .search("main".to_string())
            .await
            .unwrap()
            .hits
            .is_empty());
        assert!(cache.cached_files("p").await.unwrap().is_empty());
    }

    #[test]
    #[ignore = "requires GAZE_REAL_PROJECT pointing at a real workspace"]
    fn real_workspace_path_scan_and_fuzzy_search_are_bounded() {
        let Ok(root) = std::env::var("GAZE_REAL_PROJECT") else {
            return;
        };
        let project = Project {
            id: "real".to_string(),
            name: "Real".to_string(),
            root,
        };
        let started = std::time::Instant::now();
        let outcome = scan_paths(&project, &AtomicBool::new(false)).unwrap();
        let elapsed = started.elapsed();
        assert!(!outcome.files.is_empty());
        let entries = outcome
            .files
            .iter()
            .map(|path| PathEntry {
                project_id: project.id.clone(),
                project_name: project.name.clone(),
                path: path.clone(),
            })
            .collect();
        let search_started = std::time::Instant::now();
        let hits = match_paths("main", vec![Arc::new(entries)]);
        eprintln!(
            "real workspace path index: {} files in {} ms; fuzzy query {} hits in {} ms",
            outcome.files.len(),
            elapsed.as_millis(),
            hits.len(),
            search_started.elapsed().as_millis()
        );
        assert!(hits.len() <= MAX_PATH_RESULTS);
    }
}
