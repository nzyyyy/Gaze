use std::path::Path;

use tauri::{AppHandle, State};

use crate::error::CommandError;
use crate::models::TextPosition;
use crate::{lsp, python, AppState};

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn hover_code(
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
pub(crate) async fn complete_code(
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
pub(crate) async fn resolve_completion(
    project_id: String,
    path: String,
    content: String,
    resolve: lsp::CompletionResolve,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<lsp::CompletionItem>, CommandError> {
    let project = state
        .file_project(&project_id, &path)
        .await
        .map_err(CommandError::from)?;
    state
        .lsp
        .resolve_completion(&app, &project, &path, &content, resolve)
        .await
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn sync_document(
    project_id: String,
    path: String,
    content: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<lsp::DiagnosticSync, CommandError> {
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
pub(crate) async fn get_python_environment(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<python::PythonEnvironmentStatus, CommandError> {
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    state
        .lsp
        .python_environment(&project)
        .await
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn list_python_environments(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<python::PythonEnvironment>, CommandError> {
    state
        .lsp
        .ensure_python_enabled()
        .map_err(CommandError::from)?;
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    Ok(python::discover(Path::new(&project.root)).await)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn set_python_environment(
    project_id: String,
    interpreter: Option<String>,
    state: State<'_, AppState>,
) -> Result<python::PythonEnvironmentStatus, CommandError> {
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    state
        .lsp
        .set_python_environment(&project, interpreter)
        .await
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn lsp_code_actions(
    project_id: String,
    path: String,
    content: String,
    range: lsp::LspRange,
    kinds: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<lsp::CodeActionResult, CommandError> {
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    state
        .lsp
        .code_actions(&app, &project, &path, &content, range, &kinds)
        .await
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn lsp_resolve_code_action(
    project_id: String,
    path: String,
    content: String,
    resolve: lsp::CodeActionResolve,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<lsp::CodeAction>, CommandError> {
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    state
        .lsp
        .resolve_code_action(&app, &project, &path, &content, resolve)
        .await
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn lsp_editor_revision_matches(
    project_id: String,
    path: String,
    content: String,
    revision: lsp::DocumentRevision,
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    state
        .lsp
        .editor_revision_matches(&project, &path, &content, &revision)
        .await
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn lsp_signature_help(
    project_id: String,
    path: String,
    content: String,
    position: TextPosition,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<lsp::SignatureHelp>, CommandError> {
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    state
        .lsp
        .signature_help(&app, &project, &path, &content, position)
        .await
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn lsp_format(
    project_id: String,
    path: String,
    content: String,
    range: Option<lsp::LspRange>,
    options: lsp::FormattingOptions,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<lsp::FormatResult, CommandError> {
    let project = state
        .project(&project_id)
        .await
        .map_err(CommandError::from)?;
    state
        .lsp
        .format(&app, &project, &path, &content, range, options)
        .await
        .map_err(CommandError::from)
}
