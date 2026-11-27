mod ai_completion;
mod cache;
mod color_schemes;
mod commands;
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
mod navigation;
mod path_index;
mod plugins;
mod preferences;
mod python;
mod recovery;
mod replace;
mod search;
mod symbols;
mod terminal;
mod tools;
mod watcher;

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};

use cache::Cache;
use config::AppConfig;
use error::{GazeError, GazeResult};
use lsp::LspManager;
use models::{Project, WorkspaceSnapshot};
use path_index::PathIndex;
use search::SearchService;
use symbols::SymbolService;
use terminal::TerminalManager;
use tools::Tools;
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
    settings_lock: tokio::sync::Mutex<()>,
    ai_completion: Arc<ai_completion::Completion>,
    background_started: AtomicBool,
    external_files: Arc<external_files::ExternalFiles>,
    recovery: recovery::RecoveryStore,
    replace: Arc<replace::ReplaceState>,
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
        app.manage(cache.clone());
        app.manage(plugins::Plugins::new(
            data_dir.join("plugins"),
            cache.clone(),
            std::env::current_exe()?,
        ));
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
        let lsp = Arc::new(LspManager::new(&tools, cache.clone()));
        let ai_completion = Arc::new(ai_completion::Completion::default());
        let external_files = Arc::new(external_files::ExternalFiles::default());
        let replace = Arc::new(replace::ReplaceState::default());
        app.manage(tools.clone());
        app.manage(Arc::clone(&lsp));
        app.manage(Arc::clone(&ai_completion));
        app.manage(Arc::clone(&external_files));
        app.manage(Arc::clone(&replace));
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
            settings_lock: tokio::sync::Mutex::new(()),
            ai_completion,
            background_started: AtomicBool::new(false),
            external_files,
            recovery: recovery::RecoveryStore::new(data_dir.join("recovery")),
            replace,
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

    async fn read_preferences(&self) -> GazeResult<preferences::Preferences> {
        preferences::read(&self.cache).await
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
            language: self
                .cache
                .setting("language")
                .await?
                .and_then(|value| serde_json::from_str(&value).ok())
                .unwrap_or_default(),
            projects,
            active_project_id,
            theme,
            preferences: self.read_preferences().await?,
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

pub fn is_plugin_worker() -> bool {
    std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == plugins::WORKER_FLAG)
}

pub fn run_plugin_worker() -> bool {
    plugins::worker().is_ok()
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
            commands::workspace::bootstrap_workspace,
            native_menu::sync_menu_state,
            commands::workspace::import_projects,
            commands::workspace::remove_project,
            commands::workspace::set_active_project,
            commands::workspace::set_theme,
            commands::workspace::save_settings,
            plugins::list_plugins,
            plugins::install_plugin,
            plugins::set_plugin_enabled,
            plugins::uninstall_plugin,
            plugins::invoke_plugin,
            plugins::cancel_plugin,
            ai_completion::request_ai_completion,
            ai_completion::cancel_ai_completion,
            ai_completion::test_ai_completion,
            commands::files::list_directory,
            commands::files::create_entry,
            commands::files::move_entry,
            commands::files::trash_entry,
            commands::files::has_file_clipboard,
            commands::files::read_editor_clipboard,
            commands::files::write_editor_clipboard,
            commands::files::copy_entry,
            commands::files::paste_entries,
            commands::files::copy_dropped_files,
            commands::files::open_external_files,
            commands::files::close_external_file,
            commands::files::take_pending_files,
            commands::files::copy_entry_path,
            commands::files::reveal_entry,
            commands::files::read_file,
            commands::files::read_recovery,
            commands::files::write_recovery,
            commands::files::delete_recovery,
            commands::files::resolve_markdown_link,
            commands::files::open_external_url,
            commands::files::write_file,
            commands::lsp::sync_document,
            commands::lsp::get_python_environment,
            commands::lsp::list_python_environments,
            commands::lsp::set_python_environment,
            commands::lsp::complete_code,
            commands::lsp::resolve_completion,
            commands::lsp::hover_code,
            commands::search::search_paths,
            commands::search::complete_paths,
            commands::search::path_index_status,
            commands::search::symbol_index_status,
            commands::search::get_outline,
            commands::search::search_symbols,
            commands::search::find_definitions,
            commands::search::find_references,
            commands::search::find_implementations,
            commands::lsp::lsp_code_actions,
            commands::lsp::lsp_resolve_code_action,
            commands::lsp::lsp_editor_revision_matches,
            commands::lsp::lsp_signature_help,
            commands::lsp::lsp_format,
            commands::search::start_search,
            commands::search::continue_search,
            commands::search::cancel_search,
            replace::preview_replace,
            replace::cancel_replace_preview,
            replace::apply_replace,
            replace::undo_replace,
            commands::terminal::create_terminal,
            commands::terminal::write_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::close_terminal,
            commands::workspace::get_capabilities,
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
            state.replace.replace_previews.cancel_all();
            state.terminal.close_all();
            let lsp = Arc::clone(&state.lsp);
            tauri::async_runtime::block_on(async move {
                app_handle.state::<plugins::Plugins>().shutdown().await;
                lsp.shutdown().await;
            });
        }
    });
}
