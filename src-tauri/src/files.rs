use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use uuid::Uuid;

use crate::error::{GazeError, GazeResult};
use crate::models::{
    DirEntry, DirectoryListing, FileContent, FileFingerprint, FileMode, LineEnding, Project,
    TextEncodingKind, WriteResult,
};

pub const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
pub const HIGHLIGHT_FILE_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_HIGHLIGHT_LINE_UTF16: usize = 20_000;

const TEMP_FILE_PREFIX: &str = ".gaze-write-";

pub fn is_internal_temp_name(name: &str) -> bool {
    name.starts_with(TEMP_FILE_PREFIX)
}

pub fn normalize_relative(relative: &str) -> GazeResult<PathBuf> {
    if relative.is_empty() {
        return Ok(PathBuf::new());
    }
    if relative.contains('\0') {
        return Err(GazeError::InvalidPath("路径包含无效字符。".to_string()));
    }
    let native = if std::path::MAIN_SEPARATOR == '/' {
        relative.to_string()
    } else {
        relative.replace('/', std::path::MAIN_SEPARATOR_STR)
    };
    let path = PathBuf::from(native);
    if path.is_absolute() {
        return Err(GazeError::InvalidPath("只接受项目内相对路径。".to_string()));
    }
    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir if relative == "." => {}
            _ => {
                return Err(GazeError::InvalidPath(
                    "路径不能包含 ..、根目录或平台前缀。".to_string(),
                ));
            }
        }
    }
    if relative == "." {
        return Ok(PathBuf::new());
    }
    Ok(path)
}

pub fn path_to_relative(root: &Path, path: &Path) -> GazeResult<String> {
    let relative = path.strip_prefix(root).map_err(|_| {
        GazeError::InvalidPath(format!("路径不在项目 {} 内。", root.to_string_lossy()))
    })?;
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(name) => {
                let value = name.to_str().ok_or_else(|| {
                    GazeError::InvalidPath("文件名不是有效的 Unicode。".to_string())
                })?;
                parts.push(value);
            }
            _ => return Err(GazeError::InvalidPath("路径包含不支持的组件。".to_string())),
        }
    }
    Ok(parts.join("/"))
}

pub fn resolve_within_root(root: &Path, relative: &str) -> GazeResult<PathBuf> {
    let relative_path = normalize_relative(relative)?;
    let candidate = root.join(&relative_path);
    let resolved = candidate
        .canonicalize()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => {
                GazeError::NotFound(format!("文件 {} 不存在。", relative))
            }
            std::io::ErrorKind::PermissionDenied => {
                GazeError::Permission(format!("没有权限访问 {}。", relative))
            }
            _ => GazeError::Io(error),
        })?;
    ensure_within(root, &resolved)?;
    Ok(resolved)
}

fn ensure_within(root: &Path, resolved: &Path) -> GazeResult<()> {
    if resolved.starts_with(root) {
        Ok(())
    } else {
        Err(GazeError::InvalidPath(
            "符号链接指向项目目录之外，已拒绝访问。".to_string(),
        ))
    }
}

pub fn fingerprint(metadata: &fs::Metadata) -> FileFingerprint {
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().min(i64::MAX as u128) as i64)
        .unwrap_or(0);
    FileFingerprint {
        size: metadata.len(),
        modified_ns,
    }
}

fn validate_entry_name(name: &str) -> GazeResult<()> {
    if name.trim().is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', '\0'])
        || name.eq_ignore_ascii_case(".git")
        || is_internal_temp_name(&name.to_ascii_lowercase())
        || (cfg!(windows)
            && (name.contains(['<', '>', ':', '"', '|', '?', '*'])
                || name.chars().any(char::is_control)
                || name.ends_with(['.', ' '])
                || is_windows_device_name(name)))
    {
        return Err(GazeError::InvalidPath(
            "名称无效或为受保护的名称。".to_string(),
        ));
    }
    Ok(())
}

fn is_windows_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
        })
}

// Resolve parents without following links; leave the final component untouched for link operations.
fn mutation_path(root: &Path, relative: &str, allow_root: bool) -> GazeResult<PathBuf> {
    normalize_relative(relative)?;
    if relative.is_empty() {
        return if allow_root {
            Ok(root.to_path_buf())
        } else {
            Err(GazeError::InvalidPath("不能修改项目根目录。".to_string()))
        };
    }
    let parts: Vec<_> = relative.split('/').collect();
    let mut path = root.to_path_buf();
    for (index, part) in parts.iter().enumerate() {
        validate_entry_name(part)?;
        path.push(part);
        if index + 1 < parts.len() {
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(GazeError::InvalidPath(
                    "父目录必须为项目内的真实文件夹。".to_string(),
                ));
            }
            ensure_within(root, &path.canonicalize()?)?;
        }
    }
    Ok(path)
}

fn mutation_directory(root: &Path, relative: &str) -> GazeResult<PathBuf> {
    let path = mutation_path(root, relative, true)?;
    let metadata = fs::symlink_metadata(&path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(GazeError::InvalidPath(
            "目标必须为项目内的真实文件夹。".to_string(),
        ));
    }
    ensure_within(root, &path.canonicalize()?)?;
    Ok(path)
}

pub fn entry_path(project: &Project, relative: &str) -> GazeResult<PathBuf> {
    let path = mutation_path(Path::new(&project.root), relative, true)?;
    fs::symlink_metadata(&path)?;
    Ok(path)
}

