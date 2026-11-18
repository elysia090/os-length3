// Native-only endpoint witness. Creating a File supplies a narrow physical
// fact; it does not make a number accepted by the ordinary Wasm ABI or Node.
use super::*;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "sods-sendfile-owned-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        std::fs::create_dir(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// The fixture owns this File until settlement. It neither borrows nor
// accepts a raw OS fd, flags from an embedder or an existing file path.
struct OwnedOutput {
    file: File,
    binding: descriptor::OwnedStdout,
}
impl OwnedOutput {
    fn install(dir: &Scratch, files: &mut Files, endpoint: u64) -> (Table, Self) {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(dir.0.join("out"))
            .unwrap();
        assert!(file.metadata().unwrap().is_file());
        let (table, binding) = files
            .stdio_with_owned_stdout([10, endpoint, 30], 16)
            .unwrap();
        (table, Self { file, binding })
    }
}

#[test]
fn owned_regular_output_uses_the_original_endpoint_and_canonical_offer() {
    for guest_exits_before_receipt in [false, true] {
        let mut h = Harness::new(false, false, 0);
        let source = h.f.inode(&h.t, h.fd).unwrap();
        let stale_dir = Scratch::new();
        let (stale_table, stale) = OwnedOutput::install(&stale_dir, &mut h.f, 20);
        h.f.let_go(stale_table).unwrap();
        let dir = Scratch::new();
        let (table, mut sink) = OwnedOutput::install(&dir, &mut h.f, 20);
        let borrowed = std::mem::replace(&mut h.t, table);
        // A reused registry slot with the identical endpoint number is not
        // the previous installation's still-retained host token.
        h.f.let_go(borrowed).unwrap();
        h.fd = h.f.open(&h.t, source, false).unwrap();
        let alternate_dir = Scratch::new();
        let (alternate_table, alternate) = OwnedOutput::install(&alternate_dir, &mut h.f, 20);
        assert_eq!(sink.file.write(b"A").unwrap(), 1);

        h.begin(4);
        let request = h.request();
        let request =
            h.s.approve_owned_stdout(request, &alternate.binding)
                .unwrap_err();
        let request =
            h.s.approve_owned_stdout(request, &stale.binding)
                .unwrap_err();
        assert_eq!(h.s.phase(), Phase::CapChecking);
        assert!(!h.s.viewing());
        assert_eq!(h.s.offered(), 0, "foreign output grants no source view");
        assert_eq!(h.f.offset(&h.t, h.fd), Ok((0, 0)));
        let proof = h.s.approve_owned_stdout(request, &sink.binding).unwrap();

        // The live descriptor now names a regular inode, not either physical
        // output. The originally held stream still names the approved sink.
        h.f.close(&h.t, 1).unwrap();
        assert_eq!(h.f.open(&h.t, h.other, false), Ok(1));
        h.s.cap_finish(&mut h.f, &mut h.d, &mut h.e, proof).unwrap();
        let canonical = h.f.read_bytes(h.s.source.as_ref().unwrap()).as_ptr() as usize;
        let action = h.token();
        let (address, length) = h.start();
        assert_eq!((address, length), (canonical, 4));
        let confirmed = {
            // start retains the immutable canonical source and excludes mutation;
            // this straightforward native Write call cannot retain the slice.
            let view = unsafe { std::slice::from_raw_parts(address as *const u8, length as usize) };
            sink.file.write(view).unwrap() as u64
        };
        assert_eq!(confirmed, 4);

        if guest_exits_before_receipt {
            h.request_exit();
            h.e.receipt(&mut h.d, h.invocation, execution::Unwind::Exit)
                .unwrap();
            assert!(h.e.stopped());
            assert!(h.s.viewing(), "guest stop never settles external access");
            assert!(!h.s.finished());
            assert_eq!(h.f.offset(&h.t, h.fd), Ok((0, 0)));
        }
        assert_eq!(
            h.s.receipt_with_access(
                &mut h.f,
                &mut h.d,
                &mut h.e,
                9,
                action,
                confirmed + 1,
                Outcome::Transferred,
                AccessEvidence::Ended,
            ),
            Err(Error::Range),
        );
        assert!(h.s.viewing());
        assert_eq!(h.f.offset(&h.t, h.fd), Ok((0, 0)));
        h.s.receipt_with_access(
            &mut h.f,
            &mut h.d,
            &mut h.e,
            9,
            action,
            confirmed,
            Outcome::Transferred,
            AccessEvidence::Ended,
        )
        .unwrap();
        assert_eq!(h.f.offset(&h.t, h.fd), Ok((4, 1)));
        assert_eq!(h.f.offset(&h.t, 1), Ok((0, 0)));
        assert_eq!(
            h.s.result(),
            Some(if guest_exits_before_receipt {
                ResultValue::GuestLost
            } else {
                ResultValue::Return(4)
            })
        );
        h.assert_released();
        assert_eq!(sink.file.write(b"C").unwrap(), 1);
        assert_eq!(std::fs::read(dir.0.join("out")).unwrap(), b"AabcdC");
        assert_eq!(alternate.file.metadata().unwrap().len(), 0);
        assert_eq!(stale.file.metadata().unwrap().len(), 0);
        h.f.let_go(alternate_table).unwrap();
    }
}
