//! The tests of compute/vm.rs.

use super::*;
use crate::compute::spec::Budget;

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
