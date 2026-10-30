//! Firecracker, asked as it is asked: HTTP/1.1 over its Unix socket, one request at a time, JSON in, nothing or a
//! fault out (https://github.com/firecracker-microvm/firecracker/blob/main/src/firecracker/swagger/firecracker.yaml).
//! A VM is configured (machine, kernel, drives, vsock, balloon), then started; it can be paused, resumed,
//! snapshotted (its state and its memory, each a file) and a new one loaded from a snapshot, its memory read in only
//! as the guest touches it.

// No unsafe code here, nor ever added unnoticed (lib.rs: unsafe lives only where the OS is called).
#![forbid(unsafe_code)]

use serde::Serialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};

/// The VM's size: its vCPUs and memory.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct MachineConfig {
    pub vcpu_count: u8,
    pub mem_size_mib: u32,
    /// Its memory tracked page by page, so a snapshot after the first writes only what changed.
    pub track_dirty_pages: bool,
}

/// The kernel it boots and what the kernel is told.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct BootSource { pub kernel_image_path: PathBuf, pub boot_args: String }

/// A disk: its file on the host, whether it is the root, whether the guest may write it.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Drive { pub drive_id: String, pub path_on_host: PathBuf, pub is_root_device: bool, pub is_read_only: bool }

/// The VM's one line to its host: the guest's `cid`, and the host's socket the guest's connections arrive at (its
/// port after an underscore).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Vsock { pub guest_cid: u32, pub uds_path: PathBuf }

/// How much of its memory the host takes back (`amount_mib`), the guest giving back its free pages as it frees them.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Balloon { pub amount_mib: u32, pub deflate_on_oom: bool, pub free_page_reporting: bool, pub stats_polling_interval_s: u32 }

/// Where a snapshot is kept: the VM's state, and its memory.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Snapshot { pub snapshot_path: PathBuf, pub mem_file_path: PathBuf }

/// What Firecracker said instead of doing it.
#[derive(Debug, PartialEq)]
pub struct Fault { pub status: u16, pub message: String }

impl std::fmt::Display for Fault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "firecracker {}: {}", self.status, self.message) }
}

/// One Firecracker process, by its API socket.
pub struct Api { socket: PathBuf }

impl Api {
    pub fn at(socket: &Path) -> Api { Api { socket: socket.to_path_buf() } }

    /// `method path` with `body`: Ok with what it answered (empty for 204), or what it said went wrong.
    fn ask(&self, method: &str, path: &str, body: Option<&serde_json::Value>) -> Result<String, Fault> {
        let fault = |message: String| Fault { status: 0, message };
        let mut s = UnixStream::connect(&self.socket).map_err(|e| fault(format!("{}: {e}", self.socket.display())))?;
        let body = body.map(|b| b.to_string()).unwrap_or_default();
        let request = format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len());
        s.write_all(request.as_bytes()).map_err(|e| fault(e.to_string()))?;
        let mut r = BufReader::new(s);
        let mut status_line = String::new();
        r.read_line(&mut status_line).map_err(|e| fault(e.to_string()))?;
        let status: u16 = status_line.split_whitespace().nth(1).and_then(|c| c.parse().ok()).ok_or_else(|| fault(format!("no status: {status_line:?}")))?;
        let mut length = 0usize;
        loop {
            let mut h = String::new();
            if r.read_line(&mut h).map_err(|e| fault(e.to_string()))? == 0 || h == "\r\n" { break; }
            if let Some((k, v)) = h.split_once(':') { if k.eq_ignore_ascii_case("content-length") { length = v.trim().parse().unwrap_or(0); } }
        }
        let mut answer = vec![0; length];
        r.read_exact(&mut answer).map_err(|e| fault(e.to_string()))?;
        let answer = String::from_utf8_lossy(&answer).into_owned();
        if (200..300).contains(&status) { return Ok(answer); }
        let message = serde_json::from_str::<serde_json::Value>(&answer).ok().and_then(|v| v["fault_message"].as_str().map(String::from)).unwrap_or(answer);
        Err(Fault { status, message })
    }

    fn put(&self, path: &str, body: impl Serialize) -> Result<(), Fault> {
        self.ask("PUT", path, Some(&serde_json::to_value(body).unwrap_or_default())).map(|_| ())
    }

    pub fn machine(&self, m: MachineConfig) -> Result<(), Fault> { self.put("/machine-config", m) }
    pub fn boot(&self, b: &BootSource) -> Result<(), Fault> { self.put("/boot-source", b) }
    pub fn drive(&self, d: &Drive) -> Result<(), Fault> { self.put(&format!("/drives/{}", d.drive_id), d) }
    pub fn vsock(&self, v: &Vsock) -> Result<(), Fault> { self.put("/vsock", v) }
    pub fn balloon(&self, b: Balloon) -> Result<(), Fault> { self.put("/balloon", b) }

    /// The balloon resized: `mib` of the guest's memory taken back by the host (0: all of it given back).
    pub fn reclaim(&self, mib: u32) -> Result<(), Fault> {
        self.ask("PATCH", "/balloon", Some(&serde_json::json!({"amount_mib": mib}))).map(|_| ())
    }

    pub fn start(&self) -> Result<(), Fault> { self.put("/actions", serde_json::json!({"action_type": "InstanceStart"})) }

    /// Paused: its vCPUs stop where they are, its memory stays; or going on.
    pub fn pause(&self, paused: bool) -> Result<(), Fault> {
        self.ask("PATCH", "/vm", Some(&serde_json::json!({"state": if paused { "Paused" } else { "Resumed" }}))).map(|_| ())
    }

    /// Its state and memory written to `at` (the VM paused first; a diff snapshot writes only the pages changed since
    /// the last one).
    pub fn snapshot(&self, at: &Snapshot, diff: bool) -> Result<(), Fault> {
        self.put("/snapshot/create", serde_json::json!({"snapshot_type": if diff { "Diff" } else { "Full" }, "snapshot_path": at.snapshot_path, "mem_file_path": at.mem_file_path}))
    }

    /// A new VM made from a snapshot, its memory mapped from the file and read in only as the guest touches it, and
    /// running at once if `resume`.
    pub fn load(&self, at: &Snapshot, resume: bool) -> Result<(), Fault> {
        self.put("/snapshot/load", serde_json::json!({"snapshot_path": at.snapshot_path,
            "mem_backend": {"backend_type": "File", "backend_path": at.mem_file_path}, "enable_diff_snapshots": true, "resume_vm": resume}))
    }

    /// What the guest says of its memory through the balloon (bytes free, available…), as Firecracker answers it.
    pub fn balloon_stats(&self) -> Result<serde_json::Value, Fault> {
        self.ask("GET", "/balloon/statistics", None).map(|t| serde_json::from_str(&t).unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    /// A socket that answers as Firecracker does: each request kept (method, path, body), 204, or 400 with a fault
    /// for a body naming `bad`.
    fn fake(dir: &Path) -> (PathBuf, std::thread::JoinHandle<Vec<(String, String, String)>>) {
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
        let dir = std::env::temp_dir().join(format!("l3-fc-{}", std::process::id()));
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
}
