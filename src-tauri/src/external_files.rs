use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use uuid::Uuid;

use crate::error::{GazeError, GazeResult};
use crate::files;
use crate::models::Project;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenFile {
    pub project: Project,
    pub path: String,
    pub temporary: bool,
}

#[derive(Serialize)]
pub struct OpenFailure {
    pub path: String,
    pub message: String,
}

#[derive(Default, Serialize)]
pub struct OpenResult {
    pub files: Vec<OpenFile>,
    pub failures: Vec<OpenFailure>,
}

struct Context {
    project: Project,
    paths: HashSet<String>,
}

#[derive(Default)]
pub struct ExternalFiles {
    contexts: Mutex<HashMap<String, Context>>,
    pending: Mutex<Vec<String>>,
}

pub fn canonical_file(path: &Path) -> GazeResult<PathBuf> {
    if !path.is_absolute() {
        return Err(GazeError::InvalidPath("请提供文件的绝对路径。".into()));
    }
    let path = path.canonicalize()?;
    if !path.is_file() {
        return Err(GazeError::Unsupported(
            "暂不支持拖入文件夹或特殊文件。".into(),
        ));
    }
    Ok(path)
}

impl ExternalFiles {
    pub fn open(&self, path: &Path, projects: &[Project]) -> GazeResult<OpenFile> {
        let path = canonical_file(path)?;
        if let Some(project) = projects
            .iter()
            .filter(|project| path.starts_with(&project.root))
            .max_by_key(|project| project.root.len())
        {
            return Ok(OpenFile {
                path: files::path_to_relative(Path::new(&project.root), &path)?,
                project: project.clone(),
                temporary: false,
            });
        }
        let parent = path
            .parent()
            .ok_or_else(|| GazeError::InvalidPath("文件没有父目录。".into()))?;
        let root = parent
            .to_str()
            .ok_or_else(|| GazeError::InvalidPath("文件路径不是有效的 UTF-8。".into()))?;
        let mut contexts = self
            .contexts
            .lock()
            .map_err(|_| GazeError::Message("临时文件表锁已损坏。".into()))?;
        let context = if let Some(id) = contexts
            .values()
            .find(|context| context.project.root == root)
            .map(|context| context.project.id.clone())
        {
            contexts.get_mut(&id).unwrap()
        } else {
            let id = format!("external:{}", Uuid::new_v4());
            contexts.entry(id.clone()).or_insert_with(|| Context {
                project: Project {
                    id,
                    name: root.into(),
                    root: root.into(),
                },
                paths: HashSet::new(),
            })
        };
        let relative = files::path_to_relative(parent, &path)?;
        context.paths.insert(relative.clone());
        Ok(OpenFile {
            project: context.project.clone(),
            path: relative,
            temporary: true,
        })
    }

    pub fn project(&self, id: &str, path: &str) -> GazeResult<Project> {
        self.contexts
            .lock()
            .map_err(|_| GazeError::Message("临时文件表锁已损坏。".into()))?
            .get(id)
            .filter(|context| context.paths.contains(path))
            .map(|context| context.project.clone())
            .ok_or_else(|| GazeError::NotFound("临时文件已关闭。".into()))
    }

    pub fn close(&self, id: &str, path: &str) -> GazeResult<()> {
        let mut contexts = self
            .contexts
            .lock()
            .map_err(|_| GazeError::Message("临时文件表锁已损坏。".into()))?;
        if let Some(context) = contexts.get_mut(id) {
            context.paths.remove(path);
            if context.paths.is_empty() {
                contexts.remove(id);
            }
        }
        Ok(())
    }

    pub fn enqueue(&self, paths: impl IntoIterator<Item = String>) -> GazeResult<()> {
        self.pending
            .lock()
            .map_err(|_| GazeError::Message("待打开文件队列锁已损坏。".into()))?
            .extend(paths);
        Ok(())
    }

    pub fn take_pending(&self) -> GazeResult<Vec<String>> {
        Ok(std::mem::take(&mut *self.pending.lock().map_err(|_| {
            GazeError::Message("待打开文件队列锁已损坏。".into())
        })?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temporary_context_is_stable_scoped_and_released() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("中文 a.md"), "hello").unwrap();
        std::fs::write(root.join("b.md"), "world").unwrap();
        let files = ExternalFiles::default();
        let a = files.open(&root.join("中文 a.md"), &[]).unwrap();
        let again = files.open(&root.join("中文 a.md"), &[]).unwrap();
        assert!(a.temporary);
        assert_eq!(a.project.id, again.project.id);
        assert!(files.project(&a.project.id, "b.md").is_err());
        assert!(files.project(&a.project.id, "../outside.md").is_err());
        let b = files.open(&root.join("b.md"), &[]).unwrap();
        assert_eq!(a.project.id, b.project.id);
        assert!(files.open(&root, &[]).is_err());
        assert!(files.open(Path::new("relative.md"), &[]).is_err());
        files.close(&a.project.id, &a.path).unwrap();
        assert!(files.project(&a.project.id, &a.path).is_err());
        assert!(files.project(&b.project.id, &b.path).is_ok());
        files.close(&b.project.id, &b.path).unwrap();
        assert!(files.project(&b.project.id, &b.path).is_err());
    }

    #[test]
    fn reuses_most_specific_workspace_and_drains_queue_once() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.rs"), "fn main() {}").unwrap();
        let projects = vec![
            Project {
                id: "outer".into(),
                name: "outer".into(),
                root: root.to_str().unwrap().into(),
            },
            Project {
                id: "inner".into(),
                name: "inner".into(),
                root: root.join("src").to_str().unwrap().into(),
            },
        ];
        let files = ExternalFiles::default();
        let opened = files.open(&root.join("src/a.rs"), &projects).unwrap();
        assert!(!opened.temporary);
        assert_eq!(opened.project.id, "inner");
        assert_eq!(opened.path, "a.rs");
        files.enqueue(["a".into(), "b".into()]).unwrap();
        assert_eq!(files.take_pending().unwrap(), ["a", "b"]);
        assert!(files.take_pending().unwrap().is_empty());
        files.enqueue(["c".into()]).unwrap();
        assert_eq!(files.take_pending().unwrap(), ["c"]);
    }

    #[test]
    fn temporary_files_keep_save_conflict_and_path_boundary_checks() {
        use crate::models::{FileContent, LineEnding, TextEncodingKind};
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let source = root.join("a.txt");
        std::fs::write(&source, "before").unwrap();
        let files = ExternalFiles::default();
        let opened = files.open(&source, &[]).unwrap();
        let project = files.project(&opened.project.id, &opened.path).unwrap();
        let FileContent::Text { fingerprint, .. } =
            files::read_file(&project, &opened.path).unwrap()
        else {
            panic!("expected text");
        };
        files::write_file(
            &project,
            &opened.path,
            "saved",
            fingerprint,
            TextEncodingKind::Utf8,
            LineEnding::Lf,
            false,
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&source).unwrap(), "saved");
        let FileContent::Text { fingerprint, .. } =
            files::read_file(&project, &opened.path).unwrap()
        else {
            panic!("expected text");
        };
        std::fs::write(&source, "changed externally").unwrap();
        assert!(matches!(
            files::write_file(
                &project,
                &opened.path,
                "overwrite",
                fingerprint,
                TextEncodingKind::Utf8,
                LineEnding::Lf,
                false
            ),
            Err(GazeError::Conflict(_))
        ));
        assert!(files::read_file(&project, "../outside.txt").is_err());
        assert_eq!(
            std::fs::read_to_string(source).unwrap(),
            "changed externally"
        );
    }
}
