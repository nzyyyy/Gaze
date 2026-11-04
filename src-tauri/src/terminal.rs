use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;

use crate::error::{GazeError, GazeResult};

const MAX_DIMENSION: u16 = 1000;
const OUTPUT_BATCH_BYTES: usize = 32 * 1024;
const OUTPUT_BATCH_WINDOW: Duration = Duration::from_millis(2);
const OUTPUT_QUEUE_CAPACITY: usize = 16;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub session_id: String,
    pub project_id: Option<String>,
    pub cwd: String,
    pub shell: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEvent {
    pub session_id: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<u32>,
}

pub const DATA: &str = "data";
pub const EXIT: &str = "exit";

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

enum ReaderMessage {
    Output(Vec<u8>),
    Exit(Option<u32>),
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

impl TerminalManager {
    pub fn create(
        &self,
        session_id: String,
        project_id: Option<String>,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
        emit: impl Fn(TerminalEvent) + Send + 'static,
    ) -> GazeResult<TerminalSessionInfo> {
        let (program, args) = default_shell();
        self.spawn_session(session_id, project_id, program, args, cwd, cols, rows, emit)
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_session(
        &self,
        session_id: String,
        project_id: Option<String>,
        program: String,
        args: Vec<String>,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
        emit: impl Fn(TerminalEvent) + Send + 'static,
    ) -> GazeResult<TerminalSessionInfo> {
        if !cwd.is_dir() {
            return Err(GazeError::Message("终端启动目录不存在。".to_string()));
        }
        let (cols, rows) = clamp_size(cols, rows);
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(pty_size(cols, rows))
            .map_err(|error| GazeError::Message(format!("无法创建终端：{error}")))?;

        let mut command = CommandBuilder::new(&program);
        command.args(&args);
        command.cwd(&cwd);
        if cfg!(unix) {
            command.env("TERM", "xterm-256color");
            command.env("COLORTERM", "truecolor");
        }

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| GazeError::Message(format!("无法启动 shell：{error}")))?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| GazeError::Message(format!("无法读取终端输出：{error}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| GazeError::Message(format!("无法写入终端：{error}")))?;
        let killer = child.clone_killer();

        {
            let mut sessions = self.lock()?;
            if sessions.contains_key(&session_id) {
                return Err(GazeError::Message("终端会话已存在。".to_string()));
            }
            sessions.insert(
                session_id.clone(),
                Session {
                    master: pair.master,
                    writer,
                    killer,
                },
            );
        }

        let (output_sender, output_receiver) = std::sync::mpsc::sync_channel(OUTPUT_QUEUE_CAPACITY);
        let reader_thread = std::thread::Builder::new()
            .name(format!("gaze-terminal-read-{session_id}"))
            .spawn(move || {
                let mut buffer = [0u8; 8192];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(read) => {
                            if output_sender
                                .send(ReaderMessage::Output(buffer[..read].to_vec()))
                                .is_err()
                            {
                                return;
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
                let exit_code = child.wait().ok().map(|status| status.exit_code());
                let _ = output_sender.send(ReaderMessage::Exit(exit_code));
            });
        if let Err(error) = reader_thread {
            let _ = self.close(&session_id);
            return Err(GazeError::Message(format!("无法启动终端线程：{error}")));
        }

        let thread_session = session_id.clone();
        let sessions = Arc::clone(&self.sessions);
        if let Err(error) = std::thread::Builder::new()
            .name(format!("gaze-terminal-output-{session_id}"))
            .spawn(move || {
                forward_terminal_output(output_receiver, thread_session, sessions, emit);
            })
        {
            let _ = self.close(&session_id);
            return Err(GazeError::Message(format!("无法启动终端线程：{error}")));
        }

        Ok(TerminalSessionInfo {
            session_id,
            project_id,
            cwd: cwd.to_string_lossy().into_owned(),
            shell: program,
        })
    }

    pub fn write(&self, session_id: &str, data: &[u8]) -> GazeResult<()> {
        // ponytail: 按键量小，直接持锁写入；如果出现大块粘贴阻塞 resize/close，再改成每会话独立锁。
        let mut sessions = self.lock()?;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| GazeError::Message("终端会话不存在。".to_string()))?;
        session
            .writer
            .write_all(data)
            .and_then(|_| session.writer.flush())
            .map_err(|error| GazeError::Message(format!("无法写入终端：{error}")))
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> GazeResult<()> {
        let (cols, rows) = clamp_size(cols, rows);
        let sessions = self.lock()?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| GazeError::Message("终端会话不存在。".to_string()))?;
        session
            .master
            .resize(pty_size(cols, rows))
            .map_err(|error| GazeError::Message(format!("无法调整终端大小：{error}")))
    }

    pub fn close(&self, session_id: &str) -> GazeResult<()> {
        let session = self.lock()?.remove(session_id);
        if let Some(mut session) = session {
            // ponytail: 只结束 shell 本身；脱离进程组的后台任务仍可能存活，需要进程树管理时再扩展。
            let _ = session.killer.kill();
        }
        Ok(())
    }

    pub fn close_all(&self) {
        let sessions = match self.sessions.lock() {
            Ok(mut sessions) => sessions.drain().map(|(_, session)| session).collect(),
            Err(_) => Vec::new(),
        };
        kill_all(sessions);
    }

    fn lock(&self) -> GazeResult<std::sync::MutexGuard<'_, HashMap<String, Session>>> {
        self.sessions
            .lock()
            .map_err(|_| GazeError::Message("终端会话锁已损坏。".to_string()))
    }
}

fn forward_terminal_output(
    receiver: std::sync::mpsc::Receiver<ReaderMessage>,
    session_id: String,
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    emit: impl Fn(TerminalEvent),
) {
    let mut batch = Vec::with_capacity(OUTPUT_BATCH_BYTES);
    let mut flush_at: Option<Instant> = None;
    loop {
        let message = match flush_at {
            Some(deadline) => {
                match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(message) => Some(message),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        emit_terminal_data(&session_id, &batch, &emit);
                        finish_terminal(&session_id, &sessions, None, &emit);
                        return;
                    }
                }
            }
            None => match receiver.recv() {
                Ok(message) => Some(message),
                Err(_) => {
                    finish_terminal(&session_id, &sessions, None, &emit);
                    return;
                }
            },
        };

        match message {
            Some(ReaderMessage::Output(chunk)) => {
                if batch.is_empty() {
                    flush_at = Some(Instant::now() + OUTPUT_BATCH_WINDOW);
                }
                batch.extend_from_slice(&chunk);
                if batch.len() >= OUTPUT_BATCH_BYTES {
                    emit_terminal_data(&session_id, &batch, &emit);
                    batch.clear();
                    flush_at = None;
                }
            }
            Some(ReaderMessage::Exit(exit_code)) => {
                emit_terminal_data(&session_id, &batch, &emit);
                finish_terminal(&session_id, &sessions, exit_code, &emit);
                return;
            }
            None => {
                emit_terminal_data(&session_id, &batch, &emit);
                batch.clear();
                flush_at = None;
            }
        }
    }
}

fn emit_terminal_data(session_id: &str, data: &[u8], emit: &impl Fn(TerminalEvent)) {
    if data.is_empty() {
        return;
    }
    emit(TerminalEvent {
        session_id: session_id.to_string(),
        kind: DATA,
        data: Some(STANDARD.encode(data)),
        exit_code: None,
    });
}

fn finish_terminal(
    session_id: &str,
    sessions: &Arc<Mutex<HashMap<String, Session>>>,
    exit_code: Option<u32>,
    emit: &impl Fn(TerminalEvent),
) {
    let session = sessions
        .lock()
        .ok()
        .and_then(|mut sessions| sessions.remove(session_id));
    drop(session);
    emit(TerminalEvent {
        session_id: session_id.to_string(),
        kind: EXIT,
        data: None,
        exit_code,
    });
}

fn kill_all(sessions: Vec<Session>) {
    for mut session in sessions {
        let _ = session.killer.kill();
    }
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn clamp_size(cols: u16, rows: u16) -> (u16, u16) {
    (cols.clamp(1, MAX_DIMENSION), rows.clamp(1, MAX_DIMENSION))
}

#[cfg(windows)]
fn default_shell() -> (String, Vec<String>) {
    (
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string()),
        Vec::new(),
    )
}

#[cfg(not(windows))]
fn default_shell() -> (String, Vec<String>) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    (shell, vec!["-l".to_string()])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn decode(event: &TerminalEvent) -> String {
        let data = event.data.clone().unwrap_or_default();
        String::from_utf8_lossy(&STANDARD.decode(data).unwrap()).into_owned()
    }

