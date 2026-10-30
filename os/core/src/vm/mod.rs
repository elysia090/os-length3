//! Virtual machines: this OS on servers, ours or a person's own. Each run is a microVM of its own on KVM, made and
//! driven through Firecracker (firecracker.rs): a kernel, the root as a read-only disk shared by every VM booted
//! from it (image.rs), a small disk of its own, no network unless the repo was given it, and one vsock to its host,
//! over which the host gives it its run (compute.rs Spec) and it says what it prints (wire.rs). A host is any Linux
//! with /dev/kvm: `l3 host` says what it has and what it lacks.
//!
//! What scales worst on a host, in order, and how each is met:
//!
//! 1. Memory, which bounds how many VMs a host holds. The root is one disk, its pages in the host's cache once for
//!    all; the balloon gives back what a guest frees as it frees it (free page reporting) and takes back more on
//!    ask; a VM nobody uses is snapshotted and let go, and made again from its snapshot, its memory read in only as
//!    the guest touches it.
//! 2. Boot time, which bounds how finely time is sold. A VM booted once is snapshotted; a run starts as a VM loaded
//!    from it (no boot), from a pool kept warm.
//! 3. Disk. Nothing is copied per VM but what it is given and what it writes: the root by its digest, an environment
//!    by its key (compute.rs), a run's disk sparse.
//! 4. Network. None by default: the vsock alone. A repo given the network goes out through the host, which sees and
//!    bounds what leaves.
//! 5. Placement across hosts: each host says what it has room for; the Remote places by memory first.
//! 6. The VMM's own boundary: Firecracker under its jailer (its own user, chroot, seccomp, cgroup).
//! 7. Metering: each VM's CPU and memory from its cgroup, into the ledger (compute.rs), by the millisecond.

pub mod firecracker;
pub mod image;
pub mod wire;

