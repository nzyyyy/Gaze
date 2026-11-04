use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::error::{GazeError, GazeResult};
use crate::files::{read_file_with_bytes, restore_file_bytes, write_file};
use crate::git_workspace;
use crate::models::{
    FileContent, FileFingerprint, LineEnding, Project, SearchOptions, TextEncodingKind,
};
use crate::search::{apply_search_args, parse_rg_line, scope_projects, ProjectLookup};
use crate::AppState;

const MAX_REPLACE_FILES: usize = 200;
const MAX_REPLACE_MATCHES: usize = 5_000;
const MAX_PREVIEW_LINES: usize = 5;
const MAX_PREVIEW_CHARS: usize = 240;
const PREVIEW_CANCELLED: &str = "替换预览已取消。";

#[derive(Clone, Default)]
pub struct ReplacePreviewService {
    sessions: Arc<Mutex<HashMap<String, CancellationToken>>>,
}

impl ReplacePreviewService {
    fn start(&self, request_id: &str) -> GazeResult<CancellationToken> {
        if request_id.trim().is_empty() {
            return Err(GazeError::Message(
                "替换预览请求缺少 request id。".to_string(),
            ));
        }
        let cancel = CancellationToken::new();
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| GazeError::Message("替换预览会话锁已损坏。".to_string()))?;
        if let Some(old) = sessions.insert(request_id.to_string(), cancel.clone()) {
            old.cancel();
        }
        Ok(cancel)
    }

    fn finish(&self, request_id: &str, cancel: &CancellationToken) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if sessions
                .get(request_id)
                .is_some_and(|current| current == cancel)
            {
                sessions.remove(request_id);
            }
        }
    }

    pub fn cancel(&self, request_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(cancel) = sessions.remove(request_id) {
                cancel.cancel();
            }
        }
    }

    pub fn cancel_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, cancel) in sessions.drain() {
                cancel.cancel();
            }
        }
    }
}

#[derive(Clone)]
pub struct ReplaceUndoService {
    root: Arc<PathBuf>,
    publication_lock: Arc<Mutex<()>>,
}

#[derive(Clone)]
struct ReplaceUndoSession {
    inner: Arc<PendingUndoSession>,
}

struct PendingUndoSession {
    id: Uuid,
    directory: PathBuf,
    entries: Mutex<Vec<UndoEntry>>,
    published: AtomicBool,
}

impl Drop for PendingUndoSession {
    fn drop(&mut self) {
        if !self.published.load(Ordering::Acquire) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }
}

struct PreparedUndoBackup {
    session: ReplaceUndoSession,
    id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UndoManifest {
    id: Uuid,
    entries: Vec<UndoEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UndoEntry {
    backup_id: Uuid,
    project: Project,
    path: String,
    original_fingerprint: FileFingerprint,
    replaced_fingerprint: FileFingerprint,
    match_count: usize,
}

impl ReplaceUndoService {
    pub fn new(root: impl Into<PathBuf>) -> GazeResult<Self> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self {
            root: Arc::new(root),
            publication_lock: Arc::new(Mutex::new(())),
        })
    }

    fn current_directory(&self) -> PathBuf {
        self.root.join("current")
    }

    fn backup_path(&self, id: Uuid) -> PathBuf {
        self.current_directory().join(format!("{id}.bak"))
    }

    fn begin_session(&self) -> GazeResult<ReplaceUndoSession> {
        let id = Uuid::new_v4();
        let directory = self.root.join(format!("pending-{id}"));
        fs::create_dir(&directory)?;
        Ok(ReplaceUndoSession {
            inner: Arc::new(PendingUndoSession {
                id,
                directory,
                entries: Mutex::new(Vec::new()),
                published: AtomicBool::new(false),
            }),
        })
    }

    fn finish_session(&self, session: ReplaceUndoSession) -> GazeResult<()> {
        let entries = {
            let mut entries = session
                .inner
                .entries
                .lock()
                .map_err(|_| GazeError::Message("替换撤销会话锁已损坏。".to_string()))?;
            std::mem::take(&mut *entries)
        };
        if entries.is_empty() {
            return Ok(());
        }
        let manifest = UndoManifest {
            id: session.inner.id,
            entries,
        };
        Self::save_manifest(&session.inner.directory, &manifest)?;

        let _publication = self
            .publication_lock
            .lock()
            .map_err(|_| GazeError::Message("替换撤销发布锁已损坏。".to_string()))?;
        let current = self.current_directory();
        let retired = self.root.join(format!("retired-{}", Uuid::new_v4()));
        let had_current = match fs::symlink_metadata(&current) {
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        };
        if had_current {
            fs::rename(&current, &retired)?;
        }
        if let Err(error) = fs::rename(&session.inner.directory, &current) {
            if had_current {
                let _ = fs::rename(&retired, &current);
            }
            return Err(error.into());
        }
        session.inner.published.store(true, Ordering::Release);
        if had_current {
            fs::remove_dir_all(retired)?;
        }
        Ok(())
    }

