//! `l3 address`: where to reach this device over SSH, one destination a
//! line as OpenSSH takes it (`ssh -p 22000 notes@127.0.0.1`, one a repo),
//! as `ip addr` answers with an address; beside it, on standard error, who
//! may connect, how many keys are let in and the host key's fingerprint.
//! All of it is worked out here and shown here: the Remote hears only that
//! this device listens, and to whom (its scope's word).
//!
//! SSH is off until it is turned on: asked on a terminal (y/N, then from
//! where: this device only, the default, or PCs on the same network too),
//! never in a script (it says so, exit 5), or set with
//! `l3 address ssh on [device|network]` and `l3 address ssh off`. The scope
//! chosen is kept on this device; `on` alone takes it again. Turning on
//! starts l3's listener in the background (ssh.rs), which says so to the
//! Remote; Runtime shows on every device that it listens, and any of them
//! can turn it off.

use super::Ctx;
use crate::args::Call;
use crate::out::{note, Error, Reply, Result};
use length3_core::{paths, remote, ssh, tr};
use serde_json::json;

/// This device's SSH as data: whether it listens, to whom, where, its host key, the keys let in.
fn shown(h: &ssh::Here) -> serde_json::Value {
    json!({"on": h.on, "scope": h.scope, "port": h.port, "bound": h.bound, "interfaces": h.interfaces, "destinations": h.destinations,
        "fingerprint": h.fingerprint, "keys": h.keys, "started": h.started})
}

/// The addresses taken besides loopback, each after its interface (`wlan0 192.168.1.5`); a record from before
/// interfaces were kept names the addresses alone.
fn taken(h: &ssh::Here) -> Vec<String> {
    if !h.interfaces.is_empty() { return h.interfaces.iter().map(|t| format!("{} {}", t.interface, t.addr)).collect(); }
    h.bound.iter().filter(|a| !matches!(a.as_str(), "127.0.0.1" | "::1")).cloned().collect()
}

/// What a person checks before trusting it, plainly, a line each: who may connect (and on which interfaces and
/// addresses here), how many keys are let in, and the host key ssh will show the first time.
fn facts(h: &ssh::Here) -> Vec<String> {
    let lan = taken(h);
    let mut out = vec![match h.scope {
        ssh::Scope::Device => tr!("From this device only (127.0.0.1): no other PC finds it", "この端末からだけ（127.0.0.1）：ほかの PC からは見えません"),
        ssh::Scope::Network if lan.is_empty() => tr!("From PCs on the same network too (no LAN or VPN address here now: this device only until one comes)",
            "同じネットワークの PC からも（いまは LAN や VPN のアドレスがないので、できるまでこの端末からだけ）"),
        ssh::Scope::Network => tr!("From PCs on the same network too ({}); never from the Internet", "同じネットワークの PC からも（{}）。インターネットからは入れません", lan.join(", ")),
    }];
    out.push(if h.keys == 1 { tr!("1 key let in ({})", "入れる鍵：1本（{}）", ssh::KEYS) } else { tr!("{} keys let in ({})", "入れる鍵：{}本（{}）", h.keys, ssh::KEYS) });
    if let Some(f) = &h.fingerprint {
        out.push(tr!("Host key {} (ssh shows it the first time it connects: check it is this)", "ホスト鍵 {}（初めて接続するとき ssh が表示します。これと同じか確かめてください）", f));
    }
    out
}

/// How to turn it on, said wherever it is off.
fn how_on() -> String {
    tr!("l3 address ssh on turns it on, from this device only (on network: from the same network too); your key goes in the {} dotfile",
        "l3 address ssh on でオンにできます。この端末からだけです（on network なら同じネットワークからも）。鍵は {} の dotfile に置きます", ssh::KEYS)
}

