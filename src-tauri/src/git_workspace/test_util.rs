use super::*;
use crate::git_workspace::git::{ensure_success, strings};
use std::{fs, path::Path, process::Output};

pub(crate) fn git_ok(git: &Git, cwd: &Path, args: &[&str]) {
    ensure_success(git.run(cwd, &strings(args), None).unwrap()).unwrap();
}

pub(crate) fn init_repo(git: &Git, path: &Path) {
    git_ok(git, path, &["init", "-b", "main"]);
    git_ok(git, path, &["config", "user.name", "GitDock Tests"]);
    git_ok(git, path, &["config", "user.email", "gitdock@example.com"]);
}

pub(crate) fn run_request(state: &AppState, cwd: &Path, request: OperationRequest) -> Output {
    let spec = operations::command_spec(state, 1, cwd, &request).unwrap();
    let output = state
        .git()
        .unwrap()
        .run_env(cwd, &spec.args, spec.input.as_deref(), &spec.env)
        .unwrap();
    ensure_success(output).unwrap()
}

pub(crate) fn commit_file(git: &Git, cwd: &Path, path: &str, contents: &str, message: &str) {
    fs::write(cwd.join(path), contents).unwrap();
    git_ok(git, cwd, &["add", path]);
    git_ok(git, cwd, &["commit", "-m", message]);
}

pub(crate) fn test_state(git: Git, config_path: PathBuf) -> AppState {
    let mut state = AppState::new(crate::cache::Cache::open_in_memory().unwrap(), None);
    state.git = Mutex::new(Ok(git));
    state.store = Mutex::new(store::ConfigStore::load(config_path).unwrap());
    state
}
