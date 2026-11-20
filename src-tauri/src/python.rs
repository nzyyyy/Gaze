use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::process::Command;

use crate::error::{GazeError, GazeResult};

#[derive(Clone, Debug, Serialize)]
pub struct PythonEnvironment {
    pub path: String,
    pub name: String,
    pub kind: &'static str,
}

#[derive(Debug, Serialize)]
pub struct PythonEnvironmentStatus {
    pub selected: Option<String>,
    pub environment: Option<PythonEnvironment>,
    pub automatic: Option<PythonEnvironment>,
}

pub fn setting_key(project_id: &str) -> String {
    format!("python-interpreter:{project_id}")
}

pub fn validate_interpreter(path: &Path) -> GazeResult<()> {
    if executable(path) && python_executable_name(path) {
        Ok(())
    } else {
        Err(GazeError::InvalidPath(
            "请选择可执行的 Python 解释器文件。".into(),
        ))
    }
}

pub fn status(root: &Path, selected: Option<String>) -> PythonEnvironmentStatus {
    let automatic = automatic(root);
    let environment = match &selected {
        Some(path) => describe(Path::new(path)),
        None => automatic.clone(),
    };
    PythonEnvironmentStatus {
        selected,
        environment,
        automatic,
    }
}

fn automatic(root: &Path) -> Option<PythonEnvironment> {
    if root.join("uv.lock").is_file() || root.join("uv.toml").is_file() {
        if let Some(path) = std::env::var_os("UV_PROJECT_ENVIRONMENT") {
            if !path.is_empty() {
                if let Some(environment) = venv(&root.join(path), "uv") {
                    return Some(environment);
                }
            }
        }
    }
    let kind = if root.join("uv.lock").is_file() {
        "uv"
    } else {
        "venv"
    };
    let default = root.join(".venv");
    if let Some(environment) = venv(&default, kind).or_else(|| conda_environment(&default)) {
        return Some(environment);
    }
    let mut candidates = project_environments(root).into_iter();
    let first = candidates.next()?;
    candidates.next().is_none().then_some(first)
}

pub async fn discover(root: &Path) -> Vec<PythonEnvironment> {
    let home = home_dir();
    let conda = conda_environments(root, home.as_deref()).await;
    let root = root.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut all = Vec::new();
        all.extend(automatic(&root));
        all.extend(project_environments(&root));
        all.extend(conda.iter().filter_map(|p| conda_environment(p)));
        for (variable, kind) in [("VIRTUAL_ENV", "venv"), ("CONDA_PREFIX", "conda")] {
            if let Some(prefix) = env_path(variable) {
                if let Some(item) = if kind == "conda" {
                    conda_environment(&prefix)
                } else {
                    venv(&prefix, kind)
                } {
                    all.push(item);
                }
            }
        }
        if let Some(home) = home {
            let pyenv = env_path("PYENV_ROOT").unwrap_or_else(|| home.join(".pyenv"));
            add_installations(&mut all, &pyenv.join("versions"), "pyenv");
            let uv = env_path("UV_PYTHON_INSTALL_DIR").unwrap_or_else(|| uv_python_dir(&home));
            add_installations(&mut all, &uv, "uv");

            let poetry =
                env_path("POETRY_VIRTUALENVS_PATH").unwrap_or_else(|| poetry_virtualenv_dir(&home));
            all.extend(child_directories(&poetry).filter_map(|p| venv(&p, "poetry")));
            let pipenv = env_path("WORKON_HOME").unwrap_or_else(|| pipenv_virtualenv_dir(&home));
            all.extend(child_directories(&pipenv).filter_map(|p| venv(&p, "pipenv")));
            all.extend(
                child_directories(&home.join(".virtualenvs")).filter_map(|p| venv(&p, "venv")),
            );
        }
        for name in ["python3", "python", "pypy3"] {
            if let Ok(paths) = which::which_all(name) {
                all.extend(paths.filter_map(|path| environment(path, "system")));
            }
        }
        deduplicate(&mut all);
        all
    })
    .await
    .unwrap_or_default()
}

