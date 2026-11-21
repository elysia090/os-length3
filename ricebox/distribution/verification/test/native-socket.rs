//! Opt-in Linux x86-64 integration proof. No inherited desktop session, host userland mounts or shipped CLI.

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod proof {
    use ricebox::bundle::Bind;
    use ricebox::run::{self, Asked};
    use ricebox::{About, Error, Form, Pin};
    use std::env;
    use std::fs::{self, File};
    use std::io::{BufRead, BufReader, Read};
    use std::os::unix::fs::{symlink, FileTypeExt};
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};

    const VERSION: &str = "0.0.1-native.proof";

    struct Scratch(PathBuf);

    impl Drop for Scratch {
        fn drop(&mut self) {
            if let Err(why) = fs::remove_dir_all(&self.0) {
                eprintln!(
                    "could not remove native socket fixture {}: {why}",
                    self.0.display()
                );
            }
        }
    }

    struct Peer(Child);

    impl Drop for Peer {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn ok(command: &mut Command, step: &str) {
        let status = command
            .status()
            .unwrap_or_else(|why| panic!("{step}: {why}"));
        assert!(status.success(), "{step}: {status}");
    }

    fn expect_guest(command: &mut Command, marker: &str, step: &str) {
        let output = command
            .stderr(Stdio::inherit())
            .output()
            .unwrap_or_else(|why| panic!("{step}: {why}"));
        let guest_stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success(),
            "{step}: {}, guest stdout: {guest_stdout:?}",
            output.status
        );
        assert_eq!(
            guest_stdout,
            format!("{marker}\n"),
            "{step}: unexpected guest stdout"
        );
        println!("{marker}");
    }

    fn install(top: &Path, busybox: &Path) -> PathBuf {
        let distribution = Path::new(env!("CARGO_MANIFEST_DIR"));
        let packages = top.join("packages");
        let package = packages.join("native-proof");
        let bin = package.join("tree/usr/bin");
        fs::create_dir_all(&bin).unwrap();
        fs::copy(busybox, bin.join("busybox")).expect("copy the supplied static BusyBox");
        symlink("busybox", bin.join("sh")).unwrap();
        let probe = bin.join("socket-proof");
        ok(
            Command::new("cc")
                .args(["-std=c17", "-O2", "-Wall", "-Wextra", "-Werror", "-static"])
                .arg(distribution.join("verification/test/fixtures/native-socket.c"))
                .arg("-o")
                .arg(&probe),
            "build the static native socket fixture",
        );
        fs::write(packages.join("record"), format!("native-proof {VERSION}\n")).unwrap();
        for (file, value) in [
            ("version", VERSION),
            ("source", "fixture"),
            ("key", "fixture"),
        ] {
            fs::write(package.join(file), format!("{value}\n")).unwrap();
        }
        let out = top.join("out");
        ok(
            Command::new("sh")
                .arg(distribution.join("build/assemble.sh"))
                .arg(&packages)
                .arg(&out)
                .args([VERSION, "ricebox-native-proof"]),
            "assemble the native fixture archive",
        );
        let sums = fs::read_to_string(out.join("SHA256SUMS")).unwrap();
        let (sha, name) = sums
            .trim_end()
            .split_once("  ")
            .expect("assembly pin and archive");
        let archive = out.join(name);
        let bytes = fs::metadata(&archive).unwrap().len();
        let system = top.join("installed");
        let about = About {
            name: "Ricebox native socket fixture",
            version: VERSION,
            distro: None,
        };
        let wrong = "0".repeat(64);
        assert_ne!(sha, wrong);
        let file = || File::open(&archive).unwrap();
        assert!(matches!(
            ricebox::put(
                &system,
                file(),
                Pin {
                    sha256: &wrong,
                    bytes
                },
                Form::Release,
                about,
                |_| unreachable!("accepted the wrong digest")
            ),
            Err(Error::NotPinned { .. })
        ));
        assert_eq!(fs::read_dir(&system).unwrap().count(), 0);
        ricebox::put(
            &system,
            file(),
            Pin { sha256: sha, bytes },
            Form::Release,
            about,
            |_| Ok(()),
        )
        .expect("install the pinned native archive");
        let installed =
            ricebox::point_current(&system, sha).expect("select the pinned native archive");
        assert_eq!(installed.sha256, sha);
        probe
    }

    // A separate instance has one thread and only Muk as a child, as run::run requires.
    fn guest(top: &Path, role: &str) {
        let lend = role == "lent";
        let (root, installed) =
            ricebox::current(&top.join("installed")).expect("read the selected root");
        assert_eq!(installed.version, VERSION);
        assert_eq!(
            root,
            top.join("installed").join(installed.sha256).join("root")
        );
        let dir = top.join("bundle");
        let binds: Vec<_> = lend
            .then(|| {
                let source = top.join("service/ricebox-proof.sock");
                assert!(source.symlink_metadata().unwrap().file_type().is_socket());
                Bind {
                    from: source.to_str().unwrap().into(),
                    inside: "run/ricebox-proof.sock".into(),
                    read_only: true,
                }
            })
            .into_iter()
            .collect();
        let cmd = [
            "/bin/sh",
            "-ec",
            r#". /etc/os-release; test "$ID" = ricebox; test "$VERSION_ID" = "$1"; exec /usr/bin/socket-proof "$2""#,
            "socket-proof",
            VERSION,
            role,
        ].map(str::to_owned);
        assert_eq!(
            run::run(&Asked {
                root: &root,
                dir: &dir,
                binds: &binds,
                cmd: &cmd,
                written: false,
                other: false,
                network: false,
                cwd: "/",
                hostname: "ricebox-proof",
                id: "ricebox-proof",
                more: &[],
            })
            .expect("launch native Muk"),
            0,
            "installed guest command failed"
        );
        assert!(!dir.exists(), "Muk bundle directory was not cleaned up");
    }

    pub fn run() {
        let args: Vec<_> = env::args_os().skip(1).collect();
        match args.as_slice() {
            [mode, top, role] if mode == "--guest" => {
                let role = role.to_str().expect("guest role must be UTF-8");
                assert!(matches!(role, "baseline" | "unlent" | "lent"));
                return guest(top.as_ref(), role);
            }
            [_] => {}
            _ => panic!("usage: cargo run --locked -p ricebox --example native-socket-proof -- STATIC_BUSYBOX"),
        }
        assert_ne!(
            rustix::process::getuid().as_raw(),
            0,
            "run the proof as an unprivileged user"
        );
        let busybox = Path::new(&args[0])
            .canonicalize()
            .expect("static BusyBox path is required");
        assert!(busybox.is_file(), "static BusyBox must be a regular file");
        let made = Command::new("mktemp")
            .arg("-d")
            .output()
            .expect("create a private native-test directory");
        assert!(made.status.success(), "mktemp: {:?}", made.status);
        let scratch = Scratch(PathBuf::from(
            std::str::from_utf8(&made.stdout).unwrap().trim_end(),
        ));
        let top = scratch.0.canonicalize().expect("absolute proof directory");
        let muk = top.join("muk");
        let sources = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        ok(
            Command::new("sh")
                .arg(sources.join("toolchain/build.sh"))
                .arg(sources.join("muk/src/muk.c"))
                .arg(&muk),
            "build current-source Muk",
        );
        let probe = install(&top, &busybox);
        let exe = env::current_exe().unwrap();
        let invoke = |role| {
            let mut command = Command::new("timeout");
            command
                .args(["--kill-after=2s", "15s"])
                .arg(&exe)
                .arg("--guest")
                .arg(&top)
                .arg(role)
                .env("RICEBOX_MUK", &muk)
                .stdin(Stdio::null());
            command
        };
        let service = top.join("service");
        fs::create_dir(&service).unwrap();
        fs::write(service.join("not-lent"), "host-only canary\n").unwrap();
        expect_guest(
            &mut invoke("baseline"),
            "GUEST_BASELINE_SOCKET_ABSENT",
            "boot the installed root before opening the socket",
        );
        let mut peer = Peer(
            Command::new(&probe)
                .arg("host")
                .current_dir(&service)
                .stdout(Stdio::piped())
                .spawn()
                .expect("start the synthetic pathname socket peer"),
        );
        let mut stdout = BufReader::new(peer.0.stdout.take().unwrap());
        let mut line = String::new();
        stdout
            .read_line(&mut line)
            .expect("read host peer readiness");
        assert_eq!(
            line, "READY\n",
            "host peer could not create and listen on its pathname socket; see stderr"
        );
        expect_guest(
            &mut invoke("unlent"),
            "GUEST_ACTIVE_HOST_SOCKET_UNLENT",
            "verify the active host socket is absent when not lent",
        );
        assert!(
            peer.0.try_wait().unwrap().is_none(),
            "host peer ended during the no-lend control"
        );
        expect_guest(
            &mut invoke("lent"),
            "GUEST_SCM_RIGHTS_MEMFD_OK",
            "run the installed guest with one read-only socket lend",
        );
        let mut result = String::new();
        stdout.read_to_string(&mut result).unwrap();
        assert!(
            peer.0.wait().unwrap().success(),
            "host FD exchange failed; see stderr"
        );
        assert_eq!(result, "HOST_SCM_RIGHTS_MEMFD_OK\n");
        print!("{result}");
    }
}

fn main() {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    proof::run();
    #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
    panic!("the native socket proof requires Linux x86-64");
}
