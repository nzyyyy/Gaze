use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use base64::Engine;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::error::{GazeError, GazeResult};
use crate::files::path_to_relative;
use crate::models::{Project, SearchEvent, SearchHit, SearchOptions, SearchRange};
use crate::tools::Tools;

pub const SEARCH_PAGE_SIZE: usize = 200;
const SEARCH_BATCH_SIZE: usize = 40;
pub const SEARCH_MAX_RESULTS: usize = 5_000;

#[derive(Clone)]
pub struct SearchService {
    sessions: Arc<Mutex<HashMap<String, SessionHandle>>>,
}

struct SessionHandle {
    cancel: CancellationToken,
    resume: Arc<tokio::sync::Notify>,
}

impl Default for SearchService {
    fn default() -> Self {
        Self::new()
    }
}

impl SearchService {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn start(
        &self,
        app: AppHandle,
        tools: Tools,
        projects: Vec<Project>,
        request_id: String,
        query: String,
        options: SearchOptions,
    ) -> GazeResult<()> {
        if request_id.trim().is_empty() {
            return Err(GazeError::Message("搜索请求缺少 request id。".to_string()));
        }
        if query.is_empty() {
            return Err(GazeError::Message("请输入要搜索的内容。".to_string()));
        }
        let rg = tools.rg.ok_or_else(|| {
            GazeError::ToolMissing(
                "未找到 ripgrep（rg）。请安装 ripgrep，或在配置文件 tools.rg 中指定路径。"
                    .to_string(),
            )
        })?;
        if projects.is_empty() {
            return Err(GazeError::Message("工作区中没有可搜索的项目。".to_string()));
        }
        let projects = scope_projects(projects, &options);
        if projects.is_empty() {
            return Err(GazeError::Message("所选项目当前不可搜索。".to_string()));
        }

        let cancel = CancellationToken::new();
        let resume = Arc::new(tokio::sync::Notify::new());
        {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| GazeError::Message("搜索会话锁已损坏。".to_string()))?;
            if let Some(old) = sessions.remove(&request_id) {
                old.cancel.cancel();
            }
            sessions.insert(
                request_id.clone(),
                SessionHandle {
                    cancel: cancel.clone(),
                    resume: Arc::clone(&resume),
                },
            );
        }

        let sessions = Arc::clone(&self.sessions);
        tokio::spawn(async move {
            let event_app = app.clone();
            let result = run_search(
                move |event| emit(&event_app, event),
                rg,
                projects,
                request_id.clone(),
                query,
                options,
                cancel.clone(),
                resume,
            )
            .await;
            if let Err(error) = result {
                if !cancel.is_cancelled() {
                    emit(
                        &app,
                        SearchEvent::Error {
                            request_id: request_id.clone(),
                            code: error.code().to_string(),
                            message: error.message(),
                        },
                    );
                }
            }
            if let Ok(mut sessions) = sessions.lock() {
                if sessions
                    .get(&request_id)
                    .is_some_and(|session| session.cancel == cancel)
                {
                    sessions.remove(&request_id);
                }
            }
        });
        Ok(())
    }

    pub fn resume(&self, request_id: &str) {
        if let Ok(sessions) = self.sessions.lock() {
            if let Some(session) = sessions.get(request_id) {
                session.resume.notify_one();
            }
        }
    }

    pub fn cancel(&self, request_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(session) = sessions.remove(request_id) {
                session.cancel.cancel();
            }
        }
    }

    pub fn cancel_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, session) in sessions.drain() {
                session.cancel.cancel();
            }
        }
    }
}

pub(crate) struct ProjectLookup {
    projects: Vec<(PathBuf, Project)>,
}

pub(crate) fn scope_projects(projects: Vec<Project>, options: &SearchOptions) -> Vec<Project> {
    if options.project_ids.is_empty() {
        projects
    } else {
        projects
            .into_iter()
            .filter(|project| options.project_ids.contains(&project.id))
            .collect()
    }
}

impl ProjectLookup {
    pub(crate) fn new(projects: Vec<Project>) -> Self {
        let mut projects: Vec<_> = projects
            .into_iter()
            .filter_map(|project| {
                let root = PathBuf::from(&project.root);
                root.is_dir().then_some((root, project))
            })
            .collect();
        projects.sort_by(|left, right| {
            right
                .0
                .components()
                .count()
                .cmp(&left.0.components().count())
        });
        Self { projects }
    }