use crate::compute::Spec;
use firecracker::{Balloon, BootSource, Drive, MachineConfig, Vsock};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// What a host fetches to run VMs, pinned by digest as roots are (root.rs): Firecracker's release (its jailer with
/// it), the digest its publisher gives beside it; and the kernel its CI boots VMs with (6.1, with vsock, virtio
/// block, balloon and free page reporting, ext4 and overlayfs built in), pinned as it was fetched for this table.
pub struct Pin { pub arch: &'static str, pub url: &'static str, pub sha256: &'static str, pub bytes: u64 }

pub const FIRECRACKER_VERSION: &str = "v1.14.0";
pub const FIRECRACKER: [Pin; 2] = [
    Pin { arch: "x86_64", url: "https://github.com/firecracker-microvm/firecracker/releases/download/v1.14.0/firecracker-v1.14.0-x86_64.tgz",
        sha256: "b0c60364661f396b92e350cb9d03e2e0c2140c4c24b1e48830eb7f79eb73e153", bytes: 7_667_248 },
    Pin { arch: "aarch64", url: "https://github.com/firecracker-microvm/firecracker/releases/download/v1.14.0/firecracker-v1.14.0-aarch64.tgz",
        sha256: "aa942421588108dced1de57639c4f6ddd063c3063c2f0bba9cd01be1ca8ba3bf", bytes: 7_381_629 },
];
pub const KERNEL: [Pin; 2] = [
    Pin { arch: "x86_64", url: "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.14/x86_64/vmlinux-6.1.155",
        sha256: "e41c7048bd2475e7e788153823fcb9166a7e0b78c4c443bd6446d015fa735f53", bytes: 44_278_288 },
    Pin { arch: "aarch64", url: "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.14/aarch64/vmlinux-6.1.155",
        sha256: "61baeae1ac6197be4fc5c71fa78df266acdc33c54570290d2f611c2b42c105be", bytes: 17_111_552 },
];

/// Where a host keeps Firecracker and its jailer.
pub fn bin(data: &Path) -> PathBuf { data.join("vm").join("bin") }

/// This machine's pins.
fn pinned(list: &'static [Pin; 2]) -> Option<&'static Pin> { list.iter().find(|p| p.arch == std::env::consts::ARCH) }

/// Fetch what this host lacks to run VMs: Firecracker and its jailer (from its release, checked by digest, the two
/// programs taken out of it), and the kernel. What is held already, by its digest, is not fetched again.
pub fn fetch(data: &Path, mut progress: impl FnMut(crate::fetch::Progress)) -> crate::Result<()> {
    let (Some(fc), Some(kernel)) = (pinned(&FIRECRACKER), pinned(&KERNEL)) else {
        return Err(crate::tr!("No Firecracker for this machine ({})", "この機械（{}）向けの Firecracker はありません", std::env::consts::ARCH));
    };
    let downloads = data.join("vm").join(".downloads");
    crate::boundary::private_dir(&downloads).map_err(|e| e.to_string())?;
    let k = kernel_path(data);
    crate::boundary::private_dir(k.parent().unwrap()).map_err(|e| e.to_string())?;
    crate::fetch::fetch(kernel.url, kernel.sha256, kernel.bytes, &k, &mut progress)?;
    let tgz = downloads.join(format!("firecracker-{FIRECRACKER_VERSION}-{}.tgz", fc.arch));
    crate::fetch::fetch(fc.url, fc.sha256, fc.bytes, &tgz, &mut progress)?;
    // Unpacked aside, the two programs taken out, the rest let go.
    let aside = downloads.join("unpacked");
    let _ = std::fs::remove_dir_all(&aside);
    std::fs::create_dir_all(&aside).map_err(|e| e.to_string())?;
    let file = std::fs::File::open(&tgz).map_err(|e| e.to_string())?;
    crate::root::unpack(flate2::read::GzDecoder::new(file), &aside).map_err(|e| e.to_string())?;
    let dir = bin(data);
    crate::boundary::private_dir(&dir).map_err(|e| e.to_string())?;
    for name in ["firecracker", "jailer"] {
        let from = aside.join(format!("release-{FIRECRACKER_VERSION}-{}", fc.arch)).join(format!("{name}-{FIRECRACKER_VERSION}-{}", fc.arch));
        let bytes = std::fs::read(&from).map_err(|e| format!("{}: {e}", from.display()))?;
        crate::atomic::replace(&dir.join(name), &bytes, crate::atomic::How { mode: Some(0o755), durable: true }).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_dir_all(&aside);
    let _ = std::fs::remove_file(&tgz);
    Ok(())
}

/// What this host has of what VMs need, and for what it lacks, the one fix.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Host {
    /// /dev/kvm can be opened to read and write.
    pub kvm: bool,
    pub firecracker: Option<String>,
    pub jailer: Option<String>,
    /// The kernel VMs boot (its sha256), if one is here.
    pub kernel: Option<String>,
    pub cpus: usize,
    pub memory: u64,
    /// What it lacks, each with its fix.
    pub lacks: Vec<(String, String)>,
}

/// Where the kernel VMs boot is kept.
pub fn kernel_path(data: &Path) -> PathBuf { data.join("vm").join("kernel").join("vmlinux") }

/// A program's version, the host's own copy first (`l3 host fetch`), then one on PATH.
fn version(data: &Path, program: &str) -> Option<String> {
    let own = bin(data).join(program);
    let out = std::process::Command::new(if own.is_file() { own.as_os_str() } else { std::ffi::OsStr::new(program) }).arg("--version").output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").trim().to_string())
}

/// What this host has.
pub fn host(data: &Path) -> Host {
    let kvm = std::fs::OpenOptions::new().read(true).write(true).open("/dev/kvm");
    let (firecracker, jailer) = (version(data, "firecracker"), version(data, "jailer"));
    let kernel = std::fs::read(kernel_path(data)).ok().map(|b| {
        use sha2::{Digest, Sha256};
        Sha256::digest(&b).iter().map(|x| format!("{x:02x}")).collect::<String>()
    });
    let memory = std::fs::read_to_string("/proc/meminfo").ok().and_then(|t| t.lines()
        .find_map(|l| l.strip_prefix("MemTotal:")?.trim().strip_suffix("kB")?.trim().parse::<u64>().ok())).map_or(0, |kb| kb * 1024);
    let mut lacks = Vec::new();
    match &kvm {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => lacks.push((crate::tr!("No /dev/kvm: this machine runs no VMs (a VM itself, or virtualization off in its firmware)", "/dev/kvm がありません。この機械では VM を動かせません（それ自体が VM か、ファームウェアで仮想化がオフ）"), String::new())),
        Err(_) => lacks.push((crate::tr!("/dev/kvm cannot be opened by you", "/dev/kvm をあなたが開けません"), "sudo usermod -aG kvm $USER".into())),
        Ok(_) => {}
    }
    if firecracker.is_none() { lacks.push((crate::tr!("No firecracker", "firecracker がありません"), "l3 host fetch".into())); }
    if kernel.is_none() { lacks.push((crate::tr!("No kernel for VMs", "VM のカーネルがありません"), "l3 host fetch".into())); }
    Host { kvm: kvm.is_ok(), firecracker, jailer, kernel, cpus: std::thread::available_parallelism().map_or(1, |n| n.get()), memory, lacks }
}

/// The Firecracker calls a run is, in order: its size, its kernel and what the kernel is told, its disks, its vsock,
/// its balloon.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Plan { pub machine: MachineConfig, pub boot: BootSource, pub drives: Vec<Drive>, pub vsock: Vsock, pub balloon: Balloon }

/// What the kernel is told: the root disk, read-only, and l3 as the first process (`l3 guest`, the run's agent).
pub const BOOT_ARGS: &str = "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda ro rootfstype=ext4 init=/usr/bin/l3 -- guest";

/// A VM for `spec`: as much memory as its budget lets it hold (512 MB when it says none; 128 MB to 32 GB), two
/// vCPUs, the root disk and its own, the vsock at `dir`, a balloon that gives back what the guest frees.
pub fn plan(spec: &Spec, kernel: &Path, root_disk: &Path, run_disk: &Path, dir: &Path, cid: u32) -> Plan {
    let mib = spec.budget.memory.map_or(512, |b| (b >> 20).clamp(128, 32 << 10)) as u32;
    Plan {
        machine: MachineConfig { vcpu_count: 2, mem_size_mib: mib, track_dirty_pages: true },
        boot: BootSource { kernel_image_path: kernel.to_path_buf(), boot_args: BOOT_ARGS.into() },
        drives: vec![
            Drive { drive_id: "root".into(), path_on_host: root_disk.to_path_buf(), is_root_device: true, is_read_only: true },
            Drive { drive_id: "run".into(), path_on_host: run_disk.to_path_buf(), is_root_device: false, is_read_only: false },
        ],
        vsock: Vsock { guest_cid: cid, uds_path: dir.join("v.sock") },
        balloon: Balloon { amount_mib: 0, deflate_on_oom: true, free_page_reporting: true, stats_polling_interval_s: 1 },
    }
}

/// Give Firecracker (its socket `api`) the plan, and start the VM.
pub fn boot(api: &firecracker::Api, p: &Plan) -> Result<(), firecracker::Fault> {
    api.machine(p.machine)?;
    api.boot(&p.boot)?;
    for d in &p.drives { api.drive(d)?; }
    api.vsock(&p.vsock)?;
    api.balloon(p.balloon)?;
    api.start()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::Budget;

    #[test]
    fn a_vm_is_as_large_as_its_budget_and_holds_the_root_read_only() {
        let spec = |memory| Spec { root: "r".repeat(64), environment: String::new(), repo: "notes".into(), line: "main".into(), argv: vec!["/bin/sh".into()],
            env: Vec::new(), network: false, budget: Budget { memory, ..Budget::default() } };
        let p = |memory| plan(&spec(memory), Path::new("/k"), Path::new("/root.ext4"), Path::new("/run.ext4"), Path::new("/vm/1"), 3);
        assert_eq!(p(None).machine.mem_size_mib, 512);
        assert_eq!(p(Some(1 << 20)).machine.mem_size_mib, 128);
        assert_eq!(p(Some(2 << 30)).machine.mem_size_mib, 2048);
        assert_eq!(p(Some(1 << 40)).machine.mem_size_mib, 32768);
        let plan = p(None);
        assert!(plan.drives[0].is_root_device && plan.drives[0].is_read_only && !plan.drives[1].is_read_only);
        assert_eq!((plan.vsock.guest_cid, plan.vsock.uds_path.as_path()), (3, Path::new("/vm/1/v.sock")));
        assert!(plan.boot.boot_args.contains("init=/usr/bin/l3 -- guest") && plan.boot.boot_args.contains(" ro "));
    }

    #[test]
    fn a_host_says_what_it_lacks_and_how_to_have_it() {
        let h = host(&std::env::temp_dir().join("l3-no-such-data"));
        assert!(h.kernel.is_none() && h.lacks.iter().any(|(_, fix)| fix == "l3 host fetch"));
        assert_eq!(h.kvm, std::fs::OpenOptions::new().read(true).write(true).open("/dev/kvm").is_ok());
        assert!(h.cpus >= 1);
    }
}
