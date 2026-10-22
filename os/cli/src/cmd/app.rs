//! `l3 app`: the desktop app, the same OS in a window, opened from here. One
//! is open on a device at a time (core desktop.rs): the one open is brought
//! forward, never a second started. Otherwise the app this device has is
//! started on its own (the terminal stays free) and waited for until it
//! answers; one that ends or never answers is said as such, never as open.
//! Not on this device, it says where to get it: the Remote hands it out for
//! this release, as Runtime's Desktop app card does.
//!
//! `l3 app close` closes it as its window's close button does: what it saved
//! stays, its own Prompts end with it, and what l3 runs (SSH, a Prompt in a
//! terminal) goes on. Opening it starts nothing else: no SSH, no listening
//! on a network, no Remote it is not already signed in to.

use super::Ctx;
use crate::args::Call;
use crate::out::{Error, Reply, Result};
use length3_core::{desktop, paths, remote, tr};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How long a started app has to answer before l3 says it did not.
const STARTING: Duration = Duration::from_secs(15);
/// How long a closed app has to go.
const CLOSING: Duration = Duration::from_secs(10);

/// The desktop app's files this release pins, as the Remote serves them (/v1/desktop/<file>).
const PINS: &str = include_str!("../../../shared/desktop-releases.json");

/// `l3 app`: the one open brought forward; else the app here started and waited for; else where to get it.
pub fn open(_: &Ctx, _: &Call) -> Result<Reply> {
    let data = paths::data_dir();
    if desktop::ask(&data, "show").is_some() {
        return Ok(Reply::done(tr!("The app is open already: brought it forward (no second one is started)", "アプリはもう開いています。前に出しました（もうひとつは開きません）"),
            json!({"open": true, "started": false})));
    }
    let program = program().ok_or_else(|| Error::NotFound(where_to_get()))?;
    if !program.is_file() {
        return Err(Error::NotFound(format!("{}\n{}", tr!("LENGTH3_APP names {}, and no program is there", "LENGTH3_APP は {} を指していますが、そこにプログラムはありません", program.display()), where_to_get())));
    }
    if !runnable(&program) {
        return Err(Error::Refused(tr!("{0} is here but may not run yet: chmod +x {0}, then l3 app", "{0} はありますが、まだ実行できません。chmod +x {0} のあと l3 app", program.display())));
    }
    if !screen() {
        return Err(Error::Refused(tr!("There is no screen here for a window (neither DISPLAY nor WAYLAND_DISPLAY): the app opens on this device's own desktop, and l3 is the way in from elsewhere",
            "ウィンドウを出す画面がありません（DISPLAY も WAYLAND_DISPLAY もありません）。アプリはこの端末のデスクトップで開きます。ほかからは l3 で使えます")));
    }
    let mut child = start(&program)?;
    let pid = child.id();
    let until = Instant::now() + STARTING;
    loop {
        // Ended at once, and not because the app open already took it: it could not start.
        let ended = child.try_wait()?;
        if let Some(status) = ended.filter(|s| !s.success()) {
            return Err(Error::Refused(tr!("The app could not start: it ended at once ({1}), and nothing is open. {0} run in a terminal says why",
                "アプリを起動できませんでした。すぐに終わり（{1}）、何も開いていません。理由はターミナルで {0} を実行するとわかります", program.display(), status)));
        }
        if desktop::ask(&data, "here").is_some() {
            // Answered by the one this l3 started, or (it ended handing over) by one opened meanwhile.
            let started = ended.is_none();
            let text = if started { tr!("Opened the app. Its window's close button, or l3 app close, closes it", "アプリを開きました。ウィンドウの閉じるボタンか l3 app close で閉じます") }
                else { tr!("The app is open already: brought it forward (no second one is started)", "アプリはもう開いています。前に出しました（もうひとつは開きません）") };
            return Ok(Reply::done(text, json!({"open": true, "started": started, "pid": started.then_some(pid), "program": program})));
        }
        if Instant::now() > until {
            return Err(Error::Refused(match ended {
                Some(_) => tr!("The app ended without opening, and nothing is open", "アプリは開かずに終わりました。何も開いていません"),
                // Running, but not saying so: an app older than this l3 never does, and the current one is said.
                None => std::iter::once(tr!("The app was started ({} as pid {}) but has not answered l3 in {} s, so l3 cannot say it is open. An app older than this l3 never answers; the current one:",
                    "アプリを起動しました（{} を pid {} で）が、{} 秒たっても l3 に応えないので、開いたとは言えません。この l3 より古いアプリは応えません。いまのもの：",
                    program.display(), pid, STARTING.as_secs())).chain(downloads()).collect::<Vec<_>>().join("\n"),
            }));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// `l3 app close`: the app open closed as its close button closes it, and waited for until it has gone.
pub fn close(_: &Ctx, _: &Call) -> Result<Reply> {
    let data = paths::data_dir();
    match desktop::ask(&data, "close").as_deref() {
        None => return Ok(Reply::done(tr!("The app was not open", "アプリは開いていませんでした"), json!({"open": false, "changed": false}))),
        Some("closing") => {}
        Some(_) => return Err(Error::Refused(tr!("The app open does not take l3 app close: close its window", "開いているアプリは l3 app close を受けません。ウィンドウを閉じてください"))),
    }
    let until = Instant::now() + CLOSING;
    while desktop::ask(&data, "here").is_some() {
        if Instant::now() > until {
            return Err(Error::Refused(tr!("Asked the app to close, and it is still open: its window may be asking something. Close it there",
                "アプリに閉じるよう伝えましたが、まだ開いています。ウィンドウが何か尋ねているかもしれません。そちらで閉じてください")));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(Reply::done(tr!("Closed the app: what it saved stays, its Prompts ended with it, and what l3 runs (SSH, a Prompt in a terminal) goes on",
        "アプリを閉じました。保存したものは残り、アプリの Prompt は一緒に終わりました。l3 が動かしているもの（SSH、ターミナルの Prompt）はそのままです"),
        json!({"open": false, "changed": true})))
}

/// Where the app is: $LENGTH3_APP; else `length3-os` on PATH, where the .deb puts it (/usr/bin); else the newest
/// AppImage of it as downloaded, in ~/Applications, ~/Downloads, ~/.local/bin or ~.
fn program() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("LENGTH3_APP").filter(|v| !v.is_empty()) { return Some(p.into()); }
    let path = std::env::var_os("PATH").unwrap_or_default();
    if let Some(p) = std::env::split_paths(&path).map(|d| d.join(desktop::PROGRAM)).find(|p| runnable(p)) { return Some(p); }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    ["Applications", "Downloads", ".local/bin", ""].iter()
        .flat_map(|d| std::fs::read_dir(home.join(d)).into_iter().flatten().flatten())
        .filter_map(|e| appimage_version(&e.file_name().to_string_lossy()).map(|v| (v, e.path())))
        .filter(|(_, p)| p.is_file())
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, p)| p)
}

/// The version an AppImage of the app is named for (os-length3-linux-0.4.1-desktop-x86_64.AppImage), as numbers to compare.
fn appimage_version(name: &str) -> Option<Vec<u64>> {
    let v = name.strip_prefix("os-length3-linux-")?.strip_suffix("-desktop-x86_64.AppImage")?;
    v.split('.').map(|n| n.parse().ok()).collect()
}

fn runnable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// Whether a window can be shown from here (a desktop session's display).
fn screen() -> bool {
    ["DISPLAY", "WAYLAND_DISPLAY"].iter().any(|v| std::env::var_os(v).is_some_and(|v| !v.is_empty()))
}

/// The app started on its own: its own session (it outlives this l3, and a terminal's Ctrl-C or hangup is not
/// its), nothing of the terminal's, from the home folder (wherever this l3 was run from is nothing of the app's).
fn start(program: &Path) -> Result<std::process::Child> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    if let Some(home) = std::env::var_os("HOME") { cmd.current_dir(home); }
    unsafe { cmd.pre_exec(|| { libc::setsid(); Ok(()) }); }
    cmd.spawn().map_err(|e| Error::Refused(tr!("Could not start {}: {}", "{} を起動できませんでした：{}", program.display(), e)))
}

/// Where to get the app, said where this device has none.
fn where_to_get() -> String {
    let first = tr!("The desktop app is not on this device. Get it, then l3 app opens it:", "この端末にデスクトップアプリがありません。入れてから l3 app で開きます：");
    std::iter::once(first).chain(downloads()).collect::<Vec<_>>().join("\n")
}

/// The app for this release, a line each: the Remote's copy of the pinned .deb and AppImage, as Runtime offers
/// them, and what to do with each.
fn downloads() -> Vec<String> {
    let pins: serde_json::Value = serde_json::from_str(PINS).unwrap_or_default();
    let release = include_str!("../../../RELEASE").trim();
    // This release's; one that pins none (a build between releases) takes the newest pinned.
    let newest = pins.as_object().and_then(|m| m.keys().max_by_key(|v| v.split('.').map(|n| n.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>()).cloned());
    let at = if pins[release].is_object() { release.to_string() } else { newest.unwrap_or_default() };
    let url = remote::connection().map_or_else(remote::default_url, |c| c.url);
    let file = |kind: &str| pins[&at][kind]["file"].as_str().map(|f| (format!("{url}/v1/desktop/{f}"), f.to_string()));
    let mut t = Vec::new();
    if let Some((link, f)) = file("deb") {
        t.push(tr!("  Debian, Ubuntu (.deb)  {}", "  Debian、Ubuntu（.deb）  {}", link));
        t.push(tr!("    then: sudo apt install ./{}", "    そのあと：sudo apt install ./{}", f));
    }
    if let Some((link, _)) = file("appimage") {
        t.push(tr!("  Any x86-64 Linux (AppImage)  {}", "  x86-64 の Linux なら（AppImage）  {}", link));
        t.push(tr!("    then: chmod +x it, kept in ~/Applications (or LENGTH3_APP=its path)", "    そのあと：chmod +x して ~/Applications に置く（または LENGTH3_APP=そのパス）"));
    }
    if t.is_empty() { t.push(tr!("  Runtime's Desktop app card on the web offers it", "  Web の Runtime にある「デスクトップアプリ」から入手できます")); }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_appimage_is_known_by_its_name_and_the_newest_is_taken() {
        assert_eq!(appimage_version("os-length3-linux-0.4.1-desktop-x86_64.AppImage"), Some(vec![0, 4, 1]));
        assert!(appimage_version("os-length3-linux-0.10.0-desktop-x86_64.AppImage").unwrap() > vec![0, 4, 1]);
        assert_eq!(appimage_version("os-length3-linux-0.4.1-desktop-amd64.deb"), None);
        assert_eq!(appimage_version("other.AppImage"), None);
    }

    #[test]
    fn where_to_get_it_is_this_releases_files_on_the_remote() {
        let said = where_to_get();
        // This release's, once pinned; until then the newest pinned.
        assert!(said.contains("/v1/desktop/os-length3-linux-") && said.contains("-desktop-amd64.deb"), "{said}");
        assert!(said.contains("AppImage") && said.contains("l3 app"), "{said}");
        // Getting it is installing it: nothing is built.
        for never in ["cargo", "npm", "vite", "build"] { assert!(!said.contains(never), "{never}: {said}"); }
    }
}
