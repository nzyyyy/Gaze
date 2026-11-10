//! GitDock's Git engine, bound to Gaze projects rather than a second repository store.
#![allow(dead_code)]

pub(crate) mod git;
pub(crate) mod history;
pub(crate) mod models;
pub(crate) mod operations;
pub(crate) mod process;
pub(crate) mod repository_path;
#[cfg(test)]
mod store;
pub(crate) mod summary;
#[cfg(test)]
mod test_util;
pub(crate) mod working_tree;

use git::Git;
use models::*;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct Registry {
    records: HashMap<RepositoryId, RepositoryRecord>,
    projects: HashMap<String, RepositoryId>,
    common_dirs: HashMap<RepositoryId, PathBuf>,
}

#[derive(Default)]
struct WriteLocks {
    operations: HashMap<PathBuf, bool>,
    editors: HashSet<PathBuf>,
}

pub struct AppState {
    cache: crate::cache::Cache,
    registry: Mutex<Registry>,
    git: Mutex<Result<Git, String>>,
    git_path: Option<String>,
    working_tree: Mutex<working_tree::Cache>,
    next_repository_id: AtomicU64,
    next_snapshot_id: AtomicU64,
    next_operation_id: AtomicU64,
    write_locks: Mutex<WriteLocks>,
    mutating_repositories: Mutex<HashSet<RepositoryId>>,
    running: Mutex<HashMap<OperationId, process::RunningOperation>>,
    watchers: Mutex<HashMap<RepositoryId, RecommendedWatcher>>,
    #[cfg(test)]
    store: Mutex<store::ConfigStore>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepositoryChanged {
    repository_id: RepositoryId,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitContext {
    git: GitInfo,
    repository: Option<RepositorySummary>,
    project_prefix: String,
    error: Option<String>,
}

impl AppState {
    pub fn new(cache: crate::cache::Cache, git_path: Option<&str>) -> Self {
        Self {
            cache,
            registry: Mutex::new(Registry::default()),
            git: Mutex::new(Git::discover(git_path)),
            git_path: git_path.map(str::to_string),
            working_tree: Mutex::new(working_tree::Cache::default()),
            next_repository_id: AtomicU64::new(1),
            next_snapshot_id: AtomicU64::new(1),
            next_operation_id: AtomicU64::new(1),
            write_locks: Mutex::new(WriteLocks::default()),
            mutating_repositories: Mutex::new(HashSet::new()),
            running: Mutex::new(HashMap::new()),
            watchers: Mutex::new(HashMap::new()),
            #[cfg(test)]
            store: Mutex::new(
                store::ConfigStore::load(
                    std::env::temp_dir()
                        .join(format!("gaze-git-test-{}.json", uuid::Uuid::new_v4())),
                )
                .unwrap(),
            ),
        }
    }

    fn git(&self) -> Result<Git, String> {
        let mut git = self
            .git
            .lock()
            .map_err(|_| "Git state is unavailable".to_string())?;
        if git.is_err() {
            *git = Git::discover(self.git_path.as_deref());
        }
        git.clone()
    }

    fn record(&self, id: RepositoryId) -> Result<RepositoryRecord, String> {
        let projects = self.cache.projects_blocking().map_err(|e| e.to_string())?;
        let registry = self
            .registry
            .lock()
            .map_err(|_| "Repository registry is busy")?;
        if projects
            .iter()
            .any(|project| registry.projects.get(&project.id) == Some(&id))
        {
            return registry
                .records
                .get(&id)
                .cloned()
                .ok_or_else(|| "Repository is unavailable".into());
        }
        #[cfg(test)]
        if let Some(record) = self
            .store
            .lock()
            .unwrap()
            .config()
            .repositories
            .iter()
            .find(|r| r.id == id)
        {
            return Ok(record.clone());
        }
        Err("Repository is no longer attached to a Gaze project".into())
    }

    fn attach(
        &self,
        project: &crate::models::Project,
        inspection: &git::RepositoryInspection,
    ) -> Result<RepositoryRecord, String> {
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| "Repository registry is busy")?;
        let path = inspection
            .root
            .to_str()
            .ok_or("Repository path is not Unicode")?;
        let existing = registry
            .records
            .values()
            .find(|record| record.path == path)
            .cloned();
        let record = existing.unwrap_or_else(|| RepositoryRecord {
            id: self.next_repository_id.fetch_add(1, Ordering::Relaxed),
            path: path.into(),
            name: git::path_name(&inspection.root),
            group: None,
            favorite: false,
            order: 0,
        });
        registry.projects.insert(project.id.clone(), record.id);
        registry
            .common_dirs
            .insert(record.id, inspection.common_git_dir.clone());
        registry.records.insert(record.id, record.clone());
        Ok(record)
    }

    pub fn editor_guard(&self, root: &Path) -> Result<EditorWriteGuard<'_>, String> {
        let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let root = canonical.as_path();
        let registry = self
            .registry
            .lock()
            .map_err(|_| "Repository registry is busy")?;
        let paths: HashSet<_> = registry
            .records
            .values()
            .filter(|record| {
                root.starts_with(&record.path) || Path::new(&record.path).starts_with(root)
            })
            .filter_map(|record| registry.common_dirs.get(&record.id).cloned())
            .collect();
        drop(registry);
        let mut locks = self
            .write_locks
            .lock()
            .map_err(|_| "Repository lock is busy")?;
        if paths
            .iter()
            .any(|path| locks.editors.contains(path) || locks.operations.get(path) == Some(&true))
        {
            return Err("Git 操作进行中，请稍后保存或修改文件。".into());
        }
        locks.editors.extend(paths.iter().cloned());
        Ok(EditorWriteGuard { state: self, paths })
    }