fn executable(path: &Path) -> bool {
    if !path.is_absolute() || !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).is_ok_and(|meta| meta.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn python_executable_name(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    ["python", "pypy"].iter().any(|prefix| {
        name.strip_prefix(prefix).is_some_and(|suffix| {
            let suffix = suffix.strip_suffix('t').unwrap_or(suffix);
            suffix.chars().all(|ch| ch.is_ascii_digit() || ch == '.')
        })
    })
}

fn environment(path: PathBuf, kind: &'static str) -> Option<PythonEnvironment> {
    validate_interpreter(&path).ok()?;
    let name = if kind == "system" || kind == "custom" {
        path.file_name()?.to_str()?.to_string()
    } else {
        prefix_of(&path)?.file_name()?.to_str()?.to_string()
    };
    Some(PythonEnvironment {
        path: path.to_str()?.to_string(),
        name,
        kind,
    })
}

fn prefix_of(path: &Path) -> Option<&Path> {
    let parent = path.parent()?;
    match parent.file_name().and_then(|name| name.to_str()) {
        Some("bin" | "Scripts") => parent.parent(),
        _ => Some(parent),
    }
}

fn describe(path: &Path) -> Option<PythonEnvironment> {
    let prefix = prefix_of(path)?;
    let kind = if prefix.join("conda-meta").is_dir() {
        "conda"
    } else if prefix.join("pyvenv.cfg").is_file() {
        "venv"
    } else {
        "custom"
    };
    environment(path.to_owned(), kind)
}

fn interpreter(prefix: &Path, kind: &'static str) -> Option<PythonEnvironment> {
    // Keep the path inside the environment. Its Python often symlinks to a shared runtime.
    let paths: &[&str] = if cfg!(windows) {
        &[
            "Scripts/python.exe",
            "python.exe",
            "Scripts/pypy3.exe",
            "pypy3.exe",
        ]
    } else {
        &["bin/python", "bin/python3", "bin/pypy3", "bin/pypy"]
    };
    paths
        .iter()
        .find_map(|name| environment(prefix.join(name), kind))
}

fn venv(prefix: &Path, kind: &'static str) -> Option<PythonEnvironment> {
    prefix
        .join("pyvenv.cfg")
        .is_file()
        .then(|| interpreter(prefix, kind))?
}

fn conda_environment(prefix: &Path) -> Option<PythonEnvironment> {
    prefix
        .join("conda-meta")
        .is_dir()
        .then(|| interpreter(prefix, "conda"))?
}

fn child_directories(parent: &Path) -> impl Iterator<Item = PathBuf> {
    fs::read_dir(parent)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
}

fn project_environments(root: &Path) -> Vec<PythonEnvironment> {
    [
        root.to_owned(),
        root.join(".venvs"),
        root.join("venvs"),
        root.join("envs"),
    ]
    .into_iter()
    .flat_map(|parent| child_directories(&parent))
    .filter_map(|path| venv(&path, "venv"))
    .collect()
}

fn add_installations(all: &mut Vec<PythonEnvironment>, directory: &Path, kind: &'static str) {
    for prefix in child_directories(directory) {
        all.extend(interpreter(&prefix, kind));
        if kind == "pyenv" {
            all.extend(child_directories(&prefix.join("envs")).filter_map(|p| venv(&p, kind)));
        }
    }
}

fn deduplicate(all: &mut Vec<PythonEnvironment>) {
    let mut seen = std::collections::HashSet::new();
    all.retain(|item| {
        let path = Path::new(&item.path);
        let key = if item.kind == "system" {
            path.canonicalize().unwrap_or_else(|_| path.to_owned())
        } else {
            // Deduplicate aliases of the environment directory, not its shared Python binary.
            prefix_of(path)
                .and_then(|prefix| prefix.canonicalize().ok())
                .unwrap_or_else(|| path.to_owned())
        };
        seen.insert(key)
    });
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

fn home_dir() -> Option<PathBuf> {
    env_path(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
}

fn uv_python_dir(home: &Path) -> PathBuf {
    if cfg!(windows) {
        env_path("APPDATA")
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join("uv/data/python")
    } else {
        env_path("XDG_DATA_HOME")
            .unwrap_or_else(|| home.join(".local/share"))
            .join("uv/python")
    }
}

fn poetry_virtualenv_dir(home: &Path) -> PathBuf {
    let cache = if cfg!(target_os = "macos") {
        home.join("Library/Caches")
    } else if cfg!(windows) {
        env_path("LOCALAPPDATA").unwrap_or_else(|| home.join("AppData/Local"))
    } else {
        env_path("XDG_CACHE_HOME").unwrap_or_else(|| home.join(".cache"))
    };
    env_path("POETRY_CACHE_DIR")
        .map(|p| p.join("virtualenvs"))
        .unwrap_or_else(|| cache.join("pypoetry/virtualenvs"))
}

fn pipenv_virtualenv_dir(home: &Path) -> PathBuf {
    home.join(if cfg!(windows) {
        ".virtualenvs"
    } else {
        ".local/share/virtualenvs"
    })
}

async fn conda_environments(workspace: &Path, home: Option<&Path>) -> Vec<PathBuf> {
    let mut prefixes = Vec::new();
    let mut known = vec![
        "/opt/miniconda3".into(),
        "/opt/anaconda3".into(),
        "/opt/miniforge3".into(),
    ];
    if let Some(home) = home {
        if let Ok(file) = fs::read_to_string(home.join(".conda/environments.txt")) {
            prefixes.extend(
                file.lines()
                    .map(str::trim)
                    .map(PathBuf::from)
                    .filter(|p| p.is_absolute()),
            );
        }
        known.extend(
            [
                "miniconda3",
                "anaconda3",
                "miniforge3",
                "mambaforge",
                "opt/miniconda3",
                "opt/anaconda3",
                "opt/miniforge3",
            ]
            .iter()
            .map(|name| home.join(name)),
        );
    }
    for prefix in &known {
        prefixes.push(prefix.clone());
        prefixes.extend(child_directories(&prefix.join("envs")));
    }
    let command_name = if cfg!(windows) { "conda.exe" } else { "conda" };
    let suffix = if cfg!(windows) {
        "Scripts/conda.exe"
    } else {
        "bin/conda"
    };
    let command = env_path("CONDA_EXE")
        .into_iter()
        .chain(which::which(command_name).ok())
        .chain(known.iter().map(|prefix| prefix.join(suffix)))
        .find(|path| {
            executable(path) && path.canonicalize().is_ok_and(|p| !p.starts_with(workspace))
        });
    if let Some(command) = command {
        let mut process = Command::new(command);
        process
            .current_dir(home.unwrap_or(std::env::temp_dir().as_path()))
            .args(["env", "list", "--json"])
            .env("CONDA_OFFLINE", "true")
            .stdin(Stdio::null())
            .kill_on_drop(true);
        if let Ok(Ok(output)) = tokio::time::timeout(Duration::from_secs(3), process.output()).await
        {
            if output.status.success() {
                prefixes.extend(conda_prefixes(&output.stdout));
            }
        }
    }
    prefixes
}

fn conda_prefixes(output: &[u8]) -> Vec<PathBuf> {
    let Ok(value) = serde_json::from_slice::<Value>(output) else {
        return Vec::new();
    };
    value["envs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_venv(root: &Path, name: &str) -> PathBuf {
        let prefix = root.join(name);
        let executable = prefix.join(if cfg!(windows) {
            "Scripts/python.exe"
        } else {
            "bin/python"
        });
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::write(prefix.join("pyvenv.cfg"), "").unwrap();
        fs::write(&executable, "").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        }
        executable
    }

    #[test]
    fn project_venv_wins_and_manual_selection_is_remembered_even_when_missing() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let first = make_venv(root, "custom");
        assert_eq!(
            status(root, None).environment.unwrap().path,
            first.to_str().unwrap()
        );
        let second = make_venv(root, "other");
        assert!(status(root, None).automatic.is_none());
        fs::write(root.join("uv.lock"), "").unwrap();
        let default = make_venv(root, ".venv");
        assert_eq!(
            status(root, None).environment.unwrap().path,
            default.to_str().unwrap()
        );
        let selected = Some(second.to_str().unwrap().to_string());
        let manual = status(root, selected.clone());
        assert_eq!(manual.environment.unwrap().path, second.to_str().unwrap());
        assert_eq!(manual.automatic.unwrap().path, default.to_str().unwrap());
        fs::remove_file(&second).unwrap();
        let missing = status(root, selected.clone());
        assert_eq!(missing.selected, selected);
        assert!(missing.environment.is_none());
    }

    #[test]
    fn conda_json_only_accepts_absolute_prefixes() {
        let root = tempfile::tempdir().unwrap();
        let output = serde_json::to_vec(&serde_json::json!({
            "envs": [root.path(), "../relative", null]
        }))
        .unwrap();
        assert_eq!(conda_prefixes(&output), [root.path()]);
        assert!(conda_prefixes(b"not json").is_empty());
    }
}