    #[cfg(unix)]
    #[test]
    fn streams_output_and_reports_exit() {
        let manager = TerminalManager::default();
        let (tx, rx) = mpsc::channel();
        let cwd = std::env::temp_dir().canonicalize().unwrap();
        let info = manager
            .spawn_session(
                "exit-test".to_string(),
                None,
                "/bin/sh".to_string(),
                vec!["-c".to_string(), "pwd -P; printf hello".to_string()],
                cwd.clone(),
                80,
                24,
                move |event| {
                    let _ = tx.send(event);
                },
            )
            .unwrap();
        assert!(info.project_id.is_none());
        assert_eq!(info.cwd, cwd.to_string_lossy());

        let mut output = String::new();
        let exit_code;
        loop {
            let event = rx
                .recv_timeout(Duration::from_secs(10))
                .expect("terminal event timeout");
            output.push_str(&decode(&event));
            if event.kind == EXIT {
                exit_code = event.exit_code;
                break;
            }
        }
        assert!(output.contains("hello"), "output = {output:?}");
        assert!(
            output.contains(cwd.to_str().unwrap()),
            "output = {output:?}"
        );
        assert_eq!(exit_code, Some(0));
        assert!(manager.sessions.lock().unwrap().is_empty());
        assert!(manager.write("exit-test", b"stale").is_err());
        manager.close_all();
    }

