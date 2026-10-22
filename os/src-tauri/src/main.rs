// The webview reaches the host only through these named commands. Nothing
// here reads or writes outside the OS's own data directory, and every one of
// them is what `l3` does on the command line, through the same core.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use length3_core::{api, paths};

#[cfg(target_os = "linux")]
mod shells;
/// Elsewhere a Prompt on the root is not there yet; the commands say so.
#[cfg(not(target_os = "linux"))]
mod shells {
    fn not_here() -> String { length3_core::tr!("A Prompt on the root is Linux only for now", "root の Prompt はいま Linux だけです") }
    #[derive(Default)]
    pub struct Shells;
    #[tauri::command] pub fn prompt_open(_repo: String) -> Result<u32, String> { Err(not_here()) }
    #[tauri::command] pub fn prompt_input(_id: u32, _text: String) -> Result<(), String> { Err(not_here()) }
    #[tauri::command] pub fn prompt_interrupt(_id: u32) -> Result<(), String> { Err(not_here()) }
    #[tauri::command] pub fn prompt_held(_id: u32) -> Result<Option<length3_core::prompt::Held>, String> { Ok(None) }
    #[tauri::command] pub fn prompt_close(_id: u32) -> Result<length3_core::prompt::Stopped, String> { Err(not_here()) }
    #[tauri::command] pub fn root_status() -> Option<()> { None }
    #[tauri::command] pub async fn root_fetch() -> Result<(), String> { Err(not_here()) }
    #[tauri::command] pub async fn root_use(_id: String) -> Result<(), String> { Err(not_here()) }
    impl Shells { pub fn open_repos(&self) -> Vec<String> { Vec::new() } }
}

// Every command a page sends goes to the core's one dispatcher (core/src/api.rs), the same one a browser runs
// built for the web: the app adds only what a host does around it. A command without `async` runs on the
// window's own thread (Tauri 2), and the window draws nothing until it returns, so only writes run there,
// which keeps two writes in the order the page sent them; the rest (walks of the disk, the network) run off it.

/// A command of the core's, by name, with its arguments; `space` and `free` are told which repos a Prompt has open.
#[tauri::command]
async fn core(app: tauri::AppHandle, name: String, mut args: serde_json::Value) -> Result<serde_json::Value, String> {
    if matches!(name.as_str(), "space" | "free") {
        let open = tauri::Manager::state::<shells::Shells>(&app).open_repos();
        args["open"] = serde_json::json!(open);
    }
    if api::WRITES.contains(&name.as_str()) {
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || { let _ = tx.send(api::call(&name, &args)); }).map_err(|e| e.to_string())?;
        return rx.recv().map_err(|e| e.to_string())?;
    }
    tauri::async_runtime::spawn_blocking(move || api::call(&name, &args)).await.map_err(|e| e.to_string())?
}

/// Sign in: the core gets the code and checks the page is the Remote's own; the app opens it in the browser.
#[tauri::command]
async fn remote_login_start(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let code = tauri::async_runtime::spawn_blocking(|| api::call("remote_login_start", &serde_json::json!({"client": "length3-app"})))
        .await.map_err(|e| e.to_string())??;
    use tauri_plugin_opener::OpenerExt;
    // Not opened (no browser to hand it to): the page shows the code and its address to open by hand.
    if let Some(page) = code["verification_uri_complete"].as_str() { let _ = app.opener().open_url(page, None::<&str>); }
    Ok(code)
}

/// The plan's page, Checkout (`checkout`) or the portal (`portal`), as the Remote makes it for this account,
/// opened in the browser. Only Stripe's page or the Remote's own is opened (account::plan_page).
#[tauri::command]
async fn plan_open(app: tauri::AppHandle, kind: String) -> Result<(), String> {
    let url = tauri::async_runtime::spawn_blocking(move || api::call("plan_page", &serde_json::json!({"kind": kind})))
        .await.map_err(|e| e.to_string())??;
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(url.as_str().unwrap_or_default(), None::<&str>).map_err(|e| e.to_string())
}

