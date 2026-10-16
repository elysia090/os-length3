// Prompts on the distribution's root (l3 open, core/src/launch.rs). Each
// is an `l3 open REPO` process beside the app; what it prints comes to the
// webview as `prompt` events, what is typed goes to its standard input.
// Closing kills its supervisor, and with it (PDEATHSIG, then the pid
// namespace) every process inside; it is only called stopped once the host
// shows none left, and what they held and how long it took are said.

use length3_core::{paths, prompt, root};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

struct Shell {
    child: Child,
    stdin: ChildStdin,
    ns: Option<u64>,
}

#[derive(Default)]
pub struct Shells {
    next: AtomicU32,
    open: Mutex<HashMap<u32, Shell>>,
}

#[derive(Clone, serde::Serialize)]
struct Event {
    id: u32,
    kind: &'static str,
    text: String,
    code: i32,
}

/// UTF-8 that may arrive cut in the middle of a character.
fn decode(pending: &mut Vec<u8>, chunk: &[u8]) -> String {
    pending.extend_from_slice(chunk);
    let good = match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => pending.len(),
    };
    let text = String::from_utf8_lossy(&pending[..good]).into_owned();
    pending.drain(..good);
    text
}

#[tauri::command]
pub fn prompt_open(app: AppHandle, shells: State<'_, Shells>, repo: String) -> Result<u32, String> {
    if root::current(&paths::data_dir()).is_none() {
        return Err("root がありません".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let (mut reader, writer) = std::io::pipe().map_err(|e| e.to_string())?;
    // One pipe for both, so what it prints keeps its order.
    let mut child = Command::new(prompt::l3_path(&exe))
        .args(["open", &repo])
        .stdin(Stdio::piped())
        .stdout(writer.try_clone().map_err(|e| e.to_string())?)
        .stderr(writer)
        .spawn()
        .map_err(|e| format!("l3 を起動できませんでした: {e}"))?;
    let stdin = child.stdin.take().ok_or("stdin")?;
    let supervisor = child.id();
    let id = shells.next.fetch_add(1, Ordering::SeqCst) + 1;
    // Its pid 1 appears a moment after; its namespace is the Prompt's.
    let mut ns = None;
    for _ in 0..100 {
        if let Some(n) = prompt::init_of(supervisor).and_then(prompt::pid_ns) {
            ns = Some(n);
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    shells.open.lock().unwrap().insert(id, Shell { child, stdin, ns });
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let text = decode(&mut pending, &buf[..n]);
                    if !text.is_empty() {
                        let _ = app.emit("prompt", Event { id, kind: "output", text, code: 0 });
                    }
                }
            }
        }
        // Everything that could write has ended: the shell is gone.
        let shells = tauri::Manager::state::<Shells>(&app);
        let shell = shells.open.lock().unwrap().remove(&id);
        let code = shell.map(|mut s| s.child.wait().ok().and_then(|st| st.code()).unwrap_or(-1)).unwrap_or(-1);
        let _ = app.emit("prompt", Event { id, kind: "exit", text: String::new(), code });
    });
    Ok(id)
}

#[tauri::command]
pub fn prompt_input(shells: State<'_, Shells>, id: u32, text: String) -> Result<(), String> {
    let mut open = shells.open.lock().unwrap();
    let s = open.get_mut(&id).ok_or("この Prompt は終わっています")?;
    s.stdin.write_all(text.as_bytes()).and_then(|_| s.stdin.flush()).map_err(|e| e.to_string())
}

/// Ctrl-C: the supervisor hands it to init, init to the shell's group.
#[tauri::command]
pub fn prompt_interrupt(shells: State<'_, Shells>, id: u32) -> Result<(), String> {
    let open = shells.open.lock().unwrap();
    let s = open.get(&id).ok_or("この Prompt は終わっています")?;
    unsafe { libc::kill(s.child.id() as libc::pid_t, libc::SIGINT) };
    Ok(())
}

/// What the Prompt's processes hold now.
#[tauri::command]
pub fn prompt_held(shells: State<'_, Shells>, id: u32) -> Option<prompt::Held> {
    let open = shells.open.lock().unwrap();
    open.get(&id)?.ns.map(prompt::held)
}

/// Stop: every process inside ends; said done only once the host shows none.
#[tauri::command]
pub fn prompt_close(shells: State<'_, Shells>, id: u32) -> Result<prompt::Stopped, String> {
    let (supervisor, ns) = {
        let open = shells.open.lock().unwrap();
        let s = open.get(&id).ok_or("この Prompt は終わっています")?;
        (s.child.id(), s.ns)
    };
    let before = ns.map(prompt::held).unwrap_or(prompt::Held { processes: 0, memory: 0 });
    unsafe { libc::kill(supervisor as libc::pid_t, libc::SIGKILL) };
    Ok(match ns {
        Some(ns) => prompt::wait_empty(ns, before, Duration::from_secs(3)),
        None => prompt::Stopped { before, left: 0, ms: None },
    })
}

#[derive(serde::Serialize)]
pub struct RootStatus {
    current: Option<root::Installed>,
    held: Vec<(root::Installed, bool)>,
    release: Release,
}

#[derive(serde::Serialize)]
pub struct Release {
    name: &'static str,
    version: &'static str,
    bytes: u64,
}

#[tauri::command]
pub fn root_status() -> RootStatus {
    let data = paths::data_dir();
    let r = &root::RELEASES[0];
    RootStatus {
        current: root::current(&data).map(|(_, a)| a),
        held: root::held(&data),
        release: Release { name: r.name, version: r.version, bytes: r.bytes },
    }
}

#[derive(Clone, serde::Serialize)]
struct Fetching {
    got: u64,
    of: u64,
    retry: Option<String>,
}

/// The Remote this device talks to (Home's `remote` setting), or the default.
fn remote_url() -> String {
    length3_core::home::get("remote").ok().flatten()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("url")?.as_str().map(String::from))
        .or_else(|| std::env::var("LENGTH3_REMOTE").ok())
        .unwrap_or_else(|| "https://remote.length3.com".into())
}

/// Fetch the release root from the Remote and install it, saying how far it is.
#[tauri::command]
pub async fn root_fetch(app: AppHandle) -> Result<root::Installed, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut last = 0u64;
        root::fetch_and_install(&paths::data_dir(), &remote_url(), |p| match p {
            length3_core::fetch::Progress::Bytes(got, of) if got - last >= 1 << 20 || got == of => {
                last = got;
                let _ = app.emit("root-fetch", Fetching { got, of, retry: None });
            }
            length3_core::fetch::Progress::Retry(n, why) => {
                let _ = app.emit("root-fetch", Fetching { got: last, of: 0, retry: Some(format!("{why}（{n}回目）")) });
            }
            _ => {}
        })
    }).await.map_err(|e| e.to_string())?
}
