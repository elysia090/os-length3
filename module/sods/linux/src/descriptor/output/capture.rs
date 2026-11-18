//! Exact native captured-write handoff. No raw ABI view or external sink.
use super::{
    Error as OutputError, Files, FilesError, Filled, LaneRegistry, OutputHold, RegistryId, Table,
    Unfilled, WriteStage,
};
use crate::effect::{Completion, Token};
use crate::execution::{self, Execution, Invocation, Snapshot};
use crate::lease::{self, Domain};
use std::marker::PhantomData;
use std::num::NonZeroUsize;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Error {
    Identity,
    State,
    Length,
    Incomplete,
    Files(FilesError),
    Output(OutputError),
    Execution(execution::Error),
    Lease(lease::Error),
}
impl From<FilesError> for Error {
    fn from(error: FilesError) -> Self {
        Self::Files(error)
    }
}
impl From<OutputError> for Error {
    fn from(error: OutputError) -> Self {
        Self::Output(error)
    }
}
impl From<execution::Error> for Error {
    fn from(error: execution::Error) -> Self {
        Self::Execution(error)
    }
}
impl From<lease::Error> for Error {
    fn from(error: lease::Error) -> Self {
        Self::Lease(error)
    }
}

pub(crate) struct Context<'a> {
    pub(super) files: &'a mut Files,
    pub(super) lanes: &'a mut LaneRegistry,
    pub(super) domain: &'a mut Domain,
    pub(super) execution: &'a mut Execution,
}
impl Context<'_> {
    pub(crate) fn admission_owners(&self) -> (&Domain, &Execution) {
        (self.domain, self.execution)
    }
}
pub(crate) struct Request {
    pub(crate) invocation: Invocation,
    pub(crate) sequence: u32,
    pub(crate) fd: u32,
    pub(crate) at: u64,
    pub(crate) length: NonZeroUsize,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CallId {
    pub(crate) sequence: u32,
    pub(crate) action: Token,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Access {
    /// Neither source nor staging access may be assumed to have ended.
    Unknown,
    SourceEnded,
    StageEnded,
    /// The trusted caller ended both accesses; not an external sink receipt.
    BothEnded,
}
pub(crate) struct Receipt {
    /// None offers no complete input. Even an exact count is not completion
    /// without the native fill witness and independently ended access.
    pub(crate) complete: Option<usize>,
    pub(crate) access: Access,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Finished {
    Waiting,
    Discarded,
    Accepted(NonZeroUsize),
    /// Exact ended evidence was settled; acceptance was refused. Never retry
    /// this receipt, or mistake it for an invalid/unconsumed receipt.
    Rejected(OutputError),
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Ready,
    Started,
    Unknown,
    Terminal,
}

/// One initialized provisional buffer and the admitted guest base. Native
/// callers can fill it once but cannot use mere view drop to prove a copy.
pub(super) struct CopyGuard<'a> {
    pub(crate) at: u64,
    bytes: &'a mut [u8],
    filled: &'a mut bool,
}
impl CopyGuard<'_> {
    pub(super) fn copy_from_exact(self, input: &[u8]) -> Result<(), Error> {
        if input.len() != self.bytes.len() {
            return Err(Error::Length);
        }
        self.bytes.copy_from_slice(input);
        *self.filled = true;
        Ok(())
    }
}

/// The transport owns the captured sequence; this call owns its only span,
/// retained OFD and Q/K stage until exact release or acceptance.
#[must_use = "retain through acceptance or stopped cleanup"]
pub(crate) struct WriteCall {
    id: CallId,
    invocation: Invocation,
    execution: Snapshot,
    registry: RegistryId,
    at: u64,
    length: NonZeroUsize,
    destination: Option<OutputHold>,
    stage: Option<WriteStage<Unfilled>>,
    phase: Phase,
    filled: bool,
    cancelled: bool,
}
impl WriteCall {
    /// The parent must already have admitted this exact Worker sequence.
    /// Everything below is a single native turn with no callbacks.
    pub(crate) fn admit(ctx: &mut Context<'_>, table: &Table, req: Request) -> Result<Self, Error> {
        if req.sequence == 0 || req.sequence > i32::MAX as u32 {
            return Err(Error::Identity);
        }
        ctx.execution.check_domain(ctx.domain)?;
        ctx.execution.syscall_allowed(req.invocation)?;
        let execution = ctx.execution.stamp()?;
        let destination = ctx.files.hold_output(table, req.fd)?;
        let action = match ctx
            .domain
            .span(ctx.execution.binding(), req.at, req.length.get() as u64)
        {
            Ok(action) => action,
            Err(error) => {
                ctx.files
                    .release_output(destination)
                    .expect("new exact OFD hold");
                return Err(error.into());
            }
        };
        let stage = ctx
            .lanes
            .held_writer(ctx.files, &destination)
            .and_then(|mut writer| writer.stage_write(req.length));
        let stage = match stage {
            Ok(stage) => stage,
            Err(error) => {
                ctx.domain.cancel(action).expect("new ready span");
                ctx.domain.retire(action).expect("no host attempt");
                ctx.files
                    .release_output(destination)
                    .expect("new exact OFD hold");
                return Err(error.into());
            }
        };
        ctx.execution
            .hold_call(req.invocation)
            .expect("checked same turn");
        Ok(Self {
            id: CallId {
                sequence: req.sequence,
                action,
            },
            invocation: req.invocation,
            execution,
            registry: ctx.lanes.id,
            at: req.at,
            length: req.length,
            destination: Some(destination),
            stage: Some(stage),
            phase: Phase::Ready,
            filled: false,
            cancelled: false,
        })
    }
    pub(crate) fn id(&self) -> CallId {
        self.id
    }
    fn check(&self, domain: &Domain, execution: &Execution, id: CallId) -> Result<(), Error> {
        if id != self.id || !execution.retains_snapshot(self.execution) {
            return Err(Error::Identity);
        }
        execution.check_domain(domain)?;
        Ok(())
    }
    fn check_owner(&self, ctx: &Context<'_>, id: CallId) -> Result<(), Error> {
        self.check(ctx.domain, ctx.execution, id)?;
        if ctx.lanes.id != self.registry || ctx.files.owner() != self.registry.files {
            return Err(Error::Identity);
        }
        Ok(())
    }
    pub(super) fn start<'a>(
        &'a mut self,
        ctx: Context<'a>,
        id: CallId,
    ) -> Result<CopyGuard<'a>, Error> {
        self.check_owner(&ctx, id)?;
        if self.phase != Phase::Ready {
            return Err(Error::State);
        }
        ctx.execution.check_held_call_live(self.invocation)?;
        let stage = self.stage.as_mut().expect("ready stage");
        let writer = ctx
            .lanes
            .held_writer(ctx.files, self.destination.as_ref().expect("ready hold"))?;
        writer
            .queue
            .copy_length(&stage.reservation, self.length.get())?;
        ctx.domain.start(id.action)?;
        self.phase = Phase::Started;
        Ok(CopyGuard {
            at: self.at,
            bytes: &mut stage.bytes,
            filled: &mut self.filled,
        })
    }
    #[cfg(test)]
    pub(crate) fn fill_native(
        &mut self,
        ctx: Context<'_>,
        id: CallId,
        input: &[u8],
    ) -> Result<u64, Error> {
        let guard = self.start(ctx, id)?;
        let at = guard.at;
        guard.copy_from_exact(input)?;
        Ok(at)
    }

    #[cfg(test)]
    pub(crate) fn finish(
        &mut self,
        ctx: &mut Context<'_>,
        id: CallId,
        receipt: Receipt,
    ) -> Result<Finished, Error> {
        self.settle(ctx, id, receipt, false)
    }
    #[cfg(all(target_arch = "wasm32", feature = "queued-worker-probe"))]
    pub(crate) fn raw_start(
        &mut self,
        ctx: Context<'_>,
        id: CallId,
    ) -> Result<(usize, u64, usize), Error> {
        let guard = self.start(ctx, id)?;
        Ok((
            guard.bytes.as_mut_ptr() as usize,
            guard.at,
            guard.bytes.len(),
        ))
    }
    #[cfg(all(target_arch = "wasm32", feature = "queued-worker-probe"))]
    pub(crate) fn raw_finish(
        &mut self,
        ctx: &mut Context<'_>,
        id: CallId,
        trusted: crate::wasm::FinishEvidence,
    ) -> Result<Finished, Error> {
        self.settle(ctx, id, trusted.receipt(), true)
    }
    fn settle(
        &mut self,
        ctx: &mut Context<'_>,
        id: CallId,
        receipt: Receipt,
        trusted_raw: bool,
    ) -> Result<Finished, Error> {
        self.check_owner(ctx, id)?;
        if !matches!(self.phase, Phase::Started | Phase::Unknown) {
            return Err(Error::State);
        }
        if receipt.complete.is_some_and(|n| n != self.length.get()) {
            return Err(Error::Length);
        }
        if receipt.access != Access::BothEnded {
            // Domain progress here is complete eligible input, not a guessed
            // partial read count or output. Neither partial access evidence
            // nor a full count ends the two-ended handoff.
            ctx.domain.receipt(id.action, 0, Completion::Unknown)?;
            self.phase = Phase::Unknown;
            return Ok(Finished::Waiting);
        }
        let complete = receipt.complete.is_some();
        if complete && !self.filled && !trusted_raw {
            return Err(Error::Incomplete);
        }
        let accept = complete
            && self.phase == Phase::Started
            && !self.cancelled
            && ctx.execution.check_held_call_live(self.invocation).is_ok();
        let mut writer = ctx
            .lanes
            .held_writer(ctx.files, self.destination.as_ref().expect("started hold"))?;
        let confirmed = if complete {
            self.length.get() as u64
        } else {
            0
        };
        ctx.domain
            .receipt(id.action, confirmed, Completion::Stopped)?;
        ctx.domain.retire(id.action).expect("matching stopped copy");
        let stage = self.stage.take().expect("started stage");
        let finished = if accept {
            let filled: WriteStage<Filled> = WriteStage {
                reservation: stage.reservation,
                bytes: stage.bytes,
                state: PhantomData,
            };
            match writer.publish_staged(filled) {
                Ok(length) => Finished::Accepted(length),
                Err((error, filled)) => {
                    writer.cancel_staged(filled).expect("same held reservation");
                    Finished::Rejected(error)
                }
            }
        } else {
            writer.cancel_staged(stage).expect("same held reservation");
            Finished::Discarded
        };
        self.release_owner(ctx);
        Ok(finished)
    }
    pub(crate) fn cancel(&mut self, ctx: &mut Context<'_>, id: CallId) -> Result<bool, Error> {
        self.check_owner(ctx, id)?;
        match self.phase {
            Phase::Terminal => return Ok(true),
            Phase::Started | Phase::Unknown => {
                ctx.domain.cancel(id.action)?;
                self.cancelled = true;
                return Ok(false);
            }
            Phase::Ready => {}
        }
        let mut writer = ctx
            .lanes
            .held_writer(ctx.files, self.destination.as_ref().expect("ready hold"))?;
        ctx.domain.cancel(id.action)?;
        ctx.domain.retire(id.action).expect("never dispatched");
        writer
            .cancel_staged(self.stage.take().expect("ready stage"))
            .expect("same held reservation");
        self.release_owner(ctx);
        Ok(true)
    }
    fn release_owner(&mut self, ctx: &mut Context<'_>) {
        ctx.files
            .release_output(self.destination.take().expect("matching output"))
            .expect("same retained OFD");
        ctx.execution
            .finish_call(self.invocation)
            .expect("same retained call");
        self.phase = Phase::Terminal;
    }
}
#[cfg(test)]
mod tests {
    use super::super::{
        tests::{files, n},
        Consumer, Limits, Root,
    };
    use super::*;
    use crate::execution::{ImageResult, Unwind};

