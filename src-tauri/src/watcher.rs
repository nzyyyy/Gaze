use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::cache::Cache;
use crate::error::{GazeError, GazeResult};
use crate::files::{is_internal_temp_name, path_to_relative};
use crate::models::{FsChangeEvent, Project};
use crate::path_index::{is_ignored, IgnoreCache, PathChange, PathIndex};
use crate::symbols::SymbolService;

const DEBOUNCE: Duration = Duration::from_millis(320);
const MAX_COALESCE: Duration = Duration::from_millis(1_400);
const WATCH_QUEUE_CAPACITY: usize = 256;
const MAX_BATCH_PATHS: usize = 2_048;

type WatchEvent = notify::Result<notify::Event>;
type WatchSender = tokio::sync::mpsc::Sender<WatchEvent>;
type WatchReceiver = tokio::sync::mpsc::Receiver<WatchEvent>;

#[derive(Default)]
struct EventBatch {
    paths: HashSet<PathBuf>,
    overflow: bool,
}

impl EventBatch {
    fn push(&mut self, event: WatchEvent) {
        let event = match event {
            Ok(event) => event,
            Err(error) => {
                tracing::warn!(%error, "file watcher reported an error");
                return;
            }
        };
        if !is_relevant_kind(&event.kind) {
            return;
        }
        for path in event.paths {
            if self.paths.len() >= MAX_BATCH_PATHS && !self.paths.contains(&path) {
                self.overflow = true;
                continue;
            }
            self.paths.insert(path);
        }
    }
}

fn watcher_channel() -> (WatchSender, WatchReceiver, Arc<AtomicBool>) {
    let (sender, receiver) = tokio::sync::mpsc::channel(WATCH_QUEUE_CAPACITY);
    (sender, receiver, Arc::new(AtomicBool::new(false)))
}

fn offer_event(sender: &WatchSender, event: WatchEvent, overflow: &AtomicBool) {
    if matches!(
        sender.try_send(event),
        Err(tokio::sync::mpsc::error::TrySendError::Full(_))
    ) {
        overflow.store(true, Ordering::Release);
    }
}

async fn receive_batch(
    receiver: &mut WatchReceiver,
    queue_overflow: &AtomicBool,
) -> Option<EventBatch> {
    let first = receiver.recv().await?;
    let mut batch = EventBatch::default();
    batch.push(first);
    let started = tokio::time::Instant::now();
    let mut deadline = started + DEBOUNCE;
    loop {
        let now = tokio::time::Instant::now();
        let cap = started + MAX_COALESCE;
        if now >= cap {
            break;
        }
        let wait_until = deadline.min(cap);
        match tokio::time::timeout(wait_until.saturating_duration_since(now), receiver.recv()).await
        {
            Ok(Some(event)) => {
                batch.push(event);
                deadline = tokio::time::Instant::now() + DEBOUNCE;
            }
            _ => break,
        }
    }
    batch.overflow |= queue_overflow.swap(false, Ordering::AcqRel);
    Some(batch)
}

