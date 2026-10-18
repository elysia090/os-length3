//! `l3 address`: where to reach this device over SSH, one destination a
//! line as OpenSSH takes it (`ssh -p 22000 notes@192.168.1.5`, one a repo),
//! as `ip addr` answers with an address. SSH is off until it is turned on:
//! asked on a terminal (y/N), never in a script (it says so, exit 5), or set
//! with `l3 address ssh on|off`. Turning on starts l3's listener in the
//! background (ssh.rs), which says so to the Remote; Runtime shows it on
//! every device, and any of them can turn it off.

use super::Ctx;
use crate::args::Call;
use crate::out::{note, Error, Reply, Result};
use length3_core::{paths, remote, ssh, tr};
use serde_json::json;

/// The listener as data: where it is reached, its port, its host key.
fn shown(l: &ssh::Listening) -> serde_json::Value {
    json!({"on": true, "port": l.port, "destinations": l.destinations, "fingerprint": l.fingerprint, "pid": l.pid, "started": l.started})
}

/// How to turn it on, said wherever it is off.
fn how_on() -> String {
    tr!("l3 address ssh on turns it on; your key goes in the {} dotfile", "l3 address ssh on でオンにできます。鍵は {} の dotfile に置きます", ssh::KEYS)
}

/// `l3 address`: each destination, one a line, nothing else; off, it asks on a terminal and says so elsewhere.
pub fn show(_: &Ctx, call: &Call) -> Result<Reply> {
    let data = paths::data_dir();
    if let Some(l) = ssh::listening(&data) {
        return Ok(Reply::data(l.destinations.join("\n"), shown(&l)));
    }
    use std::io::IsTerminal;
    let asking = !call.flags.json && std::io::stdin().is_terminal() && std::io::stderr().is_terminal();
    if !asking {
        return Err(Error::Off(tr!("SSH is off on this device. {}", "この端末の SSH はオフです。{}", how_on())));
    }
    eprint!("{}", tr!("SSH is off on this device. Turn it on? [y/N] ", "この端末の SSH はオフです。オンにしますか？ [y/N] "));
    let mut answer = String::new();
    let _ = std::io::stdin().read_line(&mut answer);
    if !matches!(answer.trim(), "y" | "Y" | "yes" | "Yes" | "YES" | "はい") {
        return Err(Error::Off(tr!("SSH stays off. {}", "SSH はオフのままです。{}", how_on())));
    }
    let l = turn_on()?;
    note(&on_said(&l));
    Ok(Reply::data(l.destinations.join("\n"), shown(&l)))
}

/// `l3 address ssh on|off`: without asking.
pub fn set(_: &Ctx, call: &Call) -> Result<Reply> {
    let data = paths::data_dir();
    if call.word(0) == Some("on") {
        let was = ssh::listening(&data).is_some();
        let l = turn_on()?;
        let first = if was { tr!("SSH was on already · host key {}", "SSH はもうオンです · ホスト鍵 {}", l.fingerprint) } else { on_said(&l) };
        return Ok(Reply::done(format!("{first}\n{}", l.destinations.join("\n")), json!({"changed": !was, "ssh": shown(&l)})));
    }
    let stopped = ssh::stop(&data);
    // Said to the Remote here too, in case the listener could not (it was killed): pages stop showing it.
    if remote::connection().is_some() { let _ = ssh::withdraw(); }
    let text = if stopped.is_some() { tr!("SSH is off; its sessions ended", "SSH をオフにしました。そのセッションは終わりました") }
        else { tr!("SSH was off already", "SSH はもうオフです") };
    Ok(Reply::done(text, json!({"changed": stopped.is_some(), "ssh": {"on": false}})))
}

fn on_said(l: &ssh::Listening) -> String {
    tr!("SSH is on · host key {} (ssh shows it the first time it connects)", "SSH をオンにしました · ホスト鍵 {}（初めて接続するとき ssh が表示します）", l.fingerprint)
}

