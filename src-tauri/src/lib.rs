mod cache;
mod color_schemes;
mod config;
mod error;
mod external_files;
mod files;
mod fonts;
mod git_workspace;
mod lsp;
mod markdown;
mod models;
mod native_files;
mod native_menu;
mod path_index;
mod preferences;
mod recovery;
mod replace;
mod search;
mod symbols;
mod terminal;
mod tools;
mod watcher;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use cache::Cache;
use config::AppConfig;
use error::{CommandError, GazeError, GazeResult};
use lsp::LspManager;
use models::{
    DirEntry, DirectoryListing, FileContent, FileFingerprint, LineEnding, NavigationResult,
    OutlineResult, Project, SymbolSearchResult, TextEncodingKind, TextPosition, WorkspaceSnapshot,
    WriteResult,
};
use path_index::{PathIndex, PathIndexStatus, PathSearchResponse};
use search::SearchService;
use symbols::{SymbolIndexStatus, SymbolService};
use terminal::{TerminalManager, TerminalSessionInfo};
use tools::{ToolCapabilities, Tools};
use watcher::WatcherService;

pub struct AppState {
    cache: Cache,
    tools: Tools,
    path_index: Arc<PathIndex>,
    search_service: SearchService,
    symbols: Arc<SymbolService>,
    lsp: Arc<LspManager>,
    watchers: WatcherService,
    terminal: TerminalManager,
    background_started: AtomicBool,
    external_files: external_files::ExternalFiles,
    recovery: recovery::RecoveryStore,
    replace_previews: replace::ReplacePreviewService,
    replace_lock: tokio::sync::Mutex<()>,
}

impl AppState {
    fn load(app: &tauri::App) -> Result<Self, Box<dyn std::error::Error>> {
        let data_dir = app.path().app_data_dir()?;
        let config_dir = app.path().app_config_dir()?;
        std::fs::create_dir_all(&data_dir)?;
        std::fs::create_dir_all(config_dir.join("logs"))?;
        let log_dir = config_dir.join("logs");
        let file_appender = tracing_appender::rolling::daily(log_dir, "gaze.log");
        let filter = tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("gaze_lib=info,warn"));
        let _ = tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_ansi(false)
            .with_writer(file_appender)
            .try_init();