pub struct WatcherService {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl Default for WatcherService {
    fn default() -> Self {
        Self::new()
    }
}

impl WatcherService {
    pub fn new() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
        }
    }

    pub fn start(
        &self,
        app: AppHandle,
        project: Project,
        cache: Cache,
        path_index: Arc<PathIndex>,
        symbols: Arc<SymbolService>,
        ctags: Option<PathBuf>,
    ) -> GazeResult<()> {
        {
            let watchers = self
                .watchers
                .lock()
                .map_err(|_| GazeError::Message("文件监听表锁已损坏。".to_string()))?;
            if watchers.contains_key(&project.id) {
                return Ok(());
            }
        }
        let (sender, mut receiver, overflow) = watcher_channel();
        let callback_overflow = Arc::clone(&overflow);
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                offer_event(&sender, event, &callback_overflow);
            })
            .map_err(|error| GazeError::Message(format!("无法创建文件监听器：{error}")))?;
        watcher
            .watch(Path::new(&project.root), RecursiveMode::Recursive)
            .map_err(|error| {
                GazeError::Message(format!("无法监听项目 {}：{error}", project.name))
            })?;
        {
            let mut watchers = self
                .watchers
                .lock()
                .map_err(|_| GazeError::Message("文件监听表锁已损坏。".to_string()))?;
            watchers.insert(project.id.clone(), watcher);
        }

        tokio::spawn(async move {
            while let Some(events) = receive_batch(&mut receiver, &overflow).await {
                if events.overflow {
                    tracing::warn!(project = %project.name, "file watcher overflowed; refreshing the whole project");
                }
                if let Err(error) = flush_events(
                    &app,
                    &project,
                    &cache,
                    &path_index,
                    &symbols,
                    ctags.as_deref(),
                    events,
                )
                .await
                {
                    tracing::warn!(project = %project.name, %error, "failed to apply filesystem changes");
                }
            }
        });
        Ok(())
    }

    pub fn stop(&self, project_id: &str) {
        if let Ok(mut watchers) = self.watchers.lock() {
            watchers.remove(project_id);
        }
    }

    pub fn start_file(&self, app: AppHandle, project: Project, relative: String) -> GazeResult<()> {
        let key = format!("{}\0{relative}", project.id);
        let mut watchers = self
            .watchers
            .lock()
            .map_err(|_| GazeError::Message("文件监听表锁已损坏。".into()))?;
        if watchers.contains_key(&key) {
            return Ok(());
        }
        let (sender, mut receiver, overflow) = watcher_channel();
        let callback_overflow = Arc::clone(&overflow);
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                offer_event(&sender, event, &callback_overflow);
            })
            .map_err(|error| GazeError::Message(format!("无法创建文件监听器：{error}")))?;
        // Watch the parent so atomic saves replacing the file keep being observed.
        watcher
            .watch(Path::new(&project.root), RecursiveMode::NonRecursive)
            .map_err(|error| GazeError::Message(format!("无法监听文件：{error}")))?;
        watchers.insert(key, watcher);
        tokio::spawn(async move {
            while let Some(events) = receive_batch(&mut receiver, &overflow).await {
                if let Some(event) = file_event(&project, &relative, events) {
                    let _ = app.emit("gaze://fs-change", event);
                }
            }
        });
        Ok(())
    }

    pub fn stop_file(&self, project_id: &str, relative: &str) {
        self.stop(&format!("{project_id}\0{relative}"));
    }

    pub fn stop_all(&self) {
        if let Ok(mut watchers) = self.watchers.lock() {
            watchers.clear();
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn flush_events(
    app: &AppHandle,
    project: &Project,
    cache: &Cache,
    path_index: &Arc<PathIndex>,
    symbols: &Arc<SymbolService>,
    ctags: Option<&Path>,
    events: EventBatch,
) -> GazeResult<()> {
    if events.overflow {
        return flush_overflow(app, project, cache, path_index, symbols, ctags).await;
    }
    let root = Path::new(&project.root);
    let mut paths = HashSet::new();
    for path in events.paths {
        let Ok(relative) = path_to_relative(root, &path) else {
            continue;
        };
        if relative.is_empty()
            || relative == ".DS_Store"
            || relative.split('/').any(|part| part == ".git")
            || relative
                .rsplit('/')
                .next()
                .is_some_and(is_internal_temp_name)
        {
            continue;
        }
        paths.insert(relative);
    }
    if paths.is_empty() {
        return Ok(());
    }

    path_index.wait_for_index(&project.id).await;

    let mut rescan_ignore_rules = false;
    for relative in &paths {
        let name = relative.rsplit('/').next().unwrap_or(relative);
        if name == ".gitignore" || name == ".ignore" {
            rescan_ignore_rules = true;
        }
    }
    let paths_vec: Vec<String> = paths.into_iter().collect();
    let root_for_scan = root.to_path_buf();
    let classifications = tokio::task::spawn_blocking(move || {
        let mut ignores = IgnoreCache::new(&root_for_scan);
        paths_vec
            .into_iter()
            .map(|relative| {
                let absolute = root_for_scan.join(&relative);
                let kind = std::fs::symlink_metadata(&absolute)
                    .ok()
                    .map(|metadata| metadata.is_dir());
                let ignored =
                    is_ignored(&absolute, kind.unwrap_or(false), &mut ignores).unwrap_or(false);
                (relative, kind, ignored)
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(GazeError::Join)?;

    let mut changed_files = Vec::new();
    let mut changed_directories = HashSet::new();
    let mut removed_paths = Vec::new();
    let mut changes = Vec::new();
    for (relative, kind, ignored) in classifications {
        if let Some(parent) = relative.rsplit_once('/').map(|(parent, _)| parent) {
            changed_directories.insert(parent.to_string());
        }
        match kind {
            Some(true) => {
                changed_directories.insert(relative.clone());
            }
            Some(false) => changed_files.push(relative.clone()),
            None => removed_paths.push(relative.clone()),
        };
        if !ignored {
            changes.push(match kind {
                Some(true) => PathChange::Directory(relative),
                Some(false) => PathChange::File(relative),
                None => PathChange::Removed(relative),
            });
        }
    }

    let path_result = if rescan_ignore_rules {
        Arc::clone(path_index)
            .index_project(app.clone(), cache.clone(), project.clone())
            .await
    } else {
        path_index
            .apply_changes(cache, project, changes.clone())
            .await
    };
    if let Err(error) = path_result {
        tracing::warn!(project = %project.name, %error, "failed to update the path index");
    }

    if update_symbol_cache(cache, project, &changes).await? || rescan_ignore_rules {
        symbols.invalidate(&project.id);
        if let Some(ctags) = ctags {
            let symbols = Arc::clone(symbols);
            let cache = cache.clone();
            let app = app.clone();
            let project = project.clone();
            let ctags = ctags.to_path_buf();
            tokio::spawn(async move {
                if let Err(error) = symbols
                    .ensure_project_index(app, cache, ctags, project)
                    .await
                {
                    if !matches!(error, GazeError::Cancelled) {
                        tracing::warn!(%error, "failed to refresh symbols after file changes");
                    }
                }
            });
        }
    }

    changed_files.sort();
    changed_files.dedup();
    removed_paths.sort();
    removed_paths.dedup();
    let mut changed_directories: Vec<String> = changed_directories.into_iter().collect();
    changed_directories.sort();

    let event = FsChangeEvent {
        project_id: project.id.clone(),
        rescan: false,
        changed_files,
        changed_directories,
        removed_paths,
    };
    let _ = app.emit("gaze://fs-change", event);
    Ok(())
}

async fn flush_overflow(
    app: &AppHandle,
    project: &Project,
    cache: &Cache,
    path_index: &Arc<PathIndex>,
    symbols: &Arc<SymbolService>,
    ctags: Option<&Path>,
) -> GazeResult<()> {
    path_index.wait_for_index(&project.id).await;
    let previous_paths: HashSet<String> = cache
        .cached_files(&project.id)
        .await?
        .into_iter()
        .map(|file| file.rel_path)
        .collect();
    let path_result = Arc::clone(path_index)
        .index_project(app.clone(), cache.clone(), project.clone())
        .await;
    if let Err(error) = path_result {
        tracing::warn!(project = %project.name, %error, "failed to refresh the path index after watcher overflow");
    }
    let current_paths: HashSet<String> = cache
        .cached_files(&project.id)
        .await?
        .into_iter()
        .map(|file| file.rel_path)
        .collect();

    symbols.invalidate(&project.id);
    if let Some(ctags) = ctags {
        let symbols = Arc::clone(symbols);
        let cache = cache.clone();
        let app = app.clone();
        let project = project.clone();
        let ctags = ctags.to_path_buf();
        tokio::spawn(async move {
            if let Err(error) = symbols
                .ensure_project_index(app, cache, ctags, project)
                .await
            {
                if !matches!(error, GazeError::Cancelled) {
                    tracing::warn!(%error, "failed to refresh symbols after watcher overflow");
                }
            }
        });
    }

    let _ = app.emit(
        "gaze://fs-change",
        overflow_change_event(&project.id, &previous_paths, &current_paths),
    );
    Ok(())
}

fn overflow_change_event(
    project_id: &str,
    previous_paths: &HashSet<String>,
    current_paths: &HashSet<String>,
) -> FsChangeEvent {
    let mut changed_files: Vec<String> = current_paths.iter().cloned().collect();
    let mut removed_paths: Vec<String> =
        previous_paths.difference(current_paths).cloned().collect();
    changed_files.sort();
    removed_paths.sort();
    FsChangeEvent {
        project_id: project_id.to_string(),
        rescan: true,
        changed_files,
        changed_directories: vec![String::new()],
        removed_paths,
    }
}

async fn update_symbol_cache(
    cache: &Cache,
    project: &Project,
    changes: &[PathChange],
) -> GazeResult<bool> {
    let mut refresh = false;
    let mut directories = Vec::new();
    for change in changes {
        match change {
            PathChange::File(path) | PathChange::Removed(path) => {
                cache.remove_symbols_under(&project.id, path).await?;
                refresh = true;
            }
            PathChange::Directory(path) => directories.push(format!("{path}/")),
        }
    }
    if refresh || directories.is_empty() {
        return Ok(refresh);
    }
    // A directory notification can discover new files without changing existing symbols.
    let files = cache.cached_files(&project.id).await?;
    let existing = cache.symbol_file_fingerprints(&project.id).await?;
    Ok(files.iter().any(|file| {
        directories
            .iter()
            .any(|prefix| file.rel_path.starts_with(prefix))
            && existing.get(&file.rel_path) != Some(&file.fingerprint)
    }))
}

fn is_relevant_kind(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Any
            | EventKind::Create(_)
            | EventKind::Modify(_)
            | EventKind::Remove(_)
            | EventKind::Other
    ) || matches!(
        kind,
        EventKind::Access(notify::event::AccessKind::Close(
            notify::event::AccessMode::Write
        ))
    )
}

fn file_event(project: &Project, relative: &str, events: EventBatch) -> Option<FsChangeEvent> {
    let absolute = Path::new(&project.root).join(relative);
    let changed = events.overflow || events.paths.iter().any(|path| absolute.starts_with(path));
    if !changed {
        return None;
    }
    let exists = absolute.is_file();
    Some(FsChangeEvent {
        project_id: project.id.clone(),
        rescan: false,
        changed_files: if exists {
            vec![relative.into()]
        } else {
            vec![]
        },
        changed_directories: vec![],
        removed_paths: if exists {
            vec![]
        } else {
            vec![relative.into()]
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn directory_notifications_preserve_symbols_and_only_refresh_new_or_changed_files() {
        use crate::cache::{CachedFile, CachedSymbol};
        use crate::models::FileFingerprint;
        let cache = Cache::open_in_memory().unwrap();
        let project = Project {
            id: "p".into(),
            name: "Demo".into(),
            root: "/demo".into(),
        };
        cache.insert_project(&project).await.unwrap();
        let file = CachedFile {
            rel_path: "src/a.ts".into(),
            fingerprint: FileFingerprint {
                size: 1,
                modified_ns: 1,
            },
        };
        cache.upsert_file(&project.id, &file).await.unwrap();
        let symbol = CachedSymbol {
            path: file.rel_path.clone(),
            name: "value".into(),
            kind: "variable".into(),
            line: 0,
            character: 0,
            scope: None,
            signature: None,
        };
        cache
            .replace_symbols_for_file(&project.id, &file.rel_path, &file, &[symbol])
            .await
            .unwrap();
        let directories = [PathChange::Directory("src".into())];
        assert!(!update_symbol_cache(&cache, &project, &directories)
            .await
            .unwrap());
        assert_eq!(
            cache.symbols_for_project(&project.id).await.unwrap().len(),
            1
        );
        assert!(
            !update_symbol_cache(&cache, &project, &[PathChange::Directory("empty".into())])
                .await
                .unwrap()
        );
        assert!(!update_symbol_cache(&cache, &project, &[]).await.unwrap());
        let added = CachedFile {
            rel_path: "src/b.ts".into(),
            fingerprint: file.fingerprint,
        };
        cache.upsert_file(&project.id, &added).await.unwrap();
        assert!(update_symbol_cache(&cache, &project, &directories)
            .await
            .unwrap());
        assert_eq!(
            cache.symbols_for_project(&project.id).await.unwrap().len(),
            1
        );
        assert!(
            update_symbol_cache(&cache, &project, &[PathChange::Removed("src".into())])
                .await
                .unwrap()
        );
        assert!(cache
            .symbols_for_project(&project.id)
            .await
            .unwrap()
            .is_empty());
        assert!(cache
            .symbol_file_fingerprints(&project.id)
            .await
            .unwrap()
            .is_empty());
    }

    #[test]
    fn read_close_is_not_a_workspace_change_but_write_close_is() {
        assert!(!is_relevant_kind(&EventKind::Access(
            notify::event::AccessKind::Close(notify::event::AccessMode::Read),
        )));
        assert!(is_relevant_kind(&EventKind::Access(
            notify::event::AccessKind::Close(notify::event::AccessMode::Write),
        )));
    }

    #[tokio::test]
    async fn watcher_queue_is_bounded_and_flags_overflow() {
        let (sender, receiver, overflow) = watcher_channel();
        for _ in 0..WATCH_QUEUE_CAPACITY {
            offer_event(&sender, Ok(notify::Event::new(EventKind::Any)), &overflow);
        }
        assert_eq!(receiver.len(), WATCH_QUEUE_CAPACITY);
        assert!(!overflow.load(Ordering::Acquire));

        offer_event(&sender, Ok(notify::Event::new(EventKind::Any)), &overflow);
        assert_eq!(receiver.len(), WATCH_QUEUE_CAPACITY);
        assert!(overflow.load(Ordering::Acquire));
    }

    #[test]
    fn event_batch_deduplicates_paths_and_caps_unique_paths() {
        let mut batch = EventBatch::default();
        for _ in 0..4 {
            batch.push(Ok(
                notify::Event::new(EventKind::Any).add_path("/root/repeated".into())
            ));
        }
        assert_eq!(batch.paths.len(), 1);
        assert!(!batch.overflow);

        for index in 0..MAX_BATCH_PATHS + 32 {
            batch.push(Ok(notify::Event::new(EventKind::Any)
                .add_path(PathBuf::from(format!("/root/{index}")))));
        }
        assert_eq!(batch.paths.len(), MAX_BATCH_PATHS);
        assert!(batch.overflow);
    }

    #[test]
    fn overflow_notification_conservatively_covers_current_and_removed_files() {
        let previous: HashSet<String> = ["a.ts".to_string(), "gone.ts".to_string()].into();
        let current: HashSet<String> = ["a.ts".to_string(), "new.ts".to_string()].into();
        let event = overflow_change_event("p", &previous, &current);
        assert_eq!(event.project_id, "p");
        assert!(event.rescan);
        assert_eq!(event.changed_files, ["a.ts", "new.ts"]);
        assert_eq!(event.changed_directories, [""]);
        assert_eq!(event.removed_paths, ["gone.ts"]);
    }

    #[test]
    fn file_watch_filters_siblings_and_observes_replacement_and_removal() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let project = Project {
            id: "external:test".into(),
            name: "test".into(),
            root: root.to_str().unwrap().into(),
        };
        let event = |path: PathBuf| {
            let mut batch = EventBatch::default();
            batch.push(Ok(notify::Event::new(EventKind::Any).add_path(path)));
            batch
        };
        std::fs::write(root.join("a.txt"), "original").unwrap();
        assert!(file_event(&project, "a.txt", event(root.join("b.txt"))).is_none());
        std::fs::write(root.join("new.txt"), "replacement").unwrap();
        std::fs::rename(root.join("new.txt"), root.join("a.txt")).unwrap();
        assert_eq!(
            file_event(&project, "a.txt", event(root.join("a.txt")))
                .unwrap()
                .changed_files,
            ["a.txt"]
        );
        std::fs::remove_file(root.join("a.txt")).unwrap();
        assert_eq!(
            file_event(&project, "a.txt", event(root.join("a.txt")))
                .unwrap()
                .removed_paths,
            ["a.txt"]
        );
        let overflow = EventBatch {
            overflow: true,
            ..EventBatch::default()
        };
        assert_eq!(
            file_event(&project, "a.txt", overflow)
                .unwrap()
                .removed_paths,
            ["a.txt"]
        );
    }
}
