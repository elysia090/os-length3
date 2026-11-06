//! The tests of vm/firecracker.rs.

use super::*;
use std::os::unix::net::UnixListener;

/// Each request a fake was asked: its method, path and body.
type Seen = Vec<(String, String, String)>;

/// A socket that answers as Firecracker does: each request kept (method, path, body), 204, or 400 with a fault
/// for a body naming `bad`.
fn fake(dir: &Path) -> (PathBuf, std::thread::JoinHandle<Seen>) {
    let path = dir.join("api.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let handle = std::thread::spawn(move || {
        let mut seen = Vec::new();
        for s in listener.incoming().take(4) {
            let s = s.unwrap();
            let mut r = BufReader::new(s.try_clone().unwrap());
            let mut line = String::new();
            r.read_line(&mut line).unwrap();
            let mut length = 0;
            loop {
                let mut h = String::new();
                r.read_line(&mut h).unwrap();
                if h == "\r\n" { break; }
                if let Some(v) = h.strip_prefix("Content-Length:") { length = v.trim().parse().unwrap(); }
            }
            let mut body = vec![0; length];
            r.read_exact(&mut body).unwrap();
            let (method, path) = { let mut w = line.split_whitespace(); (w.next().unwrap().to_string(), w.next().unwrap().to_string()) };
            let answer = if String::from_utf8_lossy(&body).contains("bad") {
                let f = r#"{"fault_message":"The kernel file cannot be opened"}"#;
                format!("HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\n\r\n{f}", f.len())
            } else { "HTTP/1.1 204 No Content\r\n\r\n".to_string() };
            (&s).write_all(answer.as_bytes()).unwrap();
            seen.push((method, path, String::from_utf8(body).unwrap()));
        }
        seen
    });
    (path, handle)
}

#[test]
fn a_vm_is_configured_started_and_paused_as_firecracker_is_asked_and_its_faults_are_said() {
    let dir = crate::fs::testing::dir("l3-fc");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let (sock, seen) = fake(&dir);
    let api = Api::at(&sock);
    api.machine(MachineConfig { vcpu_count: 2, mem_size_mib: 512, track_dirty_pages: true }).unwrap();
    api.drive(&Drive { drive_id: "root".into(), path_on_host: "/r.ext4".into(), is_root_device: true, is_read_only: true }).unwrap();
    api.pause(true).unwrap();
    let fault = api.boot(&BootSource { kernel_image_path: "/bad".into(), boot_args: String::new() }).unwrap_err();
    let fault = Fault { status: fault.status, message: fault.message };
    assert_eq!(fault, Fault { status: 400, message: "The kernel file cannot be opened".into() });
    let seen = seen.join().unwrap();
    assert_eq!(seen.iter().map(|(m, p, _)| format!("{m} {p}")).collect::<Vec<_>>(), ["PUT /machine-config", "PUT /drives/root", "PATCH /vm", "PUT /boot-source"]);
    assert_eq!(serde_json::from_str::<serde_json::Value>(&seen[0].2).unwrap(), serde_json::json!({"vcpu_count": 2, "mem_size_mib": 512, "track_dirty_pages": true}));
    assert_eq!(serde_json::from_str::<serde_json::Value>(&seen[2].2).unwrap(), serde_json::json!({"state": "Paused"}));
    let _ = std::fs::remove_dir_all(&dir);
}
