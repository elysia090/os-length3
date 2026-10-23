// Prompts on the distribution's root (l3 prompt, core/src/launch.rs). Each
// is an `l3 prompt REPO` process beside the app; what it prints comes to the
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
    repo: String,
    child: Child,
    stdin: ChildStdin,
    ns: Option<u64>,
}

#[derive(Default)]
pub struct Shells {
    next: AtomicU32,
    open: Mutex<HashMap<u32, Shell>>,
}

impl Shells {
    /// Repos a Prompt has open now: they stay on the device while it runs.
    pub fn open_repos(&self) -> Vec<String> {
        let mut all: Vec<String> = self.open.lock().unwrap().values().map(|s| s.repo.clone()).collect();
        // And each l3 runs (in a terminal too): every Prompt records itself while it runs (core/src/prompt.rs).
        all.extend(prompt::running(&paths::data_dir()).into_iter().map(|r| r.repo));
        all.sort();
        all.dedup();
        all
    }
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

/// Run `f` off the window's thread: a command without `async` runs on it (Tauri 2), and the window draws
/// nothing until it returns. What is typed (prompt_input, prompt_interrupt) stays on it, in order.
async fn apart<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Open a Prompt; it waits up to a second for the Prompt's pid 1 to appear.
#[tauri::command]
pub async fn prompt_open(app: AppHandle, repo: String) -> Result<u32, String> {
    apart(move || open(app, repo)).await
}

fn open(app: AppHandle, repo: String) -> Result<u32, String> {
    let shells = tauri::Manager::state::<Shells>(&app);
    if root::current(&paths::data_dir()).is_none() {
        return Err(length3_core::tr!("There is no root", "root がありません"));
    }
    // Said plainly when it is not here, rather than as l3's "which repo?".
    length3_core::repos::Repos::open()?.dir(&repo)?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let (mut reader, writer) = std::io::pipe().map_err(|e| e.to_string())?;
    // One pipe for both, so what it prints keeps its order. The repo is named by LENGTH3_REPO from the data
    // directory, never as a word: l3 reads a word against its forms first, so a repo called ls or stop was
    // `l3 prompt ls` (the list) or `l3 prompt stop`, and one called --network a flag.
    let mut child = Command::new(prompt::l3_path(&exe))
        .arg("prompt")
        .env("LENGTH3_REPO", &repo)
        .current_dir(paths::data_dir())
        .stdin(Stdio::piped())
        .stdout(writer.try_clone().map_err(|e| e.to_string())?)
        .stderr(writer)
        .spawn()
        .map_err(|e| length3_core::tr!("Could not start l3: {}", "l3 を起動できませんでした：{}", e))?;
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
    shells.open.lock().unwrap().insert(id, Shell { repo, child, stdin, ns });
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let text = decode(&mut pending, &buf[..n]);
                    // An emit fails only when no window is left to hear it.
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
    let s = open.get_mut(&id).ok_or_else(|| length3_core::tr!("This Prompt has ended", "この Prompt は終わっています"))?;
    s.stdin.write_all(text.as_bytes()).and_then(|_| s.stdin.flush()).map_err(|e| e.to_string())
}

/// Ctrl-C: the supervisor hands it to init, init to the shell's group.
#[tauri::command]
pub fn prompt_interrupt(shells: State<'_, Shells>, id: u32) -> Result<(), String> {
    let open = shells.open.lock().unwrap();
    let s = open.get(&id).ok_or_else(|| length3_core::tr!("This Prompt has ended", "この Prompt は終わっています"))?;
    unsafe { libc::kill(s.child.id() as libc::pid_t, libc::SIGINT) };
    Ok(())
}

/// What the Prompt's processes hold now (every process on the host looked at in /proc).
#[tauri::command]
pub async fn prompt_held(app: AppHandle, id: u32) -> Result<Option<prompt::Held>, String> {
    apart(move || {
        let ns = tauri::Manager::state::<Shells>(&app).open.lock().unwrap().get(&id).and_then(|s| s.ns);
        Ok(ns.map(prompt::held))
    }).await
}

/// Stop: every process inside ends; said done only once the host shows none (up to 3 s).
#[tauri::command]
pub async fn prompt_close(app: AppHandle, id: u32) -> Result<prompt::Stopped, String> {
    apart(move || close(&tauri::Manager::state::<Shells>(&app), id)).await
}

fn close(shells: &Shells, id: u32) -> Result<prompt::Stopped, String> {
    let (supervisor, ns) = {
        let open = shells.open.lock().unwrap();
        let s = open.get(&id).ok_or_else(|| length3_core::tr!("This Prompt has ended", "この Prompt は終わっています"))?;
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
    /// The other distributions' roots that can be used (held or fetched).
    distros: Vec<Distro>,
}

#[derive(serde::Serialize)]
pub struct Distro {
    id: &'static str,
    name: &'static str,
    version: &'static str,
    bytes: u64,
    sha256: &'static str,
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
        distros: root::DISTROS.iter().map(|d| Distro { id: d.id, name: d.name, version: d.version, bytes: d.bytes, sha256: d.sha256 }).collect(),
    }
}

#[derive(Clone, serde::Serialize)]
struct Fetching {
    got: u64,
    of: u64,
    retry: Option<String>,
}

/// The Remote this device talks to (Home's `remote` setting, by its name today), or the default.
fn remote_url() -> String {
    length3_core::remote::connection().map_or_else(length3_core::remote::default_url, |c| c.url)
}

/// What a directory of the current root holds (File's tree of "/"), read off the window's thread.
#[tauri::command]
pub async fn root_list(path: String) -> Result<Vec<root::Entry>, String> {
    apart(move || root::list(&paths::data_dir(), &path)).await
}

/// Fetch the release root from the Remote and install it, saying how far it is.
#[tauri::command]
pub async fn root_fetch(app: AppHandle) -> Result<root::Installed, String> {
    root_use(app, "l3".into()).await
}

/// Make `id` (l3, ubuntu, debian) the root Prompts run on, fetching it first
/// if it is not held, saying how far it is (`root-fetch`).
#[tauri::command]
pub async fn root_use(app: AppHandle, id: String) -> Result<root::Installed, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data = paths::data_dir();
        let mut last = 0u64;
        let progress = |p: length3_core::fetch::Progress| match p {
            length3_core::fetch::Progress::Bytes(got, of) if got - last >= 1 << 20 || got == of => {
                last = got;
                let _ = app.emit("root-fetch", Fetching { got, of, retry: None });
            }
            length3_core::fetch::Progress::Retry(n, why) => {
                let _ = app.emit("root-fetch", Fetching { got: last, of: 0, retry: Some(length3_core::tr!("{} (try {})", "{}（{}回目）", why, n)) });
            }
            _ => {}
        };
        if id == "l3" {
            return match root::use_held(&data, root::RELEASES[0].sha256) {
                Some(r) => Ok(r),
                None => root::fetch_and_install(&data, &remote_url(), progress),
            };
        }
        let d = root::distro(&id).ok_or_else(|| format!("no root {id}"))?;
        root::fetch_distro(&data, &remote_url(), d, progress)
    }).await.map_err(|e| e.to_string())?
}
