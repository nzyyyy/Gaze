use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{GazeError, GazeResult};
use crate::models::FileFingerprint;

#[derive(Debug, Clone)]
pub struct RecoveryStore {
    root: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryRecord {
    pub project_id: String,
    pub path: String,
    pub content: String,
    pub original_fingerprint: FileFingerprint,
    pub updated_at_ms: u64,
}

impl RecoveryStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn read(&self, project_id: &str, path: &str) -> GazeResult<Option<RecoveryRecord>> {
        let file_path = self.file_path(project_id, path);
        let bytes = match fs::read(&file_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let record: RecoveryRecord = serde_json::from_slice(&bytes)?;
        if record.project_id != project_id || record.path != path {
            return Err(GazeError::Message("恢复记录与目标文件不匹配。".to_string()));
        }
        Ok(Some(record))
    }

    pub fn write(
        &self,
        project_id: &str,
        path: &str,
        content: &str,
        original_fingerprint: FileFingerprint,
    ) -> GazeResult<RecoveryRecord> {
        let record = RecoveryRecord {
            project_id: project_id.to_string(),
            path: path.to_string(),
            content: content.to_string(),
            original_fingerprint,
            updated_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX),
        };
        fs::create_dir_all(&self.root)?;
        let file_path = self.file_path(project_id, path);
        let mut temporary = tempfile::NamedTempFile::new_in(&self.root)?;
        serde_json::to_writer(temporary.as_file_mut(), &record)?;
        temporary.as_file_mut().flush()?;
        temporary.as_file_mut().sync_all()?;
        temporary.persist(&file_path).map_err(|error| error.error)?;
        Ok(record)
    }

    pub fn delete(&self, project_id: &str, path: &str) -> GazeResult<()> {
        match fs::remove_file(self.file_path(project_id, path)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    fn file_path(&self, project_id: &str, path: &str) -> PathBuf {
        let mut hasher = Sha256::new();
        hash_part(&mut hasher, project_id);
        hash_part(&mut hasher, path);
        let digest = hasher.finalize();
        let name = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        self.root.join(format!("{name}.json"))
    }
}

fn hash_part(hasher: &mut Sha256, value: &str) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fingerprint(modified_ns: i64) -> FileFingerprint {
        FileFingerprint {
            size: 42,
            modified_ns,
        }
    }

    #[test]
    fn round_trips_source_and_fingerprint_in_a_hashed_file() {
        let directory = tempfile::tempdir().unwrap();
        let store = RecoveryStore::new(directory.path().join("recovery"));
        let project_id = "project/../../ unsafe";
        let path = "src/复杂 文件.ts";

        let written = store
            .write(
                project_id,
                path,
                "const draft = '未保存';\n",
                fingerprint(i64::MAX),
            )
            .unwrap();

        assert_eq!(store.read(project_id, path).unwrap(), Some(written.clone()));
        assert!(written.updated_at_ms > 0);
        assert_eq!(written.original_fingerprint, fingerprint(i64::MAX));
        let entries = fs::read_dir(directory.path().join("recovery"))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(entries.len(), 1);
        let name = entries[0].file_name().to_string_lossy().to_string();
        assert!(name.ends_with(".json"));
        assert_eq!(name.len(), 69);
        assert!(name[..64]
            .chars()
            .all(|character| character.is_ascii_hexdigit()));
        assert!(!directory.path().join("gaze.sqlite3").exists());
    }

    #[test]
    fn atomically_replaces_a_record_without_leaving_temporary_files() {
        let directory = tempfile::tempdir().unwrap();
        let store = RecoveryStore::new(directory.path().join("recovery"));
        store.write("p1", "a.ts", "first", fingerprint(1)).unwrap();
        store.write("p1", "a.ts", "second", fingerprint(2)).unwrap();

        let record = store.read("p1", "a.ts").unwrap().unwrap();
        assert_eq!(record.content, "second");
        assert_eq!(record.original_fingerprint, fingerprint(2));
        assert_eq!(fs::read_dir(store.root).unwrap().count(), 1);
    }

    #[test]
    fn isolates_file_keys_and_deletes_idempotently() {
        let directory = tempfile::tempdir().unwrap();
        let store = RecoveryStore::new(directory.path().join("recovery"));
        store.write("p1", "a.ts", "one", fingerprint(1)).unwrap();
        store.write("p2", "a.ts", "two", fingerprint(1)).unwrap();
        store.write("p1", "b.ts", "three", fingerprint(1)).unwrap();

        store.delete("p1", "a.ts").unwrap();
        store.delete("p1", "a.ts").unwrap();

        assert_eq!(store.read("p1", "a.ts").unwrap(), None);
        assert_eq!(store.read("p2", "a.ts").unwrap().unwrap().content, "two");
        assert_eq!(store.read("p1", "b.ts").unwrap().unwrap().content, "three");
    }

    #[test]
    fn rejects_a_record_whose_identity_does_not_match_its_hash() {
        let directory = tempfile::tempdir().unwrap();
        let store = RecoveryStore::new(directory.path().join("recovery"));
        store.write("p1", "a.ts", "draft", fingerprint(1)).unwrap();
        let path = store.file_path("p1", "a.ts");
        let mut record: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        record["path"] = serde_json::Value::String("other.ts".to_string());
        fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();

        assert!(store.read("p1", "a.ts").is_err());
    }

    #[test]
    fn recovery_directory_is_independent_from_workspace_paths() {
        let directory = tempfile::tempdir().unwrap();
        let app_data = directory.path().join("app-data");
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let store = RecoveryStore::new(app_data.join("recovery"));

        store
            .write("p1", "src/a.ts", "draft", fingerprint(1))
            .unwrap();

        assert!(app_data.join("recovery").is_dir());
        assert_eq!(fs::read_dir(&workspace).unwrap().count(), 0);
    }
}