    struct Guest {
        root: Root,
        table: Table,
        source: crate::inode::Inode,
        receiver: Consumer,
        domain: Domain,
        execution: Execution,
        invocation: Invocation,
    }
    impl Guest {
        fn new() -> Self {
            let (mut files, _, source, old, _) = files(502);
            files.let_go(old).unwrap();
            let mut root = Root::new(files, 1).ok().unwrap();
            let (producer, receiver) = root
                .destination(Limits {
                    bytes: 2,
                    entries: 1,
                    pins: 0,
                })
                .unwrap();
            let table = root.queued_stdio(1, [&producer, &producer], 8).unwrap();
            let mut domain = Domain::new(505, 1, 4).unwrap();
            let mut execution = Execution::new(1, domain.bind(16).unwrap());
            execution.image_begin(&mut domain, 16).unwrap();
            execution
                .image_finish(&mut domain, ImageResult::Installed)
                .unwrap();
            let invocation = execution.start(&mut domain).unwrap();
            Self {
                root,
                table,
                source,
                receiver,
                domain,
                execution,
                invocation,
            }
        }
        fn admit(&mut self, sequence: u32, at: u64) -> Result<WriteCall, Error> {
            WriteCall::admit(
                &mut Context {
                    files: &mut self.root.files,
                    lanes: &mut self.root.registry,
                    domain: &mut self.domain,
                    execution: &mut self.execution,
                },
                &self.table,
                Request {
                    invocation: self.invocation,
                    sequence,
                    fd: 1,
                    at,
                    length: n(2),
                },
            )
        }
        fn context(&mut self) -> Context<'_> {
            Context {
                files: &mut self.root.files,
                lanes: &mut self.root.registry,
                domain: &mut self.domain,
                execution: &mut self.execution,
            }
        }
        fn front(&mut self) -> Option<Vec<u8>> {
            self.root
                .reader(&self.receiver)
                .unwrap()
                .front_bytes()
                .unwrap()
                .map(<[u8]>::to_vec)
        }
        fn fill(&mut self, call: &mut WriteCall, id: CallId, bytes: &[u8]) {
            let offered = call.start(self.context(), id).unwrap();
            assert_eq!(offered.at, 5);
            offered.copy_from_exact(bytes).unwrap();
        }
    }
    const fn receipt(complete: Option<usize>, access: Access) -> Receipt {
        Receipt { complete, access }
    }

    #[test]
    fn output_slot_switches_arms_only_after_exact_ownership_retires() {
        use crate::read::{ReadCapacity, Reads};
        use crate::syscall::{Continuation, Step};
        let mut g = Guest::new();
        let mut c = Continuation::new(&g.execution).unwrap();
        let ordinary = g.root.files.stdio([1, 20, 30], 8).unwrap();
        let source = g.root.files.open(&ordinary, g.source, false).unwrap();
        let invocation = g.invocation;
        let mut reads = Reads::new(&g.root.files, ReadCapacity::new(1).unwrap());
        let ctx = Context {
            files: &mut g.root.files,
            lanes: &mut g.root.registry,
            domain: &mut g.domain,
            execution: &mut g.execution,
        };
        let Step::CaptureWrite { call, .. } = c
            .admit_capture_write(
                ctx,
                &g.table,
                Request {
                    invocation,
                    sequence: 1,
                    fd: 1,
                    at: 5,
                    length: n(2),
                },
            )
            .unwrap()
        else {
            panic!()
        };
        assert!(c.has_byte_output());
        assert_eq!(c.sendfile_query(&g.execution), Ok(None));
        assert!(c
            .sendfile_cap_start(
                &mut g.root.files,
                &mut g.domain,
                &mut g.execution,
                1,
                call.action
            )
            .is_err());
        assert!(c.owns(call.action));
        assert!(c
            .enter_sequenced(
                &mut g.root.files,
                &ordinary,
                None,
                &mut reads,
                &mut g.domain,
                &mut g.execution,
                invocation,
                2,
                40,
                [1, source.into(), 0, 2, 0, 0],
                16
            )
            .is_err());
        c.fill_native_capture(g.context(), call, b"AB").unwrap();
        assert_eq!(
            c.finish_native_capture(&mut g.context(), call, receipt(Some(2), Access::BothEnded)),
            Ok(Finished::Accepted(n(2)))
        );
        assert!(!c.has_byte_output());

        let Step::SendfileCapability {
            action,
            sequence: 2,
            endpoint: 20,
        } = c
            .enter_sequenced(
                &mut g.root.files,
                &ordinary,
                None,
                &mut reads,
                &mut g.domain,
                &mut g.execution,
                invocation,
                2,
                40,
                [1, source.into(), 0, 2, 0, 0],
                16,
            )
            .unwrap()
        else {
            panic!()
        };
        assert!(c.has_byte_output());
        assert_eq!(
            c.sendfile_cap_start(
                &mut g.root.files,
                &mut g.domain,
                &mut g.execution,
                2,
                action
            ),
            Ok(20)
        );
        let same_scalars = CallId {
            sequence: 2,
            action,
        };
        assert!(c.cancel_capture(&mut g.context(), same_scalars).is_err());
        assert!(c
            .finish_native_capture(&mut g.context(), call, receipt(Some(2), Access::BothEnded))
            .is_err());
        assert!(!c
            .abandon(
                &mut g.root.files,
                &mut reads,
                &mut g.domain,
                &mut g.execution
            )
            .unwrap());
        assert!(
            c.has_byte_output() && c.owns(action),
            "abandon did not destroy the in-flight capability ticket"
        );
        assert!(c
            .sendfile_cap_finish_rejected(
                &mut g.root.files,
                &mut g.domain,
                &mut g.execution,
                2,
                action,
                21
            )
            .is_err());
        assert!(c.owns(action));
        assert!(c
            .sendfile_cap_finish_rejected(
                &mut g.root.files,
                &mut g.domain,
                &mut g.execution,
                2,
                action,
                20
            )
            .is_ok());
        assert!(!c.has_byte_output() && !c.owns(action));
        assert_eq!(g.root.files.offset(&ordinary, source), Ok((0, 0)));
        assert_eq!(g.front().as_deref(), Some(&b"AB"[..]));
    }

    #[test]
    fn continuation_owns_the_exact_write_and_cancels_without_a_stale_return() {
        use crate::syscall::{Continuation, Step};
        let mut g = Guest::new();
        let mut continuation = Continuation::new(&g.execution).unwrap();
        let request = |invocation, sequence, at| Request {
            invocation,
            sequence,
            fd: 1,
            at,
            length: n(2),
        };
        let invocation = g.invocation;
        // A fully admitted sequence with invalid physical range is not reusable.
        for at in [15, 5] {
            let ctx = Context {
                files: &mut g.root.files,
                lanes: &mut g.root.registry,
                domain: &mut g.domain,
                execution: &mut g.execution,
            };
            assert!(continuation
                .admit_capture_write(ctx, &g.table, request(invocation, 1, at))
                .is_err());
        }
        let ctx = Context {
            files: &mut g.root.files,
            lanes: &mut g.root.registry,
            domain: &mut g.domain,
            execution: &mut g.execution,
        };
        let Step::CaptureWrite {
            call,
            at: 5,
            length: 2,
        } = continuation
            .admit_capture_write(ctx, &g.table, request(invocation, 2, 5))
            .unwrap()
        else {
            panic!()
        };
        assert!(continuation.owns(call.action));
        let stale = CallId {
            sequence: 1,
            ..call
        };
        assert!(continuation
            .fill_native_capture(g.context(), stale, b"AB")
            .is_err());
        assert!(continuation
            .admit_request(&g.domain, &g.execution, invocation, Some(3))
            .is_err());
        assert_eq!(
            continuation
                .fill_native_capture(g.context(), call, b"AB")
                .unwrap(),
            5
        );
        assert!(
            !continuation.cancel_capture(&mut g.context(), call).unwrap(),
            "cancel is not ended access"
        );
        assert_eq!(
            continuation
                .finish_native_capture(&mut g.context(), call, receipt(Some(2), Access::Unknown))
                .unwrap(),
            Finished::Waiting
        );
        assert!(continuation.owns(call.action));
        assert_eq!(
            continuation
                .finish_native_capture(&mut g.context(), call, receipt(Some(2), Access::BothEnded))
                .unwrap(),
            Finished::Discarded
        );
        assert!(!continuation.owns(call.action));
        assert_eq!(g.front(), None);
        assert!(continuation
            .finish_native_capture(&mut g.context(), call, receipt(Some(2), Access::BothEnded))
            .is_err());
        assert!(continuation
            .admit_request(&g.domain, &g.execution, invocation, Some(3))
            .is_err());
    }

    #[test]
    fn handoff_matches_exact_sequence_action_and_execution_and_keeps_the_original_ofd() {
        let mut g = Guest::new();
        let mut call = g.admit(7, 5).unwrap();
        let id = call.id();
        let bad_seq = CallId { sequence: 8, ..id };
        let bad_token = CallId {
            action: Token::from_parts(g.domain.id(), id.action.sequence() + 1),
            ..id
        };
        let mut foreign_execution = Execution::new(2, g.execution.binding());
        assert_eq!(
            call.finish(&mut g.context(), id, receipt(Some(2), Access::BothEnded)),
            Err(Error::State)
        );
        for rejected in [bad_seq, bad_token] {
            assert!(matches!(
                call.start(g.context(), rejected),
                Err(Error::Identity)
            ));
        }
        assert!(matches!(
            call.start(
                Context {
                    execution: &mut foreign_execution,
                    ..g.context()
                },
                id
            ),
            Err(Error::Identity)
        ));
        g.root.files.close(&g.table, 1).unwrap();
        assert_eq!(g.root.files.dup(&g.table, 0, 1, false), Ok(1));
        let offered = call.start(g.context(), id).unwrap();
        assert_eq!((offered.at, offered.bytes.as_ref()), (5, &b"\0\0"[..]));
        let address = offered.bytes.as_ptr();
        offered.copy_from_exact(b"AB").unwrap();
        assert_eq!(g.front(), None);
        assert!(matches!(call.start(g.context(), id), Err(Error::State)));
        assert_eq!(
            call.finish(
                &mut g.context(),
                bad_token,
                receipt(Some(2), Access::BothEnded)
            ),
            Err(Error::Identity)
        );
        assert_eq!(
            call.finish(&mut g.context(), id, receipt(Some(1), Access::BothEnded)),
            Err(Error::Length)
        );
        assert_eq!(
            call.finish(&mut g.context(), id, receipt(Some(3), Access::BothEnded)),
            Err(Error::Length)
        );
        assert_eq!(g.front(), None);
        assert_eq!(
            call.finish(&mut g.context(), id, receipt(Some(2), Access::BothEnded)),
            Ok(Finished::Accepted(n(2)))
        );
        assert_eq!(
            g.root
                .reader(&g.receiver)
                .unwrap()
                .front_bytes()
                .unwrap()
                .unwrap()
                .as_ptr(),
            address
        );
        assert_eq!(
            call.finish(&mut g.context(), id, receipt(Some(2), Access::BothEnded)),
            Err(Error::State)
        );
        g.execution.request_exit(g.invocation, 0).unwrap();
        g.execution
            .receipt(&mut g.domain, g.invocation, Unwind::Exit)
            .unwrap();
        assert!(g.execution.retireable());
        assert_eq!(g.front(), Some(b"AB".to_vec()));
    }

    #[test]
    fn full_count_with_unknown_access_and_producer_exit_retains_until_exact_late_stop() {
        let mut g = Guest::new();
        let mut call = g.admit(7, 5).unwrap();
        let id = call.id();
        g.fill(&mut call, id, b"AB");
        assert_eq!(
            call.finish(&mut g.context(), id, receipt(Some(2), Access::Unknown)),
            Ok(Finished::Waiting)
        );
        assert_eq!(call.cancel(&mut g.context(), id), Ok(false));
        assert_eq!(call.cancel(&mut g.context(), id), Ok(false));
        g.execution
            .receipt(&mut g.domain, g.invocation, Unwind::Fault)
            .unwrap();
        assert!(!g.execution.retireable());
        assert_eq!(
            g.domain.change(g.execution.binding(), 32),
            Err(lease::Error::Busy)
        );
        assert!(matches!(call.start(g.context(), id), Err(Error::State)));
        assert_eq!(g.front(), None);
        let mut wrong = LaneRegistry::new(&mut g.root.files, 1).unwrap();
        let mut context = Context {
            files: &mut g.root.files,
            lanes: &mut wrong,
            domain: &mut g.domain,
            execution: &mut g.execution,
        };
        assert_eq!(
            call.finish(&mut context, id, receipt(None, Access::BothEnded)),
            Err(Error::Identity)
        );
        assert_eq!(
            call.finish(
                &mut g.context(),
                CallId { sequence: 8, ..id },
                receipt(None, Access::BothEnded)
            ),
            Err(Error::Identity)
        );
        for one_side in [Access::SourceEnded, Access::StageEnded] {
            assert_eq!(
                call.finish(&mut g.context(), id, receipt(Some(2), one_side)),
                Ok(Finished::Waiting),
            );
            assert!(!g.execution.retireable());
        }
        assert!(!g.execution.retireable());
        // Ended access is enough to discard unpublished bytes; it doesn't say anything was accepted.
        assert_eq!(
            call.finish(&mut g.context(), id, receipt(None, Access::BothEnded)),
            Ok(Finished::Discarded)
        );
        assert!(g.execution.retireable());
        assert_eq!(g.front(), None);
        let change = g.domain.change(g.execution.binding(), 32).unwrap();
        g.domain.cancel(change).unwrap();
        g.domain.retire(change).unwrap();
    }

    #[test]
    fn loss_before_first_copy_or_before_acceptance_does_not_publish() {
        for copied in [false, true] {
            let mut g = Guest::new();
            assert!(matches!(g.admit(0, 5), Err(Error::Identity)));
            assert!(matches!(
                g.admit(7, 15),
                Err(Error::Lease(lease::Error::Range))
            ));
            let mut call = g.admit(7, 5).unwrap();
            let id = call.id();
            if copied {
                g.fill(&mut call, id, b"AB");
            }
            g.execution.request_exit(g.invocation, 0).unwrap();
            if copied {
                assert_eq!(
                    call.finish(&mut g.context(), id, receipt(Some(2), Access::BothEnded)),
                    Ok(Finished::Discarded)
                );
            } else {
                assert!(matches!(
                    call.start(g.context(), id),
                    Err(Error::Execution(execution::Error::State))
                ));
                assert_eq!(call.cancel(&mut g.context(), id), Ok(true));
            }
            g.execution
                .receipt(&mut g.domain, g.invocation, Unwind::Exit)
                .unwrap();
            assert!(g.execution.retireable());
            assert_eq!(g.front(), None);
        }
    }

    #[test]
    fn unstarted_pressure_rolls_back_and_staged_send_cannot_reuse_an_earlier_call() {
        let mut g = Guest::new();
        let held = g.root.files.hold_output(&g.table, 1).unwrap();
        let mut writer = g.root.held_writer(&held).unwrap();
        let first = writer.reserve(n(2)).unwrap();
        writer.publish_copy(first, b"AB").unwrap();
        g.root.files.release_output(held).unwrap();
        assert!(matches!(
            g.admit(6, 5),
            Err(Error::Output(OutputError::Full))
        ));
        assert!(g.execution.syscall_allowed(g.invocation).is_ok());
        assert!(g.root.reader(&g.receiver).unwrap().discard_front());
        let mut a = g.admit(7, 5).unwrap();
        let stale = a.id();
        assert_eq!(a.cancel(&mut g.context(), stale), Ok(true));
        let mut b = g.admit(8, 5).unwrap();
        let id = b.id();
        assert!(matches!(b.start(g.context(), stale), Err(Error::Identity)));
        // Closing admission while a stage exists denies acceptance, but the exact
        // stopped access still releases it without touching unrelated records.
        g.fill(&mut b, id, b"AB");
        let held = g.root.files.hold_output(&g.table, 1).unwrap();
        g.root.held_writer(&held).unwrap().close_admission();
        g.root.files.release_output(held).unwrap();
        assert_eq!(
            b.finish(&mut g.context(), id, receipt(Some(2), Access::BothEnded)),
            Ok(Finished::Rejected(OutputError::Closed))
        );
        assert!(g.execution.syscall_allowed(g.invocation).is_ok());
        assert!(matches!(
            g.admit(9, 5),
            Err(Error::Output(OutputError::Closed))
        ));
        assert!(g.execution.syscall_allowed(g.invocation).is_ok());
        assert_eq!(g.front(), None);
    }

    #[test]
    fn closed_destination_prevents_first_copy_and_still_allows_unstarted_cleanup() {
        let mut g = Guest::new();
        let mut call = g.admit(7, 5).unwrap();
        let id = call.id();
        let held = g.root.files.hold_output(&g.table, 1).unwrap();
        g.root.held_writer(&held).unwrap().close_admission();
        g.root.files.release_output(held).unwrap();
        assert!(matches!(
            call.start(g.context(), id),
            Err(Error::Output(OutputError::Closed))
        ));
        assert_eq!(call.cancel(&mut g.context(), id), Ok(true));
        assert!(g.execution.syscall_allowed(g.invocation).is_ok());
        assert_eq!(g.front(), None);
    }

    #[test]
    fn initialized_or_short_input_cannot_be_adopted_on_a_full_count_claim() {
        let mut g = Guest::new();
        let mut call = g.admit(7, 5).unwrap();
        let id = call.id();
        let offered = call.start(g.context(), id).unwrap();
        assert_eq!(offered.copy_from_exact(b"A"), Err(Error::Length));
        assert_eq!(
            call.finish(&mut g.context(), id, receipt(Some(2), Access::BothEnded)),
            Err(Error::Incomplete)
        );
        assert_eq!(g.front(), None);
        assert_eq!(
            call.finish(&mut g.context(), id, receipt(None, Access::BothEnded)),
            Ok(Finished::Discarded)
        );
        assert!(g.execution.syscall_allowed(g.invocation).is_ok());
        assert_eq!(g.front(), None);
    }

    #[test]
    fn cancellation_after_dispatch_cannot_reclaim_before_both_accesses_end() {
        let mut g = Guest::new();
        let mut call = g.admit(7, 5).unwrap();
        let id = call.id();
        g.fill(&mut call, id, b"AB");
        assert_eq!(call.cancel(&mut g.context(), id), Ok(false));
        assert!(g.execution.syscall_allowed(g.invocation).is_err());
        assert!(g.domain.retire(id.action).is_err());
        assert_eq!(
            call.finish(&mut g.context(), id, receipt(Some(2), Access::BothEnded)),
            Ok(Finished::Discarded),
        );
        assert_eq!(g.front(), None);
        let mut fresh = g.admit(8, 5).unwrap();
        let next = fresh.id();
        assert_eq!(fresh.cancel(&mut g.context(), next), Ok(true));
    }

    #[test]
    fn even_a_live_worker_cannot_resume_acceptance_after_access_became_uncertain() {
        let mut g = Guest::new();
        let mut call = g.admit(7, 5).unwrap();
        let id = call.id();
        g.fill(&mut call, id, b"AB");
        for partial in [Access::SourceEnded, Access::StageEnded] {
            assert_eq!(
                call.finish(&mut g.context(), id, receipt(Some(2), partial)),
                Ok(Finished::Waiting),
            );
        }
        g.execution.check_held_call_live(g.invocation).unwrap();
        assert_eq!(
            call.finish(&mut g.context(), id, receipt(Some(2), Access::BothEnded),),
            Ok(Finished::Discarded),
        );
        assert_eq!(g.front(), None);
        assert!(g.execution.syscall_allowed(g.invocation).is_ok());
    }
}