    fn watch(
        &self,
        id: RepositoryId,
        inspection: &git::RepositoryInspection,
        app: &AppHandle,
    ) -> Result<(), String> {
        let mut watchers = self.watchers.lock().map_err(|_| "Git watcher is busy")?;
        if watchers.contains_key(&id) {
            return Ok(());
        }
        let (send, recv) = mpsc::channel();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if event.is_ok_and(|event| !matches!(event.kind, EventKind::Access(_))) {
                    let _ = send.send(());
                }
            })
            .map_err(|e| e.to_string())?;
        let mut paths = vec![inspection.root.clone()];
        for path in [&inspection.git_dir, &inspection.common_git_dir] {
            if !paths.iter().any(|root| path.starts_with(root)) {
                paths.push(path.clone());
            }
        }
        for path in paths {
            watcher
                .watch(&path, RecursiveMode::Recursive)
                .map_err(|e| e.to_string())?;
        }
        let app = app.clone();
        std::thread::spawn(move || {
            while recv.recv().is_ok() {
                let start = Instant::now();
                while start.elapsed() < Duration::from_secs(1)
                    && recv.recv_timeout(Duration::from_millis(300)).is_ok()
                {}
                let state = app.state::<AppState>();
                if state.record(id).is_err() {
                    break;
                }
                if state
                    .mutating_repositories
                    .lock()
                    .is_ok_and(|ids| ids.contains(&id))
                {
                    continue;
                }
                working_tree::invalidate_repository(&state, id);
                let _ = app.emit(
                    "repository-changed",
                    RepositoryChanged { repository_id: id },
                );
            }
        });
        watchers.insert(id, watcher);
        Ok(())
    }

    fn validate_trash_targets(&self, root: &Path, paths: &[String]) -> Result<(), String> {
        let projects = self
            .cache
            .projects_blocking()
            .map_err(|error| error.to_string())?;
        for path in paths {
            let target = repository_path::trash_target(root, path)?;
            if projects.iter().any(|project| {
                Path::new(&project.root)
                    .canonicalize()
                    .unwrap_or_else(|_| PathBuf::from(&project.root))
                    .starts_with(&target)
            }) {
                return Err(
                    "无法删除已导入的项目根目录或其父目录，请先从工作区移除该项目。".into(),
                );
            }
        }
        Ok(())
    }

    pub fn detach(&self, project_id: &str) {
        let Ok(mut registry) = self.registry.lock() else {
            return;
        };
        let Some(id) = registry.projects.remove(project_id) else {
            return;
        };
        if registry.projects.values().any(|value| *value == id) {
            return;
        }
        registry.records.remove(&id);
        registry.common_dirs.remove(&id);
        if let Ok(mut watchers) = self.watchers.lock() {
            watchers.remove(&id);
        }
        working_tree::invalidate_repository(self, id);
    }

    pub fn stop(&self) {
        if let Ok(running) = self.running.lock() {
            for operation in running.values() {
                let _ = process::terminate_process_group(operation.pid);
            }
        }
        if let Ok(mut watchers) = self.watchers.lock() {
            watchers.clear();
        }
    }
}

