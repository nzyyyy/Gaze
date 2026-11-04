use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{GazeError, GazeResult};
use crate::models::{FileFingerprint, Project};

#[derive(Debug, Clone)]
pub struct CachedFile {
    pub rel_path: String,
    pub fingerprint: FileFingerprint,
}

#[derive(Debug, Clone)]
pub struct CachedSymbol {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub line: u32,
    pub character: u32,
    pub scope: Option<String>,
    pub signature: Option<String>,
}

#[derive(Clone)]
pub struct Cache {
    connection: Arc<Mutex<Connection>>,
}

impl Cache {
    pub fn open(path: &Path) -> GazeResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS workspace_projects (
                id TEXT PRIMARY KEY,
                root TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                sort_order INTEGER NOT NULL,
                added_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS file_index (
                project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
                rel_path TEXT NOT NULL,
                size INTEGER NOT NULL,
                modified_ns INTEGER NOT NULL,
                PRIMARY KEY (project_id, rel_path)
            );
            CREATE TABLE IF NOT EXISTS symbol_files (
                project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
                rel_path TEXT NOT NULL,
                size INTEGER NOT NULL,
                modified_ns INTEGER NOT NULL,
                PRIMARY KEY (project_id, rel_path)
            );
            CREATE TABLE IF NOT EXISTS symbols (
                project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
                rel_path TEXT NOT NULL,
                name TEXT NOT NULL,
                kind TEXT NOT NULL,
                line INTEGER NOT NULL,
                character INTEGER NOT NULL,
                scope TEXT,
                signature TEXT,
                PRIMARY KEY (project_id, rel_path, name, kind, line, character)
            );
            CREATE INDEX IF NOT EXISTS symbols_by_project_name
                ON symbols(project_id, name);
            PRAGMA user_version = 1;
            ",
        )?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> GazeResult<Self> {
        let connection = Connection::open_in_memory()?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.execute_batch(
            "
            CREATE TABLE workspace_projects (
                id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
                sort_order INTEGER NOT NULL, added_at INTEGER NOT NULL
            );
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE file_index (
                project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
                rel_path TEXT NOT NULL, size INTEGER NOT NULL, modified_ns INTEGER NOT NULL,
                PRIMARY KEY (project_id, rel_path)
            );
            CREATE TABLE symbol_files (
                project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
                rel_path TEXT NOT NULL, size INTEGER NOT NULL, modified_ns INTEGER NOT NULL,
                PRIMARY KEY (project_id, rel_path)
            );
            CREATE TABLE symbols (
                project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
                rel_path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
                line INTEGER NOT NULL, character INTEGER NOT NULL, scope TEXT, signature TEXT,
                PRIMARY KEY (project_id, rel_path, name, kind, line, character)
            );
            ",
        )?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    async fn run<T, F>(&self, operation: F) -> GazeResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
    {
        let connection = Arc::clone(&self.connection);
        tokio::task::spawn_blocking(move || {
            let mut connection = connection
                .lock()
                .map_err(|_| GazeError::Message("数据库锁已损坏。".to_string()))?;
            operation(&mut connection).map_err(GazeError::from)
        })
        .await?
    }

    pub async fn projects(&self) -> GazeResult<Vec<Project>> {
        self.run(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, name, root FROM workspace_projects ORDER BY sort_order, added_at",
            )?;
            let rows = statement.query_map([], |row| {
                Ok(Project {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    root: row.get(2)?,
                })
            })?;
            rows.collect()
        })
        .await
    }

    pub fn projects_blocking(&self) -> GazeResult<Vec<Project>> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| GazeError::Message("数据库锁已损坏。".into()))?;
        let mut statement = connection.prepare(
            "SELECT id, name, root FROM workspace_projects ORDER BY sort_order, added_at",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                root: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub async fn insert_project(&self, project: &Project) -> GazeResult<()> {
        let project = project.clone();
        self.run(move |connection| {
            let sort_order: i64 = connection.query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM workspace_projects",
                [],
                |row| row.get(0),
            )?;
            let added_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            connection.execute(
                "INSERT INTO workspace_projects(id, root, name, sort_order, added_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![project.id, project.root, project.name, sort_order, added_at],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn delete_project(&self, project_id: &str) -> GazeResult<()> {
        let project_id = project_id.to_string();
        self.run(move |connection| {
            connection.execute(
                "DELETE FROM workspace_projects WHERE id = ?1",
                params![project_id],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn setting(&self, key: &str) -> GazeResult<Option<String>> {
        let key = key.to_string();
        self.run(move |connection| {
            connection
                .query_row(
                    "SELECT value FROM settings WHERE key = ?1",
                    params![key],
                    |row| row.get(0),
                )
                .optional()
        })
        .await
    }

    pub async fn set_setting(&self, key: &str, value: &str) -> GazeResult<()> {
        let key = key.to_string();
        let value = value.to_string();
        self.run(move |connection| {
            connection.execute(
                "INSERT INTO settings(key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn set_settings(&self, values: Vec<(String, String)>) -> GazeResult<()> {
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            for (key, value) in values {
                transaction.execute(
                    "INSERT INTO settings(key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![key, value],
                )?;
            }
            transaction.commit()
        })
        .await
    }

    pub async fn cached_files(&self, project_id: &str) -> GazeResult<Vec<CachedFile>> {
        let project_id = project_id.to_string();
        self.run(move |connection| {
            let mut statement = connection.prepare(
                "SELECT rel_path, size, modified_ns FROM file_index WHERE project_id = ?1",
            )?;
            let rows = statement.query_map(params![project_id], |row| {
                Ok(CachedFile {
                    rel_path: row.get(0)?,
                    fingerprint: FileFingerprint {
                        size: row.get::<_, i64>(1)? as u64,
                        modified_ns: row.get(2)?,
                    },
                })
            })?;
            rows.collect()
        })
        .await
    }

    pub async fn replace_file_index(
        &self,
        project_id: &str,
        files: &[CachedFile],
    ) -> GazeResult<()> {
        let project_id = project_id.to_string();
        let files = files.to_vec();
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            transaction.execute(
                "DELETE FROM file_index WHERE project_id = ?1",
                params![project_id],
            )?;
            {
                let mut insert = transaction.prepare(
                    "INSERT INTO file_index(project_id, rel_path, size, modified_ns)
                     VALUES (?1, ?2, ?3, ?4)",
                )?;
                for file in &files {
                    insert.execute(params![
                        project_id,
                        file.rel_path,
                        file.fingerprint.size as i64,
                        file.fingerprint.modified_ns
                    ])?;
                }
            }
            transaction.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn upsert_file(&self, project_id: &str, file: &CachedFile) -> GazeResult<()> {
        let project_id = project_id.to_string();
        let file = file.clone();
        self.run(move |connection| {
            connection.execute(
                "INSERT INTO file_index(project_id, rel_path, size, modified_ns)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(project_id, rel_path) DO UPDATE SET
                    size = excluded.size, modified_ns = excluded.modified_ns",
                params![
                    project_id,
                    file.rel_path,
                    file.fingerprint.size as i64,
                    file.fingerprint.modified_ns
                ],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn remove_files_under(&self, project_id: &str, prefix: &str) -> GazeResult<()> {
        let project_id = project_id.to_string();
        let prefix = prefix.to_string();
        self.run(move |connection| {
            connection.execute(
                "DELETE FROM file_index WHERE project_id = ?1
                 AND (rel_path = ?2 OR rel_path LIKE ?3 ESCAPE '\\')",
                params![project_id, prefix, format!("{}/%", escape_like(&prefix))],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn replace_files_under(
        &self,
        project_id: &str,
        prefix: &str,
        files: &[CachedFile],
    ) -> GazeResult<()> {
        let project_id = project_id.to_string();
        let prefix = prefix.to_string();
        let files = files.to_vec();
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            let pattern = format!("{}/%", escape_like(&prefix));
            transaction.execute(
                "DELETE FROM file_index WHERE project_id = ?1
                 AND (rel_path = ?2 OR rel_path LIKE ?3 ESCAPE '\\')",
                params![project_id, prefix, pattern],
            )?;
            {
                let mut insert = transaction.prepare(
                    "INSERT INTO file_index(project_id, rel_path, size, modified_ns)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(project_id, rel_path) DO UPDATE SET
                        size = excluded.size, modified_ns = excluded.modified_ns",
                )?;
                for file in &files {
                    insert.execute(params![
                        project_id,
                        file.rel_path,
                        file.fingerprint.size as i64,
                        file.fingerprint.modified_ns
                    ])?;
                }
            }
            transaction.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn replace_symbols_for_file(
        &self,
        project_id: &str,
        rel_path: &str,
        file: &CachedFile,
        symbols: &[CachedSymbol],
    ) -> GazeResult<()> {
        let project_id = project_id.to_string();
        let rel_path = rel_path.to_string();
        let file = file.clone();
        let symbols = symbols.to_vec();
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            transaction.execute(
                "DELETE FROM symbols WHERE project_id = ?1 AND rel_path = ?2",
                params![project_id, rel_path],
            )?;
            transaction.execute(
                "INSERT INTO symbol_files(project_id, rel_path, size, modified_ns)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(project_id, rel_path) DO UPDATE SET
                    size = excluded.size, modified_ns = excluded.modified_ns",
                params![
                    project_id,
                    rel_path,
                    file.fingerprint.size as i64,
                    file.fingerprint.modified_ns
                ],
            )?;
            {
                let mut insert = transaction.prepare(
                    "INSERT OR REPLACE INTO symbols(
                        project_id, rel_path, name, kind, line, character, scope, signature
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                )?;
                for symbol in &symbols {
                    insert.execute(params![
                        project_id,
                        symbol.path,
                        symbol.name,
                        symbol.kind,
                        symbol.line,
                        symbol.character,
                        symbol.scope,
                        symbol.signature
                    ])?;
                }
            }
            transaction.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn remove_symbols_for_file(
        &self,
        project_id: &str,
        rel_path: &str,
    ) -> GazeResult<()> {
        let project_id = project_id.to_string();
        let rel_path = rel_path.to_string();
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            transaction.execute(
                "DELETE FROM symbols WHERE project_id = ?1 AND rel_path = ?2",
                params![project_id, rel_path],
            )?;
            transaction.execute(
                "DELETE FROM symbol_files WHERE project_id = ?1 AND rel_path = ?2",
                params![project_id, rel_path],
            )?;
            transaction.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn remove_symbols_under(&self, project_id: &str, prefix: &str) -> GazeResult<()> {
        let project_id = project_id.to_string();
        let prefix = prefix.to_string();
        self.run(move |connection| {
            let transaction = connection.transaction()?;
            for table in ["symbols", "symbol_files"] {
                transaction.execute(
                    &format!(
                        "DELETE FROM {table} WHERE project_id = ?1
                         AND (rel_path = ?2 OR rel_path LIKE ?3 ESCAPE '\\')"
                    ),
                    params![project_id, prefix, format!("{}/%", escape_like(&prefix))],
                )?;
            }
            transaction.commit()?;
            Ok(())
        })
        .await
    }

    pub async fn symbol_file_fingerprints(
        &self,
        project_id: &str,
    ) -> GazeResult<std::collections::HashMap<String, FileFingerprint>> {
        let project_id = project_id.to_string();
        self.run(move |connection| {
            let mut statement = connection.prepare(
                "SELECT rel_path, size, modified_ns FROM symbol_files WHERE project_id = ?1",
            )?;
            let rows = statement.query_map(params![project_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    FileFingerprint {
                        size: row.get::<_, i64>(1)? as u64,
                        modified_ns: row.get(2)?,
                    },
                ))
            })?;
            let mut result = std::collections::HashMap::new();
            for row in rows {
                let (path, fingerprint) = row?;
                result.insert(path, fingerprint);
            }
            Ok(result)
        })
        .await
    }

    pub async fn symbols_for_file(
        &self,
        project_id: &str,
        rel_path: &str,
    ) -> GazeResult<Vec<CachedSymbol>> {
        let project_id = project_id.to_string();
        let rel_path = rel_path.to_string();
        self.run(move |connection| {
            let mut statement = connection.prepare(
                "SELECT rel_path, name, kind, line, character, scope, signature
                 FROM symbols WHERE project_id = ?1 AND rel_path = ?2
                 ORDER BY line, character",
            )?;
            let rows = statement.query_map(params![project_id, rel_path], map_symbol)?;
            rows.collect()
        })
        .await
    }

    pub async fn symbols_for_project(&self, project_id: &str) -> GazeResult<Vec<CachedSymbol>> {
        let project_id = project_id.to_string();
        self.run(move |connection| {
            let mut statement = connection.prepare(
                "SELECT rel_path, name, kind, line, character, scope, signature
                 FROM symbols WHERE project_id = ?1
                 ORDER BY rel_path, line, character",
            )?;
            let rows = statement.query_map(params![project_id], map_symbol)?;
            rows.collect()
        })
        .await
    }
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn map_symbol(row: &rusqlite::Row<'_>) -> rusqlite::Result<CachedSymbol> {
    Ok(CachedSymbol {
        path: row.get(0)?,
        name: row.get(1)?,
        kind: row.get(2)?,
        line: row.get::<_, i64>(3)? as u32,
        character: row.get::<_, i64>(4)? as u32,
        scope: row.get(5)?,
        signature: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn project_restore_and_cache_cascade() {
        let cache = Cache::open_in_memory().unwrap();
        let project = Project {
            id: "p1".to_string(),
            name: "Demo".to_string(),
            root: "/tmp/demo".to_string(),
        };
        cache.insert_project(&project).await.unwrap();
        assert_eq!(cache.projects().await.unwrap(), vec![project.clone()]);
        cache
            .replace_file_index(
                "p1",
                &[CachedFile {
                    rel_path: "src/main.ts".to_string(),
                    fingerprint: FileFingerprint {
                        size: 10,
                        modified_ns: 20,
                    },
                }],
            )
            .await
            .unwrap();
        assert_eq!(cache.cached_files("p1").await.unwrap().len(), 1);
        cache.delete_project("p1").await.unwrap();
        assert!(cache.cached_files("p1").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn settings_round_trip() {
        let cache = Cache::open_in_memory().unwrap();
        assert_eq!(cache.setting("theme").await.unwrap(), None);
        cache.set_setting("theme", "dark").await.unwrap();
        assert_eq!(
            cache.setting("theme").await.unwrap().as_deref(),
            Some("dark")
        );
    }

    #[tokio::test]
    async fn settings_batch_rolls_back_when_one_write_fails() {
        let cache = Cache::open_in_memory().unwrap();
        cache.set_setting("theme", "light").await.unwrap();
        cache
            .run(|connection| {
                connection.execute_batch(
                    "CREATE TRIGGER reject_preferences BEFORE INSERT ON settings
             WHEN NEW.key = 'preferences' BEGIN SELECT RAISE(ABORT, 'write failed'); END;",
                )
            })
            .await
            .unwrap();
        assert!(cache
            .set_settings(vec![
                ("theme".into(), "dark".into()),
                ("preferences".into(), "{}".into()),
            ])
            .await
            .is_err());
        assert_eq!(
            cache.setting("theme").await.unwrap().as_deref(),
            Some("light")
        );
        assert_eq!(cache.setting("preferences").await.unwrap(), None);
    }

    #[tokio::test]
    async fn directory_removal_escapes_sql_like_wildcards() {
        let cache = Cache::open_in_memory().unwrap();
        let project = Project {
            id: "p".to_string(),
            name: "Demo".to_string(),
            root: "/tmp/demo".to_string(),
        };
        cache.insert_project(&project).await.unwrap();
        let file = |path: &str| CachedFile {
            rel_path: path.to_string(),
            fingerprint: FileFingerprint {
                size: 1,
                modified_ns: 1,
            },
        };
        cache
            .replace_file_index(
                "p",
                &[
                    file("src_a/main.ts"),
                    file("srcXa/main.ts"),
                    file("100%/main.ts"),
                ],
            )
            .await
            .unwrap();
        cache.remove_files_under("p", "src_a").await.unwrap();
        cache.remove_files_under("p", "100%").await.unwrap();
        let remaining: Vec<String> = cache
            .cached_files("p")
            .await
            .unwrap()
            .into_iter()
            .map(|file| file.rel_path)
            .collect();
        assert_eq!(remaining, vec!["srcXa/main.ts"]);
    }

    #[tokio::test]
    async fn symbol_directory_removal_cleans_both_tables_without_touching_siblings() {
        let cache = Cache::open_in_memory().unwrap();
        let project = Project {
            id: "p".to_string(),
            name: "Demo".to_string(),
            root: "/tmp/demo".to_string(),
        };
        cache.insert_project(&project).await.unwrap();
        for path in ["src/a.ts", "srcX/a.ts"] {
            let file = CachedFile {
                rel_path: path.to_string(),
                fingerprint: FileFingerprint {
                    size: 1,
                    modified_ns: 1,
                },
            };
            cache.upsert_file("p", &file).await.unwrap();
            let symbol = CachedSymbol {
                path: path.to_string(),
                name: "value".to_string(),
                kind: "variable".to_string(),
                line: 0,
                character: 0,
                scope: None,
                signature: None,
            };
            cache
                .replace_symbols_for_file("p", path, &file, &[symbol])
                .await
                .unwrap();
        }
        cache.remove_symbols_under("p", "src").await.unwrap();
        assert_eq!(cache.symbol_file_fingerprints("p").await.unwrap().len(), 1);
        let symbols = cache.symbols_for_project("p").await.unwrap();
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].path, "srcX/a.ts");
    }
}