    fn save_manifest(directory: &Path, manifest: &UndoManifest) -> GazeResult<()> {
        let bytes = serde_json::to_vec(manifest)?;
        let path = directory.join("manifest.json");
        let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
        temporary.write_all(&bytes)?;
        temporary.as_file().sync_all()?;
        temporary.persist(path).map_err(|error| error.error)?;
        Ok(())
    }

    fn current_manifest(&self) -> GazeResult<Option<UndoManifest>> {
        let path = self.current_directory().join("manifest.json");
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        Ok(Some(serde_json::from_slice(&bytes)?))
    }

    fn restore_entry(&self, entry: &UndoEntry) -> ReplaceOutcome {
        let original = match fs::read(self.backup_path(entry.backup_id)) {
            Ok(original) => original,
            Err(error) => {
                return outcome(
                    &entry.project.id,
                    &entry.path,
                    ReplaceStatus::Error,
                    entry.match_count,
                    Some(format!("无法读取替换备份：{error}")),
                )
            }
        };
        match restore_file_bytes(
            &entry.project,
            &entry.path,
            &original,
            entry.replaced_fingerprint,
        ) {
            Ok(_) => outcome(
                &entry.project.id,
                &entry.path,
                ReplaceStatus::Applied,
                entry.match_count,
                None,
            ),
            Err(GazeError::NotFound(_)) => undo_conflict(entry, "文件已不存在，未撤销。"),
            Err(GazeError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                undo_conflict(entry, "文件已不存在，未撤销。")
            }
            Err(GazeError::Conflict(_)) => undo_conflict(entry, "文件在替换后已变化，未撤销。"),
            Err(error) => outcome(
                &entry.project.id,
                &entry.path,
                ReplaceStatus::Error,
                entry.match_count,
                Some(error.message()),
            ),
        }
    }

    fn finish_undo(
        &self,
        session_id: Uuid,
        remaining: Vec<UndoEntry>,
        restored: Vec<Uuid>,
    ) -> GazeResult<()> {
        if restored.is_empty() {
            return Ok(());
        }
        let _publication = self
            .publication_lock
            .lock()
            .map_err(|_| GazeError::Message("替换撤销发布锁已损坏。".to_string()))?;
        let current = self.current_manifest()?;
        if current
            .as_ref()
            .is_none_or(|current| current.id != session_id)
        {
            return Err(GazeError::Conflict(
                "替换撤销会话已变化，请重试。".to_string(),
            ));
        }
        if remaining.is_empty() {
            fs::remove_dir_all(self.current_directory())?;
            return Ok(());
        }
        Self::save_manifest(
            &self.current_directory(),
            &UndoManifest {
                id: session_id,
                entries: remaining,
            },
        )?;
        for backup_id in restored {
            fs::remove_file(self.backup_path(backup_id))?;
        }
        Ok(())
    }
}

impl ReplaceUndoSession {
    fn prepare_backup(&self, original: &[u8]) -> GazeResult<PreparedUndoBackup> {
        let id = Uuid::new_v4();
        let path = self.inner.directory.join(format!("{id}.bak"));
        let mut file = tempfile::NamedTempFile::new_in(&self.inner.directory)?;
        file.write_all(original)?;
        file.as_file().sync_all()?;
        file.persist_noclobber(path).map_err(|error| error.error)?;
        Ok(PreparedUndoBackup {
            session: self.clone(),
            id,
        })
    }
}

