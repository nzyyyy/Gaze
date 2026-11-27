use std::path::PathBuf;
use std::sync::Arc;

use tauri::AppHandle;

use crate::cache::Cache;
use crate::error::GazeResult;
use crate::lsp::LspManager;
use crate::models::{NavigationResult, OutlineResult, Project, SymbolSearchResult, TextPosition};
use crate::symbols::SymbolService;

pub(crate) async fn get_outline(
    app: AppHandle,
    cache: &Cache,
    lsp: &LspManager,
    symbols: &Arc<SymbolService>,
    ctags: Option<PathBuf>,
    project: &Project,
    path: &str,
) -> GazeResult<OutlineResult> {
    let lsp_error = if lsp.has_server_for(path) {
        match lsp.document_symbols(&app, project, path).await {
            Ok(result) => return Ok(result),
            Err(error) => Some(error.message()),
        }
    } else {
        Some("没有为该文件配置 LSP。".to_string())
    };
    let Some(ctags) = ctags else {
        return Ok(OutlineResult {
            symbols: Vec::new(),
            source: "ctags".to_string(),
            message: Some(format!(
                "LSP 不可用（{}）；同时未找到 universal-ctags，无法生成文件大纲。",
                lsp_error.unwrap_or_default()
            )),
        });
    };
    symbols.index_file(cache, &ctags, project, path).await?;
    let symbols = symbols.outline(cache, project, path).await?;
    Ok(OutlineResult {
        symbols,
        source: "ctags".to_string(),
        message: Some(format!(
            "LSP 不可用（{}），当前显示 ctags 文本符号。",
            lsp_error.unwrap_or_default()
        )),
    })
}

pub(crate) async fn search_symbols(
    app: AppHandle,
    cache: &Cache,
    symbols: &Arc<SymbolService>,
    ctags: Option<PathBuf>,
    project: &Project,
    query: &str,
) -> GazeResult<SymbolSearchResult> {
    let Some(ctags) = ctags else {
        return Ok(SymbolSearchResult {
            symbols: Vec::new(),
            indexing: false,
            message: Some("未找到 universal-ctags，符号搜索不可用。".to_string()),
        });
    };
    symbols
        .ensure_project_index(app, cache.clone(), ctags, project.clone())
        .await?;
    symbols.search(cache, project, query).await
}

pub(crate) async fn find_definitions(
    app: AppHandle,
    cache: &Cache,
    lsp: &LspManager,
    symbols: &Arc<SymbolService>,
    ctags: Option<PathBuf>,
    project: &Project,
    path: &str,
    position: TextPosition,
) -> GazeResult<NavigationResult> {
    let projects = cache.projects().await?;
    let lsp_error = match lsp
        .definition(&app, &projects, project, path, position)
        .await
    {
        Ok(result) => return Ok(result),
        Err(error) => error.message(),
    };
    let Some(ctags) = ctags else {
        return Ok(NavigationResult {
            locations: Vec::new(),
            source: "ctags".to_string(),
            message: Some("没有可用的 LSP 或 universal-ctags，无法定位定义。".to_string()),
        });
    };
    symbols
        .ensure_project_index(app, cache.clone(), ctags, project.clone())
        .await?;
    let locations = symbols
        .definition_candidates(cache, project, position, path)
        .await?;
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

pub(crate) async fn find_references(
    app: &AppHandle,
    cache: &Cache,
    lsp: &LspManager,
    project: &Project,
    path: &str,
    position: TextPosition,
    include_declaration: Option<bool>,
) -> GazeResult<NavigationResult> {
    let projects = cache.projects().await?;
    match lsp
        .references(
            app,
            &projects,
            project,
            path,
            position,
            include_declaration.unwrap_or(true),
        )
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

pub(crate) async fn find_implementations(
    app: &AppHandle,
    cache: &Cache,
    lsp: &LspManager,
    project: &Project,
    path: &str,
    position: TextPosition,
) -> GazeResult<NavigationResult> {
    let projects = cache.projects().await?;
    match lsp
        .implementations(app, &projects, project, path, position)
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
