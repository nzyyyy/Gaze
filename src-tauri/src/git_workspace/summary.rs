use super::{
    git::{capabilities, ongoing_state, Git},
    models::*,
    working_tree, AppState,
};
use std::{path::Path, sync::atomic::Ordering};
use tauri::State;
pub(crate) fn repository_summary(git: &Git, record: &RepositoryRecord) -> RepositorySummary {
    repository_summary_with_snapshot(git, record, 0).0
}

pub(crate) fn repository_summary_with_snapshot(
    git: &Git,
    record: &RepositoryRecord,
    snapshot_id: u64,
) -> (RepositorySummary, Option<WorkingTreeSnapshot>) {
    let missing = || RepositorySummary {
        id: record.id,
        path: record.path.clone(),
        name: record.name.clone(),
        group: record.group.clone(),
        favorite: record.favorite,
        order: record.order,
        kind: RepositoryKind::Missing,
        capabilities: capabilities(RepositoryKind::Missing),
        branch: None,
        head_oid: None,
        changed_count: 0,
        conflict_count: 0,
        ahead: 0,
        behind: 0,
        last_commit: None,
        ongoing: None,
        error: Some("Repository path is unavailable. Relocate or remove this entry.".into()),
    };
    let path = Path::new(&record.path);
    if !path.exists() {
        return (missing(), None);
    }
    let Ok(inspection) = git.inspect_repository(path) else {
        return (missing(), None);
    };
    let kind = if inspection.bare {
        RepositoryKind::Bare
    } else {
        RepositoryKind::WorkTree
    };
    let snapshot = (!inspection.bare)
        .then(|| {
            working_tree::read_snapshot(git, record.id, &inspection.root, false, snapshot_id).ok()
        })
        .flatten();
    let branch = git
        .text(&inspection.root, &["branch", "--show-current"])
        .ok()
        .filter(|branch| !branch.is_empty());
    let head_oid = snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.head_oid.clone())
        .or_else(|| {
            git.text(&inspection.root, &["rev-parse", "--verify", "HEAD"])
                .ok()
        });
    let (ahead, behind) = git
        .text(
            &inspection.root,
            &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        )
        .ok()
        .and_then(|counts| {
            let mut counts = counts.split_whitespace();
            Some((counts.next()?.parse().ok()?, counts.next()?.parse().ok()?))
        })
        .unwrap_or((0, 0));
    let (changed_count, conflict_count) = snapshot
        .as_ref()
        .map(|snapshot| {
            (
                snapshot.files.len(),
                snapshot.files.iter().filter(|file| file.conflict).count(),
            )
        })
        .unwrap_or((0, 0));
    let summary = RepositorySummary {
        id: record.id,
        path: record.path.clone(),
        name: record.name.clone(),
        group: record.group.clone(),
        favorite: record.favorite,
        order: record.order,
        kind: kind.clone(),
        capabilities: capabilities(kind),
        branch,
        head_oid,
        changed_count,
        conflict_count,
        ahead,
        behind,
        last_commit: git
            .text(&inspection.root, &["log", "-1", "--format=%s"])
            .ok(),
        ongoing: ongoing_state(&inspection.git_dir),
        error: None,
    };
    (summary, snapshot)
}

#[tauri::command(async)]
pub(crate) fn refresh_repository(
    repository_id: RepositoryId,
    state: State<'_, AppState>,
) -> Result<RepositoryRefresh, String> {
    let snapshot_id = state.next_snapshot_id.fetch_add(1, Ordering::Relaxed);
    let git = state.git()?;
    let (summary, mut snapshot) =
        repository_summary_with_snapshot(&git, &state.record(repository_id)?, snapshot_id);
    if let Some(snapshot) = snapshot.as_mut() {
        working_tree::attach_line_stats(&git, Path::new(&summary.path), &mut snapshot.files);
        working_tree::cache_snapshot(&state, snapshot)?;
    }
    Ok(RepositoryRefresh { summary, snapshot })
}