/// `l3 address`: each destination, one a line, and what to check of it on standard error; off, it asks on a
/// terminal (whether, then from where) and says so elsewhere.
pub fn show(_: &Ctx, call: &Call) -> Result<Reply> {
    let data = paths::data_dir();
    let h = ssh::here(&data);
    if h.on {
        for f in facts(&h) { note(&f); }
        return Ok(Reply::data(h.destinations.join("\n"), shown(&h)));
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
    let kept = ssh::scope(&data);
    let first = if kept == ssh::Scope::Network { 2 } else { 1 };
    eprint!("{}", tr!("Who may connect?\n  1  this device only: no other PC finds it\n  2  PCs on the same network too (a LAN, a VPN), never the Internet\n[{}] ",
        "どこから接続できるようにしますか？\n  1  この端末からだけ：ほかの PC からは見えません\n  2  同じネットワークの PC からも（LAN、VPN）。インターネットからは入れません\n[{}] ", first));
    let mut answer = String::new();
    let _ = std::io::stdin().read_line(&mut answer);
    let scope = match answer.trim() {
        "" => kept,
        "1" => ssh::Scope::Device,
        "2" => ssh::Scope::Network,
        _ => return Err(Error::Off(tr!("SSH stays off: 1 or 2 is the answer. {}", "SSH はオフのままです（1 か 2 で答えます）。{}", how_on()))),
    };
    let h = turn_on(scope)?;
    note(&tr!("SSH is on", "SSH をオンにしました"));
    for f in facts(&h) { note(&f); }
    Ok(Reply::data(h.destinations.join("\n"), shown(&h)))
}

/// `l3 address ssh on [device|network]` and `l3 address ssh off`: without asking. `on` alone takes the scope kept.
pub fn set(_: &Ctx, call: &Call) -> Result<Reply> {
    let data = paths::data_dir();
    if call.word(0) == Some("on") {
        let was = ssh::listening(&data);
        let scope = call.word(1).and_then(ssh::Scope::from_word).unwrap_or_else(|| ssh::scope(&data));
        let h = turn_on(scope)?;
        let first = match &was {
            Some(l) if l.scope == scope => tr!("SSH was on already", "SSH はもうオンです"),
            Some(_) => tr!("SSH stays on; who may connect changed", "SSH はオンのまま、接続できる範囲を変えました"),
            None => tr!("SSH is on", "SSH をオンにしました"),
        };
        let lines: Vec<String> = std::iter::once(first).chain(facts(&h)).chain(h.destinations.iter().cloned()).collect();
        return Ok(Reply::done(lines.join("\n"), json!({"changed": was.is_none_or(|l| l.scope != scope), "ssh": shown(&h)})));
    }
    let stopped = ssh::stop(&data);
    // Said to the Remote here too, in case the listener could not (it was killed): pages stop showing it.
    if remote::connection().is_some() { let _ = ssh::withdraw(); }
    let text = if stopped.is_some() { tr!("SSH is off; its sessions ended", "SSH をオフにしました。そのセッションは終わりました") }
        else { tr!("SSH was off already", "SSH はもうオフです") };
    Ok(Reply::done(text, json!({"changed": stopped.is_some(), "ssh": {"on": false}})))
}

/// Turn SSH on here, to `scope` (kept for next time): the keys taken in from the Remote and checked, then the
/// listener started in the background and waited for until it listens (or says why it cannot). One running already
/// takes the scope at once, its other sessions going on.
fn turn_on(scope: ssh::Scope) -> Result<ssh::Here> {
    let data = paths::data_dir();
    if ssh::listening(&data).is_some() {
        ssh::set_scope(&data, scope)?;
        ssh::rescope(&data, scope).ok_or_else(|| Error::Io(tr!("The SSH listener did not take the scope asked; l3 address ssh off, then on", "SSH の待ち受けが範囲の変更を受けませんでした。l3 address ssh off のあと、もう一度 on にしてください")))?;
        return Ok(ssh::here(&data));
    }
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
    ssh::set_scope(&data, scope)?;
    start_listener()?;
    let h = ssh::here(&data);
    if !h.on { return Err(Error::Io(tr!("The SSH listener said it listens, but is not there", "SSH の待ち受けは始まったと言いましたが、見当たりません"))); }
    Ok(h)
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