/// Network and file walks run off the window's thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

// ---- SSH into this device's Prompts (core/src/ssh.rs; the listener is l3's) ----

/// This device's SSH as its card shows it (core ssh::Here): whether it listens, who may connect, where each repo is
/// reached, its host key and how many keys are let in. Worked out here; none of it goes to the Remote.
#[cfg(unix)]
fn ssh_now() -> serde_json::Value {
    serde_json::to_value(length3_core::ssh::here(&paths::data_dir())).unwrap_or_default()
}

#[cfg(not(unix))]
fn ssh_now() -> serde_json::Value {
    serde_json::json!({"on": false, "scope": "device", "destinations": [], "bound": [], "keys": 0})
}

#[tauri::command]
async fn ssh_here() -> Result<serde_json::Value, String> {
    blocking(|| Ok(ssh_now())).await
}

/// Turn it on (to `scope`: "device", this device only, or "network", the same network's PCs too; none: the one kept)
/// or off, as `l3 address ssh on|off` does, by the l3 beside the app: the same listener, kept by l3 in the background
/// whether or not the app stays open, and the same checks (a key in .authorized_keys first).
#[tauri::command]
async fn ssh_set(on: bool, scope: Option<String>) -> Result<serde_json::Value, String> {
    blocking(move || {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let mut args = vec!["address", "ssh", if on { "on" } else { "off" }];
        if on { if let Some(s) = scope.as_deref().filter(|s| matches!(*s, "device" | "network")) { args.push(s); } }
        args.push("--json");
        let out = std::process::Command::new(length3_core::prompt::l3_path(&exe)).args(&args)
            .stdin(std::process::Stdio::null()).output()
            .map_err(|e| length3_core::tr!("Could not start l3: {}", "l3 を起動できませんでした：{}", e))?;
        if !out.status.success() {
            let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
            return Err(v["error"]["message"].as_str().map(String::from).unwrap_or_else(|| String::from_utf8_lossy(&out.stderr).trim().to_string()));
        }
        Ok(ssh_now())
    }).await
}

// ---- one app on a device, and l3 app (core/src/desktop.rs) ----

/// What the app answers l3 on its socket: it is here; its window forward; its window closed, as its close
/// button closes it (the last window closed, the app ends as it always does).
#[cfg(unix)]
fn answer(app: &tauri::AppHandle, word: &str) -> String {
    use tauri::Manager;
    let window = app.get_webview_window("main");
    match (word, window) {
        ("here", _) => "here",
        ("show", Some(w)) => { let _ = w.unminimize(); let _ = w.show(); let _ = w.set_focus(); "shown" }
        ("show", None) => "here",
        ("close", Some(w)) => { let _ = w.close(); "closing" }
        ("close", None) => { app.exit(0); "closing" }
        _ => "?",
    }.to_string()
}

fn main() {
    // One app on a device: one started while another is open brings that one forward and ends. A data
    // directory that cannot hold the lock still opens the app, only l3 app cannot find it.
    #[cfg(unix)]
    let held = match length3_core::desktop::hold(&paths::data_dir()) {
        Ok(Some(h)) => Some(h),
        Ok(None) => {
            // The one open may be a moment from answering (it has just taken the lock).
            for _ in 0..50 {
                if length3_core::desktop::ask(&paths::data_dir(), "show").is_some() { break; }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            return;
        }
        Err(_) => None,
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(shells::Shells::default())
        .setup(move |app| {
            #[cfg(unix)]
            if let Some(h) = held {
                let app = app.handle().clone();
                std::thread::spawn(move || h.serve(|word| answer(&app, word)));
            }
            #[cfg(not(unix))]
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            core, remote_login_start, plan_open,
            shells::prompt_open, shells::prompt_input, shells::prompt_interrupt, shells::prompt_held, shells::prompt_close,
            shells::root_status, shells::root_fetch, shells::root_use, ssh_here, ssh_set
        ])
        .run(tauri::generate_context!())
        .expect("Length³ OS shell failed to start");
}
