use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};
use url::Url;

use crate::error::{GazeError, GazeResult};

const MAX_MESSAGE_BYTES: usize = 32 * 1024 * 1024;

type PendingMap = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

struct PendingRequest<'a> {
    client: &'a LspClient,
    id: i64,
}

impl Drop for PendingRequest<'_> {
    fn drop(&mut self) {
        let removed = self
            .client
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&self.id));
        if removed.is_some() {
            self.client
                .notify("$/cancelRequest", json!({ "id": self.id }));
        }
    }
}

#[derive(Clone)]
pub struct LspClient {
    sender: mpsc::UnboundedSender<Value>,
    pending: PendingMap,
    next_id: Arc<AtomicI64>,
    child: Arc<tokio::sync::Mutex<Child>>,
    closed: Arc<AtomicBool>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
}

impl LspClient {
    pub async fn spawn<Fut: Future<Output = ()> + Send>(
        executable: &Path,
        args: &[String],
        working_directory: &Path,
        root_uri: &str,
        project_name: &str,
        python_path: Option<String>,
        publish_diagnostics: impl Fn(Value) -> Fut + Send + 'static,
    ) -> GazeResult<Self> {
        let mut command = Command::new(executable);
        command
            .args(args)
            .current_dir(working_directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|error| {
            GazeError::ToolMissing(format!(
                "无法启动语言服务器 {}：{error}",
                executable.display()
            ))
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| GazeError::Message("无法写入语言服务器标准输入。".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| GazeError::Message("无法读取语言服务器标准输出。".to_string()))?;
        let stderr = child.stderr.take();
        let (sender, mut receiver) = mpsc::unbounded_channel::<Value>();
        let pending = Arc::new(Mutex::new(HashMap::<
            i64,
            oneshot::Sender<Result<Value, String>>,
        >::new()));
        let closed = Arc::new(AtomicBool::new(false));
        let stderr_tail = Arc::new(Mutex::new(VecDeque::<String>::new()));

        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(message) = receiver.recv().await {
                let bytes = match encode_message(&message) {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        tracing::warn!(%error, "failed to encode an LSP message");
                        break;
                    }
                };
                if let Err(error) = stdin.write_all(&bytes).await {
                    tracing::warn!(%error, "failed to write to the language server");
                    break;
                }
                if let Err(error) = stdin.flush().await {
                    tracing::warn!(%error, "failed to flush the language server");
                    break;
                }
            }
        });