pub struct EditorWriteGuard<'a> {
    state: &'a AppState,
    paths: HashSet<PathBuf>,
}
impl Drop for EditorWriteGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut locks) = self.state.write_locks.lock() {
            for path in &self.paths {
                locks.editors.remove(path);
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn git_context(
    project_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<GitContext, String> {
    let project = state
        .cache
        .projects()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|project| project.id == project_id)
        .ok_or("项目已从工作区移除。")?;
    let app_clone = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_clone.state::<AppState>();
        let result = state.git();
        let info = Git::info(&result);
        let git = match result {
            Ok(git) => git,
            Err(error) => {
                return Ok(GitContext {
                    git: info,
                    repository: None,
                    project_prefix: String::new(),
                    error: Some(error),
                })
            }
        };
        let inspection = match git.inspect_repository(Path::new(&project.root)) {
            Ok(inspection) => inspection,
            Err(error) => {
                return Ok(GitContext {
                    git: info,
                    repository: None,
                    project_prefix: String::new(),
                    error: Some(format!("该项目不是可用的 Git 仓库：{error}")),
                })
            }
        };
        let prefix = Path::new(&project.root)
            .strip_prefix(&inspection.root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let record = state.attach(&project, &inspection)?;
        state.watch(record.id, &inspection, &app_clone)?;
        Ok(GitContext {
            git: info,
            repository: Some(summary::repository_summary(&git, &record)),
            project_prefix: prefix,
            error: None,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn reconcile_gaze(app: &AppHandle, repository_id: RepositoryId) {
    let git_state = app.state::<AppState>();
    let Ok(record) = git_state.record(repository_id) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::block_on(async move {
        let state = app.state::<crate::AppState>();
        let Ok(projects) = state.cache.projects().await else {
            return;
        };
        let affected: Vec<_> = projects
            .into_iter()
            .filter(|p| {
                Path::new(&p.root).starts_with(&record.path)
                    || Path::new(&record.path).starts_with(&p.root)
            })
            .collect();
        for project in &affected {
            state.symbols.invalidate(&project.id);
            state.lsp.forget_documents(Path::new(&project.root)).await;
        }
        state.start_path_index(&app, affected, None);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use test_util::init_repo;

    #[tokio::test]
    async fn projects_in_one_worktree_share_identity_and_removed_projects_lose_access() {
        let dir = tempfile::tempdir().unwrap();
        let git = Git::discover(None).unwrap();
        init_repo(&git, dir.path());
        let cache = crate::cache::Cache::open_in_memory().unwrap();
        let a = crate::models::Project {
            id: "a".into(),
            name: "a".into(),
            root: dir.path().to_str().unwrap().into(),
        };
        let b = crate::models::Project {
            id: "b".into(),
            name: "b".into(),
            root: dir.path().join("src").to_str().unwrap().into(),
        };
        std::fs::create_dir(dir.path().join("src")).unwrap();
        cache.insert_project(&a).await.unwrap();
        cache.insert_project(&b).await.unwrap();
        let state = AppState::new(cache.clone(), None);
        let inspection = git.inspect_repository(dir.path()).unwrap();
        let one = state.attach(&a, &inspection).unwrap();
        let two = state.attach(&b, &inspection).unwrap();
        assert_eq!(one.id, two.id);
        assert!(state
            .validate_trash_targets(&inspection.root, &["src".into()])
            .is_err());
        assert!(state
            .validate_trash_targets(&inspection.root, &["src/file.ts".into()])
            .is_ok());
        let lock = state.editor_guard(Path::new(&a.root)).unwrap();
        assert!(process::acquire_lock(&state, &inspection.common_git_dir, true).is_err());
        drop(lock);
        process::acquire_lock(&state, &inspection.common_git_dir, true).unwrap();
        assert!(state.editor_guard(Path::new(&b.root)).is_err());
        process::release_lock(&state, &inspection.common_git_dir);
        process::acquire_lock(&state, &inspection.common_git_dir, false).unwrap();
        let editor = state.editor_guard(Path::new(&b.root)).unwrap();
        assert!(process::acquire_lock(&state, &inspection.common_git_dir, false).is_err());
        drop(editor);
        assert!(process::acquire_lock(&state, &inspection.common_git_dir, true).is_err());
        let editor = state.editor_guard(Path::new(&a.root)).unwrap();
        process::release_lock(&state, &inspection.common_git_dir);
        assert!(process::acquire_lock(&state, &inspection.common_git_dir, true).is_err());
        drop(editor);
        process::acquire_lock(&state, &inspection.common_git_dir, true).unwrap();
        let unrelated = tempfile::tempdir().unwrap();
        assert!(state.editor_guard(unrelated.path()).is_ok());
        process::release_lock(&state, &inspection.common_git_dir);
        cache.delete_project("a").await.unwrap();
        assert!(state.record(one.id).is_ok());
        cache.delete_project("b").await.unwrap();
        assert!(state.record(one.id).is_err());
    }
}