pub fn clipboard_path(project: &Project, path: &str, relative: bool) -> GazeResult<PathBuf> {
    let absolute = entry_path(project, path)?;
    Ok(if relative {
        PathBuf::from(if path.is_empty() { "." } else { path })
    } else {
        absolute
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteResult {
    entries: Vec<DirEntry>,
    failures: Vec<PasteFailure>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PasteFailure {
    name: String,
    message: String,
}

pub fn paste_entries(
    project: &Project,
    parent: &str,
    sources: &[PathBuf],
) -> GazeResult<PasteResult> {
    paste_entries_with(project, parent, sources, crate::native_files::copy_item)
}

pub fn copy_dropped_files(
    project: &Project,
    parent: &str,
    sources: &[PathBuf],
) -> GazeResult<PasteResult> {
    let mut failures = Vec::new();
    let sources: Vec<_> = sources
        .iter()
        .filter_map(
            |source| match crate::external_files::canonical_file(source) {
                Ok(path) => Some(path),
                Err(error) => {
                    failures.push(PasteFailure {
                        name: source
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .into(),
                        message: error.message(),
                    });
                    None
                }
            },
        )
        .collect();
    if sources.is_empty() {
        mutation_directory(Path::new(&project.root), parent)?;
        return Ok(PasteResult {
            entries: vec![],
            failures,
        });
    }
    let mut result = paste_entries(project, parent, &sources)?;
    result.failures.extend(failures);
    Ok(result)
}

fn paste_entries_with(
    project: &Project,
    parent: &str,
    sources: &[PathBuf],
    copy: impl Fn(&Path, &Path) -> GazeResult<()>,
) -> GazeResult<PasteResult> {
    let directory = mutation_directory(Path::new(&project.root), parent)?;
    if sources.is_empty() {
        return Err(GazeError::Message("剪贴板中没有可粘贴的文件。".into()));
    }
    let mut result = PasteResult {
        entries: Vec::new(),
        failures: Vec::new(),
    };
    for source in sources {
        let copied = (|| {
            let name = source
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| GazeError::InvalidPath("文件名无效。".into()))?;
            validate_entry_name(name)?;
            let metadata = fs::symlink_metadata(source)?;
            if metadata.is_dir() && directory.starts_with(source.canonicalize()?) {
                return Err(GazeError::InvalidPath(
                    "不能将目录复制到自身或子目录。".into(),
                ));
            }
            // Stage on the destination volume, then publish without ever replacing an existing item.
            let stage = tempfile::Builder::new()
                .prefix(TEMP_FILE_PREFIX)
                .tempdir_in(&directory)?;
            let staged = stage.path().join("item");
            copy(source, &staged)?;
            let mut number = 0u64;
            loop {
                let name = if number == 0 {
                    name.to_string()
                } else {
                    let (stem, extension) = if metadata.is_dir() {
                        (name, String::new())
                    } else {
                        (
                            source
                                .file_stem()
                                .and_then(|value| value.to_str())
                                .unwrap_or(name),
                            source
                                .extension()
                                .and_then(|value| value.to_str())
                                .map(|value| format!(".{value}"))
                                .unwrap_or_default(),
                        )
                    };
                    let suffix = if number == 1 {
                        String::new()
                    } else {
                        format!(" {number}")
                    };
                    format!("{stem} 副本{suffix}{extension}")
                };
                mutation_directory(Path::new(&project.root), parent)?;
                let target = directory.join(&name);
                match rename_no_replace(&staged, &target) {
                    Ok(()) => {
                        let path = if parent.is_empty() {
                            name
                        } else {
                            format!("{parent}/{name}")
                        };
                        return Ok(mutation_entry(
                            &path,
                            &fs::symlink_metadata(&target)?,
                            &target,
                        ));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => number += 1,
                    Err(error) => return Err(error.into()),
                }
            }
        })();
        match copied {
            Ok(entry) => result.entries.push(entry),
            Err(error) => result.failures.push(PasteFailure {
                name: source
                    .file_name()
                    .unwrap_or(source.as_os_str())
                    .to_string_lossy()
                    .into_owned(),
                message: error.to_string(),
            }),
        }
    }
    Ok(result)
}

fn protect_project_roots(path: &Path, projects: &[Project]) -> GazeResult<()> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Ok(());
    }
    let canonical = path.canonicalize()?;
    if projects
        .iter()
        .any(|project| Path::new(&project.root).starts_with(&canonical))
    {
        return Err(GazeError::InvalidPath(
            "该目录包含已导入项目的根目录，不能移动或删除。".to_string(),
        ));
    }
    Ok(())
}

fn mutation_entry(path: &str, metadata: &fs::Metadata, target: &Path) -> DirEntry {
    let is_symlink = metadata.file_type().is_symlink();
    DirEntry {
        name: path.rsplit('/').next().unwrap_or(path).to_string(),
        path: path.to_string(),
        is_dir: if is_symlink {
            fs::metadata(target).is_ok_and(|m| m.is_dir())
        } else {
            metadata.is_dir()
        },
        is_symlink,
        size: metadata.len(),
        modified_ms: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| time.as_millis().min(u64::MAX as u128) as u64),
    }
}

pub fn create_entry(
    project: &Project,
    parent: &str,
    name: &str,
    is_dir: bool,
) -> GazeResult<DirEntry> {
    validate_entry_name(name)?;
    let directory = mutation_directory(Path::new(&project.root), parent)?;
    let target = directory.join(name);
    if is_dir {
        fs::create_dir(&target).map_err(mutation_error)?;
    } else {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(mutation_error)?;
    }
    let path = if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    };
    Ok(mutation_entry(
        &path,
        &fs::symlink_metadata(&target)?,
        &target,
    ))
}

fn mutation_error(error: std::io::Error) -> GazeError {
    if error.kind() == std::io::ErrorKind::AlreadyExists {
        GazeError::Conflict("目标名称已存在，未覆盖任何内容。".to_string())
    } else if error.kind() == std::io::ErrorKind::CrossesDevices {
        GazeError::Unsupported("不支持跨文件系统移动，请选择同一文件系统内的目录。".to_string())
    } else {
        error.into()
    }
}

pub fn move_entry(
    project: &Project,
    relative: &str,
    destination: &str,
    projects: &[Project],
) -> GazeResult<DirEntry> {
    let root = Path::new(&project.root);
    let source = mutation_path(root, relative, false)?;
    let target = mutation_path(root, destination, false)?;
    protect_project_roots(&source, projects)?;
    let parent = destination
        .rsplit_once('/')
        .map_or("", |(parent, _)| parent);
    mutation_directory(root, parent)?;
    let metadata = fs::symlink_metadata(&source)?;
    let entry = mutation_entry(destination, &metadata, &source);
    if relative == destination {
        return Ok(entry);
    }
    if metadata.is_dir() && target.starts_with(&source) {
        return Err(GazeError::InvalidPath(
            "不能将目录移动到自身或子目录。".to_string(),
        ));
    }
    rename_no_replace(&source, &target).map_err(mutation_error)?;
    Ok(entry)
}

