use std::path::PathBuf;

use super::*;

fn example(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../examples/plugins")
        .join(name)
}

fn manager(directory: &Path, worker: PathBuf) -> Plugins {
    Plugins::new(
        directory.join("installed"),
        Cache::open(&directory.join("workspace.sqlite3")).unwrap(),
        worker,
    )
}

async fn enable(plugins: &Plugins, plugin: &InstalledPlugin, approved: bool) -> GazeResult<()> {
    plugins
        .set_enabled(
            &plugin.manifest.id,
            plugin.revision,
            true,
            approved,
            Vec::new(),
        )
        .await?;
    Ok(())
}

fn command(id: &str, text: &str) -> Input {
    Input::Command {
        id: id.into(),
        text: text.into(),
        language: "Plain Text".into(),
    }
}

#[tokio::test]
async fn installation_rejects_bad_manifests_and_preserves_the_installed_copy() {
    let data = tempfile::tempdir().unwrap();
    let plugins = manager(data.path(), PathBuf::new());
    let source = tempfile::tempdir().unwrap();
    let original = plugins
        .install(example("text-tools"))
        .await
        .unwrap()
        .remove(0);

    let manifest = fs::read_to_string(example("text-tools").join(MANIFEST)).unwrap();
    for bad in [
        manifest.replace("\"apiVersion\": 1", "\"apiVersion\": 127"),
        manifest.replace("example.text-tools", "gaze.mermaid"),
        manifest.replace("\"plugin.js\"", "\"../plugin.js\""),
        manifest.replace(
            "\"kind\": \"markdown\", \"language\": \"csv\"",
            "\"kind\": \"command\", \"id\": \"uppercase\", \"title\": \"Duplicate\"",
        ),
    ] {
        fs::write(source.path().join(MANIFEST), bad).unwrap();
        assert!(plugins.install(source.path().to_owned()).await.is_err());
        assert_eq!(plugins.list().await.unwrap()[0].revision, original.revision);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        fs::write(source.path().join(MANIFEST), &manifest).unwrap();
        symlink(
            example("text-tools").join("plugin.js"),
            source.path().join("plugin.js"),
        )
        .unwrap();
        assert!(plugins.install(source.path().to_owned()).await.is_err());
    }

    let conflict = plugins
        .set_enabled(
            &original.manifest.id,
            original.revision,
            true,
            false,
            vec!["csv".into()],
        )
        .await;
    assert!(matches!(conflict, Err(GazeError::Conflict(_))));
    enable(&plugins, &original, false).await.unwrap();

    let reopened = manager(data.path(), PathBuf::new());
    assert!(reopened.list().await.unwrap()[0].enabled);
    let replaced = reopened
        .install(example("text-tools"))
        .await
        .unwrap()
        .remove(0);
    assert_ne!(replaced.revision, original.revision);
    assert!(!replaced.enabled);
    assert!(plugins
        .invoke(
            original.revision,
            Uuid::new_v4(),
            command("uppercase", "word")
        )
        .await
        .is_err());
    reopened.uninstall(replaced.revision).await.unwrap();
    assert!(plugins.list().await.unwrap().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn native_execution_requires_revision_approval_and_cancels_running_work() {
    let data = tempfile::tempdir().unwrap();
    let plugins = manager(data.path(), PathBuf::new());
    let source = tempfile::tempdir().unwrap();
    let manifest = fs::read_to_string(example("native-command").join(MANIFEST)).unwrap();
    fs::write(
        source.path().join(MANIFEST),
        manifest.replace("plugin.py", "plugin"),
    )
    .unwrap();
    fs::write(
        source.path().join("plugin"),
        b"#!/bin/sh\ncat >/dev/null\nprintf '%s' '{\"kind\":\"replace\",\"text\":\"sorted\"}'",
    )
    .unwrap();
    let plugin = plugins
        .install(source.path().to_owned())
        .await
        .unwrap()
        .remove(0);
    assert!(matches!(
        enable(&plugins, &plugin, false).await,
        Err(GazeError::Permission(_))
    ));
    enable(&plugins, &plugin, true).await.unwrap();

    let input = command("sort-lines", "b\na");
    let output = plugins
        .invoke(plugin.revision, Uuid::new_v4(), input)
        .await
        .unwrap();
    assert!(matches!(output, Output::Replace { text } if text == "sorted"));

    fs::write(
        plugins.directory(plugin.revision).join("plugin"),
        b"modified",
    )
    .unwrap();
    assert!(matches!(
        plugins
            .invoke(
                plugin.revision,
                Uuid::new_v4(),
                command("sort-lines", "b\na")
            )
            .await,
        Err(GazeError::Permission(_))
    ));

    for (source_code, cancels) in [
        ("exit 3", false),
        (
            "printf '%s' '{\"kind\":\"text\",\"text\":\"wrong\"}'",
            false,
        ),
        ("exec /bin/sleep 10", true),
    ] {
        fs::write(
            source.path().join("plugin"),
            format!("#!/bin/sh\n{source_code}\n"),
        )
        .unwrap();
        let updated = plugins
            .install(source.path().to_owned())
            .await
            .unwrap()
            .remove(0);
        assert!(!updated.enabled);
        assert!(matches!(
            enable(&plugins, &updated, false).await,
            Err(GazeError::Permission(_))
        ));
        enable(&plugins, &updated, true).await.unwrap();
        let request_id = Uuid::new_v4();
        let invoke = plugins.invoke(updated.revision, request_id, command("sort-lines", "b\na"));
        if cancels {
            let disable = async {
                loop {
                    if plugins.registry.lock().await.jobs.contains_key(&request_id) {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
                plugins
                    .set_enabled(
                        &updated.manifest.id,
                        updated.revision,
                        false,
                        false,
                        Vec::new(),
                    )
                    .await
                    .unwrap();
            };
            let (result, ()) = tokio::time::timeout(Duration::from_secs(2), async {
                tokio::join!(invoke, disable)
            })
            .await
            .unwrap();
            assert!(matches!(result, Err(GazeError::Cancelled)));
        } else {
            assert!(invoke.await.is_err());
        }
    }
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "requires GAZE_TEST_PLUGIN_WORKER pointing to the macOS app executable"]
async fn packaged_plugin_smoke() {
    let worker = std::env::var_os("GAZE_TEST_PLUGIN_WORKER").expect("packaged Gaze executable");
    let data = tempfile::tempdir().unwrap();
    let plugins = manager(data.path(), worker.into());
    let js = plugins
        .install(example("text-tools"))
        .await
        .unwrap()
        .remove(0);
    enable(&plugins, &js, false).await.unwrap();
    assert!(matches!(
        plugins.invoke(js.revision, Uuid::new_v4(), command("uppercase", "Gaze")).await.unwrap(),
        Output::Replace { text } if text == "GAZE"
    ));
    let table = plugins
        .invoke(
            js.revision,
            Uuid::new_v4(),
            Input::Markdown {
                language: "csv".into(),
                code: "name,note\nGaze,\"fast, local\"".into(),
            },
        )
        .await
        .unwrap();
    assert!(matches!(table, Output::Table { rows, .. } if rows[0][1] == "fast, local"));

    let native = plugins
        .install(example("native-command"))
        .await
        .unwrap()
        .into_iter()
        .find(|plugin| plugin.manifest.runtime == Runtime::Native)
        .unwrap();
    enable(&plugins, &native, true).await.unwrap();
    assert!(matches!(
        plugins.invoke(native.revision, Uuid::new_v4(), command("sort-lines", "b\na")).await.unwrap(),
        Output::Replace { text } if text == "a\nb"
    ));
}