        if let Some(stderr) = stderr {
            let stderr_tail = Arc::clone(&stderr_tail);
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    tracing::debug!(target: "gaze::lsp", "{line}");
                    if let Ok(mut tail) = stderr_tail.lock() {
                        if tail.len() >= 24 {
                            tail.pop_front();
                        }
                        tail.push_back(line);
                    }
                }
            });
        }

        let response_sender = sender.clone();
        let reader_pending = Arc::clone(&pending);
        let reader_closed = Arc::clone(&closed);
        let reader_stderr = Arc::clone(&stderr_tail);
        let root_uri = root_uri.to_string();
        let project_name = project_name.to_string();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_message(&mut reader).await {
                    Ok(Some(mut message)) => {
                        if message.get("id").is_none()
                            && message["method"] == "textDocument/publishDiagnostics"
                        {
                            publish_diagnostics(message["params"].take()).await;
                            continue;
                        }
                        route_message(
                            message,
                            &response_sender,
                            &reader_pending,
                            &root_uri,
                            &project_name,
                            python_path.as_deref(),
                        );
                    }
                    Ok(None) => break,
                    Err(error) => {
                        tracing::warn!(%error, "LSP transport stopped");
                        break;
                    }
                }
            }
            reader_closed.store(true, Ordering::SeqCst);
            let message = stderr_summary(&reader_stderr)
                .map(|stderr| format!("语言服务器连接已关闭：{stderr}"))
                .unwrap_or_else(|| "语言服务器连接已关闭。".to_string());
            if let Ok(mut pending) = reader_pending.lock() {
                for (_, sender) in pending.drain() {
                    let _ = sender.send(Err(message.clone()));
                }
            }
        });

        Ok(Self {
            sender,
            pending,
            next_id: Arc::new(AtomicI64::new(0)),
            child: Arc::new(tokio::sync::Mutex::new(child)),
            closed,
            stderr_tail,
        })
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> GazeResult<Value> {
        if self.is_closed() {
            let detail = stderr_summary(&self.stderr_tail);
            return Err(GazeError::Message(match detail {
                Some(detail) => format!("语言服务器已退出：{detail}"),
                None => "语言服务器已退出。".to_string(),
            }));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (response_sender, response_receiver) = oneshot::channel();
        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| GazeError::Message("LSP 请求表锁已损坏。".to_string()))?;
            pending.insert(id, response_sender);
        }
        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if self.sender.send(message).is_err() {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            return Err(GazeError::Message("无法写入语言服务器。".to_string()));
        }
        let _pending_request = PendingRequest { client: self, id };
        match tokio::time::timeout(timeout, response_receiver).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(message))) => Err(GazeError::Message(message)),
            Ok(Err(_)) => Err(GazeError::Message("语言服务器请求已中断。".to_string())),
            Err(_) => Err(GazeError::Message(format!(
                "语言服务器在 {} 秒内未响应 {method} 请求。",
                timeout.as_secs()
            ))),
        }
    }

    pub fn notify(&self, method: &str, params: Value) {
        let _ = self.sender.send(json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }));
    }

    pub async fn shutdown(&self) {
        let _ = self
            .request("shutdown", Value::Null, Duration::from_secs(2))
            .await;
        self.notify("exit", Value::Null);
        let mut child = self.child.lock().await;
        if tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
    }

    pub async fn kill(&self) {
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
    }
}

fn route_message(
    message: Value,
    sender: &mpsc::UnboundedSender<Value>,
    pending: &Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>,
    root_uri: &str,
    project_name: &str,
    python_path: Option<&str>,
) {
    if let Some(id) = message.get("id").and_then(Value::as_i64) {
        if message.get("method").is_none() {
            if let Ok(mut pending) = pending.lock() {
                if let Some(response) = pending.remove(&id) {
                    let result = if let Some(error) = message.get("error") {
                        let code = error.get("code").and_then(Value::as_i64).unwrap_or(-32603);
                        let text = error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("未知语言服务器错误");
                        Err(format!("LSP 错误 {code}: {text}"))
                    } else {
                        Ok(message.get("result").cloned().unwrap_or(Value::Null))
                    };
                    let _ = response.send(result);
                }
            }
            return;
        }

        if let Some(method) = message.get("method").and_then(Value::as_str) {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            let response =
                server_request_response(method, &params, root_uri, project_name, python_path);
            let _ = sender.send(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": response,
            }));
        }
        return;
    }

    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return;
    };
    if method == "window/logMessage" {
        if let Some(text) = message
            .get("params")
            .and_then(|params| params.get("message"))
            .and_then(Value::as_str)
        {
            tracing::debug!(target: "gaze::lsp", "{text}");
        }
    }
}

fn server_request_response(
    method: &str,
    params: &Value,
    root_uri: &str,
    project_name: &str,
    python_path: Option<&str>,
) -> Value {
    match method {
        "workspace/configuration" => Value::Array(
            params["items"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|item| {
                    if let Some(path) = python_path {
                        if item["section"] == "python" && in_workspace(&item["scopeUri"], root_uri)
                        {
                            return json!({ "pythonPath": path });
                        }
                    }
                    Value::Null
                })
                .collect(),
        ),
        "workspace/workspaceFolders" => json!([
            { "uri": root_uri, "name": project_name }
        ]),
        "workspace/applyEdit" => json!({
            "applied": false,
            "failureReason": "Gaze 暂不应用语言服务器发起的批量编辑。"
        }),
        "client/registerCapability"
        | "client/unregisterCapability"
        | "window/workDoneProgress/create"
        | "window/showMessageRequest" => Value::Null,
        _ => Value::Null,
    }
}