fn rename_no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    rustix::fs::renameat_with(
        rustix::fs::CWD,
        source,
        rustix::fs::CWD,
        target,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(std::io::Error::from)?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let from: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        // Zero flags forbids replacing an existing destination or copying across volumes.
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(from.as_ptr(), to.as_ptr(), 0)
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

pub fn trash_entry(project: &Project, relative: &str, projects: &[Project]) -> GazeResult<()> {
    trash_entry_with(project, relative, projects, |path| {
        let context = trash::TrashContext::default();
        #[cfg(target_os = "macos")]
        let context = {
            use trash::macos::{DeleteMethod, TrashContextExtMacos};
            let mut context = context;
            // Native trash avoids Finder automation permissions and subprocesses.
            context.set_delete_method(DeleteMethod::NsFileManager);
            context
        };
        context
            .delete(path)
            .map_err(|error| GazeError::Message(format!("无法移到废纸篓：{error}")))
    })
}

fn trash_entry_with(
    project: &Project,
    relative: &str,
    projects: &[Project],
    trash: impl FnOnce(&Path) -> GazeResult<()>,
) -> GazeResult<()> {
    let path = mutation_path(Path::new(&project.root), relative, false)?;
    protect_project_roots(&path, projects)?;
    trash(&path)
}

pub fn list_directory(project: &Project, relative: &str) -> GazeResult<DirectoryListing> {
    let root = Path::new(&project.root);
    let target = resolve_within_root(root, relative)?;
    let target_metadata = fs::metadata(&target)?;
    if !target_metadata.is_dir() {
        return Err(GazeError::InvalidPath(format!(
            "{} 不是目录。",
            if relative.is_empty() {
                "项目根目录"
            } else {
                relative
            }
        )));
    }

    let mut entries = Vec::new();
    for item in fs::read_dir(&target)? {
        let item = item?;
        let name = match item.file_name().into_string() {
            Ok(name) => name,
            Err(_) => continue,
        };
        if name == ".git" || name == ".DS_Store" || is_internal_temp_name(&name) {
            continue;
        }
        let file_type = match item.file_type() {
            Ok(file_type) => file_type,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => continue,
            Err(error) => return Err(error.into()),
        };
        let is_symlink = file_type.is_symlink();
        let metadata = if is_symlink {
            fs::metadata(item.path()).ok()
        } else {
            Some(item.metadata()?)
        };
        let is_dir = metadata
            .as_ref()
            .map(|metadata| metadata.is_dir())
            .unwrap_or(file_type.is_dir());
        let modified_ms = metadata
            .as_ref()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64);
        let path = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        entries.push(DirEntry {
            name,
            path,
            is_dir,
            is_symlink,
            size: metadata
                .as_ref()
                .map(|metadata| metadata.len())
                .unwrap_or(0),
            modified_ms,
        });
    }
    entries.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(DirectoryListing {
        project_id: project.id.clone(),
        path: relative.to_string(),
        entries,
    })
}

pub fn read_file(project: &Project, relative: &str) -> GazeResult<FileContent> {
    read_file_with_bytes(project, relative).map(|(content, _)| content)
}

pub(crate) fn read_file_with_bytes(
    project: &Project,
    relative: &str,
) -> GazeResult<(FileContent, Vec<u8>)> {
    let root = Path::new(&project.root);
    let path = resolve_within_root(root, relative)?;
    let metadata = fs::metadata(&path)?;
    if metadata.is_dir() {
        return Err(GazeError::InvalidPath(format!(
            "{relative} 是目录，不能作为文件打开。"
        )));
    }
    let file_fingerprint = fingerprint(&metadata);
    if metadata.len() > MAX_FILE_BYTES {
        return Err(GazeError::TooLarge(format!(
            "文件大小为 {:.1} MiB，超过 {} MiB 读取上限。",
            metadata.len() as f64 / 1_048_576.0,
            MAX_FILE_BYTES / 1_048_576
        )));
    }
    let bytes = fs::read(&path)?;
    let utf16_bom = bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]);
    let utf8_bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
    let scan_bytes = if utf16_bom {
        None
    } else if utf8_bom {
        Some(&bytes[3..])
    } else {
        Some(bytes.as_slice())
    };
    if scan_bytes.is_some_and(has_nul) {
        return Ok((
            FileContent::Binary {
                project_id: project.id.clone(),
                path: relative.to_string(),
                fingerprint: file_fingerprint,
                size: metadata.len(),
            },
            bytes,
        ));
    }
    let decoded = decode(&bytes);
    let content = decoded.content;
    let encoding = decoded.encoding;
    let encoding_kind = decoded.encoding_kind;
    let mut warnings = decoded.warnings;
    let line_ending = detect_line_ending(&content);
    if content.is_empty() {
        let (editable, edit_blocked_reason) = edit_policy(encoding_kind, FileMode::Normal);
        return Ok((
            FileContent::Text {
                project_id: project.id.clone(),
                path: relative.to_string(),
                content,
                encoding,
                encoding_kind,
                line_ending,
                mode: FileMode::Normal,
                editable,
                edit_blocked_reason,
                fingerprint: file_fingerprint,
                size: metadata.len(),
                warnings,
            },
            bytes,
        ));
    }

    let max_line_utf16 = content
        .lines()
        .map(|line| line.encode_utf16().count())
        .max()
        .unwrap_or(0);
    let mode = if metadata.len() > HIGHLIGHT_FILE_BYTES {
        warnings.push("文件较大，已切换为纯文本模式。".to_string());
        FileMode::Large
    } else if max_line_utf16 > MAX_HIGHLIGHT_LINE_UTF16 {
        warnings.push("检测到超长行，已关闭高亮、折叠和自动换行。".to_string());
        FileMode::LongLine
    } else {
        FileMode::Normal
    };
    let (editable, edit_blocked_reason) = edit_policy(encoding_kind, mode);

    Ok((
        FileContent::Text {
            project_id: project.id.clone(),
            path: relative.to_string(),
            content,
            encoding,
            encoding_kind,
            line_ending,
            mode,
            editable,
            edit_blocked_reason,
            fingerprint: file_fingerprint,
            size: metadata.len(),
            warnings,
        },
        bytes,
    ))
}

struct DecodedFile {
    content: String,
    encoding: String,
    encoding_kind: TextEncodingKind,
    warnings: Vec<String>,
}

