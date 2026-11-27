use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};

use crate::error::{CommandError, GazeError, GazeResult};
use crate::models::{
    DirEntry, DirectoryListing, FileContent, FileFingerprint, LineEnding, TextEncodingKind,
    WriteResult,
};
use crate::{external_files, files, git_workspace, markdown, native_files, recovery, AppState};

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn list_directory(
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
pub(crate) async fn create_entry(
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
pub(crate) async fn move_entry(
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
pub(crate) async fn trash_entry(
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
pub(crate) async fn has_file_clipboard(app: AppHandle) -> Result<bool, CommandError> {
    native_file_action(&app, || {
        native_files::clipboard_paths().map(|paths| !paths.is_empty())
    })
    .await
}

#[tauri::command]
pub(crate) async fn read_editor_clipboard(app: AppHandle) -> Result<Option<String>, CommandError> {
    native_file_action(&app, native_files::read_clipboard_text).await
}

#[tauri::command]
pub(crate) async fn write_editor_clipboard(
    app: AppHandle,
    text: String,
) -> Result<(), CommandError> {
    native_file_action(&app, move || native_files::write_clipboard_text(&text)).await
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
pub(crate) async fn copy_entry(
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
pub(crate) async fn copy_entry_path(
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
pub(crate) async fn reveal_entry(
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
pub(crate) async fn paste_entries(
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
pub(crate) async fn copy_dropped_files(
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
pub(crate) async fn open_external_files(
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
pub(crate) fn close_external_file(
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
pub(crate) fn take_pending_files(state: State<'_, AppState>) -> Result<Vec<String>, CommandError> {
    state
        .external_files
        .take_pending()
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn read_file(
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
pub(crate) async fn read_recovery(
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
pub(crate) async fn write_recovery(
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
pub(crate) async fn delete_recovery(
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

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn resolve_markdown_link(
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
pub(crate) async fn open_external_url(url: String) -> Result<(), CommandError> {
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
pub(crate) async fn write_file(
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
