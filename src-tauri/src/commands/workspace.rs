use std::path::Path;
use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::error::{CommandError, GazeError, GazeResult};
use crate::models::{Project, WorkspaceSnapshot};
use crate::tools::ToolCapabilities;
use crate::{git_workspace, plugins, preferences, AppState};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportFailure {
    path: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportResult {
    projects: Vec<Project>,
    failures: Vec<ImportFailure>,
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn bootstrap_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<WorkspaceSnapshot, CommandError> {
    let snapshot = {
        let _settings = state.settings_lock.lock().await;
        let snapshot = state.snapshot().await.map_err(CommandError::from)?;
        plugins::apply_builtin_preferences(&state, None, &snapshot.preferences).await;
        snapshot
    };
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
pub(crate) async fn import_projects(
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
pub(crate) async fn remove_project(
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
pub(crate) async fn set_active_project(
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
pub(crate) async fn set_theme(
    theme: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
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
pub(crate) async fn save_settings(
    settings: preferences::AppSettings,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let _settings = state.settings_lock.lock().await;
    let previous = state.read_preferences().await.map_err(CommandError::from)?;
    let next = &settings.preferences;
    if next.ai_completion_enabled {
        next.ai_completion.validate().map_err(CommandError::from)?;
    }
    settings
        .save(&state.cache)
        .await
        .map_err(CommandError::from)?;
    plugins::apply_builtin_preferences(&state, Some(&previous), next).await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn get_capabilities(
    state: State<'_, AppState>,
) -> Result<ToolCapabilities, CommandError> {
    Ok(state.tools.capabilities())
}