fn decode(bytes: &[u8]) -> DecodedFile {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return match std::str::from_utf8(&bytes[3..]) {
            Ok(text) => DecodedFile {
                content: text.to_string(),
                encoding: "UTF-8 BOM".to_string(),
                encoding_kind: TextEncodingKind::Utf8Bom,
                warnings: Vec::new(),
            },
            Err(_) => DecodedFile {
                content: String::from_utf8_lossy(&bytes[3..]).into_owned(),
                encoding: "UTF-8 BOM（含无效字节）".to_string(),
                encoding_kind: TextEncodingKind::LossyUtf8,
                warnings: vec!["文件包含无效 UTF-8 字节，已替换为替换字符。".to_string()],
            },
        };
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, had_errors) = encoding_rs::UTF_16LE.decode_with_bom_removal(bytes);
        return DecodedFile {
            content: text.into_owned(),
            encoding: "UTF-16 LE".to_string(),
            encoding_kind: if had_errors {
                TextEncodingKind::LossyUtf8
            } else {
                TextEncodingKind::Utf16Le
            },
            warnings: utf16_warnings(had_errors),
        };
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, had_errors) = encoding_rs::UTF_16BE.decode_with_bom_removal(bytes);
        return DecodedFile {
            content: text.into_owned(),
            encoding: "UTF-16 BE".to_string(),
            encoding_kind: if had_errors {
                TextEncodingKind::LossyUtf8
            } else {
                TextEncodingKind::Utf16Be
            },
            warnings: utf16_warnings(had_errors),
        };
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => DecodedFile {
            content: text.to_string(),
            encoding: "UTF-8".to_string(),
            encoding_kind: TextEncodingKind::Utf8,
            warnings: Vec::new(),
        },
        Err(_) => DecodedFile {
            content: String::from_utf8_lossy(bytes).into_owned(),
            encoding: "UTF-8（含无效字节）".to_string(),
            encoding_kind: TextEncodingKind::LossyUtf8,
            warnings: vec!["文件包含无效 UTF-8 字节，已替换为替换字符。".to_string()],
        },
    }
}

fn utf16_warnings(had_errors: bool) -> Vec<String> {
    if had_errors {
        vec!["文件包含无法解码的 UTF-16 数据，已替换无效字符。".to_string()]
    } else {
        Vec::new()
    }
}

fn edit_policy(encoding_kind: TextEncodingKind, mode: FileMode) -> (bool, Option<String>) {
    if encoding_kind == TextEncodingKind::LossyUtf8 {
        return (
            false,
            Some("文件包含无效 UTF-8 字节，保存可能破坏原始内容，因此仅支持阅读。".to_string()),
        );
    }
    match mode {
        FileMode::Normal => (true, None),
        FileMode::Large => (false, Some("文件超过 2 MiB，仅支持阅读。".to_string())),
        FileMode::LongLine => (false, Some("文件包含超长行，仅支持阅读。".to_string())),
    }
}

fn detect_line_ending(text: &str) -> LineEnding {
    let crlf = text.match_indices("\r\n").count();
    let lf = text.matches('\n').count().saturating_sub(crlf);
    if crlf > lf {
        return LineEnding::Crlf;
    }
    if lf > crlf {
        return LineEnding::Lf;
    }
    match text.find('\n') {
        Some(index) if index > 0 && text.as_bytes()[index - 1] == b'\r' => LineEnding::Crlf,
        _ => LineEnding::Lf,
    }
}

fn apply_line_ending(text: &str, line_ending: LineEnding) -> String {
    match line_ending {
        LineEnding::Lf => text.replace("\r\n", "\n"),
        LineEnding::Crlf => {
            let mut output = String::with_capacity(text.len() + text.matches('\n').count());
            let mut previous = '\0';
            for character in text.chars() {
                if character == '\n' && previous != '\r' {
                    output.push('\r');
                }
                output.push(character);
                previous = character;
            }
            output
        }
    }
}

