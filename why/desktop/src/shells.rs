// Prompts on the distribution's root (why prompt, why/core/src/prompt/launch.rs). Each
// is an `why prompt REPO` process beside the app; what it prints comes to the
// webview as `prompt` events, what is typed goes to its standard input.
// Closing kills its supervisor, and with it (PDEATHSIG, then the pid
// namespace) every process inside; it is only called stopped once the host
// shows none left, and what they held and how long it took are said.

use why_core::{fs::paths, prompt::running, root, storage};
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
}

#[derive(Default)]
pub struct Shells {
    next: AtomicU32,
    open: Mutex<HashMap<u32, Shell>>,
}

impl Shells {
    /// Repos a Prompt of this window has open now: they stay on the device while it runs. The core reads every
    /// other (each why's, in a terminal too) from its record, with the root it runs on (why/core/src/storage/).
    pub fn open_repos(&self) -> Vec<String> {
        let mut all: Vec<String> = self.open.lock().unwrap().values().map(|s| s.repo.clone()).collect();
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

/// Open a Prompt: its `why prompt`, which prepares it (.packages, .setup), then runs it.
#[tauri::command]
pub async fn prompt_open(app: AppHandle, repo: String) -> Result<u32, String> {
    apart(move || open(app, repo)).await
}

fn open(app: AppHandle, repo: String) -> Result<u32, String> {
    let shells = tauri::Manager::state::<Shells>(&app);
    if root::current(&paths::data_dir()).is_none() {
        return Err(why_core::tr!("There is no root", "root がありません"));
    }
    // Said plainly when it is not here, rather than as why's "which repo?".
    why_core::repos::store::Repos::open()?.dir(&repo)?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let (mut reader, writer) = std::io::pipe().map_err(|e| e.to_string())?;
    // One pipe for both, so what it prints keeps its order. The repo is named by WHY_REPO from the data
    // directory, never as a word: why reads a word against its forms first, so a repo called ls or stop was
    // `why prompt ls` (the list) or `why prompt stop`, and one called --network a flag.
    let mut child = Command::new(running::why_path(&exe))
        .arg("prompt")
        .env("WHY_REPO", &repo)
        .current_dir(paths::data_dir())
        .stdin(Stdio::piped())
        .stdout(writer.try_clone().map_err(|e| e.to_string())?)
        .stderr(writer)
        .spawn()
        .map_err(|e| why_core::tr!("Could not start why: {}", "why を起動できませんでした：{}", e))?;
    let stdin = child.stdin.take().ok_or("stdin")?;
    let id = shells.next.fetch_add(1, Ordering::SeqCst) + 1;
    shells.open.lock().unwrap().insert(id, Shell { repo, child, stdin });
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
    let s = open.get_mut(&id).ok_or_else(|| why_core::tr!("This Prompt has ended", "この Prompt は終わっています"))?;
    s.stdin.write_all(text.as_bytes()).and_then(|_| s.stdin.flush()).map_err(|e| e.to_string())
}

/// Ctrl-C: the supervisor hands it to init, init to the shell's group.
#[tauri::command]
pub fn prompt_interrupt(shells: State<'_, Shells>, id: u32) -> Result<(), String> {
    let open = shells.open.lock().unwrap();
    let s = open.get(&id).ok_or_else(|| why_core::tr!("This Prompt has ended", "この Prompt は終わっています"))?;
    running::signal(s.child.id(), running::Signal::Int);
    Ok(())
}

/// What a Prompt's processes hold now, and whether it is still being prepared (its record says so).
#[derive(serde::Serialize)]
pub struct Holding {
    #[serde(flatten)]
    held: running::Held,
    preparing: bool,
}

/// What the Prompt's processes hold now (every process on the host looked at in /proc): its pid 1's
/// namespace, looked for each time, since the Prompt that prepares it has one of its own before.
#[tauri::command]
pub async fn prompt_held(app: AppHandle, id: u32) -> Result<Option<Holding>, String> {
    apart(move || {
        let Some(supervisor) = tauri::Manager::state::<Shells>(&app).open.lock().unwrap().get(&id).map(|s| s.child.id()) else { return Ok(None) };
        let preparing = running::all(&paths::data_dir()).iter().any(|r| r.pid == supervisor && r.preparing);
        Ok(running::ns_of(supervisor).map(|ns| Holding { held: running::held(ns), preparing }))
    }).await
}

/// Stop: every process inside ends; said done only once the host shows none (up to 3 s).
#[tauri::command]
pub async fn prompt_close(app: AppHandle, id: u32) -> Result<running::Stopped, String> {
    apart(move || close(&tauri::Manager::state::<Shells>(&app), id)).await
}

fn close(shells: &Shells, id: u32) -> Result<running::Stopped, String> {
    let supervisor = {
        let open = shells.open.lock().unwrap();
        let s = open.get(&id).ok_or_else(|| why_core::tr!("This Prompt has ended", "この Prompt は終わっています"))?;
        s.child.id()
    };
    // Stopped while it is prepared too: what prepares it ends with its supervisor (launch::set_up).
    let ns = running::ns_of(supervisor);
    let before = ns.map(running::held).unwrap_or(running::Held { processes: 0, memory: 0 });
    running::signal(supervisor, running::Signal::Kill);
    Ok(match ns {
        Some(ns) => running::wait_empty(ns, before, Duration::from_secs(3)),
        None => running::Stopped { before, left: 0, ms: None },
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

/// Whether Prompts run on the root here, and if not why: the why beside the app asked once (`why root check`), since it
/// is what makes a Prompt's namespaces, and AppArmor may let it and not the app. Where they do not, the page runs its
/// Prompts translated, as a browser does.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Native {
    native: bool,
    why: Option<String>,
}

#[tauri::command]
pub async fn root_native() -> Native {
    static ASKED: std::sync::OnceLock<Native> = std::sync::OnceLock::new();
    ASKED.get_or_init(|| {
        if !cfg!(target_arch = "x86_64") {
            return Native { native: false, why: Some(why_core::tr!("The root is x86-64, and this machine is {}", "root は x86-64 で、この機械は {} です", std::env::consts::ARCH)) };
        }
        let asked = std::env::current_exe().map_err(|e| e.to_string()).and_then(|exe| Command::new(running::why_path(&exe))
            .args(["root", "check", "--json"]).stdin(Stdio::null()).stderr(Stdio::null()).output().map_err(|e| e.to_string()));
        match asked {
            Ok(out) => serde_json::from_slice(&out.stdout).unwrap_or_else(|e| Native { native: false, why: Some(e.to_string()) }),
            Err(e) => Native { native: false, why: Some(e) },
        }
    }).clone()
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
    why_core::remote::connection().map_or_else(why_core::remote::default_url, |c| c.url)
}

/// What a directory of the current root holds (File's tree of "/"), read off the window's thread.
#[tauri::command]
pub async fn root_list(path: String) -> Result<Vec<root::Entry>, String> {
    apart(move || root::list(&paths::data_dir(), &path)).await
}

/// Fetch the release root from the Remote and install it, saying how far it is.
#[tauri::command]
pub async fn root_fetch(app: AppHandle) -> Result<root::Installed, String> {
    root_use(app, "why".into()).await
}

/// Make `id` (why, ubuntu, debian) the root Prompts run on, fetching it first
/// if it is not held, saying how far it is (`root-fetch`).
#[tauri::command]
pub async fn root_use(app: AppHandle, id: String) -> Result<root::Installed, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data = paths::data_dir();
        let mut last = 0u64;
        let progress = |p: why_core::device::download::Progress| match p {
            why_core::device::download::Progress::Bytes(got, of) if got - last >= 1 << 20 || got == of => {
                last = got;
                let _ = app.emit("root-fetch", Fetching { got, of, retry: None });
            }
            why_core::device::download::Progress::Retry(n, why) => {
                let _ = app.emit("root-fetch", Fetching { got: last, of: 0, retry: Some(why_core::tr!("{} (try {})", "{}（{}回目）", why, n)) });
            }
            _ => {}
        };
        if id == "why" {
            return match root::use_held(&data, root::RELEASES[0].sha256) {
                Some(r) => Ok(r),
                None => storage::fetch_root(&data, &remote_url(), progress),
            };
        }
        let d = root::distro(&id).ok_or_else(|| format!("no root {id}"))?;
        storage::fetch_distro(&data, &remote_url(), d, progress)
    }).await.map_err(|e| e.to_string())?
}
