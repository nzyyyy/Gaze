use tauri::{AppHandle, State};

use crate::error::CommandError;
use crate::models::{
    NavigationResult, OutlineResult, SearchOptions, SymbolSearchResult, TextPosition,
};
use crate::path_index::{PathCompletion, PathIndexStatus, PathSearchResponse};
use crate::symbols::SymbolIndexStatus;
use crate::{navigation, AppState};

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn search_paths(
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
pub(crate) async fn complete_paths(
    project_id: String,
    document_path: String,
    directory: String,
    prefix: String,
    directory_only: bool,
    state: State<'_, AppState>,
) -> Result<Vec<PathCompletion>, CommandError> {
    if !state
        .read_preferences()
        .await
        .map_err(CommandError::from)?
        .path_completion_enabled
    {
        return Ok(Vec::new());
    }
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    state
        .path_index
        .complete(project, document_path, directory, prefix, directory_only)
        .await
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn path_index_status(state: State<'_, AppState>) -> Vec<PathIndexStatus> {
    state.path_index.statuses()
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn symbol_index_status(
    project_id: String,
    state: State<'_, AppState>,
) -> Option<SymbolIndexStatus> {
    state.symbols.status(&project_id)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn get_outline(
    project_id: String,
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<OutlineResult, CommandError> {
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    navigation::get_outline(
        app,
        &state.cache,
        &state.lsp,
        &state.symbols,
        state.tools.ctags.clone(),
        &project,
        &path,
    )
    .await
    .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn search_symbols(
    project_id: String,
    query: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SymbolSearchResult, CommandError> {
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    navigation::search_symbols(
        app,
        &state.cache,
        &state.symbols,
        state.tools.ctags.clone(),
        &project,
        &query,
    )
    .await
    .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn find_definitions(
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
    navigation::find_definitions(
        app,
        &state.cache,
        &state.lsp,
        &state.symbols,
        state.tools.ctags.clone(),
        &project,
        &path,
        position,
    )
    .await
    .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn find_references(
    project_id: String,
    path: String,
    position: TextPosition,
    include_declaration: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<NavigationResult, CommandError> {
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    navigation::find_references(
        &app,
        &state.cache,
        &state.lsp,
        &project,
        &path,
        position,
        include_declaration,
    )
    .await
    .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn find_implementations(
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
    navigation::find_implementations(&app, &state.cache, &state.lsp, &project, &path, position)
        .await
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn start_search(
    request_id: String,
    query: String,
    options: SearchOptions,
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
pub(crate) fn continue_search(
    request_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    state.search_service.resume(&request_id);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn cancel_search(
    request_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    state.search_service.cancel(&request_id);
    Ok(())
}