fn encode_text(text: &str, encoding_kind: TextEncodingKind) -> GazeResult<Vec<u8>> {
    match encoding_kind {
        TextEncodingKind::Utf8 => Ok(text.as_bytes().to_vec()),
        TextEncodingKind::Utf8Bom => {
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend_from_slice(text.as_bytes());
            Ok(bytes)
        }
        TextEncodingKind::Utf16Le => {
            let mut bytes = vec![0xFF, 0xFE];
            for unit in text.encode_utf16() {
                bytes.extend_from_slice(&unit.to_le_bytes());
            }
            Ok(bytes)
        }
        TextEncodingKind::Utf16Be => {
            let mut bytes = vec![0xFE, 0xFF];
            for unit in text.encode_utf16() {
                bytes.extend_from_slice(&unit.to_be_bytes());
            }
            Ok(bytes)
        }
        TextEncodingKind::LossyUtf8 => Err(GazeError::Unsupported(
            "该文件包含无效 UTF-8 字节，不能安全保存。".to_string(),
        )),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn write_file(
    project: &Project,
    relative: &str,
    content: &str,
    base_fingerprint: FileFingerprint,
    encoding_kind: TextEncodingKind,
    line_ending: LineEnding,
    force: bool,
) -> GazeResult<WriteResult> {
    if encoding_kind == TextEncodingKind::LossyUtf8 {
        return Err(GazeError::Unsupported(
            "该文件包含无效 UTF-8 字节，不能安全保存。".to_string(),
        ));
    }
    let normalized = apply_line_ending(content, line_ending);
    let bytes = encode_text(&normalized, encoding_kind)?;
    write_bytes(
        project,
        relative,
        &bytes,
        base_fingerprint,
        force,
        "保存后的文件",
    )
}

pub(crate) fn restore_file_bytes(
    project: &Project,
    relative: &str,
    bytes: &[u8],
    base_fingerprint: FileFingerprint,
) -> GazeResult<WriteResult> {
    write_bytes(
        project,
        relative,
        bytes,
        base_fingerprint,
        false,
        "恢复后的文件",
    )
}

fn write_bytes(
    project: &Project,
    relative: &str,
    bytes: &[u8],
    base_fingerprint: FileFingerprint,
    force: bool,
    size_label: &str,
) -> GazeResult<WriteResult> {
    let root = Path::new(&project.root);
    let path = resolve_within_root(root, relative)?;
    let metadata = fs::metadata(&path)?;
    if metadata.is_dir() {
        return Err(GazeError::InvalidPath(format!(
            "{relative} 是目录，不能写入。"
        )));
    }
    if metadata.permissions().readonly() {
        return Err(GazeError::Permission("文件是只读的。".to_string()));
    }
    let current_fingerprint = fingerprint(&metadata);
    if !force && current_fingerprint != base_fingerprint {
        return Err(GazeError::Conflict(
            "文件已在磁盘上被修改，保存已阻止。请重新载入或确认覆盖。".to_string(),
        ));
    }
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(GazeError::TooLarge(format!(
            "{size_label}大小为 {:.1} MiB，超过 {} MiB 上限。",
            bytes.len() as f64 / 1_048_576.0,
            MAX_FILE_BYTES / 1_048_576
        )));
    }
    write_atomically(&path, bytes, &metadata)?;
    let metadata = fs::metadata(&path)?;
    Ok(WriteResult {
        fingerprint: fingerprint(&metadata),
        size: metadata.len(),
    })
}

fn write_atomically(path: &Path, bytes: &[u8], original: &fs::Metadata) -> GazeResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| GazeError::InvalidPath("无法确定文件的父目录。".to_string()))?;
    let temp_path = parent.join(format!("{TEMP_FILE_PREFIX}{}.tmp", Uuid::new_v4()));
    let result = (|| -> GazeResult<()> {
        let mut temp = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        temp.write_all(bytes)?;
        temp.set_permissions(original.permissions())?;
        temp.sync_all()?;
        drop(temp);
        fs::rename(&temp_path, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn has_nul(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|byte| *byte == 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn mutation_project(directory: &Path) -> Project {
        Project {
            id: "p".into(),
            name: "test".into(),
            root: directory.canonicalize().unwrap().display().to_string(),
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dropped_files_copy_without_overwriting_and_report_invalid_items() {
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let project = mutation_project(root.path());
        fs::create_dir(root.path().join("target")).unwrap();
        fs::write(root.path().join("target/a.txt"), "existing").unwrap();
        let source = external.path().join("a.txt");
        fs::write(&source, "source").unwrap();
        let folder = external.path().join("folder");
        fs::create_dir(&folder).unwrap();
        let sources = vec![source.clone(), folder, external.path().join("missing")];
        let result = copy_dropped_files(&project, "target", &sources).unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].path, "target/a 副本.txt");
        assert_eq!(result.failures.len(), 2);
        assert_eq!(
            fs::read_to_string(root.path().join("target/a.txt")).unwrap(),
            "existing"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("target/a 副本.txt")).unwrap(),
            "source"
        );
        assert_eq!(fs::read_to_string(source).unwrap(), "source");
        assert!(copy_dropped_files(&project, "../escape", &sources).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn paste_copies_files_directories_and_symlinks_without_overwriting() {
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let project = mutation_project(root.path());
        let source = external.path().join("a.txt");
        fs::write(&source, b"new content").unwrap();
        fs::write(root.path().join("a.txt"), b"original").unwrap();
        fs::create_dir(external.path().join("folder.ext")).unwrap();
        fs::write(external.path().join("folder.ext/nested"), b"nested").unwrap();
        std::os::unix::fs::symlink("missing-target", external.path().join("link")).unwrap();
        let sources = vec![
            source.clone(),
            external.path().join("folder.ext"),
            external.path().join("link"),
        ];
        let first = paste_entries(&project, "", &sources).unwrap();
        assert!(first.failures.is_empty());
        assert_eq!(
            first
                .entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            ["a 副本.txt", "folder.ext", "link"]
        );
        assert_eq!(fs::read(root.path().join("a.txt")).unwrap(), b"original");
        assert_eq!(
            fs::read(root.path().join("a 副本.txt")).unwrap(),
            b"new content"
        );
        assert_eq!(
            fs::read(root.path().join("folder.ext/nested")).unwrap(),
            b"nested"
        );
        assert_eq!(
            fs::read_link(root.path().join("link")).unwrap(),
            Path::new("missing-target")
        );
        let second = paste_entries(&project, "", &sources).unwrap();
        assert!(second.failures.is_empty());
        assert_eq!(second.entries[0].path, "a 副本 2.txt");
        assert_eq!(second.entries[1].path, "folder.ext 副本");
        assert!(second.entries[2].is_symlink);
        assert!(fs::read_dir(root.path())
            .unwrap()
            .all(|entry| !is_internal_temp_name(entry.unwrap().file_name().to_str().unwrap())));
    }

    #[test]
    fn paste_keeps_successes_and_cleans_failed_staging() {
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let project = mutation_project(root.path());
        let good = external.path().join("good");
        let bad = external.path().join("bad");
        fs::write(&good, b"good").unwrap();
        fs::write(&bad, b"bad").unwrap();
        let result = paste_entries_with(&project, "", &[bad, good], |source, target| {
            fs::copy(source, target)?;
            if source.ends_with("bad") {
                Err(GazeError::Message("copy failed".into()))
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].name, "good");
        assert_eq!(result.failures[0].name, "bad");
        assert!(!root.path().join("bad").exists());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn paste_retries_a_concurrently_occupied_name() {
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let project = mutation_project(root.path());
        let source = external.path().join("a.txt");
        fs::write(&source, b"copy").unwrap();
        let result = paste_entries_with(&project, "", &[source], |source, staged| {
            fs::copy(source, staged)?;
            fs::write(root.path().join("a.txt"), b"concurrent")?;
            Ok(())
        })
        .unwrap();
        assert!(result.failures.is_empty());
        assert_eq!(result.entries[0].path, "a 副本.txt");
        assert_eq!(fs::read(root.path().join("a.txt")).unwrap(), b"concurrent");
    }

    #[test]
    fn paste_rejects_invalid_targets_recursive_copies_and_missing_sources() {
        let root = tempfile::tempdir().unwrap();
        let project = mutation_project(root.path());
        fs::create_dir_all(root.path().join("dir/sub")).unwrap();
        let source = root.path().join("dir");
        for parent in ["dir", "dir/sub"] {
            let result =
                paste_entries_with(&project, parent, std::slice::from_ref(&source), |_, _| {
                    panic!("must not copy")
                })
                .unwrap();
            assert_eq!(result.failures.len(), 1);
            assert!(result.entries.is_empty());
        }
        for parent in ["../outside", "/tmp", ".git", "missing"] {
            assert!(paste_entries_with(
                &project,
                parent,
                std::slice::from_ref(&source),
                |_, _| panic!("must not copy")
            )
            .is_err());
        }
        assert!(paste_entries_with(&project, "", &[], |_, _| panic!("must not copy")).is_err());
        let result = paste_entries_with(&project, "", &[root.path().join("gone")], |_, _| {
            panic!("must not copy")
        })
        .unwrap();
        assert_eq!(result.failures.len(), 1);
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn clipboard_paths_offer_absolute_and_project_relative_paths() {
        let root = tempfile::tempdir().unwrap();
        let project = mutation_project(root.path());
        fs::create_dir(root.path().join("src")).unwrap();
        fs::write(root.path().join("src/你好.ts"), b"content").unwrap();
        assert_eq!(
            clipboard_path(&project, "src/你好.ts", false).unwrap(),
            Path::new(&project.root).join("src/你好.ts")
        );
        assert_eq!(
            clipboard_path(&project, "src/你好.ts", true).unwrap(),
            Path::new("src/你好.ts")
        );
        assert_eq!(
            clipboard_path(&project, "", false).unwrap(),
            Path::new(&project.root)
        );
        assert_eq!(clipboard_path(&project, "", true).unwrap(), Path::new("."));
        for relative in [false, true] {
            assert!(clipboard_path(&project, "../outside", relative).is_err());
            assert!(clipboard_path(&project, "missing", relative).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn clipboard_paths_do_not_follow_links_and_paste_rejects_link_destinations() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let project = mutation_project(root.path());
        std::os::unix::fs::symlink(outside.path(), root.path().join("link")).unwrap();
        assert_eq!(
            entry_path(&project, "link").unwrap(),
            Path::new(&project.root).join("link")
        );
        assert_eq!(entry_path(&project, "").unwrap(), Path::new(&project.root));
        assert!(entry_path(&project, "../outside").is_err());
        assert!(entry_path(&project, "link/child").is_err());
        assert!(paste_entries_with(
            &project,
            "link",
            &[outside.path().to_path_buf()],
            |_, _| panic!("must not copy")
        )
        .is_err());
    }

    #[test]
    fn creates_and_moves_entries_without_overwriting() {
        let temporary = tempfile::tempdir().unwrap();
        let project = mutation_project(temporary.path());
        let root = Path::new(&project.root);
        assert!(create_entry(&project, "", "src", true).unwrap().is_dir);
        assert_eq!(
            create_entry(&project, "src", "你好.ts", false)
                .unwrap()
                .path,
            "src/你好.ts"
        );
        fs::write(root.join("src/你好.ts"), "retained content").unwrap();
        assert!(create_entry(&project, "src", "你好.ts", false).is_err());
        create_entry(&project, "", "target", true).unwrap();
        let moved = move_entry(&project, "src/你好.ts", "target/new.ts", &[]).unwrap();
        assert_eq!(moved.name, "new.ts");
        assert_eq!(
            fs::read_to_string(root.join(&moved.path)).unwrap(),
            "retained content"
        );
        assert!(!root.join("src/你好.ts").exists());
        create_entry(&project, "target", "existing.ts", false).unwrap();
        assert!(matches!(
            move_entry(&project, "target/new.ts", "target/existing.ts", &[]),
            Err(GazeError::Conflict(_))
        ));
        assert_eq!(
            fs::read_to_string(root.join("target/new.ts")).unwrap(),
            "retained content"
        );
        assert_eq!(fs::read(root.join("target/existing.ts")).unwrap(), b"");
        assert!(move_entry(&project, "target", "src", &[]).is_err());
        assert!(move_entry(&project, "target", "target/child", &[]).is_err());
        move_entry(&project, "target", "renamed", &[]).unwrap();
        assert!(root.join("renamed/new.ts").exists());
        assert!(move_entry(&project, "renamed", "renamed", &[]).is_ok());
    }

    #[test]
    fn mutations_reject_invalid_names_paths_and_project_roots() {
        let temporary = tempfile::tempdir().unwrap();
        let project = mutation_project(temporary.path());
        for name in [
            "",
            " ",
            ".",
            "..",
            ".git",
            ".GIT",
            ".gaze-write-x",
            "a/b",
            "a\\b",
            "x\0y",
        ] {
            assert!(create_entry(&project, "", name, false).is_err(), "{name:?}");
        }
        for parent in ["..", ".", "/", "a/../b", "a//b", "a/"] {
            assert!(
                create_entry(&project, parent, "file", false).is_err(),
                "{parent}"
            );
        }
        create_entry(&project, "", "src", true).unwrap();
        create_entry(&project, "src", "nested", true).unwrap();
        let nested = mutation_project(&Path::new(&project.root).join("src/nested"));
        assert!(move_entry(&project, "src", "dest", std::slice::from_ref(&nested)).is_err());
        assert!(trash_entry_with(&project, "src", &[nested], |_| panic!(
            "must not trash imported root"
        ))
        .is_err());
        for path in ["", ".", "..", "src/../src", ".git", "/src"] {
            assert!(move_entry(&project, path, "dest", &[]).is_err());
            assert!(trash_entry_with(&project, path, &[], |_| panic!(
                "must not trash protected path"
            ))
            .is_err());
        }
        assert!(move_entry(&project, "src", "", &[]).is_err());
        assert!(Path::new(&project.root).join("src/nested").exists());
    }

    #[test]
    fn trash_failure_keeps_data_and_success_uses_only_the_trash_backend() {
        let temporary = tempfile::tempdir().unwrap();
        let project = mutation_project(temporary.path());
        let root = Path::new(&project.root);
        create_entry(&project, "", "folder", true).unwrap();
        fs::write(root.join("folder/keep.txt"), "keep").unwrap();
        let result = trash_entry_with(&project, "folder", &[], |_| {
            Err(GazeError::Message("trash unavailable".into()))
        });
        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(root.join("folder/keep.txt")).unwrap(),
            "keep"
        );
        let fake_trash = tempfile::tempdir().unwrap();
        trash_entry_with(&project, "folder", &[], |path| {
            fs::rename(path, fake_trash.path().join("folder"))?;
            Ok(())
        })
        .unwrap();
        assert!(!root.join("folder").exists());
        assert_eq!(
            fs::read_to_string(fake_trash.path().join("folder/keep.txt")).unwrap(),
            "keep"
        );
    }

    #[test]
    #[ignore = "uses system trash; run explicitly with temporary fixtures"]
    fn trashes_only_temporary_fixtures_using_system_trash() {
        let temporary = tempfile::tempdir().unwrap();
        let project = mutation_project(temporary.path());
        let name = format!("gaze-trash-test-{}", Uuid::new_v4());
        create_entry(&project, "", &name, true).unwrap();
        fs::write(
            temporary.path().join(&name).join("fixture.txt"),
            "temporary fixture",
        )
        .unwrap();
        trash_entry(&project, &name, std::slice::from_ref(&project)).unwrap();
        assert!(!temporary.path().join(&name).exists());
        #[cfg(unix)]
        {
            let target = temporary.path().join("keep.txt");
            fs::write(&target, "keep target").unwrap();
            let link_name = format!("gaze-trash-link-{}", Uuid::new_v4());
            std::os::unix::fs::symlink(&target, temporary.path().join(&link_name)).unwrap();
            trash_entry(&project, &link_name, std::slice::from_ref(&project)).unwrap();
            assert!(fs::symlink_metadata(temporary.path().join(&link_name)).is_err());
            assert_eq!(fs::read_to_string(target).unwrap(), "keep target");
        }
    }

    #[cfg(unix)]
    #[test]
    fn link_mutations_never_change_targets_or_traverse_link_directories() {
        use std::os::unix::fs::symlink;
        let temporary = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let project = mutation_project(temporary.path());
        let root = Path::new(&project.root);
        fs::write(outside.path().join("keep.txt"), "outside").unwrap();
        symlink(outside.path(), root.join("link")).unwrap();
        assert!(create_entry(&project, "link", "bad", false).is_err());
        create_entry(&project, "", "file", false).unwrap();
        assert!(move_entry(&project, "file", "link/bad", &[]).is_err());
        symlink(outside.path().join("keep.txt"), root.join("existing-link")).unwrap();
        assert!(move_entry(&project, "file", "existing-link", &[]).is_err());
        let entry = move_entry(&project, "link", "renamed-link", &[]).unwrap();
        assert!(entry.is_symlink && entry.is_dir);
        trash_entry_with(&project, "renamed-link", &[], |path| {
            fs::remove_file(path)?;
            Ok(())
        })
        .unwrap();
        assert_eq!(
            fs::read_to_string(outside.path().join("keep.txt")).unwrap(),
            "outside"
        );
        symlink(outside.path().join("missing"), root.join("broken")).unwrap();
        move_entry(&project, "broken", "broken-renamed", &[]).unwrap();
        trash_entry_with(&project, "broken-renamed", &[], |path| {
            fs::remove_file(path)?;
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn rejects_path_traversal_and_absolute_paths() {
        assert!(normalize_relative("../secret").is_err());
        assert!(normalize_relative("a/../../secret").is_err());
        assert!(normalize_relative("/etc/passwd").is_err());
        assert_eq!(
            normalize_relative("src/你好.ts").unwrap(),
            PathBuf::from("src/你好.ts")
        );
    }

    #[test]
    fn reads_utf8_bom_utf16_and_binary() {
        let temporary = tempfile::tempdir().unwrap();
        let project = Project {
            id: "p".to_string(),
            name: "test".to_string(),
            root: temporary
                .path()
                .canonicalize()
                .unwrap()
                .display()
                .to_string(),
        };
        fs::write(temporary.path().join("bom.ts"), b"\xEF\xBB\xBFconst x = 1;").unwrap();
        let text = read_file(&project, "bom.ts").unwrap();
        assert!(matches!(
            text,
            FileContent::Text {
                ref content,
                ref encoding,
                ..
            } if content == "const x = 1;" && encoding == "UTF-8 BOM"
        ));

        let mut utf16 = vec![0xFF, 0xFE];
        for unit in "你好".encode_utf16() {
            utf16.extend_from_slice(&unit.to_le_bytes());
        }
        fs::write(temporary.path().join("utf16.ts"), utf16).unwrap();
        let text = read_file(&project, "utf16.ts").unwrap();
        assert!(matches!(
            text,
            FileContent::Text { ref content, ref encoding, .. }
                if content == "你好" && encoding == "UTF-16 LE"
        ));

        fs::write(temporary.path().join("binary.bin"), [0, 1, 2, 3]).unwrap();
        let content = read_file(&project, "binary.bin").unwrap();
        assert!(matches!(content, FileContent::Binary { .. }));

        fs::write(
            temporary.path().join("binary-with-bom.bin"),
            [0xEF, 0xBB, 0xBF, b'x', 0, 1],
        )
        .unwrap();
        assert!(matches!(
            read_file(&project, "binary-with-bom.bin").unwrap(),
            FileContent::Binary { .. }
        ));
    }

    #[test]
    fn large_single_line_uses_plain_text_mode() {
        let temporary = tempfile::tempdir().unwrap();
        let project = Project {
            id: "p".to_string(),
            name: "test".to_string(),
            root: temporary
                .path()
                .canonicalize()
                .unwrap()
                .display()
                .to_string(),
        };
        let mut file = fs::File::create(temporary.path().join("min.js")).unwrap();
        write!(file, "{}", "x".repeat(MAX_HIGHLIGHT_LINE_UTF16 + 1)).unwrap();
        let content = read_file(&project, "min.js").unwrap();
        assert!(matches!(
            content,
            FileContent::Text {
                mode: FileMode::LongLine,
                editable: false,
                ..
            }
        ));
    }

    fn text_file(
        content: FileContent,
    ) -> (String, FileFingerprint, TextEncodingKind, LineEnding, bool) {
        let FileContent::Text {
            content,
            fingerprint,
            encoding_kind,
            line_ending,
            editable,
            ..
        } = content
        else {
            panic!("expected text file");
        };
        (content, fingerprint, encoding_kind, line_ending, editable)
    }

    #[test]
    fn writes_utf8_and_restores_crlf_line_endings() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let project = Project {
            id: "p".to_string(),
            name: "test".to_string(),
            root: root.display().to_string(),
        };
        fs::write(root.join("a.ts"), "first\r\nsecond\r\n").unwrap();
        let (content, fingerprint, encoding, line_ending, editable) =
            text_file(read_file(&project, "a.ts").unwrap());
        assert_eq!(content, "first\r\nsecond\r\n");
        assert_eq!(encoding, TextEncodingKind::Utf8);
        assert_eq!(line_ending, LineEnding::Crlf);
        assert!(editable);

        let result = write_file(
            &project,
            "a.ts",
            "first\nsecond\nthird",
            fingerprint,
            encoding,
            line_ending,
            false,
        )
        .unwrap();
        assert_eq!(result.size, "first\r\nsecond\r\nthird".len() as u64);
        assert_eq!(
            fs::read_to_string(root.join("a.ts")).unwrap(),
            "first\r\nsecond\r\nthird"
        );
    }

    #[test]
    fn round_trips_utf8_bom_and_utf16() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let project = Project {
            id: "p".to_string(),
            name: "test".to_string(),
            root: root.display().to_string(),
        };
        fs::write(root.join("bom.ts"), b"\xEF\xBB\xBFconst x = 1;\n").unwrap();
        let (_, fingerprint, encoding, line_ending, _) =
            text_file(read_file(&project, "bom.ts").unwrap());
        assert_eq!(encoding, TextEncodingKind::Utf8Bom);
        write_file(
            &project,
            "bom.ts",
            "const x = 2;\n",
            fingerprint,
            encoding,
            line_ending,
            false,
        )
        .unwrap();
        assert_eq!(
            fs::read(root.join("bom.ts")).unwrap(),
            b"\xEF\xBB\xBFconst x = 2;\n"
        );

        let mut utf16 = vec![0xFF, 0xFE];
        for unit in "你好\r\n".encode_utf16() {
            utf16.extend_from_slice(&unit.to_le_bytes());
        }
        fs::write(root.join("utf16.ts"), &utf16).unwrap();
        let (_, fingerprint, encoding, line_ending, _) =
            text_file(read_file(&project, "utf16.ts").unwrap());
        assert_eq!(encoding, TextEncodingKind::Utf16Le);
        assert_eq!(line_ending, LineEnding::Crlf);
        write_file(
            &project,
            "utf16.ts",
            "你好\n世界",
            fingerprint,
            encoding,
            line_ending,
            false,
        )
        .unwrap();
        let (content, _, encoding, _, _) = text_file(read_file(&project, "utf16.ts").unwrap());
        assert_eq!(content, "你好\r\n世界");
        assert_eq!(encoding, TextEncodingKind::Utf16Le);
    }

    #[test]
    fn rejects_stale_fingerprint_unless_forced() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let project = Project {
            id: "p".to_string(),
            name: "test".to_string(),
            root: root.display().to_string(),
        };
        fs::write(root.join("a.ts"), "original\n").unwrap();
        let (_, fingerprint, encoding, line_ending, _) =
            text_file(read_file(&project, "a.ts").unwrap());
        fs::write(root.join("a.ts"), "external change with different size\n").unwrap();

        assert!(matches!(
            write_file(
                &project,
                "a.ts",
                "mine\n",
                fingerprint,
                encoding,
                line_ending,
                false,
            ),
            Err(GazeError::Conflict(_))
        ));
        write_file(
            &project,
            "a.ts",
            "mine\n",
            fingerprint,
            encoding,
            line_ending,
            true,
        )
        .unwrap();
        assert_eq!(fs::read_to_string(root.join("a.ts")).unwrap(), "mine\n");
    }

    #[test]
    fn refuses_to_write_lossy_and_read_only_modes() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let project = Project {
            id: "p".to_string(),
            name: "test".to_string(),
            root: root.display().to_string(),
        };
        fs::write(root.join("bad.ts"), [b'a', 0xFF, b'b']).unwrap();
        let (_, fingerprint, encoding, line_ending, editable) =
            text_file(read_file(&project, "bad.ts").unwrap());
        assert_eq!(encoding, TextEncodingKind::LossyUtf8);
        assert!(!editable);
        assert!(matches!(
            write_file(
                &project,
                "bad.ts",
                "safe\n",
                fingerprint,
                encoding,
                line_ending,
                false,
            ),
            Err(GazeError::Unsupported(_))
        ));

        fs::write(root.join("bad-bom.ts"), [0xEF, 0xBB, 0xBF, b'a', 0xFF]).unwrap();
        let (_, _, encoding, _, editable) = text_file(read_file(&project, "bad-bom.ts").unwrap());
        assert_eq!(encoding, TextEncodingKind::LossyUtf8);
        assert!(!editable);
    }

    #[cfg(unix)]
    #[test]
    fn preserves_file_permissions_when_saving() {
        use std::os::unix::fs::PermissionsExt;

        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let project = Project {
            id: "p".to_string(),
            name: "test".to_string(),
            root: root.display().to_string(),
        };
        let path = root.join("a.ts");
        fs::write(&path, "one\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let (_, fingerprint, encoding, line_ending, _) =
            text_file(read_file(&project, "a.ts").unwrap());
        write_file(
            &project,
            "a.ts",
            "two\n",
            fingerprint,
            encoding,
            line_ending,
            false,
        )
        .unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640);
    }

    #[test]
    fn write_rejects_path_traversal() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let project = Project {
            id: "p".to_string(),
            name: "test".to_string(),
            root: root.display().to_string(),
        };
        let fingerprint = FileFingerprint {
            size: 0,
            modified_ns: 0,
        };
        assert!(matches!(
            write_file(
                &project,
                "../outside.ts",
                "x",
                fingerprint,
                TextEncodingKind::Utf8,
                LineEnding::Lf,
                false,
            ),
            Err(GazeError::InvalidPath(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn listing_does_not_follow_directory_symlinks() {
        let temporary = tempfile::tempdir().unwrap();
        let project_dir = temporary.path().join("project");
        fs::create_dir(&project_dir).unwrap();
        let root = project_dir.canonicalize().unwrap();
        fs::create_dir(root.join("real")).unwrap();
        std::os::unix::fs::symlink(&root, root.join("loop")).unwrap();
        let outside = temporary.path().join("outside.txt");
        fs::write(&outside, "secret").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("outside-link.txt")).unwrap();
        let project = Project {
            id: "p".to_string(),
            name: "test".to_string(),
            root: root.display().to_string(),
        };
        let listing = list_directory(&project, "").unwrap();
        let loop_entry = listing
            .entries
            .iter()
            .find(|entry| entry.name == "loop")
            .unwrap();
        assert!(loop_entry.is_dir);
        assert!(loop_entry.is_symlink);
        assert!(matches!(
            read_file(&project, "outside-link.txt"),
            Err(GazeError::InvalidPath(_))
        ));
    }
}
