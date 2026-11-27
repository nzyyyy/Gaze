use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{CommandError, GazeError};
use crate::terminal::TerminalSessionInfo;
use crate::AppState;

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn create_terminal(
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
pub(crate) async fn write_terminal(
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
pub(crate) fn resize_terminal(
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
pub(crate) fn close_terminal(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    state
        .terminal
        .close(&session_id)
        .map_err(CommandError::from)
}
