use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use rquickjs::{Context, Function, Value};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use super::{
    digest, invalid, read_file, write_native, Input, InstalledPlugin, Output, Runtime, MANIFEST,
    MAX_MANIFEST,
};
use crate::error::{GazeError, GazeResult};

pub(crate) const WORKER_FLAG: &str = "--gaze-plugin-worker";
const MAX_OUTPUT: usize = 256 * 1024;
const JS_BUDGET: Duration = Duration::from_millis(750);

#[derive(Serialize, Deserialize)]
struct WorkerRequest<'a> {
    #[serde(borrow)]
    source: std::borrow::Cow<'a, str>,
    input: Input,
}

pub(super) fn verified_entry(plugin: &InstalledPlugin, directory: &Path) -> GazeResult<Vec<u8>> {
    let directory = directory.canonicalize()?;
    let manifest = read_file(&directory, MANIFEST, MAX_MANIFEST)?;
    let entry = read_file(
        &directory,
        &plugin.manifest.entry,
        plugin.manifest.runtime.entry_limit(),
    )?;
    if digest(&manifest, &entry) != plugin.digest {
        return Err(GazeError::Permission(
            "插件内容已更改，请重新导入并启用。".into(),
        ));
    }
    Ok(entry)
}

pub(super) async fn run(
    plugin: InstalledPlugin,
    directory: PathBuf,
    input: Input,
    cancel: &CancellationToken,
    worker: PathBuf,
) -> GazeResult<Output> {
    let markdown = matches!(&input, Input::Markdown { .. });
    let runtime = plugin.manifest.runtime;
    let (mut command, payload, _staging) = tokio::task::spawn_blocking(move || {
        let entry = verified_entry(&plugin, &directory)?;
        match runtime {
            Runtime::JavaScript => {
                let source = std::str::from_utf8(&entry)
                    .map_err(|_| invalid("JavaScript 插件入口必须使用 UTF-8。"))?;
                let payload = serde_json::to_vec(&WorkerRequest {
                    source: source.into(),
                    input,
                })?;
                let mut command = Command::new(worker);
                command.arg(WORKER_FLAG);
                Ok::<_, GazeError>((command, payload, None))
            }
            Runtime::Native => {
                // Execute the verified bytes, even if the installed file is replaced after verification.
                let staged = tempfile::tempdir()?;
                let path = staged.path().join(&plugin.manifest.entry);
                write_native(&path, &entry)?;
                let mut command = Command::new(path);
                command.current_dir(staged.path());
                Ok((command, serde_json::to_vec(&input)?, Some(staged)))
            }
        }
    })
    .await??;
    if cancel.is_cancelled() {
        return Err(GazeError::Cancelled);
    }
    command
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = command.spawn()?;
    #[cfg(unix)]
    let pid = child.id();
    let mut stdin = child.stdin.take().expect("plugin stdin is piped");
    let mut stdout = child
        .stdout
        .take()
        .expect("plugin stdout is piped")
        .take(MAX_OUTPUT as u64 + 1);
    let budget = match runtime {
        Runtime::JavaScript => Duration::from_secs(2),
        Runtime::Native => Duration::from_secs(10),
    };
    let exchange = async {
        let send = async move {
            stdin.write_all(&payload).await?;
            stdin.shutdown().await?;
            Ok::<_, GazeError>(())
        };
        let receive = async {
            let mut bytes = Vec::new();
            stdout.read_to_end(&mut bytes).await?;
            if bytes.len() > MAX_OUTPUT {
                return Err(GazeError::TooLarge("插件输出超过大小限制。".into()));
            }
            Ok::<_, GazeError>(bytes)
        };
        let ((), bytes) = tokio::try_join!(send, receive)?;
        if !child.wait().await?.success() {
            return Err(invalid("插件执行失败或进程异常退出。"));
        }
        Ok(bytes)
    };
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(GazeError::Cancelled),
        result = tokio::time::timeout(budget, exchange) => {
            result.unwrap_or_else(|_| Err(invalid("插件执行超时。")))
        }
    };
    #[cfg(unix)]
    if let Some(pid) = pid {
        // Each invocation owns a process group. Stop descendants left in that group.
        unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
    }
    if result.is_err() {
        let _ = child.kill().await;
    }
    let value: Output =
        serde_json::from_slice(&result?).map_err(|_| invalid("插件返回了无效的数据。"))?;
    match &value {
        Output::Text { .. } if markdown => Ok(value),
        Output::Table { headers, rows }
            if markdown
                && !headers.is_empty()
                && headers.len() <= 32
                && rows.len() <= 256
                && rows.iter().all(|row| row.len() == headers.len()) =>
        {
            Ok(value)
        }
        Output::Unchanged | Output::Replace { .. } if !markdown => Ok(value),
        _ => Err(invalid("插件返回的数据与请求类型不匹配。")),
    }
}

fn evaluate(request: WorkerRequest<'_>) -> rquickjs::Result<Vec<u8>> {
    let runtime = rquickjs::Runtime::new()?;
    runtime.set_memory_limit(32 * 1024 * 1024);
    runtime.set_max_stack_size(512 * 1024);
    let deadline = Instant::now() + JS_BUDGET;
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    let context = Context::full(&runtime)?;
    context.with(|ctx| {
        ctx.eval::<(), _>(request.source.as_bytes())?;
        let handler: Function = ctx.globals().get("gazePlugin")?;
        let json = serde_json::to_vec(&request.input).map_err(|_| rquickjs::Error::Unknown)?;
        let result: Value = handler.call((ctx.json_parse(json)?,))?;
        let output = ctx
            .json_stringify(result)?
            .ok_or(rquickjs::Error::Unknown)?;
        let bytes = output.to_string()?.into_bytes();
        if bytes.len() > MAX_OUTPUT {
            return Err(rquickjs::Error::Unknown);
        }
        Ok(bytes)
    })
}

pub(crate) fn worker() -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(16 * 1024 * 1024)
        .read_to_end(&mut bytes)?;
    let request = serde_json::from_slice(&bytes)?;
    let result = evaluate(request)?;
    std::io::stdout().write_all(&result)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script(source: &str) -> WorkerRequest<'_> {
        WorkerRequest {
            source: source.into(),
            input: Input::Command {
                id: "echo".into(),
                text: "x".into(),
                language: "Plain Text".into(),
            },
        }
    }

    #[test]
    fn javascript_has_no_os_bindings_and_interrupts_infinite_loops() {
        let bytes = evaluate(script(r#"globalThis.gazePlugin = (value) => ({
            kind: "replace", text: value.text + ":" +
            [typeof fetch, typeof require, typeof process, typeof Deno, typeof std, typeof os, typeof __TAURI__].join(",")
        })"#)).unwrap();
        assert!(matches!(
            serde_json::from_slice::<Output>(&bytes).unwrap(),
            Output::Replace { text } if text == "x:undefined,undefined,undefined,undefined,undefined,undefined,undefined"
        ));
        assert!(evaluate(script("while (true) {}")).is_err());
        assert!(evaluate(script("globalThis.gazePlugin = () => { while (true) {} }")).is_err());
        assert!(evaluate(script(
            "globalThis.gazePlugin = () => ({ kind: 'replace', text: 'x'.repeat(300000) })"
        ))
        .is_err());
    }
}