/// Turn SSH on here: the keys taken in from the Remote and checked, then the listener started in the background
/// and waited for until it listens (or says why it cannot).
fn turn_on() -> Result<ssh::Listening> {
    let data = paths::data_dir();
    if let Some(l) = ssh::listening(&data) { return Ok(l); }
    if remote::connection().is_none() {
        return Err(Error::Offline(tr!("SSH is turned on for a device signed in to a Remote, so any of your devices can see it and turn it off (l3 login)",
            "SSH は Remote にサインインした端末でオンにします。どの端末からも見えて、オフにできるように（l3 login）")));
    }
    // The keys as the Remote has them (a key added on another device counts); out of reach, this device's.
    let _ = remote::sync_home("dotfiles");
    let keys = ssh::keys();
    for (line, why) in &keys.skipped { note(&tr!("{} line {}: {}", "{} の {} 行目：{}", ssh::KEYS, line, why)); }
    if keys.keys.is_empty() {
        return Err(Error::Refused(tr!("Add a key first: your OpenSSH public key, one a line, in the {0} dotfile (Runtime → Dotfiles, or l3 dotfile write {0} < ~/.ssh/id_ed25519.pub)",
            "先に鍵を置いてください：OpenSSH の公開鍵を1行にひとつ、{0} の dotfile に（Runtime → Dotfiles、または l3 dotfile write {0} < ~/.ssh/id_ed25519.pub）", ssh::KEYS)));
    }
    start_listener()?;
    ssh::listening(&data).ok_or_else(|| Error::Io(tr!("The SSH listener said it listens, but is not there", "SSH の待ち受けは始まったと言いましたが、見当たりません")))
}

#[cfg(all(target_os = "linux", feature = "ssh"))]
fn start_listener() -> Result<()> {
    use std::io::BufRead;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let exe = std::env::current_exe()?;
    let mut cmd = Command::new(exe);
    // From the data directory: wherever this l3 was run from is nothing of the listener's (nor its sessions').
    cmd.args(["address", "ssh", "serve"]).current_dir(paths::data_dir()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    // Its own session: it outlives this l3, and a terminal's Ctrl-C or hangup is not its.
    unsafe { cmd.pre_exec(|| { libc::setsid(); Ok(()) }); }
    let mut child = cmd.spawn()?;
    let out = child.stdout.take().ok_or_else(|| Error::Io("stdout".into()))?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || { let mut line = String::new(); let _ = std::io::BufReader::new(out).read_line(&mut line); let _ = tx.send(line); });
    let line = rx.recv_timeout(std::time::Duration::from_secs(30)).unwrap_or_default();
    match line.trim() {
        "ready" => Ok(()),
        said => {
            let _ = child.kill();
            let _ = child.wait();
            let why = said.strip_prefix("error: ").unwrap_or(said);
            Err(Error::Refused(if why.is_empty() { tr!("The SSH listener did not start", "SSH の待ち受けが始まりませんでした") } else { why.to_string() }))
        }
    }
}

#[cfg(not(all(target_os = "linux", feature = "ssh")))]
fn start_listener() -> Result<()> {
    Err(Error::Refused(tr!("SSH into a Prompt is Linux only for now", "Prompt への SSH はいま Linux だけです")))
}

/// `l3 address ssh serve`: the listener itself (what turning on starts). Why it cannot start goes to standard
/// output, where turning on reads it.
pub fn serve(_: &Ctx, _: &Call) -> Result<Reply> {
    #[cfg(all(target_os = "linux", feature = "ssh"))]
    if let Err(e) = crate::ssh::serve() {
        println!("error: {}", e.replace('\n', " "));
        return Err(Error::Refused(e));
    }
    #[cfg(not(all(target_os = "linux", feature = "ssh")))]
    start_listener()?;
    Ok(Reply::Nothing)
}