impl PreparedUndoBackup {
    fn record(
        self,
        project: &Project,
        path: &str,
        original_fingerprint: FileFingerprint,
        replaced_fingerprint: FileFingerprint,
        match_count: usize,
    ) -> GazeResult<()> {
        let mut entries = self
            .session
            .inner
            .entries
            .lock()
            .map_err(|_| GazeError::Message("替换撤销会话锁已损坏。".to_string()))?;
        entries.push(UndoEntry {
            backup_id: self.id,
            project: project.clone(),
            path: path.to_string(),
            original_fingerprint,
            replaced_fingerprint,
            match_count,
        });
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePreview {
    pub files: Vec<ReplaceFilePreview>,
    pub skipped: Vec<ReplaceSkip>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceFilePreview {
    pub project_id: String,
    pub path: String,
    pub fingerprint: FileFingerprint,
    pub match_count: usize,
    pub lines: Vec<ReplacePreviewLine>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePreviewLine {
    pub line_number: usize,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceSkip {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceTarget {
    pub project_id: String,
    pub path: String,
    pub fingerprint: FileFingerprint,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceApplyResult {
    pub outcomes: Vec<ReplaceOutcome>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceOutcome {
    pub project_id: String,
    pub path: String,
    pub status: ReplaceStatus,
    pub match_count: usize,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReplaceStatus {
    Applied,
    Skipped,
    Conflict,
    Error,
}

#[derive(Clone)]
struct Replacer {
    regex: Regex,
    expand: bool,
}

impl Replacer {
    fn compile(query: &str, options: &SearchOptions) -> GazeResult<Self> {
        if query.is_empty() {
            return Err(GazeError::Message("请输入要替换的内容。".into()));
        }
        let pattern = if options.regex {
            query.to_string()
        } else {
            regex::escape(query)
        };
        let regex = RegexBuilder::new(&pattern)
            .case_insensitive(!options.case_sensitive)
            .multi_line(true)
            .dot_matches_new_line(false)
            .build()
            .map_err(|error| GazeError::Message(format!("正则表达式无效：{error}")))?;
        Ok(Self {
            regex,
            expand: options.regex,
        })
    }

    fn apply(&self, text: &str, replacement: &str) -> AppliedText {
        let mut count = 0;
        let mut starts = Vec::new();
        let mut replaced = String::with_capacity(text.len());
        let mut end = 0;
        for captures in self.regex.captures_iter(text) {
            let found = captures.get(0).expect("a regex match always has capture 0");
            replaced.push_str(&text[end..found.start()]);
            if starts.len() < MAX_PREVIEW_LINES {
                starts.push((found.start(), replaced.len()));
            }
            if self.expand {
                captures.expand(replacement, &mut replaced);
            } else {
                replaced.push_str(replacement);
            }
            count += 1;
            end = found.end();
        }
        replaced.push_str(&text[end..]);
        AppliedText {
            replaced,
            count,
            starts,
        }
    }
}

struct AppliedText {
    replaced: String,
    count: usize,
    starts: Vec<(usize, usize)>,
}

struct ComputedReplacement {
    fingerprint: FileFingerprint,
    encoding_kind: TextEncodingKind,
    line_ending: LineEnding,
    original_bytes: Vec<u8>,
    original: String,
    replaced: String,
    count: usize,
    starts: Vec<(usize, usize)>,
}

struct Discovery {
    candidates: Vec<(String, String)>,
    skipped: Vec<ReplaceSkip>,
    truncated: bool,
}

fn clip_line(text: &str, line_number: usize) -> String {
    let line = text.lines().nth(line_number).unwrap_or_default();
    let mut clipped: String = line.chars().take(MAX_PREVIEW_CHARS).collect();
    if line.chars().count() > MAX_PREVIEW_CHARS {
        clipped.push('…');
    }
    clipped
}

fn preview_lines(computed: &ComputedReplacement) -> Vec<ReplacePreviewLine> {
    computed
        .starts
        .iter()
        .map(|(before, after)| {
            let line_number = computed.original[..*before]
                .bytes()
                .filter(|byte| *byte == b'\n')
                .count();
            let after_line = computed.replaced[..*after]
                .bytes()
                .filter(|byte| *byte == b'\n')
                .count();
            ReplacePreviewLine {
                line_number,
                before: clip_line(&computed.original, line_number),
                after: clip_line(&computed.replaced, after_line),
            }
        })
        .collect()
}

fn compute_file_replacement(
    project: &Project,
    path: &str,
    replacer: &Replacer,
    replacement: &str,
) -> GazeResult<ComputedReplacement> {
    let (content, original_bytes) = read_file_with_bytes(project, path)?;
    let FileContent::Text {
        content,
        fingerprint,
        encoding_kind,
        line_ending,
        editable,
        edit_blocked_reason,
        ..
    } = content
    else {
        return Err(GazeError::Unsupported("二进制文件不可替换。".into()));
    };
    if !editable {
        return Err(GazeError::Unsupported(
            edit_blocked_reason.unwrap_or_else(|| "该文件当前不可编辑。".into()),
        ));
    }
    let applied = replacer.apply(&content, replacement);
    Ok(ComputedReplacement {
        fingerprint,
        encoding_kind,
        line_ending,
        original_bytes,
        original: content,
        replaced: applied.replaced,
        count: applied.count,
        starts: applied.starts,
    })
}

async fn discover_candidates(
    rg: &Path,
    projects: Vec<Project>,
    query: &str,
    options: &SearchOptions,
    cancel: CancellationToken,
) -> GazeResult<Discovery> {
    let lookup = ProjectLookup::new(projects);
    if lookup.is_empty() {
        return Err(GazeError::Message("项目目录当前不可访问。".to_string()));
    }
    let roots = lookup.search_roots();
    let working_directory = roots
        .first()
        .cloned()
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let mut command = Command::new(rg);
    apply_search_args(&mut command, query, options, &roots, &working_directory);
    command
        .current_dir(&working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| GazeError::ToolMissing(format!("无法启动 ripgrep：{error}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| GazeError::Message("无法读取 ripgrep 输出。".into()))?;
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
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    let mut skipped = Vec::new();
    let mut matches = 0usize;
    let mut truncated = false;
    loop {
        let line = tokio::select! {
            _ = cancel.cancelled() => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Err(GazeError::Message(PREVIEW_CANCELLED.into()));
            }
            line = reader.next_line() => line?,
        };
        let Some(line) = line else {
            break;
        };
        let value: serde_json::Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if value.get("type").and_then(|value| value.as_str()) != Some("match") {
            continue;
        }
        matches += value["data"]["submatches"].as_array().map_or(0, Vec::len);
        let Some(hit) = parse_rg_line(&line, &lookup, &working_directory) else {
            skipped.push(ReplaceSkip {
                path: String::new(),
                reason: "存在无法解码的匹配路径，已停止使用本次预览。".into(),
            });
            truncated = true;
            break;
        };
        let is_new = seen.insert((hit.project_id.clone(), hit.path.clone()));
        if matches > MAX_REPLACE_MATCHES || (is_new && candidates.len() == MAX_REPLACE_FILES) {
            truncated = true;
            break;
        }
        if is_new {
            candidates.push((hit.project_id, hit.path));
        }
    }
    if truncated {
        let _ = child.start_kill();
    }
    let status = tokio::select! {
        _ = cancel.cancelled() => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(GazeError::Message(PREVIEW_CANCELLED.into()));
        }
        status = child.wait() => status?,
    };
    let stderr = stderr_task.await.unwrap_or_default();
    if cancel.is_cancelled() {
        return Err(GazeError::Message(PREVIEW_CANCELLED.into()));
    }
    if !truncated && !status.success() && status.code() != Some(1) {
        return Err(GazeError::Message(format!(
            "搜索候选失败：{}",
            stderr.lines().take(4).collect::<Vec<_>>().join("\n")
        )));
    }
    Ok(Discovery {
        candidates,
        skipped,
        truncated,
    })
}

async fn compute_preview(
    discovery: Discovery,
    by_id: HashMap<String, Project>,
    replacer: Replacer,
    replacement: String,
    cancel: CancellationToken,
) -> Result<ReplacePreview, String> {
    let mut files = Vec::new();
    let mut skipped = discovery.skipped;
    let mut matches = 0;
    let mut truncated = discovery.truncated;
    for (project_id, path) in discovery.candidates {
        if cancel.is_cancelled() {
            return Err(PREVIEW_CANCELLED.into());
        }
        let Some(project) = by_id.get(&project_id) else {
            skipped.push(ReplaceSkip {
                path,
                reason: "项目已从工作区移除。".into(),
            });
            continue;
        };
        let project = project.clone();
        let compute_path = path.clone();
        let compute_replacer = replacer.clone();
        let compute_replacement = replacement.clone();
        let mut task = tokio::task::spawn_blocking(move || {
            compute_file_replacement(
                &project,
                &compute_path,
                &compute_replacer,
                &compute_replacement,
            )
        });
        let computed = tokio::select! {
            _ = cancel.cancelled() => return Err(PREVIEW_CANCELLED.into()),
            result = &mut task => result.map_err(|error| format!("替换预览任务失败：{error}"))?,
        };
        if cancel.is_cancelled() {
            return Err(PREVIEW_CANCELLED.into());
        }
        match computed {
            Ok(computed) if computed.count == 0 => skipped.push(ReplaceSkip {
                path,
                reason: "文件内容已变化，不再包含匹配。".into(),
            }),
            Ok(computed) => {
                matches += computed.count;
                truncated |= matches > MAX_REPLACE_MATCHES;
                let lines = preview_lines(&computed);
                files.push(ReplaceFilePreview {
                    project_id,
                    path,
                    fingerprint: computed.fingerprint,
                    match_count: computed.count,
                    lines,
                });
            }
            Err(error) => skipped.push(ReplaceSkip {
                path,
                reason: error.message(),
            }),
        }
    }
    if cancel.is_cancelled() {
        return Err(PREVIEW_CANCELLED.into());
    }
    Ok(ReplacePreview {
        files,
        skipped,
        truncated,
    })
}

#[tauri::command(async, rename_all = "camelCase")]
pub(crate) async fn preview_replace(
    request_id: String,
    query: String,
    replacement: String,
    options: SearchOptions,
    state: State<'_, AppState>,
) -> Result<ReplacePreview, String> {
    let cancel = state
        .replace_previews
        .start(&request_id)
        .map_err(|error| error.message())?;
    let result = async {
        let replacer = Replacer::compile(&query, &options).map_err(|error| error.message())?;
        let projects = state
            .cache
            .projects()
            .await
            .map_err(|error| error.message())?;
        let projects = scope_projects(projects, &options);
        if projects.is_empty() {
            return Err("所选项目当前不可搜索。".into());
        }
        let by_id: HashMap<_, _> = projects
            .iter()
            .map(|project| (project.id.clone(), project.clone()))
            .collect();
        let rg = state
            .tools
            .rg
            .clone()
            .ok_or_else(|| "未找到 ripgrep（rg）。".to_string())?;
        let discovery = discover_candidates(&rg, projects, &query, &options, cancel.clone())
            .await
            .map_err(|error| error.message())?;
        compute_preview(discovery, by_id, replacer, replacement, cancel.clone()).await
    }
    .await;
    state.replace_previews.finish(&request_id, &cancel);
    result
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn cancel_replace_preview(
    request_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.replace_previews.cancel(&request_id);
    Ok(())
}

fn outcome(
    project_id: &str,
    path: &str,
    status: ReplaceStatus,
    match_count: usize,
    message: Option<String>,
) -> ReplaceOutcome {
    ReplaceOutcome {
        project_id: project_id.to_string(),
        path: path.to_string(),
        status,
        match_count,
        message,
    }
}

fn undo_conflict(entry: &UndoEntry, message: &str) -> ReplaceOutcome {
    outcome(
        &entry.project.id,
        &entry.path,
        ReplaceStatus::Conflict,
        entry.match_count,
        Some(message.to_string()),
    )
}

fn apply_one(
    project: &Project,
    target: &ReplaceTarget,
    replacer: &Replacer,
    replacement: &str,
    undo_session: &ReplaceUndoSession,
) -> ReplaceOutcome {
    let computed = match compute_file_replacement(project, &target.path, replacer, replacement) {
        Ok(computed) => computed,
        Err(error) => {
            return outcome(
                &target.project_id,
                &target.path,
                ReplaceStatus::Error,
                0,
                Some(error.message()),
            )
        }
    };
    if computed.fingerprint != target.fingerprint {
        return outcome(
            &target.project_id,
            &target.path,
            ReplaceStatus::Conflict,
            0,
            Some("文件在预览后已变化，未写入。".into()),
        );
    }
    if computed.count == 0 {
        return outcome(
            &target.project_id,
            &target.path,
            ReplaceStatus::Skipped,
            0,
            Some("文件内容已变化，不再包含匹配。".into()),
        );
    }
    let backup = match undo_session.prepare_backup(&computed.original_bytes) {
        Ok(backup) => backup,
        Err(error) => {
            return outcome(
                &target.project_id,
                &target.path,
                ReplaceStatus::Error,
                computed.count,
                Some(format!("无法备份原文件，未写入：{}", error.message())),
            )
        }
    };
    let written = match write_file(
        project,
        &target.path,
        &computed.replaced,
        computed.fingerprint,
        computed.encoding_kind,
        computed.line_ending,
        false,
    ) {
        Ok(written) => written,
        Err(GazeError::Conflict(message)) => {
            return outcome(
                &target.project_id,
                &target.path,
                ReplaceStatus::Conflict,
                computed.count,
                Some(message),
            )
        }
        Err(error) => {
            return outcome(
                &target.project_id,
                &target.path,
                ReplaceStatus::Error,
                computed.count,
                Some(error.message()),
            )
        }
    };
    if let Err(error) = backup.record(
        project,
        &target.path,
        computed.fingerprint,
        written.fingerprint,
        computed.count,
    ) {
        return outcome(
            &target.project_id,
            &target.path,
            ReplaceStatus::Error,
            computed.count,
            Some(format!("替换已写入，但撤销记录失败：{}", error.message())),
        );
    }
    outcome(
        &target.project_id,
        &target.path,
        ReplaceStatus::Applied,
        computed.count,
        None,
    )
}

#[tauri::command(async)]
pub(crate) async fn apply_replace(
    query: String,
    replacement: String,
    targets: Vec<ReplaceTarget>,
    options: SearchOptions,
    state: State<'_, AppState>,
    undo_state: State<'_, ReplaceUndoService>,
    git_state: State<'_, git_workspace::AppState>,
) -> Result<ReplaceApplyResult, String> {
    if targets.is_empty() {
        return Err("没有选择要替换的文件。".into());
    }
    let replacer = Replacer::compile(&query, &options).map_err(|error| error.message())?;
    let projects = state
        .cache
        .projects()
        .await
        .map_err(|error| error.message())?;
    let projects = scope_projects(projects, &options);
    let by_id: HashMap<_, _> = projects
        .into_iter()
        .map(|project| (project.id.clone(), project))
        .collect();
    let _replace_guard = state.replace_lock.lock().await;
    let undo_session = undo_state
        .begin_session()
        .map_err(|error| error.message())?;
    let mut outcomes = Vec::new();
    for target in targets {
        let Some(project) = by_id.get(&target.project_id) else {
            outcomes.push(outcome(
                &target.project_id,
                &target.path,
                ReplaceStatus::Error,
                0,
                Some("项目已从工作区移除。".into()),
            ));
            continue;
        };
        let guard = match git_state.editor_guard(Path::new(&project.root)) {
            Ok(guard) => guard,
            Err(error) => {
                outcomes.push(outcome(
                    &target.project_id,
                    &target.path,
                    ReplaceStatus::Error,
                    0,
                    Some(error),
                ));
                continue;
            }
        };
        let project = project.clone();
        let replacer = replacer.clone();
        let replacement = replacement.clone();
        let session = undo_session.clone();
        let result = tokio::task::spawn_blocking(move || {
            apply_one(&project, &target, &replacer, &replacement, &session)
        })
        .await;
        match result {
            Ok(result) => outcomes.push(result),
            Err(error) => {
                undo_state
                    .finish_session(undo_session)
                    .map_err(|undo_error| undo_error.message())?;
                return Err(format!("应用替换任务失败：{error}"));
            }
        }
        drop(guard);
    }
    undo_state
        .finish_session(undo_session)
        .map_err(|error| error.message())?;
    Ok(ReplaceApplyResult { outcomes })
}

#[tauri::command(async)]
pub(crate) async fn undo_replace(
    state: State<'_, AppState>,
    undo_state: State<'_, ReplaceUndoService>,
    git_state: State<'_, git_workspace::AppState>,
) -> Result<ReplaceApplyResult, String> {
    let _replace_guard = state.replace_lock.lock().await;
    let manifest = undo_state
        .current_manifest()
        .map_err(|error| error.message())?
        .ok_or_else(|| "没有可撤销的替换。".to_string())?;
    let session_id = manifest.id;
    let mut outcomes = Vec::new();
    let mut remaining = Vec::new();
    let mut restored = Vec::new();
    for entry in manifest.entries {
        let guard = match git_state.editor_guard(Path::new(&entry.project.root)) {
            Ok(guard) => guard,
            Err(error) => {
                outcomes.push(outcome(
                    &entry.project.id,
                    &entry.path,
                    ReplaceStatus::Error,
                    entry.match_count,
                    Some(error),
                ));
                remaining.push(entry);
                continue;
            }
        };
        let undo = undo_state.inner().clone();
        let task_entry = entry.clone();
        let result = tokio::task::spawn_blocking(move || undo.restore_entry(&task_entry)).await;
        let result = match result {
            Ok(result) => result,
            Err(error) => outcome(
                &entry.project.id,
                &entry.path,
                ReplaceStatus::Error,
                entry.match_count,
                Some(format!("撤销替换任务失败：{error}")),
            ),
        };
        if matches!(result.status, ReplaceStatus::Applied) {
            restored.push(entry.backup_id);
        } else {
            remaining.push(entry);
        }
        outcomes.push(result);
        drop(guard);
    }
    undo_state
        .finish_undo(session_id, remaining, restored)
        .map_err(|error| error.message())?;
    Ok(ReplaceApplyResult { outcomes })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(root: &Path) -> Project {
        Project {
            id: "p".into(),
            name: "Demo".into(),
            root: root.display().to_string(),
        }
    }

    fn options(regex: bool) -> SearchOptions {
        SearchOptions {
            regex,
            ..Default::default()
        }
    }

    fn apply_for_test(
        project: &Project,
        paths: &[&str],
        replacement: &str,
        undo: &ReplaceUndoService,
    ) -> ReplaceApplyResult {
        let replacer = Replacer::compile("needle", &options(false)).unwrap();
        let session = undo.begin_session().unwrap();
        let outcomes = paths
            .iter()
            .map(|path| {
                let preview =
                    compute_file_replacement(project, path, &replacer, replacement).unwrap();
                apply_one(
                    project,
                    &ReplaceTarget {
                        project_id: project.id.clone(),
                        path: (*path).to_string(),
                        fingerprint: preview.fingerprint,
                    },
                    &replacer,
                    replacement,
                    &session,
                )
            })
            .collect();
        undo.finish_session(session).unwrap();
        ReplaceApplyResult { outcomes }
    }

    fn undo_for_test(undo: &ReplaceUndoService) -> ReplaceApplyResult {
        let manifest = undo.current_manifest().unwrap().unwrap();
        let mut outcomes = Vec::new();
        let mut remaining = Vec::new();
        let mut restored = Vec::new();
        for entry in manifest.entries {
            let result = undo.restore_entry(&entry);
            if matches!(result.status, ReplaceStatus::Applied) {
                restored.push(entry.backup_id);
            } else {
                remaining.push(entry);
            }
            outcomes.push(result);
        }
        undo.finish_undo(manifest.id, remaining, restored).unwrap();
        ReplaceApplyResult { outcomes }
    }

    #[test]
    fn literal_replacement_keeps_dollar_text_but_regex_expands_captures() {
        let literal = Replacer::compile("needle", &options(false)).unwrap();
        assert_eq!(literal.apply("needle needle", "$1").replaced, "$1 $1");
        let regex = Replacer::compile(r"item-(\d+)", &options(true)).unwrap();
        let applied = regex.apply("item-12 and item-34", "[$1]");
        assert_eq!(applied.replaced, "[12] and [34]");
        assert_eq!(applied.count, 2);
    }

    #[test]
    fn invalid_regex_is_rejected_before_any_file_is_read() {
        assert!(Replacer::compile("(", &options(true)).is_err());
    }

    #[test]
    fn preview_sessions_cancel_superseded_requests_without_clearing_new_ones() {
        let service = ReplacePreviewService::default();
        let first = service.start("request").unwrap();
        let second = service.start("request").unwrap();
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        service.finish("request", &first);
        service.cancel("request");
        assert!(second.is_cancelled());
    }

    #[tokio::test]
    async fn cancelled_preview_does_not_return_computed_files() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        std::fs::write(root.join("a.txt"), "needle\n").unwrap();
        let project = project(&root);
        let by_id = HashMap::from([(project.id.clone(), project)]);
        let cancel = CancellationToken::new();
        cancel.cancel();
        let result = compute_preview(
            Discovery {
                candidates: vec![("p".into(), "a.txt".into())],
                skipped: Vec::new(),
                truncated: false,
            },
            by_id,
            Replacer::compile("needle", &options(false)).unwrap(),
            "value".into(),
            cancel,
        )
        .await;
        assert_eq!(result.err().unwrap(), PREVIEW_CANCELLED);
    }

    #[tokio::test]
    async fn preview_computes_matches_and_preserves_skip_results() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        std::fs::write(root.join("a.txt"), "needle\nneedle\n").unwrap();
        std::fs::write(root.join("b.txt"), "unchanged\n").unwrap();
        let project = project(&root);
        let by_id = HashMap::from([(project.id.clone(), project)]);
        let preview = compute_preview(
            Discovery {
                candidates: vec![("p".into(), "a.txt".into()), ("p".into(), "b.txt".into())],
                skipped: Vec::new(),
                truncated: false,
            },
            by_id,
            Replacer::compile("needle", &options(false)).unwrap(),
            "value".into(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(preview.files.len(), 1);
        assert_eq!(preview.files[0].path, "a.txt");
        assert_eq!(preview.files[0].match_count, 2);
        assert_eq!(preview.skipped.len(), 1);
        assert_eq!(preview.skipped[0].path, "b.txt");
        assert!(!preview.truncated);
    }

    #[test]
    fn preview_tracks_unicode_and_multiline_replacement_positions() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        std::fs::write(root.join("a.txt"), "needle\nneedle\n").unwrap();
        let replacer = Replacer::compile("needle", &options(false)).unwrap();
        let computed =
            compute_file_replacement(&project(&root), "a.txt", &replacer, "😀\n新行").unwrap();
        let lines = preview_lines(&computed);
        assert_eq!(computed.count, 2);
        assert_eq!(computed.replaced, "😀\n新行\n😀\n新行\n");
        assert_eq!(lines[1].line_number, 1);
        assert_eq!(lines[1].before, "needle");
        assert_eq!(lines[1].after, "😀");
        std::fs::write(root.join("a.txt"), "needle needle").unwrap();
        let computed = compute_file_replacement(&project(&root), "a.txt", &replacer, "😀").unwrap();
        assert_eq!(preview_lines(&computed)[1].after, "😀 😀");
    }

    #[tokio::test]
    async fn discovery_limits_actual_matches_including_many_on_one_line() {
        let rg = match which::which("rg") {
            Ok(path) => path,
            Err(_) => return,
        };
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        std::fs::write(root.join("a.txt"), "a ".repeat(MAX_REPLACE_MATCHES)).unwrap();
        let exact = discover_candidates(
            &rg,
            vec![project(&root)],
            "a",
            &options(false),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert!(!exact.truncated);
        assert_eq!(exact.candidates.len(), 1);
        std::fs::write(root.join("a.txt"), "a ".repeat(MAX_REPLACE_MATCHES + 1)).unwrap();
        assert!(
            discover_candidates(
                &rg,
                vec![project(&root)],
                "a",
                &options(false),
                CancellationToken::new(),
            )
            .await
            .unwrap()
            .truncated
        );
    }

    #[test]
    fn stale_preview_is_a_conflict_and_never_overwrites() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        std::fs::write(root.join("a.txt"), "needle\n").unwrap();
        let project = project(&root);
        let replacer = Replacer::compile("needle", &options(false)).unwrap();
        let preview = compute_file_replacement(&project, "a.txt", &replacer, "changed").unwrap();
        let undo = ReplaceUndoService::new(root.join("replace-backups")).unwrap();
        let session = undo.begin_session().unwrap();
        std::fs::write(root.join("a.txt"), "external content\n").unwrap();
        let result = apply_one(
            &project,
            &ReplaceTarget {
                project_id: "p".into(),
                path: "a.txt".into(),
                fingerprint: preview.fingerprint,
            },
            &replacer,
            "changed",
            &session,
        );
        undo.finish_session(session).unwrap();
        assert!(matches!(result.status, ReplaceStatus::Conflict));
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "external content\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn undo_backups_are_private_even_when_the_store_already_exists() {
        use std::os::unix::fs::PermissionsExt;

        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        fs::write(root.join("secret.env"), "needle secret\n").unwrap();
        fs::set_permissions(root.join("secret.env"), fs::Permissions::from_mode(0o600)).unwrap();
        let backup_root = root.join("replace-backups");
        fs::create_dir(&backup_root).unwrap();
        fs::set_permissions(&backup_root, fs::Permissions::from_mode(0o755)).unwrap();
        let undo = ReplaceUndoService::new(&backup_root).unwrap();
        let result = apply_for_test(&project(&root), &["secret.env"], "changed", &undo);
        assert!(matches!(result.outcomes[0].status, ReplaceStatus::Applied));
        assert_eq!(
            fs::metadata(&backup_root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        for entry in fs::read_dir(undo.current_directory()).unwrap() {
            assert_eq!(
                entry.unwrap().metadata().unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert!(matches!(
            undo_for_test(&undo).outcomes[0].status,
            ReplaceStatus::Applied
        ));
        assert_eq!(
            fs::read_to_string(root.join("secret.env")).unwrap(),
            "needle secret\n"
        );
    }

    #[test]
    fn undo_restores_utf16_crlf_original_bytes_exactly() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let original = "needle\r\nsecond\r\n";
        let mut utf16 = vec![0xFF, 0xFE];
        utf16.extend(original.encode_utf16().flat_map(u16::to_le_bytes));
        std::fs::write(root.join("a.txt"), &utf16).unwrap();
        let project = project(&root);
        let undo = ReplaceUndoService::new(root.join("replace-backups")).unwrap();
        let result = apply_for_test(&project, &["a.txt"], "changed", &undo);
        assert!(matches!(result.outcomes[0].status, ReplaceStatus::Applied));
        let decoded = crate::files::read_file(&project, "a.txt").unwrap();
        let FileContent::Text {
            content,
            line_ending,
            ..
        } = decoded
        else {
            panic!("expected text");
        };
        assert_eq!(content, "changed\r\nsecond\r\n");
        assert_eq!(line_ending, LineEnding::Crlf);

        let result = undo_for_test(&undo);
        assert!(matches!(result.outcomes[0].status, ReplaceStatus::Applied));
        assert_eq!(std::fs::read(root.join("a.txt")).unwrap(), utf16);
        assert!(undo.current_manifest().unwrap().is_none());
    }

    #[test]
    fn undo_rejects_later_modification_and_missing_files() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        std::fs::write(root.join("a.txt"), "needle a\n").unwrap();
        std::fs::write(root.join("b.txt"), "needle b\n").unwrap();
        let project = project(&root);
        let undo = ReplaceUndoService::new(root.join("replace-backups")).unwrap();
        apply_for_test(&project, &["a.txt", "b.txt"], "changed", &undo);
        std::fs::write(root.join("a.txt"), "external content\n").unwrap();
        std::fs::remove_file(root.join("b.txt")).unwrap();

        let result = undo_for_test(&undo);
        assert_eq!(result.outcomes.len(), 2);
        assert!(result
            .outcomes
            .iter()
            .all(|outcome| matches!(outcome.status, ReplaceStatus::Conflict)));
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "external content\n"
        );
        assert!(!root.join("b.txt").exists());
        assert_eq!(undo.current_manifest().unwrap().unwrap().entries.len(), 2);
    }

    #[test]
    fn partial_undo_keeps_failed_backup_for_retry() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        std::fs::write(root.join("a.txt"), "needle a\r\n").unwrap();
        std::fs::write(root.join("b.txt"), "needle b\r\n").unwrap();
        let project = project(&root);
        let undo = ReplaceUndoService::new(root.join("replace-backups")).unwrap();
        apply_for_test(&project, &["a.txt", "b.txt"], "changed", &undo);
        let before = undo.current_manifest().unwrap().unwrap();
        let a_backup = before.entries[0].backup_id;
        let b_backup = before.entries[1].backup_id;
        let replaced_a = std::fs::read(root.join("a.txt")).unwrap();
        let mut permissions = std::fs::metadata(root.join("a.txt")).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(root.join("a.txt"), permissions).unwrap();

        let first = undo_for_test(&undo);
        assert!(matches!(first.outcomes[0].status, ReplaceStatus::Error));
        assert!(matches!(first.outcomes[1].status, ReplaceStatus::Applied));
        assert_eq!(std::fs::read(root.join("a.txt")).unwrap(), replaced_a);
        assert_eq!(
            std::fs::read_to_string(root.join("b.txt")).unwrap(),
            "needle b\r\n"
        );
        let remaining = undo.current_manifest().unwrap().unwrap();
        assert_eq!(remaining.entries.len(), 1);
        assert_eq!(remaining.entries[0].path, "a.txt");
        assert!(undo.backup_path(a_backup).exists());
        assert!(!undo.backup_path(b_backup).exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(root.join("a.txt")).unwrap().permissions();
            permissions.set_mode(0o600);
            std::fs::set_permissions(root.join("a.txt"), permissions).unwrap();
        }
        #[cfg(windows)]
        {
            let mut permissions = std::fs::metadata(root.join("a.txt")).unwrap().permissions();
            permissions.set_readonly(false);
            std::fs::set_permissions(root.join("a.txt"), permissions).unwrap();
        }
        let second = undo_for_test(&undo);
        assert_eq!(second.outcomes.len(), 1);
        assert!(matches!(second.outcomes[0].status, ReplaceStatus::Applied));
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "needle a\r\n"
        );
        assert!(undo.current_manifest().unwrap().is_none());
    }

    #[test]
    fn unfinished_session_does_not_replace_previous_undo_data() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        std::fs::write(root.join("a.txt"), "needle a\n").unwrap();
        std::fs::write(root.join("b.txt"), "needle b\n").unwrap();
        let project = project(&root);
        let undo = ReplaceUndoService::new(root.join("replace-backups")).unwrap();
        apply_for_test(&project, &["a.txt"], "changed", &undo);
        let first = undo.current_manifest().unwrap().unwrap();

        let pending = undo.begin_session().unwrap();
        let backup = pending.prepare_backup(b"uncommitted").unwrap();
        drop(backup);
        assert_eq!(undo.current_manifest().unwrap().unwrap().id, first.id);
        drop(pending);
        assert_eq!(undo.current_manifest().unwrap().unwrap().id, first.id);

        apply_for_test(&project, &["b.txt"], "changed", &undo);
        let second = undo.current_manifest().unwrap().unwrap();
        assert_ne!(second.id, first.id);
        assert_eq!(second.entries.len(), 1);
        assert_eq!(second.entries[0].path, "b.txt");
    }
}