    fn resolve(&self, path: &Path) -> Option<(&Project, String)> {
        self.projects.iter().find_map(|(root, project)| {
            path.strip_prefix(root)
                .ok()
                .and_then(|_| path_to_relative(root, path).ok())
                .filter(|relative| !relative.is_empty())
                .map(|relative| (project, relative))
        })
    }

    pub(crate) fn search_roots(&self) -> Vec<PathBuf> {
        let mut roots: Vec<PathBuf> = Vec::new();
        for (root, _) in self.projects.iter().rev() {
            if !roots.iter().any(|selected| root.starts_with(selected)) {
                roots.push(root.clone());
            }
        }
        roots
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.projects.is_empty()
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_search<F>(
    emit_event: F,
    rg: PathBuf,
    projects: Vec<Project>,
    request_id: String,
    query: String,
    options: SearchOptions,
    cancel: CancellationToken,
    resume: Arc<tokio::sync::Notify>,
) -> GazeResult<()>
where
    F: Fn(SearchEvent) + Send + Sync + 'static,
{
    let lookup = ProjectLookup::new(projects);
    if lookup.projects.is_empty() {
        return Err(GazeError::Message(
            "项目目录当前不可访问，无法搜索。".to_string(),
        ));
    }
    let search_roots = lookup.search_roots();
    let working_directory = search_roots
        .first()
        .cloned()
        .unwrap_or_else(|| PathBuf::from("."));
    let mut command = Command::new(&rg);
    apply_search_args(
        &mut command,
        &query,
        &options,
        &search_roots,
        &working_directory,
    );
    command
        .current_dir(&working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| {
        GazeError::ToolMissing(format!("无法启动 ripgrep（{}）：{error}", rg.display()))
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| GazeError::Message("无法读取 ripgrep 输出。".to_string()))?;
    let stderr = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        let mut buffer = String::new();
        if let Some(stderr) = stderr {
            let mut reader = BufReader::new(stderr);
            let _ = reader.read_to_string(&mut buffer).await;
        }
        buffer
    });
    let mut reader = BufReader::new(stdout).lines();
    let mut pending = Vec::new();
    let mut received = 0usize;
    let mut page_count = 0usize;
    let mut truncated = false;

    loop {
        let line = tokio::select! {
            _ = cancel.cancelled() => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Ok(());
            }
            line = reader.next_line() => line?,
        };
        let Some(line) = line else {
            break;
        };
        let Some(hit) = parse_rg_line(&line, &lookup, &working_directory) else {
            continue;
        };
        pending.push(hit);
        received += 1;
        page_count += 1;
        if pending.len() >= SEARCH_BATCH_SIZE {
            emit_event(SearchEvent::Batch {
                request_id: request_id.clone(),
                matches: std::mem::take(&mut pending),
                received: received as u64,
            });
        }
        if received >= SEARCH_MAX_RESULTS {
            truncated = true;
            break;
        }
        if page_count >= SEARCH_PAGE_SIZE {
            flush_batch(&emit_event, &request_id, &mut pending, received);
            emit_event(SearchEvent::Paused {
                request_id: request_id.clone(),
                received: received as u64,
                has_more: true,
            });
            page_count = 0;
            tokio::select! {
                _ = cancel.cancelled() => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    return Ok(());
                }
                _ = resume.notified() => {}
            }
        }
    }

    if cancel.is_cancelled() {
        let _ = child.start_kill();
        let _ = child.wait().await;
        return Ok(());
    }
    flush_batch(&emit_event, &request_id, &mut pending, received);
    if truncated {
        let _ = child.start_kill();
    }
    let status = child.wait().await?;
    let stderr = stderr_task.await.unwrap_or_default();
    if !truncated && !status.success() && status.code() != Some(1) {
        return Err(GazeError::Message(clean_rg_error(&stderr)));
    }
    tracing::info!(matches = received, truncated, "workspace search complete");
    emit_event(SearchEvent::Done {
        request_id,
        received: received as u64,
        truncated,
    });
    Ok(())
}