    #[test]
    fn coalesces_output_chunks_before_emitting() {
        let manager = TerminalManager::default();
        let (sender, receiver) = std::sync::mpsc::sync_channel(8);
        for value in 0..4 {
            sender
                .send(ReaderMessage::Output(vec![value; 8192]))
                .unwrap();
        }
        sender.send(ReaderMessage::Exit(Some(0))).unwrap();
        let (event_sender, event_receiver) = mpsc::channel();
        forward_terminal_output(
            receiver,
            "batch-test".to_string(),
            Arc::clone(&manager.sessions),
            move |event| {
                let _ = event_sender.send(event);
            },
        );

        let events: Vec<TerminalEvent> = event_receiver.iter().collect();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, DATA);
        let bytes = STANDARD.decode(events[0].data.as_deref().unwrap()).unwrap();
        assert_eq!(bytes.len(), OUTPUT_BATCH_BYTES);
        for (value, chunk) in bytes.chunks(8192).enumerate() {
            assert!(chunk.iter().all(|byte| *byte == value as u8));
        }
        assert_eq!(events[1].kind, EXIT);
        assert_eq!(events[1].exit_code, Some(0));
    }

    #[cfg(unix)]
    #[test]
    fn writes_and_resizes() {
        let manager = TerminalManager::default();
        let (tx, rx) = mpsc::channel();
        manager
            .spawn_session(
                "write-test".to_string(),
                Some("project".to_string()),
                "/bin/sh".to_string(),
                vec!["-c".to_string(), "cat".to_string()],
                std::env::temp_dir(),
                80,
                24,
                move |event| {
                    let _ = tx.send(event);
                },
            )
            .unwrap();

        manager.resize("write-test", 100, 40).unwrap();
        manager.write("write-test", b"ping\n").unwrap();

        let mut output = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !output.contains("ping") && std::time::Instant::now() < deadline {
            if let Ok(event) = rx.recv_timeout(Duration::from_millis(500)) {
                output.push_str(&decode(&event));
            }
        }
        assert!(output.contains("ping"), "output = {output:?}");
        manager.close("write-test").unwrap();
    }
}