        let cache = Cache::open(&data_dir.join("gaze.sqlite3"))?;
        let config_path = config_dir.join("config.json");
        let (config, config_error) = match AppConfig::load(&config_path) {
            Ok(config) => (config, None),
            Err(error) => {
                tracing::warn!(%error, path = %config_path.display(), "failed to load configuration");
                (AppConfig::default(), Some(error.message()))
            }
        };
        let tools = Tools::detect(&config);
        let mut tools = tools;
        if let Some(error) = config_error {
            tools.config_message = Some(format!(
                "配置文件读取失败，自定义工具和 LSP 设置未生效：{error}"
            ));
        }
        let lsp = Arc::new(LspManager::new(&tools));
        app.manage(git_workspace::AppState::new(
            cache.clone(),
            config.tools.git.as_deref().and_then(Path::to_str),
        ));
        app.manage(replace::ReplaceUndoService::new(
            data_dir.join("replace-backups"),
        )?);
        Ok(Self {
            cache,
            tools,
            path_index: Arc::new(PathIndex::new()),
            search_service: SearchService::new(),
            symbols: Arc::new(SymbolService::new()),
            lsp,
            watchers: WatcherService::new(),
            terminal: TerminalManager::default(),
            background_started: AtomicBool::new(false),
            external_files: external_files::ExternalFiles::default(),
            recovery: recovery::RecoveryStore::new(data_dir.join("recovery")),
            replace_previews: replace::ReplacePreviewService::default(),
            replace_lock: tokio::sync::Mutex::new(()),
        })
    }

    async fn project(&self, project_id: &str) -> GazeResult<Project> {
        self.cache
            .projects()
            .await?
            .into_iter()
            .find(|project| project.id == project_id)
            .ok_or_else(|| GazeError::NotFound("项目已从工作区移除。".to_string()))
    }

    async fn file_project(&self, project_id: &str, path: &str) -> GazeResult<Project> {
        if project_id.starts_with("external:") {
            self.external_files.project(project_id, path)
        } else {
            self.project(project_id).await
        }
    }

    async fn snapshot(&self) -> GazeResult<WorkspaceSnapshot> {
        let projects = self.cache.projects().await?;
        let mut active_project_id = self.cache.setting("active_project").await?;
        if active_project_id.as_deref() == Some("") {
            active_project_id = None;
        }
        if active_project_id
            .as_ref()
            .is_some_and(|id| !projects.iter().any(|project| &project.id == id))
        {
            active_project_id = None;
        }
        let theme = self
            .cache
            .setting("theme")
            .await?
            .unwrap_or_else(|| "system".to_string());
        Ok(WorkspaceSnapshot {
            projects,
            active_project_id,
            theme,
            preferences: self
                .cache
                .setting("preferences")
                .await?
                .and_then(|value| serde_json::from_str::<preferences::Preferences>(&value).ok())
                .filter(|value| value.validate().is_ok())
                .unwrap_or_default(),
            color_schemes: self
                .cache
                .setting("color_schemes")
                .await?
                .and_then(|value| serde_json::from_str(&value).ok())
                .unwrap_or_default(),
            fonts: self
                .cache
                .setting("fonts")
                .await?
                .and_then(|value| serde_json::from_str(&value).ok())
                .unwrap_or_default(),
        })
    }

    fn start_path_index(
        &self,
        app: &AppHandle,
        projects: Vec<Project>,
        symbol_project_id: Option<String>,
    ) {
        let mut ordered = Vec::new();
        let mut ordered_ids = std::collections::HashSet::new();
        if let Some(active) = symbol_project_id.as_deref() {
            if let Some(index) = projects.iter().position(|project| project.id == active) {
                ordered.push(projects[index].clone());
                ordered_ids.insert(projects[index].id.clone());
            }
        }
        for project in projects {
            if ordered_ids.insert(project.id.clone()) {
                ordered.push(project);
            }
        }
        let index = Arc::clone(&self.path_index);
        let symbols = Arc::clone(&self.symbols);
        let cache = self.cache.clone();
        let ctags = self.tools.ctags.clone();
        let app = app.clone();
        tokio::spawn(async move {
            for project in ordered {
                let path_ready = match Arc::clone(&index)
                    .index_project(app.clone(), cache.clone(), project.clone())
                    .await
                {
                    Ok(()) => true,
                    Err(error) => {
                        if !matches!(error, GazeError::Cancelled) {
                            tracing::warn!(%error, "path indexing task ended with an error");
                        }
                        false
                    }
                };
                if path_ready
                    && symbol_project_id.as_deref() == Some(project.id.as_str())
                    && ctags.is_some()
                {
                    let ctags = ctags.clone().expect("ctags checked above");
                    if let Err(error) = symbols
                        .ensure_project_index(app.clone(), cache.clone(), ctags, project.clone())
                        .await
                    {
                        if !matches!(error, GazeError::Cancelled) {
                            tracing::warn!(%error, "symbol indexing task ended with an error");
                        }
                    }
                }
            }
        });
    }

    fn ensure_active_indexing(&self, app: &AppHandle, project: Project) {
        if self.path_index.has_project(&project.id) && !self.path_index.is_indexing(&project.id) {
            if let Some(ctags) = self.tools.ctags.clone() {
                let symbols = Arc::clone(&self.symbols);
                let cache = self.cache.clone();
                let app = app.clone();
                tokio::spawn(async move {
                    if let Err(error) = symbols
                        .ensure_project_index(app, cache, ctags, project)
                        .await
                    {
                        if !matches!(error, GazeError::Cancelled) {
                            tracing::warn!(%error, "symbol indexing task ended with an error");
                        }
                    }
                });
            }
        } else {
            let project_id = project.id.clone();
            self.start_path_index(app, vec![project], Some(project_id));
        }
    }

    fn watch_projects(&self, app: &AppHandle, projects: &[Project]) {
        for project in projects {
            if let Err(error) = self.watchers.start(
                app.clone(),
                project.clone(),
                self.cache.clone(),
                Arc::clone(&self.path_index),
                Arc::clone(&self.symbols),
                self.tools.ctags.clone(),
            ) {
                tracing::warn!(project = %project.name, %error, "failed to start project watcher");
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportFailure {
    path: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResult {
    projects: Vec<Project>,
    failures: Vec<ImportFailure>,
}

#[tauri::command(rename_all = "camelCase")]
async fn bootstrap_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<WorkspaceSnapshot, CommandError> {
    let snapshot = state.snapshot().await.map_err(CommandError::from)?;
    state
        .path_index
        .load_cached(&state.cache, &snapshot.projects)
        .await
        .map_err(CommandError::from)?;
    if !state.background_started.swap(true, Ordering::SeqCst) {
        state.watch_projects(&app, &snapshot.projects);
        state.start_path_index(
            &app,
            snapshot.projects.clone(),
            snapshot.active_project_id.clone(),
        );
    }
    Ok(snapshot)
}

#[tauri::command(rename_all = "camelCase")]
async fn import_projects(
    paths: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ImportResult, CommandError> {
    let existing = state.cache.projects().await.map_err(CommandError::from)?;
    let mut imported = Vec::new();
    let mut failures = Vec::new();
    for raw_path in paths {
        match canonical_project_path(Path::new(&raw_path)) {
            Ok(root) => {
                if existing.iter().any(|project| project.root == root) {
                    failures.push(ImportFailure {
                        path: raw_path,
                        message: "该项目已在工作区中。".to_string(),
                    });
                    continue;
                }
                let name = Path::new(&root)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .filter(|name| !name.is_empty())
                    .unwrap_or("未命名项目")
                    .to_string();
                let project = Project {
                    id: Uuid::new_v4().to_string(),
                    name,
                    root,
                };
                match state.cache.insert_project(&project).await {
                    Ok(()) => imported.push(project),
                    Err(error) => failures.push(ImportFailure {
                        path: raw_path,
                        message: error.message(),
                    }),
                }
            }
            Err(error) => failures.push(ImportFailure {
                path: raw_path,
                message: error.message(),
            }),
        }
    }
    let active_before = state
        .cache
        .setting("active_project")
        .await
        .ok()
        .flatten()
        .filter(|value| !value.is_empty());
    if active_before.is_none() {
        if let Some(first) = imported.first() {
            let _ = state.cache.set_setting("active_project", &first.id).await;
        }
    }
    let active_after = state
        .cache
        .setting("active_project")
        .await
        .ok()
        .flatten()
        .filter(|value| !value.is_empty());
    if !imported.is_empty() {
        state.watch_projects(&app, &imported);
        state.start_path_index(&app, imported.clone(), active_after);
    }
    Ok(ImportResult {
        projects: imported,
        failures,
    })
}

fn canonical_project_path(path: &Path) -> GazeResult<String> {
    if !path.exists() {
        return Err(GazeError::NotFound(format!(
            "目录 {} 不存在。",
            path.display()
        )));
    }
    if !path.is_dir() {
        return Err(GazeError::InvalidPath(format!(
            "{} 不是目录。",
            path.display()
        )));
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| GazeError::Message(format!("无法打开目录: {error}")))?;
    canonical
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| GazeError::InvalidPath("项目路径不是有效的 Unicode。".to_string()))
}

#[tauri::command(rename_all = "camelCase")]
async fn remove_project(
    project_id: String,
    state: State<'_, AppState>,
    git_state: State<'_, git_workspace::AppState>,
) -> Result<WorkspaceSnapshot, CommandError> {
    state.path_index.remove_project(&project_id);
    state.symbols.remove_project(&project_id);
    state.watchers.stop(&project_id);
    state.lsp.remove_project(&project_id).await;
    state
        .cache
        .delete_project(&project_id)
        .await
        .map_err(CommandError::from)?;
    git_state.detach(&project_id);
    let snapshot = state.snapshot().await.map_err(CommandError::from)?;
    let _ = state
        .cache
        .set_setting(
            "active_project",
            snapshot.active_project_id.as_deref().unwrap_or(""),
        )
        .await;
    Ok(snapshot)
}

#[tauri::command(rename_all = "camelCase")]
async fn set_active_project(
    project_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    state
        .cache
        .set_setting("active_project", project_id.as_deref().unwrap_or(""))
        .await
        .map_err(CommandError::from)?;
    if let Some(project_id) = project_id.filter(|value| !value.is_empty()) {
        if let Some(project) = state
            .cache
            .projects()
            .await
            .map_err(CommandError::from)?
            .into_iter()
            .find(|project| project.id == project_id)
        {
            state.ensure_active_indexing(&app, project);
        }
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn set_theme(theme: String, state: State<'_, AppState>) -> Result<(), CommandError> {
    if !matches!(theme.as_str(), "system" | "light" | "dark") {
        return Err(CommandError::from(GazeError::InvalidPath(
            "未知主题。".to_string(),
        )));
    }
    state
        .cache
        .set_setting("theme", &theme)
        .await
        .map_err(CommandError::from)?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn save_settings(
    settings: preferences::AppSettings,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    settings
        .save(&state.cache)
        .await
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
async fn list_directory(
    project_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<DirectoryListing, CommandError> {
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    tokio::task::spawn_blocking(move || files::list_directory(&project, &path))
        .await
        .map_err(|error| CommandError::from(GazeError::Join(error)))?
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
async fn create_entry(
    project_id: String,
    parent_path: String,
    name: String,
    is_dir: bool,
    state: State<'_, AppState>,
    git_state: State<'_, git_workspace::AppState>,
) -> Result<DirEntry, CommandError> {
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    let _git_write = git_state
        .editor_guard(Path::new(&project.root))
        .map_err(|e| CommandError::from(GazeError::Message(e)))?;
    tokio::task::spawn_blocking(move || files::create_entry(&project, &parent_path, &name, is_dir))
        .await
        .map_err(|error| CommandError::from(GazeError::Join(error)))?
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
async fn move_entry(
    project_id: String,
    path: String,
    destination_path: String,
    state: State<'_, AppState>,
    git_state: State<'_, git_workspace::AppState>,
) -> Result<DirEntry, CommandError> {
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    let _git_write = git_state
        .editor_guard(Path::new(&project.root))
        .map_err(|e| CommandError::from(GazeError::Message(e)))?;
    let projects = state.cache.projects().await.map_err(CommandError::from)?;
    let source = path.clone();
    let document_path = Path::new(&project.root).join(&path);
    let entry = tokio::task::spawn_blocking(move || {
        files::move_entry(&project, &source, &destination_path, &projects)
    })
    .await
    .map_err(|error| CommandError::from(GazeError::Join(error)))?
    .map_err(CommandError::from)?;
    state.lsp.forget_documents(&document_path).await;
    Ok(entry)
}

#[tauri::command(rename_all = "camelCase")]
async fn trash_entry(
    project_id: String,
    path: String,
    state: State<'_, AppState>,
    git_state: State<'_, git_workspace::AppState>,
) -> Result<(), CommandError> {
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    let _git_write = git_state
        .editor_guard(Path::new(&project.root))
        .map_err(|e| CommandError::from(GazeError::Message(e)))?;
    let projects = state.cache.projects().await.map_err(CommandError::from)?;
    let source = path.clone();
    let document_path = Path::new(&project.root).join(&path);
    tokio::task::spawn_blocking(move || files::trash_entry(&project, &source, &projects))
        .await
        .map_err(|error| CommandError::from(GazeError::Join(error)))?
        .map_err(CommandError::from)?;
    state.lsp.forget_documents(&document_path).await;
    Ok(())
}

#[tauri::command]
async fn has_file_clipboard(app: AppHandle) -> Result<bool, CommandError> {
    native_file_action(&app, || {
        native_files::clipboard_paths().map(|paths| !paths.is_empty())
    })
    .await
}

// AppKit's shared pasteboard must be serialized with WebKit on the main thread.
async fn native_file_action<T: Send + 'static>(
    app: &AppHandle,
    action: impl FnOnce() -> GazeResult<T> + Send + 'static,
) -> Result<T, CommandError> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(action());
    })
    .map_err(|error| CommandError::from(GazeError::Message(error.to_string())))?;
    receiver
        .await
        .map_err(|error| CommandError::from(GazeError::Message(error.to_string())))?
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
async fn copy_entry(
    app: AppHandle,
    project_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let project = state
        .file_project(&project_id, &path)
        .await
        .map_err(CommandError::from)?;
    native_file_action(&app, move || {
        native_files::copy_file(&files::entry_path(&project, &path)?)
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn copy_entry_path(
    app: AppHandle,
    project_id: String,
    path: String,
    relative: bool,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let project = state
        .file_project(&project_id, &path)
        .await
        .map_err(CommandError::from)?;
    native_file_action(&app, move || {
        native_files::copy_path(&files::clipboard_path(&project, &path, relative)?)
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn reveal_entry(
    app: AppHandle,
    project_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let project = state
        .file_project(&project_id, &path)
        .await
        .map_err(CommandError::from)?;
    native_file_action(&app, move || {
        native_files::reveal(&files::entry_path(&project, &path)?)
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn paste_entries(
    app: AppHandle,
    project_id: String,
    parent_path: String,
    state: State<'_, AppState>,
    git_state: State<'_, git_workspace::AppState>,
) -> Result<files::PasteResult, CommandError> {
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    let _git_write = git_state
        .editor_guard(Path::new(&project.root))
        .map_err(|error| CommandError::from(GazeError::Message(error)))?;
    let sources = native_file_action(&app, native_files::clipboard_paths).await?;
    tokio::task::spawn_blocking(move || files::paste_entries(&project, &parent_path, &sources))
        .await
        .map_err(|error| CommandError::from(GazeError::Join(error)))?
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
async fn copy_dropped_files(
    project_id: String,
    parent_path: String,
    paths: Vec<String>,
    state: State<'_, AppState>,
    git_state: State<'_, git_workspace::AppState>,
) -> Result<files::PasteResult, CommandError> {
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    let _git_write = git_state
        .editor_guard(Path::new(&project.root))
        .map_err(|error| CommandError::from(GazeError::Message(error)))?;
    tokio::task::spawn_blocking(move || {
        files::copy_dropped_files(
            &project,
            &parent_path,
            &paths.into_iter().map(PathBuf::from).collect::<Vec<_>>(),
        )
    })
    .await
    .map_err(|error| CommandError::from(GazeError::Join(error)))?
    .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
async fn open_external_files(
    paths: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<external_files::OpenResult, CommandError> {
    let projects = state.cache.projects().await.map_err(CommandError::from)?;
    let mut result = external_files::OpenResult::default();
    for path in paths {
        let opened = state
            .external_files
            .open(Path::new(&path), &projects)
            .and_then(|file| {
                if file.temporary {
                    if let Err(error) = state.watchers.start_file(
                        app.clone(),
                        file.project.clone(),
                        file.path.clone(),
                    ) {
                        let _ = state.external_files.close(&file.project.id, &file.path);
                        return Err(error);
                    }
                }
                Ok(file)
            });
        match opened {
            Ok(file) => result.files.push(file),
            Err(error) => result.failures.push(external_files::OpenFailure {
                path,
                message: error.message(),
            }),
        }
    }
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
fn close_external_file(
    project_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    state.watchers.stop_file(&project_id, &path);
    state
        .external_files
        .close(&project_id, &path)
        .map_err(CommandError::from)
}

#[tauri::command]
fn take_pending_files(state: State<'_, AppState>) -> Result<Vec<String>, CommandError> {
    state
        .external_files
        .take_pending()
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
async fn read_file(
    project_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<FileContent, CommandError> {
    let project = state
        .file_project(&project_id, &path)
        .await
        .map_err(CommandError::from)?;
    tokio::task::spawn_blocking(move || files::read_file(&project, &path))
        .await
        .map_err(|error| CommandError::from(GazeError::Join(error)))?
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
async fn read_recovery(
    project_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Option<recovery::RecoveryRecord>, CommandError> {
    let store = state.recovery.clone();
    tokio::task::spawn_blocking(move || store.read(&project_id, &path))
        .await
        .map_err(|error| CommandError::from(GazeError::Join(error)))?
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
async fn write_recovery(
    project_id: String,
    path: String,
    content: String,
    original_fingerprint: FileFingerprint,
    state: State<'_, AppState>,
) -> Result<recovery::RecoveryRecord, CommandError> {
    let store = state.recovery.clone();
    tokio::task::spawn_blocking(move || {
        store.write(&project_id, &path, &content, original_fingerprint)
    })
    .await
    .map_err(|error| CommandError::from(GazeError::Join(error)))?
    .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
async fn delete_recovery(
    project_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let store = state.recovery.clone();
    tokio::task::spawn_blocking(move || store.delete(&project_id, &path))
        .await
        .map_err(|error| CommandError::from(GazeError::Join(error)))?
        .map_err(CommandError::from)
}

async fn read_protocol_markdown_image(
    app: &AppHandle,
    uri: &str,
) -> GazeResult<markdown::ImageData> {
    let markdown::ImageRequest {
        project_id,
        document_path,
        src,
    } = markdown::parse_image_request(uri)?;
    let project = app
        .state::<AppState>()
        .file_project(&project_id, &document_path)
        .await?;
    tokio::task::spawn_blocking(move || markdown::read_image(&project, &document_path, &src))
        .await
        .map_err(GazeError::Join)?
}

fn markdown_image_response(
    result: GazeResult<markdown::ImageData>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, StatusCode};

    let builder = tauri::http::Response::builder()
        .header(header::CACHE_CONTROL, "private, no-cache")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; sandbox",
        )
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    match result {
        Ok(image) => builder
            .header(header::CONTENT_TYPE, image.mime)
            .header(header::CONTENT_LENGTH, image.bytes.len())
            .body(image.bytes),
        Err(error) => {
            let status = match error {
                GazeError::InvalidPath(_)
                | GazeError::Permission(_)
                | GazeError::Unsupported(_) => StatusCode::FORBIDDEN,
                GazeError::NotFound(_) => StatusCode::NOT_FOUND,
                GazeError::TooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            };
            builder.status(status).body(Vec::new())
        }
    }
    .expect("static image response headers are valid")
}

#[tauri::command(rename_all = "camelCase")]
async fn resolve_markdown_link(
    project_id: String,
    document_path: String,
    href: String,
    state: State<'_, AppState>,
) -> Result<markdown::MarkdownLink, CommandError> {
    let project = state
        .file_project(&project_id, &document_path)
        .await
        .map_err(CommandError::from)?;
    tokio::task::spawn_blocking(move || markdown::resolve_link(&project, &document_path, &href))
        .await
        .map_err(|error| CommandError::from(GazeError::Join(error)))?
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
async fn open_external_url(url: String) -> Result<(), CommandError> {
    let url = markdown::external_url(&url).map_err(CommandError::from)?;
    tokio::task::spawn_blocking(move || {
        tauri_plugin_opener::open_url(url.as_str(), None::<&str>)
            .map_err(|error| GazeError::Message(format!("无法打开网页：{error}")))
    })
    .await
    .map_err(|error| CommandError::from(GazeError::Join(error)))?
    .map_err(CommandError::from)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
async fn write_file(
    project_id: String,
    path: String,
    content: String,
    base_fingerprint: FileFingerprint,
    encoding_kind: TextEncodingKind,
    line_ending: LineEnding,
    force: bool,
    state: State<'_, AppState>,
    git_state: State<'_, git_workspace::AppState>,
) -> Result<WriteResult, CommandError> {
    let project = state
        .file_project(&project_id, &path)
        .await
        .map_err(CommandError::from)?;
    let _git_write = git_state
        .editor_guard(Path::new(&project.root))
        .map_err(|e| CommandError::from(GazeError::Message(e)))?;
    tokio::task::spawn_blocking(move || {
        files::write_file(
            &project,
            &path,
            &content,
            base_fingerprint,
            encoding_kind,
            line_ending,
            force,
        )
    })
    .await
    .map_err(|error| CommandError::from(GazeError::Join(error)))?
    .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
async fn hover_code(
    project_id: String,
    path: String,
    content: String,
    position: TextPosition,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<lsp::HoverContent>, CommandError> {
    let project = state
        .file_project(&project_id, &path)
        .await
        .map_err(CommandError::from)?;
    state
        .lsp
        .hover(&app, &project, &path, &content, position)
        .await
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
async fn complete_code(
    project_id: String,
    path: String,
    content: String,
    position: TextPosition,
    trigger: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<lsp::CompletionResult, CommandError> {
    let project = state
        .file_project(&project_id, &path)
        .await
        .map_err(CommandError::from)?;
    state
        .lsp
        .complete(
            &app,
            &project,
            &path,
            &content,
            position,
            trigger.as_deref(),
        )
        .await
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
async fn sync_document(
    project_id: String,
    path: String,
    content: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    state
        .lsp
        .sync_document(&app, &project, &path, &content)
        .await
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
async fn search_paths(
    query: String,
    state: State<'_, AppState>,
) -> Result<PathSearchResponse, CommandError> {
    state
        .path_index
        .search(query)
        .await
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
fn path_index_status(state: State<'_, AppState>) -> Vec<PathIndexStatus> {
    state.path_index.statuses()
}

#[tauri::command(rename_all = "camelCase")]
fn symbol_index_status(
    project_id: String,
    state: State<'_, AppState>,
) -> Option<SymbolIndexStatus> {
    state.symbols.status(&project_id)
}

#[tauri::command(rename_all = "camelCase")]
async fn get_outline(
    project_id: String,
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<OutlineResult, CommandError> {
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    let lsp_error = if state.lsp.has_server_for(&path) {
        match state.lsp.document_symbols(&app, &project, &path).await {
            Ok(result) => return Ok(result),
            Err(error) => Some(error.message()),
        }
    } else {
        Some("没有为该文件配置 LSP。".to_string())
    };
    let Some(ctags) = state.tools.ctags.clone() else {
        return Ok(OutlineResult {
            symbols: Vec::new(),
            source: "ctags".to_string(),
            message: Some(format!(
                "LSP 不可用（{}）；同时未找到 universal-ctags，无法生成文件大纲。",
                lsp_error.unwrap_or_default()
            )),
        });
    };
    state
        .symbols
        .index_file(&state.cache, &ctags, &project, &path)
        .await
        .map_err(CommandError::from)?;
    let symbols = state
        .symbols
        .outline(&state.cache, &project, &path)
        .await
        .map_err(CommandError::from)?;
    Ok(OutlineResult {
        symbols,
        source: "ctags".to_string(),
        message: Some(format!(
            "LSP 不可用（{}），当前显示 ctags 文本符号。",
            lsp_error.unwrap_or_default()
        )),
    })
}

#[tauri::command(rename_all = "camelCase")]
async fn search_symbols(
    project_id: String,
    query: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SymbolSearchResult, CommandError> {
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    let Some(ctags) = state.tools.ctags.clone() else {
        return Ok(SymbolSearchResult {
            symbols: Vec::new(),
            indexing: false,
            message: Some("未找到 universal-ctags，符号搜索不可用。".to_string()),
        });
    };
    state
        .symbols
        .ensure_project_index(app, state.cache.clone(), ctags, project.clone())
        .await
        .map_err(CommandError::from)?;
    state
        .symbols
        .search(&state.cache, &project, &query)
        .await
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
async fn find_definitions(
    project_id: String,
    path: String,
    position: TextPosition,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<NavigationResult, CommandError> {
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    let projects = state.cache.projects().await.map_err(CommandError::from)?;
    let lsp_error = match state
        .lsp
        .definition(&app, &projects, &project, &path, position)
        .await
    {
        Ok(result) => return Ok(result),
        Err(error) => error.message(),
    };
    let Some(ctags) = state.tools.ctags.clone() else {
        return Ok(NavigationResult {
            locations: Vec::new(),
            source: "ctags".to_string(),
            message: Some("没有可用的 LSP 或 universal-ctags，无法定位定义。".to_string()),
        });
    };
    state
        .symbols
        .ensure_project_index(app, state.cache.clone(), ctags, project.clone())
        .await
        .map_err(CommandError::from)?;
    let locations = state
        .symbols
        .definition_candidates(&state.cache, &project, position, &path)
        .await
        .map_err(CommandError::from)?;
    let message = if locations.is_empty() {
        Some(format!(
            "LSP 不可用（{lsp_error}）；ctags 也未找到该位置的定义候选。"
        ))
    } else {
        Some(format!(
            "LSP 不可用（{lsp_error}），以下为 ctags 文本定义候选。"
        ))
    };
    Ok(NavigationResult {
        locations,
        source: "ctags".to_string(),
        message,
    })
}

#[tauri::command(rename_all = "camelCase")]
async fn find_references(
    project_id: String,
    path: String,
    position: TextPosition,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<NavigationResult, CommandError> {
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    let projects = state.cache.projects().await.map_err(CommandError::from)?;
    match state
        .lsp
        .references(&app, &projects, &project, &path, position)
        .await
    {
        Ok(result) => Ok(result),
        Err(error) => Ok(NavigationResult {
            locations: Vec::new(),
            source: "lsp".to_string(),
            message: Some(format!(
                "无法精确查找引用：{}。Gaze 不会用文本匹配伪造语义引用。",
                error.message()
            )),
        }),
    }
}

#[tauri::command(rename_all = "camelCase")]
async fn find_implementations(
    project_id: String,
    path: String,
    position: TextPosition,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<NavigationResult, CommandError> {
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    let projects = state.cache.projects().await.map_err(CommandError::from)?;
    match state
        .lsp
        .implementations(&app, &projects, &project, &path, position)
        .await
    {
        Ok(result) => Ok(result),
        Err(error) => Ok(NavigationResult {
            locations: Vec::new(),
            source: "lsp".to_string(),
            message: Some(format!("无法查找实现：{}。", error.message())),
        }),
    }
}

#[tauri::command(rename_all = "camelCase")]
async fn start_search(
    request_id: String,
    query: String,
    options: models::SearchOptions,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let projects = state.cache.projects().await.map_err(CommandError::from)?;
    state
        .search_service
        .start(
            app,
            state.tools.clone(),
            projects,
            request_id,
            query,
            options,
        )
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
fn continue_search(request_id: String, state: State<'_, AppState>) -> Result<(), CommandError> {
    state.search_service.resume(&request_id);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn cancel_search(request_id: String, state: State<'_, AppState>) -> Result<(), CommandError> {
    state.search_service.cancel(&request_id);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn create_terminal(
    session_id: String,
    project_id: Option<String>,
    cols: u16,
    rows: u16,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TerminalSessionInfo, CommandError> {
    let cwd = match project_id.as_deref() {
        Some(id) => PathBuf::from(state.project(id).await.map_err(CommandError::from)?.root),
        None => app.path().home_dir().map_err(|error| {
            CommandError::from(GazeError::Message(format!("无法获取用户主目录：{error}")))
        })?,
    };
    state
        .terminal
        .create(session_id, project_id, cwd, cols, rows, move |event| {
            let _ = app.emit("gaze://terminal", event);
        })
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
async fn write_terminal(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    state
        .terminal
        .write(&session_id, data.as_bytes())
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
fn resize_terminal(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    state
        .terminal
        .resize(&session_id, cols, rows)
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
fn close_terminal(session_id: String, state: State<'_, AppState>) -> Result<(), CommandError> {
    state
        .terminal
        .close(&session_id)
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
fn get_capabilities(state: State<'_, AppState>) -> Result<ToolCapabilities, CommandError> {
    Ok(state.tools.capabilities())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("gaze-image", |context, request, responder| {
            let app = context.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                let uri = request.uri().to_string();
                let result = read_protocol_markdown_image(&app, &uri).await;
                responder.respond(markdown_image_response(result));
            });
        })
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = AppState::load(app)?;
            app.manage(state);
            #[cfg(target_os = "macos")]
            native_menu::install(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap_workspace,
            native_menu::sync_menu_state,
            import_projects,
            remove_project,
            set_active_project,
            set_theme,
            save_settings,
            list_directory,
            create_entry,
            move_entry,
            trash_entry,
            has_file_clipboard,
            copy_entry,
            paste_entries,
            copy_dropped_files,
            open_external_files,
            close_external_file,
            take_pending_files,
            copy_entry_path,
            reveal_entry,
            read_file,
            read_recovery,
            write_recovery,
            delete_recovery,
            resolve_markdown_link,
            open_external_url,
            write_file,
            sync_document,
            complete_code,
            hover_code,
            search_paths,
            path_index_status,
            symbol_index_status,
            get_outline,
            search_symbols,
            find_definitions,
            find_references,
            find_implementations,
            start_search,
            continue_search,
            cancel_search,
            replace::preview_replace,
            replace::cancel_replace_preview,
            replace::apply_replace,
            replace::undo_replace,
            create_terminal,
            write_terminal,
            resize_terminal,
            close_terminal,
            get_capabilities,
            git_workspace::git_context,
            git_workspace::summary::refresh_repository,
            git_workspace::working_tree::get_status,
            git_workspace::working_tree::get_diff,
            git_workspace::working_tree::get_file_base,
            git_workspace::working_tree::get_conflict_document,
            git_workspace::history::get_history,
            git_workspace::history::export_session_log,
            git_workspace::history::get_commit_detail,
            git_workspace::history::get_stash_detail,
            git_workspace::history::get_rebase_commits,
            git_workspace::history::get_file_history,
            git_workspace::history::get_commit_file_diff,
            git_workspace::history::get_stash_file_diff,
            git_workspace::history::get_blame,
            git_workspace::history::compare_branches,
            git_workspace::history::get_branches,
            git_workspace::history::get_tags,
            git_workspace::history::get_remotes,
            git_workspace::history::get_stashes,
            git_workspace::history::get_submodules,
            git_workspace::operations::preview_operation,
            git_workspace::operations::start_operation,
            git_workspace::operations::cancel_operation
        ])
        .build(tauri::generate_context!())
        .expect("error while building Gaze");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &event {
            let state = app_handle.state::<AppState>();
            let paths = urls
                .iter()
                .filter_map(|url| url.to_file_path().ok())
                .filter_map(|path| path.to_str().map(str::to_owned));
            match state.external_files.enqueue(paths) {
                Ok(()) => {
                    let _ = app_handle.emit("gaze://open-files", ());
                }
                Err(error) => tracing::warn!(%error, "failed to queue opened files"),
            }
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
        if let tauri::RunEvent::ExitRequested { .. } = event {
            let state = app_handle.state::<AppState>();
            app_handle.state::<git_workspace::AppState>().stop();
            state.watchers.stop_all();
            state.search_service.cancel_all();
            state.replace_previews.cancel_all();
            state.terminal.close_all();
            let lsp = Arc::clone(&state.lsp);
            tauri::async_runtime::block_on(async move {
                lsp.shutdown().await;
            });
        }
    });
}
