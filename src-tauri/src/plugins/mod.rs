mod execute;
#[cfg(test)]
mod tests;
pub(crate) use execute::{worker, WORKER_FLAG};

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use tokio::sync::{Mutex, Semaphore};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::cache::Cache;
use crate::error::{CommandError, GazeError, GazeResult};

const CATALOG_KEY: &str = "external_plugins_v1";
const MANIFEST: &str = "gaze-plugin.json";
const WORKERS: usize = 4;
const MAX_JOBS: usize = 32;
const MAX_MANIFEST: usize = 64 * 1024;
const MAX_INPUT: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Runtime {
    JavaScript,
    Native,
}

impl Runtime {
    fn entry_limit(self) -> usize {
        match self {
            Self::JavaScript => 2 * 1024 * 1024,
            Self::Native => 32 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    id: String,
    name: String,
    version: String,
    api_version: u32,
    runtime: Runtime,
    entry: String,
    contributes: Vec<Contribution>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Contribution {
    Command { id: String, title: String },
    Markdown { language: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledPlugin {
    manifest: Manifest,
    revision: Uuid,
    digest: String,
    enabled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Input {
    Command {
        id: String,
        text: String,
        language: String,
    },
    Markdown {
        language: String,
        code: String,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Output {
    Unchanged,
    Replace {
        text: String,
    },
    Text {
        text: String,
    },
    Table {
        headers: Vec<String>,
        rows: Vec<Vec<String>>,
    },
}

struct Job {
    revision: Uuid,
    cancel: CancellationToken,
}

#[derive(Default)]
struct Registry {
    jobs: HashMap<Uuid, Job>,
    early_cancels: VecDeque<(Uuid, Instant)>,
    stopped: bool,
}

impl Registry {
    fn cancel_revision(&self, revision: Uuid) {
        for job in self.jobs.values().filter(|job| job.revision == revision) {
            job.cancel.cancel();
        }
    }
}

pub(crate) struct Plugins {
    root: PathBuf,
    worker: PathBuf,
    cache: Cache,
    registry: Mutex<Registry>,
    permits: Semaphore,
}

fn invalid(message: &str) -> GazeError {
    GazeError::Message(message.into())
}

fn slug(value: &str) -> bool {
    value.len() <= 64
        && value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

fn label(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 160 && !value.chars().any(char::is_control)
}

impl Manifest {
    fn validate(&self) -> GazeResult<()> {
        if self.api_version != 1 {
            return Err(GazeError::Unsupported("插件 API 版本不兼容。".into()));
        }
        if !self
            .id
            .split_once('.')
            .is_some_and(|(publisher, name)| publisher != "gaze" && slug(publisher) && slug(name))
            || !label(&self.name)
            || !label(&self.version)
        {
            return Err(invalid("插件 ID、名称或版本无效。"));
        }
        if self.entry.len() > 100
            || self.entry.starts_with('.')
            || self.entry.ends_with('.')
            || self.entry.eq_ignore_ascii_case(MANIFEST)
            || !self
                .entry
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
            || self.entry.is_empty()
            || (self.runtime == Runtime::JavaScript && !self.entry.ends_with(".js"))
            || (cfg!(windows)
                && self.runtime == Runtime::Native
                && !self.entry.to_ascii_lowercase().ends_with(".exe"))
        {
            return Err(GazeError::InvalidPath(
                "插件入口必须是目录中的单个文件名。".into(),
            ));
        }
        if self.contributes.is_empty() || self.contributes.len() > 32 {
            return Err(invalid("插件必须声明 1 至 32 项功能。"));
        }
        let mut commands = HashSet::new();
        let mut languages = HashSet::new();
        for contribution in &self.contributes {
            match contribution {
                Contribution::Command { id, title }
                    if slug(id) && label(title) && commands.insert(id) => {}
                Contribution::Markdown { language }
                    if self.runtime == Runtime::JavaScript
                        && slug(language)
                        && languages.insert(language) => {}
                _ => return Err(invalid("插件贡献无效、重复或不适用于该运行类型。")),
            }
        }
        Ok(())
    }

    fn languages(&self) -> impl Iterator<Item = &str> {
        self.contributes
            .iter()
            .filter_map(|contribution| match contribution {
                Contribution::Markdown { language } => Some(language.as_str()),
                _ => None,
            })
    }

    fn accepts(&self, input: &Input) -> bool {
        match input {
            Input::Command { id, text, language } => text.len() <= MAX_INPUT
                && !text.is_empty()
                && language.len() <= 160
                && self.contributes.iter().any(|item| matches!(item, Contribution::Command { id: command, .. } if command == id)),
            Input::Markdown { language, code } => code.len() <= MAX_INPUT && self.languages().any(|item| item == language),
        }
    }
}

fn read_file(root: &Path, name: &str, max: usize) -> GazeResult<Vec<u8>> {
    let path = root.join(name);
    // A package has two direct, regular files. Do not open links, devices, or FIFOs.
    if !fs::symlink_metadata(&path)?.is_file() || path.canonicalize()?.parent() != Some(root) {
        return Err(GazeError::InvalidPath(
            "插件必须使用目录内的普通文件。".into(),
        ));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(GazeError::InvalidPath(
            "插件必须使用目录内的普通文件。".into(),
        ));
    }
    let mut bytes = Vec::new();
    file.take(max as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > max {
        return Err(GazeError::TooLarge("插件文件超过大小限制。".into()));
    }
    Ok(bytes)
}

fn digest(manifest: &[u8], entry: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update((manifest.len() as u64).to_le_bytes());
    hash.update(manifest);
    hash.update(entry);
    format!("{:x}", hash.finalize())
}

fn write_native(path: &Path, bytes: &[u8]) -> GazeResult<()> {
    fs::write(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn stage(source: &Path, root: &Path) -> GazeResult<(InstalledPlugin, tempfile::TempDir)> {
    if !fs::symlink_metadata(source)?.is_dir() {
        return Err(GazeError::InvalidPath("请选择一个普通插件目录。".into()));
    }
    let source = source.canonicalize()?;
    let manifest_bytes = read_file(&source, MANIFEST, MAX_MANIFEST)?;
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)?;
    manifest.validate()?;
    let entry = read_file(&source, &manifest.entry, manifest.runtime.entry_limit())?;
    if manifest.runtime == Runtime::JavaScript && std::str::from_utf8(&entry).is_err() {
        return Err(invalid("JavaScript 插件入口必须使用 UTF-8。"));
    }
    fs::create_dir_all(root)?;
    let revision = Uuid::new_v4();
    let directory = tempfile::Builder::new()
        .prefix(&format!("{revision}-"))
        .rand_bytes(0)
        .tempdir_in(root)?;
    fs::write(directory.path().join(MANIFEST), &manifest_bytes)?;
    fs::write(directory.path().join(&manifest.entry), &entry)?;
    Ok((
        InstalledPlugin {
            manifest,
            revision,
            digest: digest(&manifest_bytes, &entry),
            enabled: false,
        },
        directory,
    ))
}

impl Plugins {
    pub(crate) fn new(root: PathBuf, cache: Cache, worker: PathBuf) -> Self {
        Self {
            root,
            worker,
            cache,
            registry: Mutex::default(),
            permits: Semaphore::new(WORKERS),
        }
    }

    async fn catalog(&self) -> GazeResult<(Option<String>, Vec<InstalledPlugin>)> {
        let raw = self.cache.setting(CATALOG_KEY).await?;
        let installed = match &raw {
            Some(raw) => serde_json::from_str(raw)?,
            None => Vec::new(),
        };
        Ok((raw, installed))
    }

    async fn commit(
        &self,
        raw: Option<String>,
        catalog: Vec<InstalledPlugin>,
    ) -> GazeResult<Vec<InstalledPlugin>> {
        if !self
            .cache
            .compare_setting(CATALOG_KEY, raw, serde_json::to_string(&catalog)?)
            .await?
        {
            return Err(GazeError::Conflict("插件列表已更改，请重试。".into()));
        }
        Ok(catalog)
    }

    fn directory(&self, revision: Uuid) -> PathBuf {
        self.root.join(format!("{revision}-"))
    }

    async fn remove_files(&self, revision: Uuid) {
        if let Err(error) = tokio::fs::remove_dir_all(self.directory(revision)).await {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(%error, "failed to remove old plugin files");
            }
        }
    }

    async fn list(&self) -> GazeResult<Vec<InstalledPlugin>> {
        Ok(self.catalog().await?.1)
    }

    async fn install(&self, source: PathBuf) -> GazeResult<Vec<InstalledPlugin>> {
        let root = self.root.clone();
        let (plugin, directory) =
            tokio::task::spawn_blocking(move || stage(&source, &root)).await??;
        let registry = self.registry.lock().await;
        let (raw, mut catalog) = self.catalog().await?;
        let old = catalog
            .iter()
            .find(|item| item.manifest.id == plugin.manifest.id)
            .map(|item| item.revision);
        catalog.retain(|item| item.manifest.id != plugin.manifest.id);
        catalog.push(plugin);
        catalog.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
        let directory = directory.keep();
        let plugins = match self.commit(raw, catalog).await {
            Ok(catalog) => catalog,
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(directory).await;
                return Err(error);
            }
        };
        if let Some(revision) = old {
            registry.cancel_revision(revision);
            drop(registry);
            self.remove_files(revision).await;
        }
        Ok(plugins)
    }

    async fn set_enabled(
        &self,
        id: &str,
        revision: Uuid,
        enabled: bool,
        approved: bool,
        reserved_languages: Vec<String>,
    ) -> GazeResult<Vec<InstalledPlugin>> {
        let registry = self.registry.lock().await;
        let (raw, mut catalog) = self.catalog().await?;
        let index = catalog
            .iter()
            .position(|item| item.manifest.id == id && item.revision == revision)
            .ok_or_else(|| GazeError::Conflict("插件版本已更改，请刷新后重试。".into()))?;
        let plugin = &catalog[index];
        if enabled && !plugin.enabled {
            if plugin.manifest.runtime == Runtime::Native && !approved {
                return Err(GazeError::Permission(
                    "本机插件需要单独确认运行权限。".into(),
                ));
            }
            for language in plugin.manifest.languages() {
                if reserved_languages.iter().any(|item| item == language)
                    || catalog.iter().any(|item| {
                        item.enabled && item.manifest.languages().any(|other| other == language)
                    })
                {
                    return Err(GazeError::Conflict(format!(
                        "Markdown 渲染器语言已被占用：{language}"
                    )));
                }
            }
            let directory = self.directory(revision);
            let snapshot = plugin.clone();
            tokio::task::spawn_blocking(move || execute::verified_entry(&snapshot, &directory))
                .await??;
        }
        catalog[index].enabled = enabled;
        let plugins = self.commit(raw, catalog).await?;
        if !enabled {
            registry.cancel_revision(revision);
        }
        Ok(plugins)
    }

    async fn uninstall(&self, revision: Uuid) -> GazeResult<Vec<InstalledPlugin>> {
        let registry = self.registry.lock().await;
        let (raw, mut catalog) = self.catalog().await?;
        catalog.retain(|item| item.revision != revision);
        let plugins = self.commit(raw, catalog).await?;
        registry.cancel_revision(revision);
        drop(registry);
        self.remove_files(revision).await;
        Ok(plugins)
    }

    async fn invoke(&self, revision: Uuid, request_id: Uuid, input: Input) -> GazeResult<Output> {
        let mut registry = self.registry.lock().await;
        if registry.stopped
            || registry
                .early_cancels
                .iter()
                .any(|(id, _)| *id == request_id)
        {
            return Err(GazeError::Cancelled);
        }
        if registry.jobs.len() >= MAX_JOBS || registry.jobs.contains_key(&request_id) {
            return Err(invalid("插件正在处理过多请求。"));
        }
        let plugin = self
            .catalog()
            .await?
            .1
            .into_iter()
            .find(|item| item.revision == revision && item.enabled)
            .ok_or_else(|| GazeError::NotFound("插件已停用或已移除。".into()))?;
        if !plugin.manifest.accepts(&input) {
            return Err(invalid("插件请求未声明或超过输入限制。"));
        }
        let cancel = CancellationToken::new();
        registry.jobs.insert(
            request_id,
            Job {
                revision,
                cancel: cancel.clone(),
            },
        );
        drop(registry);
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(GazeError::Cancelled),
            permit = self.permits.acquire() => {
                let _permit = permit.map_err(|_| GazeError::Cancelled)?;
                execute::run(plugin, self.directory(revision), input, &cancel, self.worker.clone()).await
            }
        };
        let mut registry = self.registry.lock().await;
        registry.jobs.remove(&request_id);
        let result = result?;
        let still_enabled = !cancel.is_cancelled()
            && self
                .catalog()
                .await?
                .1
                .iter()
                .any(|item| item.revision == revision && item.enabled);
        if still_enabled {
            Ok(result)
        } else {
            Err(GazeError::Cancelled)
        }
    }

    async fn cancel(&self, request_id: Uuid) {
        let mut registry = self.registry.lock().await;
        if let Some(job) = registry.jobs.get(&request_id) {
            job.cancel.cancel();
        } else {
            let now = Instant::now();
            registry
                .early_cancels
                .retain(|(_, time)| now.duration_since(*time) < Duration::from_secs(10));
            if registry.early_cancels.len() >= 128 {
                registry.early_cancels.pop_front();
            }
            registry.early_cancels.push_back((request_id, now));
        }
    }

    pub(crate) async fn shutdown(&self) {
        {
            let mut registry = self.registry.lock().await;
            registry.stopped = true;
            for job in registry.jobs.values() {
                job.cancel.cancel();
            }
        }
        let _permits = self.permits.acquire_many(WORKERS as u32).await;
    }
}

pub(crate) async fn apply_builtin_preferences(
    state: &crate::AppState,
    previous: Option<&crate::preferences::Preferences>,
    next: &crate::preferences::Preferences,
) {
    if previous.is_some_and(|previous| {
        previous.ai_completion_enabled != next.ai_completion_enabled
            || previous.ai_completion != next.ai_completion
    }) {
        state.ai_completion.reset();
    }
    state.lsp.set_python_enabled(next.python_enabled).await;
    state
        .lsp
        .set_typescript_enabled(next.typescript_enabled)
        .await;
}

#[tauri::command]
pub(crate) async fn list_plugins(
    plugins: State<'_, Plugins>,
) -> Result<Vec<InstalledPlugin>, CommandError> {
    Ok(plugins.list().await?)
}

#[tauri::command]
pub(crate) async fn install_plugin(
    plugins: State<'_, Plugins>,
    directory: PathBuf,
) -> Result<Vec<InstalledPlugin>, CommandError> {
    Ok(plugins.install(directory).await?)
}

#[tauri::command]
pub(crate) async fn set_plugin_enabled(
    plugins: State<'_, Plugins>,
    id: String,
    revision: Uuid,
    enabled: bool,
    approved: bool,
    reserved_languages: Vec<String>,
) -> Result<Vec<InstalledPlugin>, CommandError> {
    Ok(plugins
        .set_enabled(&id, revision, enabled, approved, reserved_languages)
        .await?)
}

#[tauri::command]
pub(crate) async fn uninstall_plugin(
    plugins: State<'_, Plugins>,
    revision: Uuid,
) -> Result<Vec<InstalledPlugin>, CommandError> {
    Ok(plugins.uninstall(revision).await?)
}

#[tauri::command]
pub(crate) async fn invoke_plugin(
    plugins: State<'_, Plugins>,
    revision: Uuid,
    request_id: Uuid,
    input: Input,
) -> Result<Output, CommandError> {
    Ok(plugins.invoke(revision, request_id, input).await?)
}

#[tauri::command]
pub(crate) async fn cancel_plugin(
    plugins: State<'_, Plugins>,
    request_id: Uuid,
) -> Result<(), CommandError> {
    plugins.cancel(request_id).await;
    Ok(())
}
