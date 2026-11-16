use super::*;

/// This machine makes a box, or says in muk's own words why not: asked of muk itself, with nothing but muk in the box.
#[test]
fn a_package_name_is_what_apt_takes_and_nothing_a_shell_reads() {
    for p in ["git", "g++", "libssl-dev", "python3.12", "nodejs=20.1-1~deb", "libc6:amd64"] { assert!(package_name(p), "{p}"); }
    for p in ["", "-y", "a b", "a;b", "$(x)", "a`b`", "a|b", "a&b", &"x".repeat(129)] { assert!(!package_name(p), "{p}"); }
}

/// `f` in a process of its own (a Prompt is run by a process with one thread: it waits for any child, and its bundle
/// is named by its pid): what it returned as its exit code.
fn apart(f: impl FnOnce() -> i32) -> libc::pid_t {
    // SAFETY: the child goes on with this thread alone, runs the Prompt and leaves with _exit.
    let pid = unsafe { libc::fork() };
    if pid == 0 { unsafe { libc::_exit(f()) } }
    pid
}
fn ended(pid: libc::pid_t) -> i32 {
    let mut status = 0;
    // SAFETY: waitpid on a child of this test.
    unsafe { libc::waitpid(pid, &mut status, 0) };
    if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { -1 }
}

/// What why lends a Prompt's box: a home of its own with the person's dotfiles in it, the repo where it starts
/// (written back), and what it is told: its repo, where repos are, the language, and a task's words under no name
/// of those.
#[test]
fn a_prompt_has_a_home_of_its_own_the_repo_where_it_starts_and_is_told_what_it_is() {
    if !Path::new("/usr/bin/cc").exists() || !Path::new("/usr/bin/python3").exists() || kept_from_boxes().is_some() { eprintln!("skipped: no box here"); return; }
    let top = crate::fs::testing::dir("why-prompt-home-test");
    let _ = std::fs::remove_dir_all(&top);
    let (root, repo) = (top.join("root"), top.join("repo"));
    for d in ["usr", "etc", "root", "tmp", "run", "dev", "proc"] { std::fs::create_dir_all(root.join(d)).unwrap(); }
    for (link, to) in [("bin", "usr/bin"), ("sbin", "usr/sbin"), ("lib", "usr/lib"), ("lib64", "usr/lib64")] { std::os::unix::fs::symlink(to, root.join(link)).unwrap(); }
    std::fs::create_dir_all(&repo).unwrap();
    let script = r#"echo "pwd $PWD home $HOME host $(hostname)" > out; cat ~/.profile >> out; ls -A ~ | tr '\n' ' ' >> out; echo >> out
echo "told $WHY_REPO $WHY_REPOS $WHY_PROMPT $LENGTH3_REPO $TASK" >> out; echo x > ~/scratch"#;
    let p = Prompt { root, other: false, repo: repo.clone(), name: "t".into(), cmd: vec!["/bin/sh".into(), "-c".into(), script.into()],
        env: vec![("TASK".into(), "do".into()), ("WHY_REPO".into(), "other".into())], network: false,
        dotfiles: vec![(".profile".into(), "export P=1\n".into()), (".t".into(), "the repo's own name is not a dotfile there".into()), ("../x".into(), "no".into())],
        data: None, also: vec![("usr".into(), "/usr".into()), ("etc".into(), "/etc".into())] };
    assert_eq!(ended(apart(|| p.run().unwrap_or(200))), 0);
    assert_eq!(std::fs::read_to_string(repo.join("out")).unwrap(), "pwd /root/t home /root host why\nexport P=1\n.profile t \ntold t /root 1 t do\n");
    // Its home went with it: what was written there is nowhere, and nothing of the Prompt is left behind.
    assert!(!std::env::temp_dir().join(format!("why-prompt-{}.box", std::process::id())).exists());
    let _ = std::fs::remove_dir_all(&top);
}

/// This host's shell and `programs`, each with the libraries it loads at the same paths, copied into `root`: a
/// tree of the test's user, as an installed root is its user's. None where one is not there, or not linked as glibc
/// links (which lists them under LD_TRACE_LOADED_OBJECTS).
fn copied_root(root: &Path, programs: &[&str]) -> Option<()> {
    let path = std::env::var("PATH").ok()?;
    for name in std::iter::once(&"sh").chain(programs) {
        let host = path.split(':').map(|d| Path::new(d).join(name)).find(|p| p.is_file())?;
        std::fs::create_dir_all(root.join("bin")).ok()?;
        std::fs::copy(&host, root.join("bin").join(name)).ok()?;
        let listed = std::process::Command::new(&host).env("LD_TRACE_LOADED_OBJECTS", "1").stdin(std::process::Stdio::null()).output().ok()?;
        let libs: Vec<String> = String::from_utf8_lossy(&listed.stdout).lines()
            .filter_map(|l| l.rsplit("=>").next()?.split_whitespace().next().filter(|p| p.starts_with('/')).map(String::from)).collect();
        if libs.is_empty() { return None; }
        for lib in libs {
            let at = root.join(lib.trim_start_matches('/'));
            std::fs::create_dir_all(at.parent()?).ok()?;
            std::fs::copy(&lib, &at).ok()?;
        }
    }
    Some(())
}