pub(crate) fn apply_search_args(
    command: &mut Command,
    query: &str,
    options: &SearchOptions,
    search_roots: &[PathBuf],
    working_directory: &Path,
) {
    command
        .arg("--json")
        .arg("--line-number")
        .arg("--column")
        .arg("--color=never")
        .arg("--no-heading")
        .arg("--with-filename")
        .arg("--no-require-git");
    if !options.regex {
        command.arg("--fixed-strings");
    }
    if options.case_sensitive {
        command.arg("--case-sensitive");
    } else {
        command.arg("--ignore-case");
    }
    if options.include_hidden {
        command.arg("--hidden");
    }
    if options.include_ignored {
        command.arg("--no-ignore");
    }
    for pattern in &options.include_globs {
        command.arg("--glob").arg(pattern);
    }
    for pattern in &options.exclude_globs {
        command.arg("--glob").arg(format!("!{pattern}"));
    }
    command.arg("--glob").arg("!.git/**");
    command.arg("--").arg(query);
    for root in search_roots {
        let argument = root
            .strip_prefix(working_directory)
            .ok()
            .filter(|path| !path.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| root.clone());
        command.arg(argument);
    }
}

pub(crate) fn parse_rg_line(line: &str, lookup: &ProjectLookup, cwd: &Path) -> Option<SearchHit> {
    let message: Value = serde_json::from_str(line).ok()?;
    if message.get("type")?.as_str()? != "match" {
        return None;
    }
    let data = message.get("data")?;
    let raw_path = data
        .pointer("/path/text")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            data.pointer("/path/bytes")
                .and_then(Value::as_str)
                .and_then(|encoded| {
                    base64::engine::general_purpose::STANDARD
                        .decode(encoded)
                        .ok()
                })
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        })?;
    let raw_path = PathBuf::from(raw_path);
    let absolute_path = if raw_path.is_absolute() {
        raw_path
    } else {
        cwd.join(raw_path)
    };
    let (project, relative) = lookup.resolve(&absolute_path)?;
    let line_number = data.get("line_number")?.as_u64()? as u32;
    let (line_bytes, text) = rg_line_text(data.get("lines")?)?;
    let text = text.trim_end_matches(['\n', '\r']);
    let mut ranges = data
        .get("submatches")
        .and_then(Value::as_array)
        .map(|submatches| {
            submatches
                .iter()
                .filter_map(|submatch| {
                    let start = submatch.get("start")?.as_u64()? as usize;
                    let end = submatch.get("end")?.as_u64()? as usize;
                    Some(SearchRange {
                        start: byte_offset_to_utf16(&line_bytes, start)?,
                        end: byte_offset_to_utf16(&line_bytes, end)?,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let (preview, adjusted_ranges) = preview_window(text, &mut ranges);
    Some(SearchHit {
        project_id: project.id.clone(),
        project_name: project.name.clone(),
        path: relative,
        line: line_number.saturating_sub(1),
        preview,
        ranges: adjusted_ranges,
    })
}

fn rg_line_text(value: &Value) -> Option<(Vec<u8>, String)> {
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        return Some((text.as_bytes().to_vec(), text.to_string()));
    }
    let encoded = value.get("bytes").and_then(Value::as_str)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Some((bytes, text))
}

fn byte_offset_to_utf16(bytes: &[u8], offset: usize) -> Option<u32> {
    let safe_end = offset.min(bytes.len());
    let prefix = std::str::from_utf8(&bytes[..safe_end]).ok()?;
    Some(prefix.encode_utf16().count() as u32)
}

fn preview_window(text: &str, ranges: &mut [SearchRange]) -> (String, Vec<SearchRange>) {
    let units: Vec<u16> = text.encode_utf16().collect();
    const MAX_PREVIEW_UNITS: usize = 520;
    if units.len() <= MAX_PREVIEW_UNITS {
        return (text.to_string(), ranges.to_vec());
    }
    let first = ranges
        .first()
        .map(|range| range.start as usize)
        .unwrap_or(0);
    let start = first
        .saturating_sub(140)
        .min(units.len().saturating_sub(MAX_PREVIEW_UNITS));
    let end = (start + MAX_PREVIEW_UNITS).min(units.len());
    let mut preview = String::from_utf16_lossy(&units[start..end]);
    let prefix_width = if start > 0 { 1 } else { 0 };
    if start > 0 {
        preview.insert(0, '…');
    }
    if end < units.len() {
        preview.push('…');
    }
    let adjusted = ranges
        .iter()
        .filter_map(|range| {
            let range_start = range.start as usize;
            let range_end = range.end as usize;
            if range_end <= start || range_start >= end {
                return None;
            }
            Some(SearchRange {
                start: (range_start.saturating_sub(start) + prefix_width) as u32,
                end: (range_end.min(end).saturating_sub(start) + prefix_width) as u32,
            })
        })
        .collect();
    (preview, adjusted)
}

fn flush_batch<F>(emit_event: &F, request_id: &str, pending: &mut Vec<SearchHit>, received: usize)
where
    F: Fn(SearchEvent),
{
    if pending.is_empty() {
        return;
    }
    emit_event(SearchEvent::Batch {
        request_id: request_id.to_string(),
        matches: std::mem::take(pending),
        received: received as u64,
    });
}

fn emit(app: &AppHandle, event: SearchEvent) {
    let _ = app.emit("gaze://search", event);
}

fn clean_rg_error(stderr: &str) -> String {
    let message = stderr.trim();
    if message.is_empty() {
        return "ripgrep 搜索失败。".to_string();
    }
    let concise = message.lines().take(4).collect::<Vec<_>>().join("\n");
    format!("搜索失败：{concise}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lookup(root: &Path) -> ProjectLookup {
        ProjectLookup::new(vec![Project {
            id: "p1".to_string(),
            name: "Demo".to_string(),
            root: root.display().to_string(),
        }])
    }

    #[test]
    fn parses_unicode_match_and_utf16_ranges() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let path = root.join("src/你好.ts");
        let line = serde_json::json!({
            "type": "match",
            "data": {
                "path": {"text": path.display().to_string()},
                "lines": {"text": "const emoji = \"😀\"; const 名字 = 1;\n"},
                "line_number": 7,
                "absolute_offset": 0,
                "submatches": [
                    {"match": {"text": "名字"}, "start": 28, "end": 34}
                ]
            }
        })
        .to_string();
        let hit = parse_rg_line(&line, &lookup(&root), &root).unwrap();
        assert_eq!(hit.project_id, "p1");
        assert_eq!(hit.path, "src/你好.ts");
        assert_eq!(hit.line, 6);
        assert_eq!(hit.ranges[0].start, 26);
        assert_eq!(hit.ranges[0].end, 28);
    }

    #[test]
    fn ignores_non_match_messages() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        assert!(parse_rg_line(
            r#"{"type":"begin","data":{"path":{"text":"ignored.ts"}}}"#,
            &lookup(&root),
            &root
        )
        .is_none());
    }

    #[test]
    fn maps_nested_projects_by_longest_root() {
        let temporary = tempfile::tempdir().unwrap();
        let outer = temporary.path().canonicalize().unwrap();
        let inner = outer.join("packages/app");
        std::fs::create_dir_all(inner.join("src")).unwrap();
        std::fs::write(inner.join("src/main.ts"), "export {}").unwrap();
        let lookup = ProjectLookup::new(vec![
            Project {
                id: "outer".to_string(),
                name: "Outer".to_string(),
                root: outer.display().to_string(),
            },
            Project {
                id: "inner".to_string(),
                name: "Inner".to_string(),
                root: inner.display().to_string(),
            },
        ]);
        let (project, path) = lookup.resolve(&inner.join("src/main.ts")).unwrap();
        assert_eq!(project.id, "inner");
        assert_eq!(path, "src/main.ts");
    }

    #[test]
    fn long_preview_keeps_match_window() {
        let mut ranges = vec![SearchRange {
            start: 900,
            end: 904,
        }];
        let (preview, adjusted) = preview_window(&"x".repeat(2_000), &mut ranges);
        assert!(preview.encode_utf16().count() <= 522);
        assert_eq!(adjusted.len(), 1);
        assert!(preview.contains('…'));
    }

    #[test]
    fn rg_arguments_respect_ignore_and_case_options() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let lookup = ProjectLookup::new(vec![Project {
            id: "p".to_string(),
            name: "P".to_string(),
            root: root.display().to_string(),
        }]);
        let roots = lookup.search_roots();
        let mut command = Command::new("rg");
        apply_search_args(
            &mut command,
            "needle",
            &SearchOptions {
                case_sensitive: true,
                regex: true,
                include_ignored: true,
                include_hidden: true,
                include_globs: vec!["src/**".into()],
                exclude_globs: vec!["src/generated/**".into()],
                ..Default::default()
            },
            &roots,
            &root,
        );
        let args = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(args.contains(&"--case-sensitive".to_string()));
        assert!(!args.contains(&"--ignore-case".to_string()));
        assert!(!args.contains(&"--fixed-strings".to_string()));
        assert!(args.contains(&"--no-ignore".to_string()));
        assert!(args.contains(&"--hidden".to_string()));
        let include = args.iter().position(|arg| arg == "src/**").unwrap();
        let exclude = args
            .iter()
            .position(|arg| arg == "!src/generated/**")
            .unwrap();
        let git = args.iter().position(|arg| arg == "!.git/**").unwrap();
        assert!(include < exclude && exclude < git);
    }

    #[test]
    fn nested_projects_are_searched_once_but_keep_attribution() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let inner = root.join("packages/app");
        std::fs::create_dir_all(inner.join("src")).unwrap();
        std::fs::write(inner.join("src/main.ts"), "const value = 1;").unwrap();
        let lookup = ProjectLookup::new(vec![
            Project {
                id: "outer".to_string(),
                name: "Outer".to_string(),
                root: root.display().to_string(),
            },
            Project {
                id: "inner".to_string(),
                name: "Inner".to_string(),
                root: inner.display().to_string(),
            },
        ]);
        assert_eq!(lookup.search_roots(), vec![root.clone()]);
        let (project, relative) = lookup.resolve(&inner.join("src/main.ts")).unwrap();
        assert_eq!(project.id, "inner");
        assert_eq!(relative, "src/main.ts");
    }

    #[tokio::test]
    async fn real_ripgrep_json_respects_gitignore_and_decodes_unicode() {
        async fn collect(
            rg: &Path,
            root: &Path,
            lookup: &ProjectLookup,
            options: SearchOptions,
        ) -> Vec<SearchHit> {
            let mut command = tokio::process::Command::new(rg);
            let roots = lookup.search_roots();
            apply_search_args(&mut command, "needle", &options, &roots, root);
            let output = command.output().await.unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| parse_rg_line(line, lookup, root))
                .collect()
        }

        let rg = match which::which("rg") {
            Ok(path) => path,
            Err(_) => return,
        };
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("ignored")).unwrap();
        std::fs::write(root.join("src/main.ts"), "const 你好 = 'needle';\n").unwrap();
        std::fs::write(root.join("ignored/secret.ts"), "const secret = 'needle';\n").unwrap();
        std::fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
        let lookup = ProjectLookup::new(vec![Project {
            id: "p".to_string(),
            name: "Demo".to_string(),
            root: root.display().to_string(),
        }]);
        let options = SearchOptions {
            case_sensitive: false,
            regex: false,
            include_ignored: false,
            include_hidden: false,
            ..Default::default()
        };

        let hits = collect(&rg, &root, &lookup, options.clone()).await;
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "src/main.ts");
        assert_eq!(hits[0].preview, "const 你好 = 'needle';");
        let expected_start = "const 你好 = '".encode_utf16().count() as u32;
        assert_eq!(hits[0].ranges[0].start, expected_start);

        let all_hits = collect(
            &rg,
            &root,
            &lookup,
            SearchOptions {
                include_ignored: true,
                ..options
            },
        )
        .await;
        assert_eq!(all_hits.len(), 2);
    }

    #[tokio::test]
    #[ignore = "requires GAZE_REAL_PROJECT pointing at a large real workspace"]
    async fn real_large_workspace_streams_200_results_and_cancels() {
        let root = match std::env::var("GAZE_REAL_PROJECT") {
            Ok(root) => PathBuf::from(root),
            Err(_) => return,
        };
        let rg = match which::which("rg") {
            Ok(path) => path,
            Err(_) => return,
        };
        let project = Project {
            id: "real".to_string(),
            name: "Real project".to_string(),
            root: root.display().to_string(),
        };
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        let cancel_handle = cancel.clone();
        let options = SearchOptions {
            case_sensitive: false,
            regex: false,
            include_ignored: true,
            include_hidden: true,
            ..Default::default()
        };
        let started = std::time::Instant::now();
        let task = tokio::spawn(run_search(
            move |event| {
                let _ = sender.send(event);
            },
            rg,
            vec![project],
            "real".to_string(),
            "const".to_string(),
            options,
            cancel,
            Arc::new(tokio::sync::Notify::new()),
        ));
        let mut received = 0usize;
        loop {
            let event = tokio::time::timeout(std::time::Duration::from_secs(30), receiver.recv())
                .await
                .expect("real project search should emit within 30 seconds")
                .expect("channel open");
            match event {
                SearchEvent::Batch {
                    matches,
                    received: count,
                    ..
                } => {
                    received += matches.len();
                    assert_eq!(received, count as usize);
                }
                SearchEvent::Paused {
                    received: count, ..
                } => {
                    assert_eq!(count, SEARCH_PAGE_SIZE as u64);
                    cancel_handle.cancel();
                    break;
                }
                SearchEvent::Done { .. } => break,
                SearchEvent::Error { message, .. } => panic!("{message}"),
            }
        }
        tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .expect("search should cancel promptly")
            .unwrap()
            .unwrap();
        eprintln!(
            "real workspace: streamed {received} results in {} ms",
            started.elapsed().as_millis()
        );
        assert_eq!(received, SEARCH_PAGE_SIZE);
    }

    #[tokio::test]
    async fn real_streaming_search_pauses_resumes_and_cancels() {
        let rg = match which::which("rg") {
            Ok(path) => path,
            Err(_) => return,
        };
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let mut content = String::new();
        for index in 0..450 {
            content.push_str(&format!("const value{index} = 'needle';\n"));
        }
        std::fs::write(root.join("matches.ts"), content).unwrap();
        let project = Project {
            id: "p".to_string(),
            name: "Demo".to_string(),
            root: root.display().to_string(),
        };
        let options = SearchOptions {
            case_sensitive: false,
            regex: false,
            include_ignored: false,
            include_hidden: false,
            ..Default::default()
        };
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        let resume = Arc::new(tokio::sync::Notify::new());
        let resume_signal = Arc::clone(&resume);
        let task = tokio::spawn(run_search(
            move |event| {
                let _ = sender.send(event);
            },
            rg.clone(),
            vec![project.clone()],
            "request".to_string(),
            "needle".to_string(),
            options.clone(),
            cancel.clone(),
            resume,
        ));

        let mut batches = 0usize;
        let mut pauses = 0usize;
        let completed = loop {
            let event = tokio::time::timeout(std::time::Duration::from_secs(5), receiver.recv())
                .await
                .expect("search should emit events")
                .expect("search channel should stay open");
            match event {
                SearchEvent::Batch { matches, .. } => batches += matches.len(),
                SearchEvent::Paused { .. } => {
                    pauses += 1;
                    assert_eq!(batches % SEARCH_PAGE_SIZE, 0);
                    resume_signal.notify_one();
                }
                SearchEvent::Done {
                    received,
                    truncated,
                    ..
                } => {
                    assert!(!truncated);
                    break received as usize;
                }
                SearchEvent::Error { message, .. } => panic!("{message}"),
            }
        };
        assert!(pauses > 0);
        assert_eq!(batches, completed);
        assert_eq!(completed, 450);
        task.await.unwrap().unwrap();

        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        let cancel_handle = cancel.clone();
        let resume = Arc::new(tokio::sync::Notify::new());
        let task = tokio::spawn(run_search(
            move |event| {
                let _ = sender.send(event);
            },
            rg,
            vec![project],
            "cancel-request".to_string(),
            "needle".to_string(),
            options,
            cancel,
            resume,
        ));
        loop {
            let event = tokio::time::timeout(std::time::Duration::from_secs(5), receiver.recv())
                .await
                .unwrap()
                .unwrap();
            if matches!(event, SearchEvent::Paused { .. }) {
                cancel_handle.cancel();
                break;
            }
        }
        tokio::time::timeout(std::time::Duration::from_secs(10), task)
            .await
            .expect("cancelled search should stop promptly")
            .unwrap()
            .unwrap();
        let mut saw_done = false;
        while let Ok(Some(event)) =
            tokio::time::timeout(std::time::Duration::from_millis(150), receiver.recv()).await
        {
            saw_done |= matches!(event, SearchEvent::Done { .. });
        }
        assert!(!saw_done);
    }
}