fn in_workspace(scope: &Value, root: &str) -> bool {
    if scope.is_null() {
        return true;
    }
    let file_path = |value: &str| Url::parse(value).ok()?.to_file_path().ok();
    scope
        .as_str()
        .and_then(file_path)
        .zip(file_path(root))
        .is_some_and(|(scope, root)| scope.starts_with(root))
}

async fn read_message<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> GazeResult<Option<Value>> {
    let mut content_length = None;
    loop {
        let mut header = String::new();
        let read = reader.read_line(&mut header).await?;
        if read == 0 {
            return Ok(None);
        }
        let trimmed = header.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some(value) = trimmed
            .split_once(':')
            .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .map(|(_, value)| value.trim())
        {
            content_length = value.parse::<usize>().ok();
        }
    }
    let length = content_length
        .ok_or_else(|| GazeError::Message("LSP 消息缺少 Content-Length。".to_string()))?;
    if length > MAX_MESSAGE_BYTES {
        return Err(GazeError::Message("LSP 消息超过大小上限。".to_string()));
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).await?;
    let message = serde_json::from_slice(&body)
        .map_err(|error| GazeError::Message(format!("LSP JSON 解析失败：{error}")))?;
    Ok(Some(message))
}

fn encode_message(message: &Value) -> GazeResult<Vec<u8>> {
    let body = serde_json::to_vec(message)?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut output = Vec::with_capacity(header.len() + body.len());
    output.extend_from_slice(header.as_bytes());
    output.extend_from_slice(&body);
    Ok(output)
}

fn stderr_summary(tail: &Mutex<VecDeque<String>>) -> Option<String> {
    tail.lock()
        .ok()
        .filter(|lines| !lines.is_empty())
        .map(|lines| lines.iter().cloned().collect::<Vec<_>>().join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    #[tokio::test]
    async fn round_trips_lsp_framing_with_unicode() {
        let value = json!({"jsonrpc": "2.0", "method": "测试", "params": "你好😀"});
        let encoded = encode_message(&value).unwrap();
        let (mut client, server) = duplex(encoded.len() + 32);
        tokio::spawn(async move {
            let mut server = server;
            server.write_all(&encoded).await.unwrap();
        });
        let mut reader = BufReader::new(&mut client);
        let decoded = read_message(&mut reader).await.unwrap().unwrap();
        assert_eq!(decoded, value);
    }

    #[tokio::test]
    async fn reports_missing_content_length() {
        let (mut client, mut server) = duplex(64);
        tokio::spawn(async move {
            server
                .write_all(b"Content-Type: application/vscode-jsonrpc\r\n\r\n{}")
                .await
                .unwrap();
        });
        let mut reader = BufReader::new(&mut client);
        assert!(read_message(&mut reader).await.is_err());
    }

    #[test]
    fn exposes_python_only_to_configuration_requests_for_that_project() {
        let dir = tempfile::tempdir().unwrap();
        let root = Url::from_directory_path(dir.path()).unwrap();
        let source = Url::from_file_path(dir.path().join("main.py")).unwrap();
        let elsewhere = Url::from_file_path(dir.path().with_extension("unrelated")).unwrap();
        let response = server_request_response(
            "workspace/configuration",
            &json!({"items": [
                { "section": "python", "scopeUri": source.as_str() },
                { "section": "python", "scopeUri": elsewhere.as_str() },
                { "section": "pyright" }
            ]}),
            root.as_str(),
            "project",
            Some("/venv/bin/python"),
        );
        assert_eq!(
            response,
            json!([{ "pythonPath": "/venv/bin/python" }, null, null])
        );
    }

    #[test]
    fn answers_server_configuration_without_enabling_edits() {
        assert_eq!(
            server_request_response("workspace/applyEdit", &Value::Null, "file:///x", "X", None),
            json!({"applied": false, "failureReason": "Gaze 暂不应用语言服务器发起的批量编辑。"})
        );
    }
}
