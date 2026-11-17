//! Private initial read/exit continuation, NOT the complete Linux syscall ABI.
//! Preopened regular read-only files only: access flags, signals, mappings and
//! multi-thread exit are not implemented here. Requested-range clipping follows
//! the current TS file caller; it is not a claim of normative Linux equivalence.
//! TS transports commands; syscall numbers, errors and resume register values
//! are decided here. The managed owner must not expose the owned ReadId for
//! independent retirement or manufacture source-failure evidence.
use crate::descriptor::{self, Files, Table};
use crate::effect::{Completion, Token};
use crate::execution::{self, Execution, Invocation, Phase, Snapshot};
use crate::lease::{self, Domain};
use crate::read::{self, Reads};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Error {
    State,
    ReadFailed,
    Execution(execution::Error),
    Read(read::Error),
    Lease(lease::Error),
    Files(descriptor::Error),
}
impl From<execution::Error> for Error {
    fn from(e: execution::Error) -> Self {
        Self::Execution(e)
    }
}
impl From<read::Error> for Error {
    fn from(e: read::Error) -> Self {
        Self::Read(e)
    }
}
impl From<lease::Error> for Error {
    fn from(e: lease::Error) -> Self {
        Self::Lease(e)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Resume {
    pub next: u64,
    pub rax: i64,
    pub rcx: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    Return(i64),
    Read {
        id: u64,
        target: u64,
    },
    Stream {
        action: Token,
        endpoint: u64,
        target: u64,
        length: u64,
        write: bool,
    },
    Exit,
    Unsupported(u64),
    Waiting,
    Resume(Resume),
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Progress {
    Reading,
    Applying,
    Uncertain,
}
struct Pending {
    invocation: Invocation,
    snapshot: Snapshot,
    read: u64,
    next: u64,
    source_failed: bool,
    progress: Progress,
}
/// Known errors certify zero effect and stopped host access. Unknown certifies
/// neither. The adapter must never classify an arbitrary throw as known zero.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PhysicalResult {
    Transferred,
    Again,
    Interrupted,
    BadFd,
    BrokenPipe,
    Io,
    Unknown,
}
struct StreamPending {
    hold: descriptor::StreamHold,
    invocation: Invocation,
    snapshot: Snapshot,
    action: Token,
    started: bool,
}
pub(crate) struct Continuation {
    owner: Snapshot,
    pending: Option<Pending>,
    stream: Option<StreamPending>,
}
impl Continuation {
    pub(crate) fn new(execution: &Execution) -> Result<Self, Error> {
        Ok(Self {
            owner: execution.stamp()?,
            pending: None,
            stream: None,
        })
    }
    /// Only Reading retains a live Reads record; Applying/Uncertain owns the
    /// resume obligation after that record has already been retired.
    pub(crate) fn owns_read(&self, id: u64) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|p| p.read == id && p.progress == Progress::Reading)
    }
    fn owner(&self, execution: &Execution) -> Result<(), Error> {
        if !execution.owns_snapshot(self.owner) {
            return Err(Error::Execution(execution::Error::Identity));
        }
        Ok(())
    }
    pub(crate) fn enter(
        &mut self,
        files: &mut Files,
        table: &Table,
        reads: &mut Reads,
        domain: &mut Domain,
        execution: &mut Execution,
        invocation: Invocation,
        nr: u64,
        args: [u64; 6],
        next: u64,
    ) -> Result<Step, Error> {
        self.owner(execution)?;
        execution.check_domain(domain)?;
        execution.syscall_allowed(invocation)?;
        if self.pending.is_some() || self.stream.is_some() {
            return Err(Error::State);
        }
        if nr == 0 || nr == 1 {
            let fd = args[0] as u32;
            let target = match files.target(table, fd) {
                Ok(target) => target,
                Err(descriptor::Error::BadFd) => return Ok(Step::Return(-9)),
                Err(error) => return Err(Error::Files(error)),
            };
            if let descriptor::Target::HostStream {
                endpoint,
                direction,
            } = target
            {
                let write = nr == 1;
                let wanted = if write {
                    descriptor::StreamDirection::Write
                } else {
                    descriptor::StreamDirection::Read
                };
                if direction != wanted {
                    return Ok(Step::Return(-9));
                }
                if args[2] == 0 {
                    return Ok(Step::Return(0));
                }
                // Stream consumes irreversibly: unlike resident file clipping,
                // validate the full requested range before any host command.
                if args[1]
                    .checked_add(args[2])
                    .is_none_or(|end| end > 0x7ffffffff000)
                {
                    return Ok(Step::Return(-14));
                }
                match domain.range(execution.binding(), args[1], args[2]) {
                    Ok(()) => (),
                    Err(lease::Error::Range) => return Ok(Step::Return(-14)),
                    Err(error) => return Err(error.into()),
                }
                if execution.phase() != Phase::Running {
                    return Err(Error::State);
                }
                let snapshot = execution.stamp()?;
                let length = args[2].min(0x7ffff000);
                let hold = files.hold_stream(table, fd, wanted).map_err(Error::Files)?;
                let action = match domain.span(execution.binding(), args[1], length) {
                    Ok(action) => action,
                    Err(error) => {
                        files.release_stream(hold).expect("same admitted owner");
                        return Err(error.into());
                    }
                };
                execution
                    .hold_call(invocation)
                    .expect("validated callback-free admission");
                self.stream = Some(StreamPending {
                    hold,
                    invocation,
                    snapshot,
                    action,
                    started: false,
                });
                return Ok(Step::Stream {
                    action,
                    endpoint,
                    target: args[1],
                    length,
                    write,
                });
            }
        }
        match nr {
            60 => {
                execution.request_exit(invocation, (args[0] & 255) as u32)?;
                Ok(Step::Exit)
            }
            0 => {
                // Current caller checks fd before zero length or target memory.
                let fd = args[0] as u32; // Linux syscall argument uses int fd.
                match files.inode(table, fd) {
                    Ok(_) => {}
                    Err(descriptor::Error::BadFd) => return Ok(Step::Return(-9)),
                    Err(e) => return Err(Error::Files(e)),
                }
                if args[2] == 0 {
                    return Ok(Step::Return(0));
                }
                let at = args[1];
                let requested = args[2];
                const TASK_SIZE: u64 = 0x7ffffffff000;
                if at.checked_add(requested).is_none_or(|end| end > TASK_SIZE) {
                    return Ok(Step::Return(-14));
                }
                let extent = domain.extent(execution.binding())?;
                if at >= extent {
                    return Ok(Step::Return(-14));
                }
                let length = requested.min(extent - at);
                let id = match reads.begin_managed(files, table, domain, execution, fd, at, length)
                {
                    Ok(id) => id,
                    Err(read::Error::Files(descriptor::Error::NotSupported)) => {
                        return Ok(Step::Unsupported(nr))
                    }
                    Err(e) => return Err(e.into()),
                };
                // No host callback or competing owner between admission and hold.
                execution
                    .hold_call(invocation)
                    .expect("validated syscall admission");
                self.pending = Some(Pending {
                    invocation,
                    snapshot: execution.stamp()?,
                    read: id,
                    next,
                    source_failed: false,
                    progress: Progress::Reading,
                });
                Ok(Step::Read { id, target: at })
            }
            _ => Ok(Step::Unsupported(nr)),
        }
    }
    pub(crate) fn owns(&self, token: Token) -> bool {
        self.stream.as_ref().is_some_and(|p| p.action == token)
    }
    pub(crate) fn stream_start(
        &mut self,
        files: &Files,
        domain: &mut Domain,
        execution: &Execution,
        action: Token,
    ) -> Result<(), Error> {
        self.owner(execution)?;
        execution.check_domain(domain)?;
        let p = self.stream.as_mut().ok_or(Error::State)?;
        if p.action != action || p.started {
            return Err(Error::State);
        }
        files.stream(&p.hold).map_err(Error::Files)?;
        execution.check(p.snapshot)?;
        if execution.phase() != Phase::Running {
            return Err(Error::State);
        }
        domain.start(action)?;
        p.started = true;
        Ok(())
    }
    pub(crate) fn stream_receipt(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &mut Execution,
        action: Token,
        count: u64,
        result: PhysicalResult,
    ) -> Result<Step, Error> {
        self.owner(execution)?;
        execution.check_domain(domain)?;
        let p = self.stream.as_ref().ok_or(Error::State)?;
        if p.action != action || !p.started || !execution.owns_snapshot(p.snapshot) {
            return Err(Error::State);
        }
        files.stream(&p.hold).map_err(Error::Files)?;
        if execution.phase() == Phase::Suspended {
            return Err(Error::State);
        }
        if count != 0
            && !matches!(
                result,
                PhysicalResult::Transferred | PhysicalResult::Unknown
            )
        {
            return Err(Error::State);
        }
        let value = match result {
            PhysicalResult::Transferred => i64::try_from(count).map_err(|_| Error::State)?,
            PhysicalResult::Again => -11,
            PhysicalResult::Interrupted => -4,
            PhysicalResult::BadFd => -9,
            PhysicalResult::BrokenPipe => -32,
            PhysicalResult::Io => -5,
            PhysicalResult::Unknown => 0,
        };
        let completion = if result == PhysicalResult::Unknown {
            Completion::Unknown
        } else {
            Completion::Stopped
        };
        domain.receipt(action, count, completion)?;
        if completion == Completion::Unknown {
            return Ok(Step::Waiting);
        }
        domain.retire(action).expect("matching stopped span");
        let p = self.stream.take().unwrap();
        files
            .release_stream(p.hold)
            .expect("validated retained stream");
        execution
            .finish_call(p.invocation)
            .expect("private continuation owns pending call");
        Ok(if execution.phase() == Phase::Running {
            Step::Return(value)
        } else {
            Step::Waiting
        })
    }
    /// Explicit evidence from the trusted source dispatcher, not inferred from
    /// an arbitrary failed read state (which could be identity or cleanup loss).
    pub(crate) fn source_failed(&mut self, execution: &Execution, read: u64) -> Result<(), Error> {
        self.owner(execution)?;
        let p = self.pending.as_mut().ok_or(Error::State)?;
        if p.read != read || p.progress != Progress::Reading {
            return Err(Error::State);
        }
        execution.check(p.snapshot)?;
        p.source_failed = true;
        Ok(())
    }
    pub(crate) fn complete(
        &mut self,
        reads: &mut Reads,
        execution: &mut Execution,
    ) -> Result<Step, Error> {
        self.owner(execution)?;
        let p = self.pending.as_mut().ok_or(Error::State)?;
        execution.check(p.snapshot)?;
        if p.progress != Progress::Reading {
            return Err(Error::State);
        }
        let (confirmed, _, state) = reads.query(p.read)?;
        let result = match state & 255 {
            3 => i64::try_from(confirmed).map_err(|_| Error::State)?,
            7 if p.source_failed => -5,
            4 | 7 => return Err(Error::ReadFailed),
            _ => return Ok(Step::Waiting),
        };
        // Retire may fail when cleanup retained obligations: do not resume then.
        reads.retire(p.read)?;
        if execution.phase() == Phase::Running {
            execution.finish_call(p.invocation)?;
            self.pending = None;
            Ok(Step::Return(result))
        } else if execution.phase() == Phase::Suspended {
            p.progress = Progress::Applying;
            Ok(Step::Resume(Resume {
                next: p.next,
                rax: result,
                rcx: p.next,
            }))
        } else {
            Err(Error::State)
        }
    }
    /// Cancellation is not stopping evidence. The continuation remains owned
    /// while a loader/copy is outstanding, even if the execution already failed.
    pub(crate) fn abandon(
        &mut self,
        files: &mut Files,
        reads: &mut Reads,
        domain: &mut Domain,
        execution: &mut Execution,
    ) -> Result<bool, Error> {
        self.owner(execution)?;
        execution.check_domain(domain)?;
        if let Some(p) = self.stream.as_ref() {
            files.stream(&p.hold).map_err(Error::Files)?;
            domain.cancel(p.action)?;
            if p.started {
                return Ok(false);
            }
            domain.retire(p.action).expect("unstarted cancelled span");
            let p = self.stream.take().unwrap();
            files
                .release_stream(p.hold)
                .expect("validated retained stream");
            execution
                .finish_call(p.invocation)
                .expect("private continuation owns pending call");
            return Ok(true);
        }
        let Some(p) = self.pending.as_ref() else {
            return Ok(true);
        };
        if p.progress != Progress::Reading {
            return Err(Error::State);
        }
        reads.cancel(files, domain, p.read)?;
        match reads.query(p.read)?.2 & 255 {
            3 | 4 | 7 => {
                reads.retire(p.read)?;
                execution.finish_call(p.invocation)?;
                self.pending = None;
                Ok(true)
            }
            _ => Ok(false),
        }
    }
    /// The Resume command is one-shot. Unknown keeps the continuation and blocks
    /// another run; partial globals failure with stopped access fails the image.
    pub(crate) fn resumed(
        &mut self,
        execution: &mut Execution,
        stopped: Completion,
        success: bool,
    ) -> Result<(), Error> {
        self.owner(execution)?;
        let p = self.pending.as_mut().ok_or(Error::State)?;
        execution.check(p.snapshot)?;
        if !matches!(p.progress, Progress::Applying | Progress::Uncertain) {
            return Err(Error::State);
        }
        if stopped == Completion::Unknown {
            p.progress = Progress::Uncertain;
            return Ok(());
        }
        execution.finish_call(p.invocation)?;
        self.pending = None;
        if !success {
            execution.fail_suspended()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    // Prepared-root fixture ownership, not a production metadata default.
    fn root_owned(mode: u32) -> crate::inode::Creation {
        crate::inode::Creation {
            mode,
            uid: 0,
            gid: 0,
        }
    }

    use super::*;
    use crate::execution::{ImageResult, Unwind};
    use crate::inode::Tree;
    use crate::read::ReadCapacity;
    fn setup(
        lazy: bool,
    ) -> (
        Files,
        Table,
        Reads,
        Domain,
        Execution,
        Continuation,
        Invocation,
        u32,
    ) {
        let mut t = Tree::new(1, 4, 4, 32, root_owned(0o755)).unwrap();
        let root = t.root();
        let inode = if lazy {
            t.lazy_file(root, b"a", root_owned(0o644), 7, 1).unwrap()
        } else {
            t.file_take(root, b"a", root_owned(0o644), &mut b"abcd".to_vec())
                .unwrap()
        };
        let mut f = Files::new(
            2,
            t,
            descriptor::Limits {
                contexts: 0,
                tables: 2,
                descriptions: 4,
                slots: 8,
            },
        );
        let table = f.table(8).unwrap();
        let fd = f.open(&table, inode, false).unwrap();
        let r = Reads::new(&f, ReadCapacity::new(4).unwrap());
        let mut d = Domain::new(3, 1, 4).unwrap();
        let b = d.bind(16).unwrap();
        let mut e = Execution::new(4, b);
        e.image_begin(&mut d, 16).unwrap();
        e.image_finish(&mut d, ImageResult::Installed).unwrap();
        let c = Continuation::new(&e).unwrap();
        let i = e.start(&mut d).unwrap();
        (f, table, r, d, e, c, i, fd)
    }
    #[test]
    fn stream_admission_full_range_direction_and_zero() {
        let (mut f, t, mut r, mut d, mut e, mut c, i, _) = setup(false);
        f.let_go(t).unwrap();
        let t = f.stdio([1, 2, 3], 8).unwrap();
        for (nr, args, result) in [
            (1, [0, 0, 1, 0, 0, 0], -9),
            (0, [0, 15, 2, 0, 0, 0], -14),
            (1, [1, u64::MAX, 0, 0, 0, 0], 0),
        ] {
            assert_eq!(
                c.enter(&mut f, &t, &mut r, &mut d, &mut e, i, nr, args, 100)
                    .unwrap(),
                Step::Return(result)
            );
        }
        let Step::Stream {
            action,
            endpoint,
            target,
            length,
            write,
        } = c
            .enter(
                &mut f,
                &t,
                &mut r,
                &mut d,
                &mut e,
                i,
                1,
                [2, 2, 3, 0, 0, 0],
                100,
            )
            .unwrap()
        else {
            panic!()
        };
        assert_eq!((endpoint, target, length, write), (3, 2, 3, true));
        assert!(c.owns(action));
        assert!(c.abandon(&mut f, &mut r, &mut d, &mut e).unwrap());
        assert!(!c.owns(action));
        assert!(c.stream_start(&f, &mut d, &e, action).is_err());
    }
    #[test]
    fn stream_unknown_retains_original_endpoint_after_close_and_worker_stop() {
        let (mut f, t, mut r, mut d, mut e, mut c, i, _) = setup(false);
        f.let_go(t).unwrap();
        let t = f.stdio([1, 2, 3], 8).unwrap();
        let Step::Stream { action, .. } = c
            .enter(
                &mut f,
                &t,
                &mut r,
                &mut d,
                &mut e,
                i,
                0,
                [0, 0, 4, 0, 0, 0],
                100,
            )
            .unwrap()
        else {
            panic!()
        };
        c.stream_start(&f, &mut d, &e, action).unwrap();
        assert!(c.stream_start(&f, &mut d, &e, action).is_err());
        assert!(c
            .stream_receipt(&mut f, &mut d, &mut e, action, 1, PhysicalResult::Io)
            .is_err());
        assert_eq!(
            c.stream_receipt(&mut f, &mut d, &mut e, action, 1, PhysicalResult::Unknown)
                .unwrap(),
            Step::Waiting
        );
        f.close(&t, 0).unwrap();
        assert_eq!(f.dup(&t, 1, 0, false), Ok(0));
        e.receipt(&mut d, i, Unwind::Fault).unwrap();
        assert!(!c.abandon(&mut f, &mut r, &mut d, &mut e).unwrap());
        assert!(d.change(e.binding(), 32).is_err());
        assert_eq!(
            c.stream_receipt(
                &mut f,
                &mut d,
                &mut e,
                action,
                2,
                PhysicalResult::Transferred
            )
            .unwrap(),
            Step::Waiting
        );
        assert!(c.abandon(&mut f, &mut r, &mut d, &mut e).unwrap());
        assert!(c
            .stream_receipt(
                &mut f,
                &mut d,
                &mut e,
                action,
                2,
                PhysicalResult::Transferred
            )
            .is_err());
        assert_eq!(
            f.target(&t, 0),
            Ok(descriptor::Target::HostStream {
                endpoint: 2,
                direction: descriptor::StreamDirection::Write
            })
        );
        assert!(d.change(e.binding(), 32).is_ok());
    }
    #[test]
    fn stream_known_zero_errors_and_short_success_are_rust_results() {
        let (mut f, t, mut r, mut d, mut e, mut c, i, _) = setup(false);
        f.let_go(t).unwrap();
        let t = f.stdio([1, 2, 3], 8).unwrap();
        for (result, n, value) in [
            (PhysicalResult::Again, 0, -11),
            (PhysicalResult::Interrupted, 0, -4),
            (PhysicalResult::BadFd, 0, -9),
            (PhysicalResult::BrokenPipe, 0, -32),
            (PhysicalResult::Io, 0, -5),
            (PhysicalResult::Transferred, 2, 2),
        ] {
            let Step::Stream { action, .. } = c
                .enter(
                    &mut f,
                    &t,
                    &mut r,
                    &mut d,
                    &mut e,
                    i,
                    1,
                    [1, 0, 4, 0, 0, 0],
                    100,
                )
                .unwrap()
            else {
                panic!()
            };
            c.stream_start(&f, &mut d, &e, action).unwrap();
            assert_eq!(
                c.stream_receipt(&mut f, &mut d, &mut e, action, n, result)
                    .unwrap(),
                Step::Return(value)
            );
        }
    }
    #[test]
    fn read_copy_return_exit_needs_matching_unwind() {
        let (mut f, t, mut r, mut d, mut e, mut c, i, fd) = setup(false);
        let Step::Read { id, .. } = c
            .enter(
                &mut f,
                &t,
                &mut r,
                &mut d,
                &mut e,
                i,
                0,
                [fd as u64, 0, 4, 0, 0, 0],
                100,
            )
            .unwrap()
        else {
            panic!()
        };
        assert!(c
            .enter(&mut f, &t, &mut r, &mut d, &mut e, i, 0, [0; 6], 100)
            .is_err());
        let (ptr, len) = r.start_managed(&mut f, &mut d, &e, id).unwrap();
        assert_eq!(
            unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) },
            b"abcd"
        );
        r.receipt(&mut f, &mut d, id, 4, Completion::Stopped)
            .unwrap();
        assert_eq!(c.complete(&mut r, &mut e), Ok(Step::Return(4)));
        assert_eq!(f.offset(&t, fd), Ok((4, 1)));
        assert_eq!(
            c.enter(
                &mut f,
                &t,
                &mut r,
                &mut d,
                &mut e,
                i,
                60,
                [257, 0, 0, 0, 0, 0],
                110
            ),
            Ok(Step::Exit)
        );
        assert_eq!(e.phase(), Phase::Running);
        assert_eq!(d.change(e.binding(), 16), Err(lease::Error::Busy));
        e.receipt(&mut d, i, Unwind::Exit).unwrap();
        assert_eq!(e.status(), Some(1));
    }
    #[test]
    fn asynchronous_lazy_resume_is_one_shot_and_writes_rax_and_rcx() {
        let (mut f, t, mut r, mut d, mut e, mut c, i, fd) = setup(true);
        let Step::Read { id, .. } = c
            .enter(
                &mut f,
                &t,
                &mut r,
                &mut d,
                &mut e,
                i,
                0,
                [fd as u64, 0, 4, 0, 0, 0],
                101,
            )
            .unwrap()
        else {
            panic!()
        };
        let (_, a) = r.load_start(&mut f, &e, id).unwrap();
        e.receipt(&mut d, i, Unwind::Yield(101)).unwrap();
        assert_eq!(e.start(&mut d), Err(execution::Error::State));
        assert!(e.image_begin(&mut d, 16).is_err());
        r.load_finish(&mut f, &mut d, &e, id, a, true, &mut b"abcd".to_vec())
            .unwrap();
        r.start_managed(&mut f, &mut d, &e, id).unwrap();
        r.receipt(&mut f, &mut d, id, 4, Completion::Stopped)
            .unwrap();
        assert_eq!(
            c.complete(&mut r, &mut e),
            Ok(Step::Resume(Resume {
                next: 101,
                rax: 4,
                rcx: 101
            }))
        );
        c.resumed(&mut e, Completion::Unknown, false).unwrap();
        assert!(c.complete(&mut r, &mut e).is_err());
        assert!(e.start(&mut d).is_err());
        c.resumed(&mut e, Completion::Stopped, true).unwrap();
        assert!(c.resumed(&mut e, Completion::Stopped, true).is_err());
        assert!(e.start(&mut d).is_ok());
    }
    #[test]
    fn fd_zero_range_and_unknown_syscall_are_rust_decisions() {
        let (mut f, t, mut r, mut d, mut e, mut c, i, fd) = setup(false);
        assert_eq!(
            c.enter(
                &mut f,
                &t,
                &mut r,
                &mut d,
                &mut e,
                i,
                0,
                [999, u64::MAX, 0, 0, 0, 0],
                1
            ),
            Ok(Step::Return(-9))
        );
        assert_eq!(
            c.enter(
                &mut f,
                &t,
                &mut r,
                &mut d,
                &mut e,
                i,
                0,
                [fd as u64, u64::MAX, 0, 0, 0, 0],
                1
            ),
            Ok(Step::Return(0))
        );
        assert_eq!(
            c.enter(
                &mut f,
                &t,
                &mut r,
                &mut d,
                &mut e,
                i,
                0,
                [fd as u64, 16, 1, 0, 0, 0],
                1
            ),
            Ok(Step::Return(-14))
        );
        assert_eq!(
            c.enter(&mut f, &t, &mut r, &mut d, &mut e, i, 999, [0; 6], 1),
            Ok(Step::Unsupported(999))
        );
        let Step::Read { id, .. } = c
            .enter(
                &mut f,
                &t,
                &mut r,
                &mut d,
                &mut e,
                i,
                0,
                [fd as u64, 14, 4, 0, 0, 0],
                1,
            )
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(r.query(id).unwrap().1, 2);
        assert!(c.abandon(&mut f, &mut r, &mut d, &mut e).unwrap());
    }
    #[test]
    fn source_failure_evidence_and_unknown_copy_are_not_interchangeable() {
        let (mut f, t, mut r, mut d, mut e, mut c, i, fd) = setup(true);
        let Step::Read { id, .. } = c
            .enter(
                &mut f,
                &t,
                &mut r,
                &mut d,
                &mut e,
                i,
                0,
                [fd as u64, 0, 4, 0, 0, 0],
                1,
            )
            .unwrap()
        else {
            panic!()
        };
        let (_, a) = r.load_start(&mut f, &e, id).unwrap();
        c.source_failed(&e, id).unwrap();
        r.load_finish(&mut f, &mut d, &e, id, a, false, &mut Vec::new())
            .unwrap();
        assert_eq!(c.complete(&mut r, &mut e), Ok(Step::Return(-5)));
        let Step::Read { id, .. } = c
            .enter(
                &mut f,
                &t,
                &mut r,
                &mut d,
                &mut e,
                i,
                0,
                [fd as u64, 0, 4, 0, 0, 0],
                1,
            )
            .unwrap()
        else {
            panic!()
        };
        let (_, a) = r.load_start(&mut f, &e, id).unwrap();
        r.load_finish(&mut f, &mut d, &e, id, a, true, &mut b"abcd".to_vec())
            .unwrap();
        r.start_managed(&mut f, &mut d, &e, id).unwrap();
        r.receipt(&mut f, &mut d, id, 2, Completion::Unknown)
            .unwrap();
        assert_eq!(c.complete(&mut r, &mut e), Ok(Step::Waiting));
        assert!(!c.abandon(&mut f, &mut r, &mut d, &mut e).unwrap());
        r.receipt(&mut f, &mut d, id, 2, Completion::Stopped)
            .unwrap();
        assert_eq!(c.complete(&mut r, &mut e), Ok(Step::Return(2)));
    }
}
