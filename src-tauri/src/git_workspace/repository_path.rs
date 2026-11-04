use std::path::{Component, Path, PathBuf};

pub(crate) fn validate_relative_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.contains('\0')
        || Path::new(path).components().any(|component| {
            matches!(
                component,
                Component::ParentDir
                    | Component::RootDir
                    | Component::Prefix(_)
                    | Component::CurDir
            ) || component.as_os_str() == ".git"
        })
    {
        Err("Invalid repository-relative path".into())
    } else {
        Ok(())
    }
}

pub(crate) fn trash_target(root: &Path, path: &str) -> Result<PathBuf, String> {
    validate_relative_path(path)?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let target = root.join(path);
    let parent = target
        .parent()
        .ok_or("Path has no parent")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !parent.starts_with(&root) {
        return Err("Path resolves outside the repository".into());
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_paths_outside_repository() {
        assert!(validate_relative_path("../secret").is_err());
        assert!(validate_relative_path("/tmp/secret").is_err());
        assert!(validate_relative_path("src/main.rs").is_ok());
        assert!(validate_relative_path(".").is_err());
        assert!(validate_relative_path(".git/config").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn trash_never_follows_a_parent_symlink_outside_the_repository() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("link")).unwrap();
        assert!(trash_target(root.path(), "link/secret").is_err());
        assert!(trash_target(root.path(), "link").is_ok());
    }
}