/// The installed root is never written, and a repo whose dotfiles ask nothing of it runs on it as it is, read-only.
/// What `.setup` asks is made in a root of the repo's own, once; and Prompts of the repo share it whatever order
/// they start and end in (#55), as programs share one machine: what one wrote another reads, one stopped (its
/// supervisor killed, as Stop does) takes nothing from the others, and a Prompt started after all have ended has
/// everything they made.
#[test]
fn a_repos_environment_is_a_root_of_its_own_made_once_and_shared_by_its_prompts() {
    if kept_from_boxes().is_some() { eprintln!("skipped: no box here"); return; }
    let top = crate::fs::testing::dir("why-environment-test");
    let (root, repo, data) = (top.join("system/aa/root"), top.join("repo"), top.join("data"));
    let _ = std::fs::remove_dir_all(&top);
    for d in ["etc", "usr/share/doc", "usr/lib", "opt", "srv", "var/lib", "root", "tmp", "run", "dev", "proc"] {
        std::fs::create_dir_all(root.join(d)).unwrap();
    }
    std::fs::create_dir_all(&repo).unwrap();
    if copied_root(&root, &["cat", "mkdir", "mv", "sleep"]).is_none() { eprintln!("skipped: no shell or programs linked by glibc here"); return; }
    let prompt = |script: &str, dotfiles: &[(&str, &str)]| Prompt { root: root.clone(), other: false, repo: repo.clone(), name: "t".into(),
        cmd: vec!["/bin/sh".into(), "-c".into(), format!("cd /root/t\nstep() {{ name=$1; shift; \"$@\" 2>/dev/null; echo \"$name $?\" >> log; }}\n\
            await() {{ while [ ! -e $1 ]; do sleep 0.02; done; }}\n{script}")],
        env: Vec::new(), network: false, dotfiles: dotfiles.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), data: Some(data.clone()), also: Vec::new() };
    let log = || std::fs::read_to_string(repo.join("log")).unwrap_or_default();
    // Nothing asked: the installed root itself, which a Prompt does not write.
    let plain = prompt("step plain-writes-root mkdir /usr/lib/x; step plain-writes-repo mkdir made", &[]);
    assert_eq!(ended(apart(|| { plain.set_up().unwrap(); plain.run().unwrap_or(200) })), 0, "{}", log());
    assert_eq!(log(), "plain-writes-root 1\nplain-writes-repo 0\n");
    assert!(!root.join("usr/lib/x").exists() && repo.join("made").is_dir());
    std::fs::remove_file(repo.join("log")).unwrap();
    // `.setup` asks: the repo's own root is made of the installed one and set up in it, once.
    let asks = [(".setup", "mkdir /opt/set-up && echo once >> /etc/set-up")];
    let start = |script: &str| { let p = prompt(script, &asks); apart(move || { p.set_up().unwrap(); p.run().unwrap_or(200) }) };
    let marked = |name: &str| {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !repo.join(name).exists() {
            assert!(std::time::Instant::now() < until, "{name} was not marked; the log:\n{}", log());
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    };
    let mark = |name: &str| std::fs::write(repo.join(name), "").unwrap();
    let a = start("step a-set-up test \"$(cat /etc/set-up)\" = once; step a-writes sh -c 'echo before > /etc/before'; : > ready-a\n\
            await go-a; step a-mkdir-while-b-runs mkdir /usr/share/doc/a; : > a-did\nwhile :; do sleep 1; done");
    marked("ready-a");
    let b = start("step b-set-up-once test \"$(cat /etc/set-up)\" = once; step b-reads-a test \"$(cat /etc/before)\" = before; step b-mkdir mkdir /usr/lib/b; : > ready-b\n\
            await go-b; step b-mkdir-after-a-stopped mkdir /opt/b; step b-rename mv /opt/b /opt/b2; : > b-did\nawait go-b2");
    marked("ready-b");
    mark("go-a");
    marked("a-did");
    // A is stopped as Runtime stops a Prompt: its supervisor killed, and with it everything in it.
    unsafe { libc::kill(a, libc::SIGKILL) };
    ended(a);
    mark("go-b");
    marked("b-did");
    let c = start("step c-mkdir-while-b-runs mkdir /srv/c; : > ready-c\nawait go-c; step c-mkdir-after-b-ended mkdir /var/lib/c\n\
            echo c > /var/lib/c/f; echo \"c-write $?\" >> log");
    marked("ready-c");
    mark("go-b2");
    assert_eq!(ended(b), 0, "{}", log());
    mark("go-c");
    assert_eq!(ended(c), 0, "{}", log());
    let d = start("for p in /etc/before /usr/share/doc/a /usr/lib/b /opt/b2 /srv/c /var/lib/c/f /opt/set-up; do [ -e $p ]; echo \"d-sees-$p $?\" >> log; done\n\
            step d-mkdir mkdir /usr/share/doc/d");
    assert_eq!(ended(d), 0, "{}", log());
    let log = log();
    let wrong: Vec<&str> = log.lines().filter(|l| !l.ends_with(" 0")).collect();
    assert!(wrong.is_empty() && log.lines().count() == 19, "{log}");
    // The installed root is as it was; what was made is in the repo's own, beside its mark of what set it up.
    assert!(!root.join("etc/before").exists() && !root.join("opt/set-up").exists());
    let env = crate::prompt::writes::env_over(&data, "t", &root);
    assert!(env.join("root/etc/before").is_file() && env.join("set-up").is_file());
    // No bundle is left of any of them but the one that was killed, which the next reading of the records lets go of.
    let left: Vec<String> = std::fs::read_dir(data.join("prompts")).map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    assert_eq!(left, [format!("{a}.box")], "{left:?}");
    crate::prompt::running::all(&data);
    assert_eq!(std::fs::read_dir(data.join("prompts")).unwrap().count(), 0);
    let _ = std::fs::remove_dir_all(&top);
}
