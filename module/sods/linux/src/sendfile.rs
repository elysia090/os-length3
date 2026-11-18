//! One finite, private sendfile(40) owner retained by the ABI7 continuation.
//!
//! Selected scope: NULL offset, readonly regular input OFD to an exact held
//! HostStream Write description. One non-byte Domain action is reserved before
//! either external service. No guest span, scratch buffer or FD rediscovery.
//! Production capability acceptance is absent; only negative host admission is
//! connected. Combined private receipts carry trusted lexical-access evidence;
//! independent opaque end certificates and accepted caps are test/probe-only.
//! Unit-test synthetic receipts prove ownership only, not Linux/Node capability.
use crate::descriptor::{self, Files, LoadRequest, ReadHold, ReadPreparation, StreamHold, Table};
use crate::effect::{Completion, Token};
use crate::execution::{self, Execution, Invocation, Snapshot};
use crate::lease::{self, Domain};

pub(crate) const MAX_RW_COUNT: u64 = 0x7fff_f000;
pub(crate) const SYSCALL_NUMBER: u64 = 40;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Error {
    State,
    Range,
    Unsupported40,
    Files(descriptor::Error),
    Execution(execution::Error),
    Lease(lease::Error),
}
impl From<descriptor::Error> for Error {
    fn from(e: descriptor::Error) -> Self {
        Self::Files(e)
    }
}
impl From<execution::Error> for Error {
    fn from(e: execution::Error) -> Self {
        Self::Execution(e)
    }
}
impl From<lease::Error> for Error {
    fn from(e: lease::Error) -> Self {
        Self::Lease(e)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Phase {
    Idle,
    CapReady,
    CapChecking,
    LoadingReady,
    Loading,
    OfferReady,
    Started,
    Unknown,
    Closing,
    Terminal,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ResultValue {
    /// Pre-dispatch typed begin error was completely rolled back. The parent
    /// maps the returned Error to its guest errno/unsupported policy; this is
    /// not a transport failure and supplies no successful syscall value.
    AdmissionFailed,
    Return(i64),
    Unsupported40,
    Cancelled,
    GuestLost,
    TransportFailed,
}
/// These are trusted stopped/uncertain physical evidence, not arbitrary caught
/// exceptions. Error outcomes require zero progress. Physical write errno
/// evidence does not prove sendfile errno equivalence. All such errors close
/// transport; SIGPIPE and general sendfile/error compatibility are absent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Transferred,
    Again,
    Interrupted,
    Io,
    BadFd,
    BrokenPipe,
    PreparationFailed,
    Unknown,
}
/// Trusted lexical-access evidence, independent of cumulative prefix certainty.
/// Raw callers are trusted embedding code, not application certification.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AccessEvidence {
    NotEnded,
    Ended,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Capture {
    snapshot: Snapshot,
    invocation: Invocation,
    domain: u64,
    binding: u64,
    sequence: u32,
    args: [u64; 6],
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Identity {
    owner: u64,
    capture: Capture,
    action: Token,
    endpoint: u64,
}
/// Read-only service request. It neither grants output nor exposes source bytes.
/// The physical proof must establish the selected live endpoint kind/flags and
/// its explicit borrowed-lifetime contract, not trust an application boolean.
#[derive(Debug)]
pub(crate) struct CapabilityRequest(Identity);
impl CapabilityRequest {
    pub(crate) fn endpoint(&self) -> u64 {
        self.0.endpoint
    }
    pub(crate) fn sequence(&self) -> u32 {
        self.0.capture.sequence
    }
    pub(crate) fn action(&self) -> Token {
        self.0.action
    }
}
/// Deliberately opaque. No application-facing `accepted: bool` constructor.
/// A rejected service response is safe to construct; acceptance is a remaining
/// reviewed physical-adapter integration gate, not granted by these unit tests.
#[derive(Debug)]
pub(crate) struct CapabilityReceipt {
    identity: Identity,
    accepted: bool,
}
impl CapabilityReceipt {
    #[cfg(any(test, feature = "sendfile-probe"))]
    pub(crate) fn synthetic_accepted(request: CapabilityRequest) -> Self {
        Self {
            identity: request.0,
            accepted: true,
        }
    }
    pub(crate) fn rejected(request: CapabilityRequest) -> Self {
        Self {
            identity: request.0,
            accepted: false,
        }
    }
}
/// Independent trusted proof that lexical access to the canonical core view has
/// ended. It says nothing about accepted-prefix certainty or future effects.
/// No production constructor exists until the physical adapter is reviewed.
#[derive(Debug)]
pub(crate) struct AccessEnded(Identity);

/// Exactly one captured call. The continuation must keep this owner while
/// `finished` is false, including failed cleanup and actual Worker exit. Dropping
/// it is not stopped evidence and deliberately does not release any ticket.
/// This component alone owns hold_call/finish_call, never its parent as well.
#[must_use = "retain until finished; cancellation is not stopped evidence"]
pub(crate) struct Sendfile {
    owner: u64,
    capture: Option<Capture>,
    action: Option<Token>,
    preparation: Option<ReadPreparation>,
    source: Option<ReadHold>,
    destination: Option<StreamHold>,
    load: Option<LoadRequest>,
    endpoint: Option<u64>,
    held_call: bool,
    phase: Phase,
    offered: u64,
    confirmed: u64,
    viewing: bool,
    closed: bool,
    result: Option<ResultValue>,
}
impl Sendfile {
    pub(crate) fn new(files: &Files) -> Self {
        Self {
            owner: files.owner(),
            capture: None,
            action: None,
            preparation: None,
            source: None,
            destination: None,
            load: None,
            endpoint: None,
            held_call: false,
            phase: Phase::Idle,
            offered: 0,
            confirmed: 0,
            viewing: false,
            closed: false,
            result: None,
        }
    }
    pub(crate) fn phase(&self) -> Phase {
        self.phase
    }
    pub(crate) fn ready(&self) -> bool {
        self.phase == Phase::OfferReady
    }
    pub(crate) fn closed(&self) -> bool {
        self.closed
    }
    pub(crate) fn viewing(&self) -> bool {
        self.viewing
    }
    pub(crate) fn finished(&self) -> bool {
        self.phase == Phase::Terminal
    }
    pub(crate) fn result(&self) -> Option<ResultValue> {
        if self.finished() {
            self.result
        } else {
            None
        }
    }
    pub(crate) fn action(&self) -> Option<Token> {
        self.action
    }
    pub(crate) fn endpoint(&self) -> Option<u64> {
        self.endpoint
    }
    pub(crate) fn sequence(&self) -> Option<u32> {
        self.capture.map(|c| c.sequence)
    }
    pub(crate) fn arguments(&self) -> Option<[u64; 6]> {
        self.capture.map(|c| c.args)
    }
    pub(crate) fn syscall_number(&self) -> u64 {
        SYSCALL_NUMBER
    }
    pub(crate) fn offered(&self) -> u64 {
        self.offered
    }
    pub(crate) fn confirmed(&self) -> u64 {
        self.confirmed
    }
    pub(crate) fn owns(&self, action: Token) -> bool {
        self.action == Some(action)
    }
    pub(crate) fn references(&self, execution: &Execution) -> bool {
        !self.finished()
            && self
                .capture
                .is_some_and(|c| execution.owns_snapshot(c.snapshot))
    }
    fn check_files(&self, files: &Files) -> Result<(), Error> {
        if files.owner() != self.owner {
            return Err(Error::Files(descriptor::Error::BadHandle));
        }
        if let Some(hold) = &self.destination {
            let (endpoint, direction) = files.stream(hold)?;
            if Some(endpoint) != self.endpoint || direction != descriptor::StreamDirection::Write {
                return Err(Error::State);
            }
        }
        Ok(())
    }
    fn check(
        &self,
        files: &Files,
        domain: &Domain,
        execution: &Execution,
        sequence: u32,
        action: Token,
    ) -> Result<(), Error> {
        self.check_files(files)?; // Foreign owner must fail before Domain consumption.
        let c = self.capture.ok_or(Error::State)?;
        if c.domain != domain.id() || c.sequence != sequence || self.action != Some(action) {
            return Err(Error::State);
        }
        if !execution.retains_snapshot(c.snapshot) {
            return Err(Error::Execution(execution::Error::Identity));
        }
        Ok(())
    }
    fn can_return_to_guest(&self, execution: &Execution) -> bool {
        self.capture
            .is_some_and(|c| execution.invocation_accepts_result(c.invocation))
    }
    /// First-work permission is stronger than an unchanged running image.
    /// Calls check exact operation identity, phase and local closure separately.
    /// Do not use this to reject stopped receipts for effects already started.
    fn can_begin_work(&self, execution: &Execution) -> bool {
        self.capture
            .is_some_and(|c| execution.check_held_call_live(c.invocation).is_ok())
    }
    fn identity(&self) -> Result<Identity, Error> {
        Ok(Identity {
            owner: self.owner,
            capture: self.capture.ok_or(Error::State)?,
            action: self.action.ok_or(Error::State)?,
            endpoint: self.endpoint.ok_or(Error::State)?,
        })
    }
    /// Reserve both descriptions, one finite action and the exact invocation
    /// BEFORE any capability or source callback. On an error, retain this owner
    /// whenever !finished && phase != Idle: fallible cleanup never drops tickets.
    /// Fully rolled-back begin errors leave Terminal/AdmissionFailed and do not
    /// close transport. The parent owns their typed-error-to-guest mapping.
    /// A cleanup error instead leaves Closing/closed and must remain retained.
    pub(crate) fn begin(
        &mut self,
        files: &mut Files,
        table: &Table,
        domain: &mut Domain,
        execution: &mut Execution,
        invocation: Invocation,
        sequence: u32,
        args: [u64; 6],
    ) -> Result<(), Error> {
        self.check_files(files)?;
        if self.phase != Phase::Idle {
            return Err(Error::State);
        }
        execution.check_domain(domain)?;
        execution.syscall_allowed(invocation)?;
        if sequence == 0 || sequence > i32::MAX as u32 {
            return Err(Error::State);
        }
        if args[2] != 0 {
            return Err(Error::Unsupported40);
        }
        // Linux int arguments use their low 32 bits; keep full originals above.
        let out_fd = args[0] as u32;
        let in_fd = args[1] as u32;
        self.capture = Some(Capture {
            snapshot: execution.stamp()?,
            invocation,
            domain: domain.id(),
            binding: execution.binding(),
            sequence,
            args,
        });
        let result = (|| {
            self.destination =
                Some(files.hold_stream(table, out_fd, descriptor::StreamDirection::Write)?);
            self.endpoint = Some(files.stream(self.destination.as_ref().unwrap())?.0);
            self.preparation = Some(files.begin_read(table, in_fd, args[3].min(MAX_RW_COUNT))?);
            self.action = Some(domain.effect(execution.binding(), args[3].min(MAX_RW_COUNT))?);
            execution.hold_call(invocation)?;
            self.held_call = true;
            Ok(())
        })();
        if let Err(error) = result {
            self.closed = true;
            self.result = Some(ResultValue::TransportFailed);
            self.cleanup_unstarted(files, domain, execution)?;
            self.closed = false;
            self.result = Some(ResultValue::AdmissionFailed);
            return Err(error);
        }
        self.phase = Phase::CapReady;
        Ok(())
    }
    /// All fallible cleanup returns owned tickets to their slots on failure.
    /// Never call after physical output start, or while a service is dispatched.
    fn cleanup_unstarted(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &mut Execution,
    ) -> Result<(), Error> {
        self.phase = Phase::Closing;
        if self.load.is_some() {
            return Err(Error::State);
        }
        if let Some(action) = self.action {
            domain.cancel(action)?;
            domain.retire(action)?;
            self.action = None;
        }
        if let Some(prep) = self.preparation.take() {
            if let Err((error, prep)) = files.abort_preparation(prep) {
                self.preparation = Some(prep);
                return Err(error.into());
            }
        }
        if let Some(hold) = self.source.take() {
            files.abort_read(hold);
        }
        self.release_rest(files, execution)
    }
    fn release_rest(&mut self, files: &mut Files, execution: &mut Execution) -> Result<(), Error> {
        if let Some(hold) = self.destination.take() {
            if let Err((error, hold)) = files.release_stream(hold) {
                self.destination = Some(hold);
                return Err(error.into());
            }
        }
        if self.held_call {
            execution.finish_call(self.capture.ok_or(Error::State)?.invocation)?;
            self.held_call = false;
        }
        if self.preparation.is_some()
            || self.source.is_some()
            || self.action.is_some()
            || self.load.is_some()
            || self.viewing
        {
            return Err(Error::State);
        }
        self.phase = Phase::Terminal;
        Ok(())
    }
    /// Retry a retained cleanup error without needing an action already retired.
    /// Closing never grants start/replay permission. Exact retained identity is
    /// cleanup authority only, not authorization to resume a guest.
    pub(crate) fn retry_cleanup(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &mut Execution,
    ) -> Result<(), Error> {
        self.check_files(files)?;
        let c = self.capture.ok_or(Error::State)?;
        if self.phase != Phase::Closing
            || self.viewing
            || self.load.is_some()
            || c.domain != domain.id()
            || !execution.retains_snapshot(c.snapshot)
        {
            return Err(Error::State);
        }
        if !self.can_return_to_guest(execution) {
            self.closed = true;
            self.result = Some(ResultValue::GuestLost);
        }
        self.cleanup_unstarted(files, domain, execution)
    }
    pub(crate) fn cap_start(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &mut Execution,
        sequence: u32,
        action: Token,
    ) -> Result<CapabilityRequest, Error> {
        self.check(files, domain, execution, sequence, action)?;
        if self.phase != Phase::CapReady || self.closed {
            return Err(Error::State);
        }
        if !self.can_begin_work(execution) {
            self.closed = true;
            self.result = Some(ResultValue::GuestLost);
            self.cleanup_unstarted(files, domain, execution)?;
            return Err(Error::Execution(execution::Error::State));
        }
        let request = CapabilityRequest(self.identity()?);
        self.phase = Phase::CapChecking;
        Ok(request)
    }
    /// Native qualification for a startup-installed owned stdout. Return a
    /// foreign/stale request intact; neither a matching endpoint number nor
    /// a capability receipt is permission to rediscover the guest fd.
    #[cfg(test)]
    pub(crate) fn approve_owned_stdout(
        &self,
        request: CapabilityRequest,
        output: &descriptor::OwnedStdout,
    ) -> Result<CapabilityReceipt, CapabilityRequest> {
        if self.phase != Phase::CapChecking
            || self.identity().ok() != Some(request.0)
            || !self.destination.as_ref().is_some_and(|hold| output.matches(hold))
        {
            return Err(request);
        }
        Ok(CapabilityReceipt {
            identity: request.0,
            accepted: true,
        })
    }

    /// Validate the non-Copy service ticket before a wrapper consumes it.
    pub(crate) fn check_capability(
        &self,
        files: &Files,
        domain: &Domain,
        execution: &Execution,
        sequence: u32,
        action: Token,
        endpoint: u64,
        request: &CapabilityRequest,
    ) -> Result<(), Error> {
        self.check(files, domain, execution, sequence, action)?;
        if self.phase != Phase::CapChecking
            || self.identity()? != request.0
            || request.endpoint() != endpoint
        {
            return Err(Error::State);
        }
        Ok(())
    }
    #[cfg(any(test, feature = "sendfile-probe"))]
    pub(crate) fn synthetic_access_ended(&self) -> Result<AccessEnded, Error> {
        Ok(AccessEnded(self.identity()?))
    }
    pub(crate) fn cap_finish(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &mut Execution,
        receipt: CapabilityReceipt,
    ) -> Result<(), Error> {
        let i = receipt.identity;
        self.check(files, domain, execution, i.capture.sequence, i.action)?;
        if self.phase != Phase::CapChecking || self.identity()? != i {
            return Err(Error::State);
        }
        let live = self.can_begin_work(execution);
        if self.closed || !live || !receipt.accepted {
            if !live {
                self.closed = true;
                self.result = Some(ResultValue::GuestLost);
            }
            if !receipt.accepted && !self.closed {
                self.closed = true;
                self.result = Some(ResultValue::Unsupported40);
            }
            return self.cleanup_unstarted(files, domain, execution);
        }
        self.prepare_source(files, domain, execution)
    }
    fn prepare_source(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &mut Execution,
    ) -> Result<(), Error> {
        match files.prepare_read(self.preparation.as_mut().ok_or(Error::State)?) {
            Ok(Some(load)) => {
                self.load = Some(load);
                self.phase = Phase::LoadingReady;
                Ok(())
            }
            Ok(None) => self.capture_source(files, domain, execution),
            Err(error) => {
                self.closed = true;
                self.result = Some(ResultValue::TransportFailed);
                self.cleanup_unstarted(files, domain, execution)?;
                Err(error.into())
            }
        }
    }
    fn capture_source(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &mut Execution,
    ) -> Result<(), Error> {
        let prep = self.preparation.take().ok_or(Error::State)?;
        match files.capture_read(prep) {
            Ok(hold) => {
                self.offered = hold.length() as u64;
                self.source = Some(hold);
                self.phase = Phase::OfferReady;
                Ok(())
            }
            Err((error, prep)) => {
                self.preparation = Some(prep);
                self.closed = true;
                self.result = Some(ResultValue::TransportFailed);
                self.cleanup_unstarted(files, domain, execution)?;
                Err(error.into())
            }
        }
    }
    pub(crate) fn load_start(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &mut Execution,
        sequence: u32,
        action: Token,
    ) -> Result<LoadRequest, Error> {
        self.check(files, domain, execution, sequence, action)?;
        if self.phase != Phase::LoadingReady || self.closed {
            return Err(Error::State);
        }
        if !self.can_begin_work(execution) {
            self.closed = true;
            self.result = Some(ResultValue::GuestLost);
            self.settle_undispatched_load(files)?;
            self.cleanup_unstarted(files, domain, execution)?;
            return Err(Error::Execution(execution::Error::State));
        }
        self.phase = Phase::Loading;
        Ok(self.load.ok_or(Error::State)?)
    }
    fn settle_undispatched_load(&mut self, files: &mut Files) -> Result<(), Error> {
        let load = self.load.ok_or(Error::State)?;
        let result = files.finish_load(
            self.preparation.as_mut().ok_or(Error::State)?,
            load.attempt,
            false,
            &mut Vec::new(),
        );
        // Matching failure is a stopped command. A stale attempt is NOT.
        if Self::stale(&result) {
            return result.map_err(Into::into);
        }
        self.load = None;
        result.map_err(Into::into)
    }
    fn stale(result: &Result<(), descriptor::Error>) -> bool {
        matches!(
            result,
            Err(descriptor::Error::Source(crate::inode::Error::Payload(
                sods_file_store::store::Error::BadCompletion
            )))
        )
    }
    /// Matching stopped-loader evidence. Cancelled/lost calls never adopt input.
    /// Foreign/stale completions preserve every holder and the caller's Vec.
    pub(crate) fn load_finish(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &mut Execution,
        sequence: u32,
        action: Token,
        load: LoadRequest,
        success: bool,
        bytes: &mut Vec<u8>,
    ) -> Result<(), Error> {
        self.check(files, domain, execution, sequence, action)?;
        if self.phase != Phase::Loading || self.load != Some(load) {
            return Err(Error::State);
        }
        let live = self.can_begin_work(execution);
        let adopt = success && !self.closed && live;
        let result = files.finish_load(
            self.preparation.as_mut().ok_or(Error::State)?,
            load.attempt,
            adopt,
            bytes,
        );
        if Self::stale(&result) {
            return result.map_err(Into::into);
        }
        self.load = None;
        if !live {
            self.closed = true;
            self.result = Some(ResultValue::GuestLost);
        }
        if !adopt || result.is_err() {
            if !self.closed {
                self.closed = true;
                self.result = Some(ResultValue::TransportFailed);
            }
            self.cleanup_unstarted(files, domain, execution)?;
            return result.map_err(Into::into);
        }
        self.capture_source(files, domain, execution)
    }
    /// Exactly one physical offer. Guard is installed BEFORE retrieving the
    /// canonical address. The adapter must create a fresh built-in view and do
    /// its reviewed synchronous preparation/write with no callback/await/core
    /// allocation in between. One offer need not equal one native OS syscall.
    pub(crate) fn start(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &mut Execution,
        sequence: u32,
        action: Token,
    ) -> Result<(usize, u64), Error> {
        self.check(files, domain, execution, sequence, action)?;
        if self.phase != Phase::OfferReady || self.closed || self.viewing {
            return Err(Error::State);
        }
        if !self.can_begin_work(execution) {
            self.closed = true;
            self.result = Some(ResultValue::GuestLost);
            self.cleanup_unstarted(files, domain, execution)?;
            return Err(Error::Execution(execution::Error::State));
        }
        domain.start(action)?;
        self.phase = Phase::Started;
        self.viewing = true;
        let bytes = files.read_bytes(self.source.as_ref().ok_or(Error::State)?);
        Ok((
            if bytes.is_empty() {
                0
            } else {
                bytes.as_ptr() as usize
            },
            self.offered,
        ))
    }
    /// A successful synchronous return/throw can prove lexical access ended
    /// without proving any prefix or stop. Invalid receipt never clears guard.
    pub(crate) fn access_ended(
        &mut self,
        files: &Files,
        domain: &Domain,
        execution: &Execution,
        receipt: AccessEnded,
    ) -> Result<(), Error> {
        let i = receipt.0;
        self.check(files, domain, execution, i.capture.sequence, i.action)?;
        if self.identity()? != i
            || !self.viewing
            || !matches!(self.phase, Phase::Started | Phase::Unknown)
        {
            return Err(Error::State);
        }
        self.viewing = false;
        Ok(())
    }
    /// Atomic combined receipt boundary for the private trusted host. In
    /// particular Unknown+Ended validates the ENTIRE count/outcome/access shape
    /// before Domain mutation or ending the view. A prefix alone never ends it.
    pub(crate) fn receipt_with_access(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &mut Execution,
        sequence: u32,
        action: Token,
        confirmed: u64,
        outcome: Outcome,
        access: AccessEvidence,
    ) -> Result<(), Error> {
        self.preflight_receipt(
            files, domain, execution, sequence, action, confirmed, outcome,
        )?;
        if outcome != Outcome::Unknown && access != AccessEvidence::Ended {
            return Err(Error::State);
        }
        self.receipt(
            files, domain, execution, sequence, action, confirmed, outcome,
        )?;
        if outcome == Outcome::Unknown && access == AccessEvidence::Ended {
            self.viewing = false;
        }
        Ok(())
    }
    fn preflight_receipt(
        &self,
        files: &Files,
        domain: &Domain,
        execution: &Execution,
        sequence: u32,
        action: Token,
        confirmed: u64,
        outcome: Outcome,
    ) -> Result<(), Error> {
        self.check(files, domain, execution, sequence, action)?;
        if !matches!(self.phase, Phase::Started | Phase::Unknown) {
            return Err(Error::State);
        }
        if confirmed < self.confirmed || confirmed > self.offered {
            return Err(Error::Range);
        }
        if confirmed != 0 && !matches!(outcome, Outcome::Transferred | Outcome::Unknown) {
            return Err(Error::State);
        }
        Ok(())
    }
    /// Cumulative evidence. Validate shape, exact owner/action/sequence and
    /// monotonic actual-offer bound BEFORE Domain or view-guard transitions.
    /// Unknown closes admission, retains every obligation, and cannot replay.
    /// Late Stopped commits once even after cancellation or actual guest fault.
    pub(crate) fn receipt(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &mut Execution,
        sequence: u32,
        action: Token,
        confirmed: u64,
        outcome: Outcome,
    ) -> Result<(), Error> {
        self.preflight_receipt(
            files, domain, execution, sequence, action, confirmed, outcome,
        )?;
        let completion = if outcome == Outcome::Unknown {
            Completion::Unknown
        } else {
            Completion::Stopped
        };
        domain.receipt(action, confirmed, completion)?;
        self.confirmed = confirmed;
        if !self.can_return_to_guest(execution) {
            self.closed = true;
            self.result = Some(ResultValue::GuestLost);
        }
        if outcome == Outcome::Unknown {
            self.closed = true;
            if self.result.is_none() {
                self.result = Some(ResultValue::TransportFailed);
            }
            self.phase = Phase::Unknown;
            return Ok(()); // A prefix alone never ends lexical access.
        }
        self.viewing = false; // Stopped explicitly includes ended access.
        self.phase = Phase::Closing;
        files.finish_read(self.source.take().ok_or(Error::State)?, confirmed);
        domain.retire(action)?;
        self.action = None;
        if !self.closed {
            self.result = Some(match outcome {
                Outcome::Transferred if confirmed == 0 && self.offered != 0 => {
                    // Truthful stopped physical zero still settles all owners,
                    // but write-zero/sendfile-zero equivalence is unproved for
                    // this profile's nonempty offer. This is not a Linux-wide
                    // claim that non-EOF sendfile zero is impossible.
                    self.closed = true;
                    ResultValue::TransportFailed
                }
                Outcome::Transferred => ResultValue::Return(confirmed as i64),
                Outcome::Again
                | Outcome::Interrupted
                | Outcome::Io
                | Outcome::BadFd
                | Outcome::BrokenPipe
                | Outcome::PreparationFailed => {
                    self.closed = true;
                    ResultValue::TransportFailed
                }
                Outcome::Unknown => unreachable!(),
            });
        }
        self.release_rest(files, execution)
    }
    /// Ready cancellations release. Dispatched capability/load and started
    /// output retain exact owners until matching stopped completion arrives.
    pub(crate) fn cancel(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &mut Execution,
        sequence: u32,
        action: Token,
    ) -> Result<bool, Error> {
        self.check(files, domain, execution, sequence, action)?;
        if self.phase == Phase::Idle || self.finished() {
            return Err(Error::State);
        }
        self.closed = true;
        if self.result.is_none() {
            self.result = Some(ResultValue::Cancelled);
        }
        domain.cancel(action)?;
        match self.phase {
            Phase::CapChecking | Phase::Loading | Phase::Started | Phase::Unknown => Ok(false),
            Phase::LoadingReady => {
                self.settle_undispatched_load(files)?;
                self.cleanup_unstarted(files, domain, execution)?;
                Ok(true)
            }
            Phase::CapReady | Phase::OfferReady | Phase::Closing => {
                self.cleanup_unstarted(files, domain, execution)?;
                Ok(true)
            }
            Phase::Idle | Phase::Terminal => Err(Error::State),
        }
    }
}

#[cfg(test)]
mod tests {
    // These ABI/state counterexamples use synthetic receipts. The separate
    // native owned-file witness never grants the production ABI a capability.
    use super::*;

    #[cfg(target_os = "linux")]
    mod owned_output;
    use crate::descriptor::{Limits, Target};
    use crate::inode::{Inode, Tree};
    fn root_owned(mode: u32) -> crate::inode::Creation {
        crate::inode::Creation {
            mode,
            uid: 0,
            gid: 0,
        }
    }

    struct Harness {
        s: Sendfile,
        f: Files,
        t: Table,
        d: Domain,
        e: Execution,
        invocation: Invocation,
        fd: u32,
        other: Inode,
    }
    impl Harness {
        fn new(lazy: bool, exact: bool, hint: usize) -> Self {
            let mut tree = Tree::new(12, 8, 8, 64, root_owned(0o755)).unwrap();
            let source = if lazy {
                if exact {
                    tree.lazy_file_exact(tree.root(), b"a", root_owned(0o444), 7, hint)
                        .unwrap()
                } else {
                    tree.lazy_file(tree.root(), b"a", root_owned(0o444), 7, hint)
                        .unwrap()
                }
            } else {
                tree.file_take(
                    tree.root(),
                    b"a",
                    root_owned(0o444),
                    &mut b"abcdef".to_vec(),
                )
                .unwrap()
            };
            let other = tree
                .file_take(tree.root(), b"b", root_owned(0o444), &mut b"xyz".to_vec())
                .unwrap();
            let mut f = Files::new(
                13,
                tree,
                Limits {
                    contexts: 0,
                    tables: 2,
                    descriptions: 8,
                    slots: 16,
                },
            );
            let t = f.stdio([10, 20, 30], 16).unwrap();
            let fd = f.open(&t, source, false).unwrap();
            let s = Sendfile::new(&f);
            let mut d = Domain::new(11, 2, 4).unwrap();
            let binding = d.bind(1).unwrap(); // Effects don't need a guest byte range.
            let mut e = Execution::new(14, binding);
            e.image_begin(&mut d, 1).unwrap();
            e.image_finish(&mut d, execution::ImageResult::Installed)
                .unwrap();
            let invocation = e.start(&mut d).unwrap();
            Self {
                s,
                f,
                t,
                d,
                e,
                invocation,
                fd,
                other,
            }
        }
        fn begin(&mut self, count: u64) {
            self.s
                .begin(
                    &mut self.f,
                    &self.t,
                    &mut self.d,
                    &mut self.e,
                    self.invocation,
                    9,
                    [1, self.fd as u64, 0, count, 0x55, 0x66],
                )
                .unwrap();
        }
        fn token(&self) -> Token {
            self.s.action().unwrap()
        }
        fn request(&mut self) -> CapabilityRequest {
            let action = self.token();
            self.s
                .cap_start(&mut self.f, &mut self.d, &mut self.e, 9, action)
                .unwrap()
        }
        fn cap(&mut self) {
            let request = self.request();
            self.s
                .cap_finish(
                    &mut self.f,
                    &mut self.d,
                    &mut self.e,
                    CapabilityReceipt {
                        identity: request.0,
                        accepted: true,
                    },
                )
                .unwrap();
        }
        fn load(&mut self, bytes: &[u8]) {
            let action = self.token();
            let load = self
                .s
                .load_start(&mut self.f, &mut self.d, &mut self.e, 9, action)
                .unwrap();
            self.s
                .load_finish(
                    &mut self.f,
                    &mut self.d,
                    &mut self.e,
                    9,
                    action,
                    load,
                    true,
                    &mut bytes.to_vec(),
                )
                .unwrap();
        }
        fn start(&mut self) -> (usize, u64) {
            let action = self.token();
            self.s
                .start(&mut self.f, &mut self.d, &mut self.e, 9, action)
                .unwrap()
        }
        fn receipt(&mut self, n: u64, result: Outcome) -> Result<(), Error> {
            let action = self.token();
            self.s
                .receipt(&mut self.f, &mut self.d, &mut self.e, 9, action, n, result)
        }
        fn cancel(&mut self) -> bool {
            let action = self.token();
            self.s
                .cancel(&mut self.f, &mut self.d, &mut self.e, 9, action)
                .unwrap()
        }
        fn assert_released(&self) {
            assert!(self.s.finished());
            assert!(!self.s.viewing());
            assert!(self.s.action.is_none());
            assert!(self.s.preparation.is_none());
            assert!(self.s.source.is_none());
            assert!(self.s.destination.is_none());
            assert!(self.s.load.is_none());
            assert!(!self.s.held_call);
        }
        fn request_exit(&mut self) {
            self.e.request_exit(self.invocation, 7).unwrap();
            assert_eq!(self.e.phase(), execution::Phase::Running);
        }
        fn assert_exit_cleanup_without_progress(&mut self, action: Token) {
            self.assert_released();
            assert_eq!(self.s.result(), Some(ResultValue::GuestLost));
            assert_eq!(self.f.offset(&self.t, self.fd), Ok((0, 0)));
            assert_eq!(self.d.retire(action), Err(lease::Error::UnknownAction));
            self.e
                .receipt(&mut self.d, self.invocation, execution::Unwind::Exit)
                .unwrap();
            assert_eq!(self.e.status(), Some(7));
            assert!(self.e.retireable());
        }
    }

    #[test]
    fn synthetic_exit_request_before_capability_dispatch_closes_the_ready_call() {
        let mut h = Harness::new(true, false, 1);
        h.begin(6);
        let action = h.token();
        h.request_exit();
        let result = h.s.cap_start(&mut h.f, &mut h.d, &mut h.e, 9, action);
        assert!(
            matches!(result, Err(Error::Execution(execution::Error::State))),
            "{result:?}"
        );
        h.assert_exit_cleanup_without_progress(action);
    }

    #[test]
    fn synthetic_exit_request_during_capability_completion_cannot_prepare_a_source() {
        let mut h = Harness::new(true, false, 1);
        h.begin(6);
        let action = h.token();
        let request = h.request();
        h.request_exit();
        h.s.cap_finish(
            &mut h.f,
            &mut h.d,
            &mut h.e,
            CapabilityReceipt::synthetic_accepted(request),
        )
        .unwrap();
        h.assert_exit_cleanup_without_progress(action);
        let mut prep = h.f.begin_read(&h.t, h.fd, 6).unwrap();
        let load = h.f.prepare_read(&mut prep).unwrap().unwrap();
        assert_eq!(
            load.attempt, 1,
            "capability completion after exit must not start Store"
        );
        h.f.finish_load(&mut prep, load.attempt, false, &mut Vec::new())
            .unwrap();
        h.f.abort_preparation(prep).unwrap();
    }

    #[test]
    fn synthetic_exit_request_before_lazy_dispatch_settles_the_unstarted_store_attempt() {
        let mut h = Harness::new(true, false, 1);
        h.begin(6);
        h.cap();
        let action = h.token();
        assert_eq!(h.s.phase(), Phase::LoadingReady);
        let prior = h.s.load.unwrap();
        h.request_exit();
        assert_eq!(
            h.s.load_start(&mut h.f, &mut h.d, &mut h.e, 9, action),
            Err(Error::Execution(execution::Error::State))
        );
        h.assert_exit_cleanup_without_progress(action);
        let mut prep = h.f.begin_read(&h.t, h.fd, 6).unwrap();
        let load = h.f.prepare_read(&mut prep).unwrap().unwrap();
        assert_ne!(
            load, prior,
            "old attempt settled and cannot be redispatched"
        );
        h.f.finish_load(&mut prep, load.attempt, false, &mut Vec::new())
            .unwrap();
        h.f.abort_preparation(prep).unwrap();
    }

    #[test]
    fn synthetic_exit_request_after_lazy_dispatch_adopts_no_bytes_on_matching_stop() {
        let mut h = Harness::new(true, false, 1);
        h.begin(6);
        h.cap();
        let action = h.token();
        let load =
            h.s.load_start(&mut h.f, &mut h.d, &mut h.e, 9, action)
                .unwrap();
        h.request_exit();
        let mut bytes = b"abcdef".to_vec();
        let stale = LoadRequest {
            attempt: load.attempt + 1,
            ..load
        };
        assert_eq!(
            h.s.load_finish(&mut h.f, &mut h.d, &mut h.e, 9, action, stale, true, &mut bytes),
            Err(Error::State)
        );
        assert_eq!(h.s.phase(), Phase::Loading);
        assert_eq!(bytes, b"abcdef");
        assert_eq!(h.f.set_offset(&h.t, h.fd, 0), Err(descriptor::Error::Busy));
        h.s.load_finish(
            &mut h.f, &mut h.d, &mut h.e, 9, action, load, true, &mut bytes,
        )
        .unwrap();
        assert_eq!(
            bytes, b"abcdef",
            "stopped after exit cannot give Store new bytes"
        );
        h.assert_exit_cleanup_without_progress(action);
        let mut prep = h.f.begin_read(&h.t, h.fd, 6).unwrap();
        let next = h.f.prepare_read(&mut prep).unwrap().unwrap();
        assert_ne!(load, next);
        h.f.finish_load(&mut prep, next.attempt, false, &mut Vec::new())
            .unwrap();
        h.f.abort_preparation(prep).unwrap();
    }

    #[test]
    fn synthetic_exit_request_after_materialization_cannot_start_a_first_offer() {
        let mut h = Harness::new(false, false, 0);
        h.begin(6);
        h.cap();
        let action = h.token();
        assert_eq!(h.s.phase(), Phase::OfferReady);
        h.request_exit();
        assert_eq!(
            h.s.start(&mut h.f, &mut h.d, &mut h.e, 9, action),
            Err(Error::Execution(execution::Error::State))
        );
        h.assert_exit_cleanup_without_progress(action);
    }

    #[test]
    fn synthetic_exit_after_start_settles_the_stopped_prefix_but_suppresses_guest_success() {
        let mut h = Harness::new(false, false, 0);
        h.begin(6);
        h.cap();
        h.start();
        let action = h.token();
        h.request_exit();
        h.receipt(3, Outcome::Transferred).unwrap();
        h.assert_released();
        assert_eq!(h.f.offset(&h.t, h.fd), Ok((3, 1)));
        assert_eq!(h.d.retire(action), Err(lease::Error::UnknownAction));
        assert_eq!(h.s.result(), Some(ResultValue::GuestLost));
        assert!(h.s.closed());
        h.e.receipt(&mut h.d, h.invocation, execution::Unwind::Exit)
            .unwrap();
        assert_eq!(h.e.status(), Some(7));
        assert!(h.e.retireable());
    }

    #[test]
    fn synthetic_capture_both_fd_reuse_during_lazy_load_commits_only_original_prefix() {
        let mut h = Harness::new(true, false, 0);
        let alias = h.f.dup(&h.t, h.fd, 0, false).unwrap();
        h.begin(u64::MAX);
        assert_eq!(h.s.sequence(), Some(9));
        assert_eq!(h.s.syscall_number(), 40);
        assert_eq!(
            h.s.arguments(),
            Some([1, h.fd as u64, 0, u64::MAX, 0x55, 0x66])
        );
        assert!(h.s.references(&h.e));
        assert!(h.s.owns(h.token()));
        assert!(h.e.syscall_allowed(h.invocation).is_err());
        h.cap();
        let action = h.token();
        let load =
            h.s.load_start(&mut h.f, &mut h.d, &mut h.e, 9, action)
                .unwrap();
        assert_eq!(load.source, 7);
        h.f.close(&h.t, 1).unwrap();
        h.f.close(&h.t, h.fd).unwrap();
        assert_eq!(h.f.open(&h.t, h.other, false).unwrap(), 1);
        assert_eq!(h.f.open(&h.t, h.other, false).unwrap(), h.fd);
        assert!(matches!(h.f.target(&h.t, 1).unwrap(), Target::File(_)));
        assert_eq!(h.f.stream(h.s.destination.as_ref().unwrap()).unwrap().0, 20);
        let mut bytes = b"abcdef".to_vec();
        h.s.load_finish(
            &mut h.f, &mut h.d, &mut h.e, 9, action, load, true, &mut bytes,
        )
        .unwrap();
        assert!(bytes.is_empty());
        assert!(h.s.ready());
        assert_eq!(h.f.set_offset(&h.t, alias, 0), Err(descriptor::Error::Busy));
        let (ptr, n) = h.start();
        assert_eq!(n, 6); // Not the provisional zero-size hint, nor requested MAX.
        assert_eq!(
            unsafe { std::slice::from_raw_parts(ptr as *const u8, n as usize) },
            b"abcdef"
        );
        h.receipt(3, Outcome::Transferred).unwrap();
        assert_eq!(h.f.offset(&h.t, alias).unwrap(), (3, 1));
        assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (0, 0));
        assert_eq!(h.f.offset(&h.t, 1).unwrap(), (0, 0));
        assert_eq!(h.s.result(), Some(ResultValue::Return(3)));
        assert_eq!(h.s.endpoint(), Some(20));
        assert!(!h.s.references(&h.e));
        assert!(h.e.syscall_allowed(h.invocation).is_ok());
        h.assert_released();
    }
    #[test]
    fn synthetic_cap_rejection_precedes_any_source_attempt_and_closes_unsupported40() {
        let mut h = Harness::new(true, false, 0);
        h.begin(6);
        assert_eq!(h.s.phase(), Phase::CapReady);
        let action = h.token();
        assert_eq!(
            h.s.load_start(&mut h.f, &mut h.d, &mut h.e, 9, action),
            Err(Error::State)
        );
        let request = h.request();
        assert_eq!(
            (request.endpoint(), request.sequence(), request.action()),
            (20, 9, action)
        );
        h.s.cap_finish(
            &mut h.f,
            &mut h.d,
            &mut h.e,
            CapabilityReceipt::rejected(request),
        )
        .unwrap();
        assert_eq!(h.s.result(), Some(ResultValue::Unsupported40));
        assert!(h.s.closed());
        h.assert_released();
        let mut prep = h.f.begin_read(&h.t, h.fd, 6).unwrap();
        let load = h.f.prepare_read(&mut prep).unwrap().unwrap();
        assert_eq!(load.attempt, 1); // Rejection did not even issue an attempt.
        h.f.finish_load(&mut prep, load.attempt, false, &mut Vec::new())
            .unwrap();
        h.f.abort_preparation(prep).unwrap();
    }
    #[test]
    fn synthetic_count_zero_requires_capability_but_does_not_materialize_source() {
        let mut h = Harness::new(true, false, 1);
        h.f.set_offset(&h.t, h.fd, u64::MAX).unwrap();
        h.begin(0);
        let action = h.token();
        assert_eq!(
            h.s.start(&mut h.f, &mut h.d, &mut h.e, 9, action),
            Err(Error::State)
        );
        assert_eq!(h.s.result(), None);
        h.cap();
        assert_eq!(h.s.phase(), Phase::OfferReady);
        assert!(h.s.load.is_none());
        assert_eq!(h.start(), (0, 0));
        assert!(h.s.viewing());
        h.receipt(0, Outcome::Transferred).unwrap();
        assert_eq!(h.s.result(), Some(ResultValue::Return(0)));
        assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (u64::MAX, 1));
        h.assert_released();
        let mut prep = h.f.begin_read(&h.t, h.fd, 1).unwrap();
        let load = h.f.prepare_read(&mut prep).unwrap().unwrap();
        assert_eq!(load.attempt, 1);
        h.f.finish_load(&mut prep, load.attempt, false, &mut Vec::new())
            .unwrap();
        h.f.abort_preparation(prep).unwrap();
    }
    #[test]
    fn synthetic_eof_materializes_despite_provisional_metadata_and_requires_cap() {
        let mut h = Harness::new(true, false, 0);
        h.f.set_offset(&h.t, h.fd, 2).unwrap();
        h.begin(4);
        h.cap();
        assert_eq!(h.s.phase(), Phase::LoadingReady);
        h.load(b"abcdef");
        assert_eq!(h.s.offered(), 4); // Provisional size0 did not invent EOF.
        h.start();
        h.receipt(4, Outcome::Transferred).unwrap();
        let mut second = Sendfile::new(&h.f);
        second
            .begin(
                &mut h.f,
                &h.t,
                &mut h.d,
                &mut h.e,
                h.invocation,
                10,
                [1, h.fd as u64, 0, 4, 0, 0],
            )
            .unwrap();
        let action = second.action().unwrap();
        assert!(!second.ready());
        let req = second
            .cap_start(&mut h.f, &mut h.d, &mut h.e, 10, action)
            .unwrap();
        second
            .cap_finish(
                &mut h.f,
                &mut h.d,
                &mut h.e,
                CapabilityReceipt {
                    identity: req.0,
                    accepted: true,
                },
            )
            .unwrap();
        assert_eq!(
            second
                .start(&mut h.f, &mut h.d, &mut h.e, 10, action)
                .unwrap(),
            (0, 0)
        );
        second
            .receipt(
                &mut h.f,
                &mut h.d,
                &mut h.e,
                10,
                action,
                0,
                Outcome::Transferred,
            )
            .unwrap();
        assert_eq!(second.result(), Some(ResultValue::Return(0)));
    }
    #[test]
    fn synthetic_source_failure_wrong_length_stale_and_foreign_input_are_not_adopted() {
        for (success, exact, input) in [
            (false, false, b"abcdef".as_slice()),
            (true, true, b"wrong".as_slice()),
        ] {
            let mut h = Harness::new(true, exact, 6);
            h.begin(6);
            h.cap();
            let action = h.token();
            let load =
                h.s.load_start(&mut h.f, &mut h.d, &mut h.e, 9, action)
                    .unwrap();
            let mut bytes = input.to_vec();
            let stale = LoadRequest {
                attempt: load.attempt + 1,
                ..load
            };
            assert_eq!(
                h.s.load_finish(&mut h.f, &mut h.d, &mut h.e, 9, action, stale, true, &mut bytes),
                Err(Error::State)
            );
            assert_eq!(bytes, input);
            let result = h.s.load_finish(
                &mut h.f, &mut h.d, &mut h.e, 9, action, load, success, &mut bytes,
            );
            assert_eq!(result.is_err(), exact);
            assert_eq!(bytes, input);
            assert_eq!(h.s.result(), Some(ResultValue::TransportFailed));
            assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (0, 0));
            h.assert_released();
        }
    }
    #[test]
    fn synthetic_finite_effect_and_call_slot_failures_rollback_without_a_callback() {
        let mut h = Harness::new(true, false, 1);
        let mut actions = Vec::new();
        for _ in 0..4 {
            actions.push(h.d.effect(h.e.binding(), 0).unwrap());
        }
        let result = h.s.begin(
            &mut h.f,
            &h.t,
            &mut h.d,
            &mut h.e,
            h.invocation,
            9,
            [1, h.fd as u64, 0, 6, 0, 0],
        );
        assert_eq!(result, Err(Error::Lease(lease::Error::Capacity)));
        h.assert_released();
        assert!(!h.s.closed());
        assert_eq!(h.s.result(), Some(ResultValue::AdmissionFailed));
        h.f.set_offset(&h.t, h.fd, 0).unwrap();
        assert!(h.e.syscall_allowed(h.invocation).is_ok());
        for action in actions {
            h.d.cancel(action).unwrap();
            h.d.retire(action).unwrap();
        }
        let mut another = Sendfile::new(&h.f);
        another
            .begin(
                &mut h.f,
                &h.t,
                &mut h.d,
                &mut h.e,
                h.invocation,
                10,
                [1, h.fd as u64, 0, 6, 0, 0],
            )
            .unwrap();
        // A finite pending-call slot rejects a second call, before any callback.
        assert!(h.e.hold_call(h.invocation).is_err());
        let a = another.action().unwrap();
        assert!(another.cancel(&mut h.f, &mut h.d, &mut h.e, 10, a).unwrap());
        let mut bad = Sendfile::new(&h.f);
        assert_eq!(
            bad.begin(
                &mut h.f,
                &h.t,
                &mut h.d,
                &mut h.e,
                h.invocation,
                11,
                [1, 0, 0, 6, 0, 0]
            ),
            Err(Error::Files(descriptor::Error::NotSupported))
        );
        assert!(bad.finished());
        assert!(!bad.closed());
        assert_eq!(bad.result(), Some(ResultValue::AdmissionFailed));
        assert!(h.e.syscall_allowed(h.invocation).is_ok());
    }
    #[test]
    fn synthetic_exact_owner_domain_execution_sequence_action_checks_precede_consumption() {
        let mut h = Harness::new(true, false, 1);
        h.begin(6);
        let action = h.token();
        let mut other = Harness::new(true, false, 1);
        other.e = Execution::new(999, other.e.binding());
        other.f = Files::new(
            999,
            Tree::new(999, 2, 2, 64, root_owned(0o755)).unwrap(),
            Limits {
                contexts: 0,
                tables: 1,
                descriptions: 1,
                slots: 1,
            },
        );
        assert!(matches!(
            h.s.cap_start(&mut other.f, &mut h.d, &mut h.e, 9, action),
            Err(Error::Files(_))
        ));
        let mut foreign_domain = Domain::new(999, 2, 4).unwrap();
        foreign_domain.bind(1).unwrap();
        assert_eq!(
            h.s.cap_start(&mut h.f, &mut foreign_domain, &mut h.e, 9, action)
                .unwrap_err(),
            Error::State
        );
        assert!(h
            .s
            .cap_start(&mut h.f, &mut h.d, &mut other.e, 9, action)
            .is_err());
        assert_eq!(
            h.s.cap_start(&mut h.f, &mut h.d, &mut h.e, 8, action)
                .unwrap_err(),
            Error::State
        );
        assert_eq!(
            h.s.cap_start(&mut h.f, &mut h.d, &mut h.e, 9, Token::from_parts(11, 999))
                .unwrap_err(),
            Error::State
        );
        assert_eq!(h.s.phase(), Phase::CapReady);
        h.cap();
        let load =
            h.s.load_start(&mut h.f, &mut h.d, &mut h.e, 9, action)
                .unwrap();
        let mut bytes = b"abcdef".to_vec();
        assert_eq!(
            h.s.load_finish(
                &mut h.f,
                &mut foreign_domain,
                &mut h.e,
                9,
                action,
                load,
                true,
                &mut bytes
            ),
            Err(Error::State)
        );
        assert_eq!(bytes, b"abcdef");
        assert!(h
            .s
            .load_finish(
                &mut h.f,
                &mut h.d,
                &mut other.e,
                9,
                action,
                load,
                true,
                &mut bytes
            )
            .is_err());
        assert_eq!(bytes, b"abcdef");
        assert_eq!(h.s.phase(), Phase::Loading);
        h.s.load_finish(
            &mut h.f, &mut h.d, &mut h.e, 9, action, load, true, &mut bytes,
        )
        .unwrap();
        assert!(bytes.is_empty());
        h.start();
        assert!(h.s.start(&mut h.f, &mut h.d, &mut h.e, 9, action).is_err());
        assert!(h
            .s
            .receipt(
                &mut other.f,
                &mut h.d,
                &mut h.e,
                9,
                action,
                1,
                Outcome::Transferred
            )
            .is_err());
        assert!(h
            .s
            .receipt(
                &mut h.f,
                &mut h.d,
                &mut h.e,
                8,
                action,
                1,
                Outcome::Transferred
            )
            .is_err());
        assert!(h.s.viewing());
        h.receipt(1, Outcome::Transferred).unwrap();
        assert!(h
            .s
            .receipt(
                &mut h.f,
                &mut h.d,
                &mut h.e,
                9,
                action,
                1,
                Outcome::Transferred
            )
            .is_err());
        assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (1, 1));
    }
    #[test]
    fn synthetic_stale_capability_and_snapshot_receipts_preserve_holders() {
        let mut h = Harness::new(true, false, 1);
        h.begin(6);
        let request = h.request();
        let mut foreign_domain = Domain::new(55, 1, 2).unwrap();
        let binding = foreign_domain.bind(1).unwrap();
        let mut foreign = Execution::new(77, binding);
        foreign.image_begin(&mut foreign_domain, 1).unwrap();
        foreign
            .image_finish(&mut foreign_domain, execution::ImageResult::Installed)
            .unwrap();
        let invocation = foreign.start(&mut foreign_domain).unwrap();
        for field in 0..5 {
            let mut bad = request.0;
            match field {
                0 => bad.capture.args[3] = 5,
                1 => bad.capture.snapshot = foreign.stamp().unwrap(),
                2 => bad.capture.invocation = invocation,
                3 => bad.capture.sequence = 10,
                _ => bad.endpoint = 21,
            }
            assert_eq!(
                h.s.cap_finish(
                    &mut h.f,
                    &mut h.d,
                    &mut h.e,
                    CapabilityReceipt {
                        identity: bad,
                        accepted: true
                    }
                ),
                Err(Error::State)
            );
        }
        assert_eq!(h.s.phase(), Phase::CapChecking);
        assert!(h.s.preparation.is_some());
        assert!(h.s.destination.is_some());
        assert!(h.s.load.is_none());
        let id = request.0;
        h.s.cap_finish(
            &mut h.f,
            &mut h.d,
            &mut h.e,
            CapabilityReceipt {
                identity: id,
                accepted: true,
            },
        )
        .unwrap();
        assert_eq!(
            h.s.cap_finish(
                &mut h.f,
                &mut h.d,
                &mut h.e,
                CapabilityReceipt {
                    identity: id,
                    accepted: true
                }
            ),
            Err(Error::State)
        );
        assert_eq!(h.s.phase(), Phase::LoadingReady);
        assert!(h.cancel());
    }
    #[test]
    fn synthetic_cancel_before_and_during_capability_never_dispatches_source() {
        let mut h = Harness::new(true, false, 1);
        h.begin(6);
        assert!(h.cancel());
        assert_eq!(h.s.result(), Some(ResultValue::Cancelled));
        h.assert_released();
        let mut h = Harness::new(true, false, 1);
        h.begin(6);
        let request = h.request();
        assert!(!h.cancel());
        assert_eq!(h.s.result(), None);
        assert!(h.s.preparation.is_some());
        h.s.cap_finish(
            &mut h.f,
            &mut h.d,
            &mut h.e,
            CapabilityReceipt {
                identity: request.0,
                accepted: true,
            },
        )
        .unwrap();
        assert_eq!(h.s.result(), Some(ResultValue::Cancelled));
        h.assert_released();
    }
    #[test]
    fn synthetic_cancel_before_loader_settles_store_attempt_before_abort_and_can_retry() {
        let mut h = Harness::new(true, false, 1);
        h.begin(6);
        h.cap();
        let first = h.s.load.unwrap();
        assert!(h.cancel());
        h.assert_released();
        let mut prep = h.f.begin_read(&h.t, h.fd, 6).unwrap();
        let next = h.f.prepare_read(&mut prep).unwrap().unwrap();
        assert_ne!(next.attempt, first.attempt);
        h.f.finish_load(&mut prep, next.attempt, false, &mut Vec::new())
            .unwrap();
        h.f.abort_preparation(prep).unwrap();
    }
    #[test]
    fn synthetic_cancel_after_loader_start_retains_and_does_not_adopt_late_bytes() {
        let mut h = Harness::new(true, false, 1);
        h.begin(6);
        h.cap();
        let action = h.token();
        let load =
            h.s.load_start(&mut h.f, &mut h.d, &mut h.e, 9, action)
                .unwrap();
        assert!(!h.cancel());
        assert_eq!(h.s.phase(), Phase::Loading);
        assert_eq!(h.f.set_offset(&h.t, h.fd, 0), Err(descriptor::Error::Busy));
        assert!(h.s.references(&h.e));
        assert!(h.e.syscall_allowed(h.invocation).is_err());
        let mut bytes = b"abcdef".to_vec();
        h.s.load_finish(
            &mut h.f, &mut h.d, &mut h.e, 9, action, load, true, &mut bytes,
        )
        .unwrap();
        assert_eq!(bytes, b"abcdef");
        assert_eq!(h.s.result(), Some(ResultValue::Cancelled));
        assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (0, 0));
        h.assert_released();
    }
    #[test]
    fn synthetic_cancellation_at_offer_and_after_start_separates_rollback_from_commit() {
        let mut h = Harness::new(false, false, 0);
        h.begin(6);
        h.cap();
        assert!(h.cancel());
        assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (0, 0));
        h.assert_released();
        let mut h = Harness::new(false, false, 0);
        h.begin(6);
        h.cap();
        h.start();
        assert!(!h.cancel());
        assert!(h.s.viewing());
        assert_eq!(h.f.set_offset(&h.t, h.fd, 0), Err(descriptor::Error::Busy));
        h.receipt(2, Outcome::Transferred).unwrap();
        assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (2, 1));
        assert_eq!(h.s.result(), Some(ResultValue::Cancelled));
        assert!(h.s.closed());
        h.assert_released();
    }
    #[test]
    fn synthetic_known_short_zero_and_transport_errors_settle_once_without_retry() {
        for (count, outcome, value) in [
            (2, Outcome::Transferred, ResultValue::Return(2)),
            (0, Outcome::Transferred, ResultValue::TransportFailed),
        ] {
            let mut h = Harness::new(false, false, 0);
            h.begin(6);
            h.cap();
            h.start();
            h.receipt(count, outcome).unwrap();
            assert_eq!(h.s.result(), Some(value));
            assert_eq!(h.s.closed(), count == 0);
            assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (count, 1));
            h.assert_released();
        }
        for outcome in [
            Outcome::Again,
            Outcome::Interrupted,
            Outcome::Io,
            Outcome::BadFd,
            Outcome::BrokenPipe,
            Outcome::PreparationFailed,
        ] {
            let mut h = Harness::new(false, false, 0);
            h.begin(6);
            h.cap();
            h.start();
            h.receipt(0, outcome).unwrap();
            assert_eq!(h.s.result(), Some(ResultValue::TransportFailed));
            assert!(h.s.closed());
            h.assert_released();
        }
    }
    #[test]
    fn synthetic_unknown_separates_lexical_guard_from_monotone_prefix_and_late_stop() {
        let mut h = Harness::new(false, false, 0);
        h.begin(20);
        h.cap();
        h.start();
        let action = h.token();
        let id = h.s.identity().unwrap();
        assert_eq!(h.receipt(7, Outcome::Transferred), Err(Error::Range)); // <= request20 but > actual6.
        assert_eq!(h.receipt(1, Outcome::Again), Err(Error::State));
        assert!(h.s.viewing());
        h.receipt(2, Outcome::Unknown).unwrap();
        assert!(h.s.closed());
        assert!(h.s.viewing()); // Unknown is NOT lexical-ended evidence.
        assert_eq!(h.s.result(), None);
        assert_eq!(h.s.confirmed(), 2);
        assert!(h.s.source.is_some());
        assert!(h.s.destination.is_some());
        assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (0, 0));
        assert!(h.s.start(&mut h.f, &mut h.d, &mut h.e, 9, action).is_err());
        assert_eq!(h.receipt(1, Outcome::Transferred), Err(Error::Range));
        assert_eq!(h.receipt(7, Outcome::Transferred), Err(Error::Range));
        let mut wrong = id;
        wrong.endpoint += 1;
        assert_eq!(
            h.s.access_ended(&h.f, &h.d, &h.e, AccessEnded(wrong)),
            Err(Error::State)
        );
        assert!(h.s.viewing());
        h.s.access_ended(&h.f, &h.d, &h.e, AccessEnded(id)).unwrap();
        assert!(!h.s.viewing());
        assert!(h.s.source.is_some());
        assert!(h.s.action.is_some());
        assert!(h.s.held_call);
        assert_eq!(
            h.s.access_ended(&h.f, &h.d, &h.e, AccessEnded(id)),
            Err(Error::State)
        );
        h.receipt(4, Outcome::Unknown).unwrap();
        assert!(!h.s.viewing());
        h.receipt(5, Outcome::Transferred).unwrap();
        assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (5, 1));
        assert!(h.s.closed());
        assert_eq!(h.s.result(), Some(ResultValue::TransportFailed));
        h.assert_released();
        assert!(h
            .s
            .receipt(
                &mut h.f,
                &mut h.d,
                &mut h.e,
                9,
                action,
                6,
                Outcome::Transferred
            )
            .is_err());
        assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (5, 1));
    }
    #[test]
    fn synthetic_guest_fault_before_late_prefix_preserves_call_and_both_holds_until_stop() {
        let mut h = Harness::new(false, false, 0);
        h.begin(6);
        h.cap();
        h.start();
        let action = h.token();
        h.e.receipt(&mut h.d, h.invocation, execution::Unwind::Fault)
            .unwrap();
        assert!(h.e.stopped());
        assert!(!h.e.retireable()); // Component still owns pending call.
        h.receipt(1, Outcome::Unknown).unwrap();
        assert_eq!(h.d.change(h.e.binding(), 1), Err(lease::Error::Busy));
        assert!(h.s.references(&h.e));
        assert!(h.s.viewing());
        h.receipt(3, Outcome::Transferred).unwrap();
        assert_eq!(h.s.result(), Some(ResultValue::GuestLost));
        assert!(h.s.closed());
        assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (3, 1));
        h.assert_released();
        assert!(h.e.retireable());
        assert!(h
            .s
            .receipt(
                &mut h.f,
                &mut h.d,
                &mut h.e,
                9,
                action,
                4,
                Outcome::Transferred
            )
            .is_err());
        assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (3, 1));
        assert!(h.d.change(h.e.binding(), 1).is_ok());
    }
    #[test]
    fn synthetic_observed_execution_exit_is_not_send_stopping_evidence() {
        let mut h = Harness::new(false, false, 0);
        h.begin(6);
        h.cap();
        h.start();
        h.e.request_exit(h.invocation, 3).unwrap();
        h.e.receipt(&mut h.d, h.invocation, execution::Unwind::Exit)
            .unwrap();
        assert_eq!(h.e.status(), Some(3));
        assert!(h.e.stopped());
        assert!(!h.e.retireable());
        assert!(!h.cancel());
        assert!(h.s.viewing());
        assert!(h.s.destination.is_some());
        assert!(h.s.source.is_some());
        assert!(h.s.held_call);
        assert_eq!(h.d.change(h.e.binding(), 1), Err(lease::Error::Busy));
        h.receipt(4, Outcome::Transferred).unwrap();
        assert_eq!(h.s.result(), Some(ResultValue::GuestLost));
        assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (4, 1));
        assert_eq!(h.e.status(), Some(3));
        assert!(h.e.retireable());
        h.assert_released();
    }
    #[test]
    fn synthetic_guest_loss_before_each_dispatch_does_not_authorize_more_work() {
        for phase in [Phase::CapReady, Phase::LoadingReady, Phase::OfferReady] {
            let mut h = Harness::new(phase == Phase::LoadingReady, false, 1);
            h.begin(6);
            if phase != Phase::CapReady {
                h.cap();
            }
            assert_eq!(h.s.phase(), phase);
            let action = h.token();
            h.e.receipt(&mut h.d, h.invocation, execution::Unwind::Fault)
                .unwrap();
            let result = match phase {
                Phase::CapReady => {
                    h.s.cap_start(&mut h.f, &mut h.d, &mut h.e, 9, action)
                        .map(|_| ())
                }
                Phase::LoadingReady => {
                    h.s.load_start(&mut h.f, &mut h.d, &mut h.e, 9, action)
                        .map(|_| ())
                }
                Phase::OfferReady => {
                    h.s.start(&mut h.f, &mut h.d, &mut h.e, 9, action)
                        .map(|_| ())
                }
                _ => unreachable!(),
            };
            assert!(matches!(result, Err(Error::Execution(_))));
            assert_eq!(h.s.result(), Some(ResultValue::GuestLost));
            assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (0, 0));
            h.assert_released();
        }
    }
    #[test]
    fn synthetic_guest_loss_during_loader_does_not_adopt_payload() {
        let mut h = Harness::new(true, false, 1);
        h.begin(6);
        h.cap();
        let action = h.token();
        let load =
            h.s.load_start(&mut h.f, &mut h.d, &mut h.e, 9, action)
                .unwrap();
        h.e.receipt(&mut h.d, h.invocation, execution::Unwind::Fault)
            .unwrap();
        let mut bytes = b"abcdef".to_vec();
        h.s.load_finish(
            &mut h.f, &mut h.d, &mut h.e, 9, action, load, true, &mut bytes,
        )
        .unwrap();
        assert_eq!(bytes, b"abcdef");
        assert_eq!(h.s.result(), Some(ResultValue::GuestLost));
        h.assert_released();
    }
    #[test]
    fn synthetic_foreign_receipts_cannot_clear_another_live_view_or_consume_its_action() {
        let mut h = Harness::new(false, false, 0);
        h.begin(6);
        h.cap();
        h.start();
        let action = h.token();
        let mut foreign = Harness::new(false, false, 0);
        foreign.e = Execution::new(77, foreign.e.binding());
        foreign.f = Files::new(
            999,
            Tree::new(999, 2, 2, 64, root_owned(0o755)).unwrap(),
            Limits {
                contexts: 0,
                tables: 1,
                descriptions: 1,
                slots: 1,
            },
        );
        let mut other_domain = Domain::new(999, 1, 2).unwrap();
        other_domain.bind(1).unwrap();
        assert!(h
            .s
            .receipt(
                &mut h.f,
                &mut other_domain,
                &mut h.e,
                9,
                action,
                2,
                Outcome::Transferred
            )
            .is_err());
        assert!(h
            .s
            .receipt(
                &mut h.f,
                &mut h.d,
                &mut foreign.e,
                9,
                action,
                2,
                Outcome::Transferred
            )
            .is_err());
        assert!(h
            .s
            .receipt(
                &mut h.f,
                &mut h.d,
                &mut h.e,
                9,
                Token::from_parts(11, 999),
                2,
                Outcome::Transferred
            )
            .is_err());
        let id = h.s.identity().unwrap();
        assert!(h
            .s
            .access_ended(&foreign.f, &h.d, &h.e, AccessEnded(id))
            .is_err());
        let mut bad = id;
        bad.capture.args[0] += 1;
        assert!(h
            .s
            .access_ended(&h.f, &h.d, &h.e, AccessEnded(bad))
            .is_err());
        assert!(h.s.viewing());
        assert_eq!(h.s.confirmed(), 0);
        assert_eq!(h.s.phase(), Phase::Started);
        assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (0, 0));
        assert_eq!(h.d.retire(action), Err(lease::Error::Incomplete));
        h.receipt(2, Outcome::Transferred).unwrap();
        assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (2, 1));
        h.assert_released();
    }
    #[test]
    fn synthetic_all_confirmed_unknown_still_retains_guard_and_action_until_stop() {
        for count in [0, 6] {
            let mut h = Harness::new(false, false, 0);
            h.begin(count);
            h.cap();
            h.start();
            h.receipt(count, Outcome::Unknown).unwrap();
            let action = h.token();
            assert!(h.s.viewing());
            assert!(h.s.source.is_some());
            assert!(h.s.destination.is_some());
            assert!(h.s.held_call);
            assert_eq!(h.d.retire(action), Err(lease::Error::Incomplete));
            assert!(!h.cancel());
            assert!(h.s.viewing());
            h.receipt(count, Outcome::Transferred).unwrap();
            assert_eq!(h.f.offset(&h.t, h.fd).unwrap().0, count);
            assert!(h.s.closed());
            h.assert_released();
        }
    }
    #[test]
    fn synthetic_guest_loss_during_cap_proof_releases_without_loading() {
        let mut h = Harness::new(true, false, 0);
        h.begin(6);
        let request = h.request();
        h.e.receipt(&mut h.d, h.invocation, execution::Unwind::Fault)
            .unwrap();
        assert!(!h.e.retireable());
        h.s.cap_finish(
            &mut h.f,
            &mut h.d,
            &mut h.e,
            CapabilityReceipt {
                identity: request.0,
                accepted: true,
            },
        )
        .unwrap();
        assert_eq!(h.s.result(), Some(ResultValue::GuestLost));
        h.assert_released();
        assert!(h.e.retireable());
        let mut prep = h.f.begin_read(&h.t, h.fd, 6).unwrap();
        let load = h.f.prepare_read(&mut prep).unwrap().unwrap();
        assert_eq!(load.attempt, 1);
        h.f.finish_load(&mut prep, load.attempt, false, &mut Vec::new())
            .unwrap();
        h.f.abort_preparation(prep).unwrap();
    }
    #[test]
    fn synthetic_fd_int_narrowing_keeps_full_original_args() {
        let mut h = Harness::new(false, false, 0);
        let args = [(99u64 << 32) | 1, (88u64 << 32) | h.fd as u64, 0, 6, 0, 0];
        h.s.begin(&mut h.f, &h.t, &mut h.d, &mut h.e, h.invocation, 9, args)
            .unwrap();
        assert_eq!(h.s.arguments(), Some(args));
        h.cap();
        h.start();
        h.receipt(2, Outcome::Transferred).unwrap();
        assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (2, 1));
        assert_eq!(h.s.result(), Some(ResultValue::Return(2)));
    }
    #[test]
    fn synthetic_unsupported_offset_and_direction_do_not_publish_call_or_source() {
        let mut h = Harness::new(true, false, 1);
        assert_eq!(
            h.s.begin(
                &mut h.f,
                &h.t,
                &mut h.d,
                &mut h.e,
                h.invocation,
                9,
                [1, h.fd as u64, 8, 6, 0, 0]
            ),
            Err(Error::Unsupported40)
        );
        assert_eq!(h.s.phase(), Phase::Idle);
        assert!(h.e.syscall_allowed(h.invocation).is_ok());
        assert_eq!(
            h.s.begin(
                &mut h.f,
                &h.t,
                &mut h.d,
                &mut h.e,
                h.invocation,
                9,
                [0, h.fd as u64, 0, 6, 0, 0]
            ),
            Err(Error::Files(descriptor::Error::BadFd))
        );
        assert!(h.s.finished());
        assert!(!h.s.closed());
        assert_eq!(h.s.result(), Some(ResultValue::AdmissionFailed));
        assert!(h.e.syscall_allowed(h.invocation).is_ok());
    }
    #[test]
    fn synthetic_transport_sequence_range_rejects_before_any_admission() {
        let mut h = Harness::new(true, false, 0);
        for sequence in [0, i32::MAX as u32 + 1, u32::MAX] {
            assert_eq!(
                h.s.begin(
                    &mut h.f,
                    &h.t,
                    &mut h.d,
                    &mut h.e,
                    h.invocation,
                    sequence,
                    [1, h.fd as u64, 0, 6, 0, 0]
                ),
                Err(Error::State)
            );
            assert_eq!(h.s.phase(), Phase::Idle);
            assert!(h.s.capture.is_none());
            assert!(h.s.destination.is_none());
            assert!(h.s.preparation.is_none());
            assert!(h.e.syscall_allowed(h.invocation).is_ok());
        }
        h.s.begin(
            &mut h.f,
            &h.t,
            &mut h.d,
            &mut h.e,
            h.invocation,
            i32::MAX as u32,
            [1, h.fd as u64, 0, 6, 0, 0],
        )
        .unwrap();
        let action = h.token();
        assert!(h
            .s
            .cancel(&mut h.f, &mut h.d, &mut h.e, i32::MAX as u32, action)
            .unwrap());
    }

    #[test]
    fn synthetic_stolen_call_cleanup_failure_retains_then_retries_without_double_commit() {
        for guest_fault in [false, true] {
            let mut h = Harness::new(false, false, 0);
            h.begin(6);
            h.cap();
            h.start();
            let action = h.token();
            // SYNTHETIC INTERNAL FAULT INJECTION: stealing this call violates
            // the sole-owner contract. Production must exclude generic callers
            // from finishing it. This is not a host/global guard proof.
            h.e.finish_call(h.invocation).unwrap();
            assert_eq!(
                h.receipt(3, Outcome::Transferred),
                Err(Error::Execution(execution::Error::Identity))
            );
            assert_eq!(h.s.phase(), Phase::Closing);
            assert!(!h.s.finished());
            assert_eq!(h.s.result(), None); // Never expose a Return before cleanup.
            assert!(!h.s.viewing());
            assert_eq!(h.s.confirmed(), 3);
            assert!(h.s.source.is_none()); // Prefix already committed exactly once.
            assert!(h.s.preparation.is_none());
            assert!(h.s.destination.is_none());
            assert!(h.s.action().is_none()); // Effect already retired, yet retry works.
            assert!(h.s.held_call);
            assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (3, 1));
            assert_eq!(h.d.retire(action), Err(lease::Error::UnknownAction));
            let mut foreign_files = Files::new(
                999,
                Tree::new(999, 2, 2, 64, root_owned(0o755)).unwrap(),
                Limits {
                    contexts: 0,
                    tables: 1,
                    descriptions: 1,
                    slots: 1,
                },
            );
            let mut foreign_domain = Domain::new(999, 1, 2).unwrap();
            let binding = foreign_domain.bind(1).unwrap();
            let mut foreign_execution = Execution::new(999, binding);
            assert!(h
                .s
                .retry_cleanup(&mut foreign_files, &mut h.d, &mut h.e)
                .is_err());
            assert!(h
                .s
                .retry_cleanup(&mut h.f, &mut foreign_domain, &mut h.e)
                .is_err());
            assert!(h
                .s
                .retry_cleanup(&mut h.f, &mut h.d, &mut foreign_execution)
                .is_err());
            assert_eq!(h.s.phase(), Phase::Closing);
            assert!(h.s.held_call);
            assert_eq!(h.s.result(), None);
            assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (3, 1));
            // Restore the intentionally stolen call using the ordinary API.
            // In the fault branch, actual invocation unwind then changes only
            // guest liveness, not the already settled source/effect evidence.
            h.e.hold_call(h.invocation).unwrap();
            if guest_fault {
                h.e.receipt(&mut h.d, h.invocation, execution::Unwind::Fault)
                    .unwrap();
                assert!(h.e.stopped());
                assert!(!h.e.retireable());
            }
            h.s.retry_cleanup(&mut h.f, &mut h.d, &mut h.e).unwrap();
            h.assert_released();
            assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (3, 1));
            if guest_fault {
                assert!(h.s.closed());
                assert_eq!(h.s.result(), Some(ResultValue::GuestLost));
                assert!(h.e.retireable());
            } else {
                assert!(!h.s.closed());
                assert_eq!(h.s.result(), Some(ResultValue::Return(3)));
                assert!(h.e.syscall_allowed(h.invocation).is_ok());
            }
            assert!(h.s.retry_cleanup(&mut h.f, &mut h.d, &mut h.e).is_err());
            assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (3, 1));
        }
    }
    #[test]
    fn synthetic_dropping_unfinished_owner_does_not_raii_release_cursor_call_or_effect() {
        for unknown in [false, true] {
            let mut h = Harness::new(false, false, 0);
            let alias = h.f.dup(&h.t, h.fd, 0, false).unwrap();
            h.begin(6);
            h.cap();
            h.start();
            if unknown {
                h.receipt(2, Outcome::Unknown).unwrap();
            }
            let action = h.token();
            let unfinished = std::mem::replace(&mut h.s, Sendfile::new(&h.f));
            // SYNTHETIC OWNER-CONTRACT VIOLATION: a future Continuation MUST
            // retain this owner. Its object-local view guard disappears on drop,
            // so this does NOT prove global view safety or generic-token exclusion.
            // It tests only that drop is not backing/call/effect stopping evidence.
            drop(unfinished);
            assert_eq!(h.f.offset(&h.t, alias).unwrap(), (0, 0));
            assert_eq!(h.f.set_offset(&h.t, alias, 0), Err(descriptor::Error::Busy));
            assert!(h.e.syscall_allowed(h.invocation).is_err());
            assert_eq!(h.d.retire(action), Err(lease::Error::Incomplete));
            h.e.receipt(&mut h.d, h.invocation, execution::Unwind::Fault)
                .unwrap();
            assert!(h.e.stopped());
            assert!(!h.e.retireable()); // The pending call remains outstanding.
            assert_eq!(h.d.change(h.e.binding(), 1), Err(lease::Error::Busy));
            assert_eq!(h.f.set_offset(&h.t, alias, 0), Err(descriptor::Error::Busy));
            // Intentionally quarantined until the fixture Files/Domain drop;
            // no fabricated late completion attempts to reconstruct the owner.
        }
    }

    #[test]
    fn synthetic_live_foreign_execution_and_issued_action_cannot_finish_another_owner() {
        let mut h = Harness::new(false, false, 0);
        h.begin(6);
        h.cap();
        let action_a = h.token();
        let inode = h.f.inode(&h.t, h.fd).unwrap();
        let fd_b = h.f.open(&h.t, inode, false).unwrap();
        let binding_b = h.d.bind(1).unwrap();
        let mut execution_b = Execution::new(77, binding_b);
        execution_b.image_begin(&mut h.d, 1).unwrap();
        execution_b
            .image_finish(&mut h.d, execution::ImageResult::Installed)
            .unwrap();
        let invocation_b = execution_b.start(&mut h.d).unwrap();
        let mut b = Sendfile::new(&h.f);
        b.begin(
            &mut h.f,
            &h.t,
            &mut h.d,
            &mut execution_b,
            invocation_b,
            9,
            [1, fd_b as u64, 0, 6, 0x77, 0x88],
        )
        .unwrap();
        let action_b = b.action().unwrap();
        assert_ne!(action_a, action_b); // Actually issued by the same Domain issuer.
        let request_b = b
            .cap_start(&mut h.f, &mut h.d, &mut execution_b, 9, action_b)
            .unwrap();
        let identity_b = request_b.0;
        b.cap_finish(
            &mut h.f,
            &mut h.d,
            &mut execution_b,
            CapabilityReceipt {
                identity: request_b.0,
                accepted: true,
            },
        )
        .unwrap();
        assert_eq!(b.phase(), Phase::OfferReady);
        assert_eq!(execution_b.phase(), execution::Phase::Running);
        assert_eq!(h.f.inode(&h.t, fd_b).unwrap(), inode);
        b.start(&mut h.f, &mut h.d, &mut execution_b, 9, action_b)
            .unwrap();
        b.receipt(
            &mut h.f,
            &mut h.d,
            &mut execution_b,
            9,
            action_b,
            0,
            Outcome::Unknown,
        )
        .unwrap();
        b.access_ended(&h.f, &h.d, &execution_b, AccessEnded(identity_b))
            .unwrap();
        assert_eq!(b.phase(), Phase::Unknown);
        assert!(!b.viewing());

        // Both owners and B's token/identity are real admitted component values;
        // capability/access evidence is synthetic. B's action can really accept
        // late Stopped, so a missing owner check cannot pass merely because
        // Domain rejects a Ready token as NotExecuting. This tests misdelivery
        // to A, NOT global ABI exclusion: B's own receipt is called only after
        // A ends its view, and their canonical views never overlap.
        h.start();
        let identity_a = h.s.identity().unwrap();
        assert_eq!(
            h.s.receipt(
                &mut h.f,
                &mut h.d,
                &mut h.e,
                9,
                action_b,
                3,
                Outcome::Transferred,
            ),
            Err(Error::State)
        );
        assert_eq!(
            h.s.receipt(
                &mut h.f,
                &mut h.d,
                &mut execution_b,
                9,
                action_a,
                3,
                Outcome::Transferred,
            ),
            Err(Error::Execution(execution::Error::Identity))
        );
        assert_eq!(
            h.s.access_ended(&h.f, &h.d, &h.e, AccessEnded(identity_b)),
            Err(Error::State)
        );
        assert_eq!(
            h.s.access_ended(&h.f, &h.d, &execution_b, AccessEnded(identity_a)),
            Err(Error::Execution(execution::Error::Identity))
        );
        assert_eq!(h.s.phase(), Phase::Started);
        assert!(h.s.viewing());
        assert_eq!(h.s.confirmed(), 0);
        assert!(h.s.source.is_some());
        assert!(h.s.destination.is_some());
        assert!(h.s.held_call);
        assert_eq!(h.s.action(), Some(action_a));
        assert_eq!(b.phase(), Phase::Unknown);
        assert!(!b.viewing());
        assert!(b.closed());
        assert_eq!(b.confirmed(), 0);
        assert!(b.source.is_some());
        assert!(b.destination.is_some());
        assert!(b.held_call);
        assert_eq!(b.action(), Some(action_b));
        assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (0, 0));
        assert_eq!(h.f.offset(&h.t, fd_b).unwrap(), (0, 0));
        assert!(h.e.syscall_allowed(h.invocation).is_err());
        assert!(execution_b.syscall_allowed(invocation_b).is_err());
        assert_eq!(h.d.retire(action_a), Err(lease::Error::Incomplete));
        assert_eq!(h.d.retire(action_b), Err(lease::Error::Incomplete));

        h.receipt(3, Outcome::Transferred).unwrap();
        h.assert_released();
        assert_eq!(h.s.result(), Some(ResultValue::Return(3)));
        assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (3, 1));
        assert_eq!(h.f.offset(&h.t, fd_b).unwrap(), (0, 0));
        assert_eq!(b.phase(), Phase::Unknown);
        // Only B's own late Stopped evidence can now retire its actual action.
        b.receipt(
            &mut h.f,
            &mut h.d,
            &mut execution_b,
            9,
            action_b,
            0,
            Outcome::Transferred,
        )
        .unwrap();
        assert!(b.finished());
        assert!(b.closed());
        assert_eq!(b.result(), Some(ResultValue::TransportFailed));
        assert!(b.source.is_none());
        assert!(b.destination.is_none());
        assert!(b.action().is_none());
        assert!(!b.held_call);
        assert!(h.e.syscall_allowed(h.invocation).is_ok());
        assert!(execution_b.syscall_allowed(invocation_b).is_ok());
        assert_eq!(h.d.retire(action_a), Err(lease::Error::UnknownAction));
        assert_eq!(h.d.retire(action_b), Err(lease::Error::UnknownAction));
        assert!(h
            .s
            .receipt(
                &mut h.f,
                &mut h.d,
                &mut h.e,
                9,
                action_a,
                3,
                Outcome::Transferred,
            )
            .is_err());
        assert!(b
            .receipt(
                &mut h.f,
                &mut h.d,
                &mut execution_b,
                9,
                action_b,
                0,
                Outcome::Transferred,
            )
            .is_err());
        assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (3, 1));
        assert_eq!(h.f.offset(&h.t, fd_b).unwrap(), (0, 1));
    }

    #[test]
    fn synthetic_nonempty_stopped_zero_settles_once_without_qualifying_guest_zero() {
        for (mode, expected) in [
            (0, ResultValue::TransportFailed),
            (1, ResultValue::TransportFailed),
            (2, ResultValue::Cancelled),
            (3, ResultValue::GuestLost),
        ] {
            let mut h = Harness::new(false, false, 0);
            let alias = h.f.dup(&h.t, h.fd, 0, false).unwrap();
            h.begin(6);
            h.cap();
            h.start();
            let action = h.token();
            assert_eq!(h.s.offered(), 6);
            assert_eq!(h.f.set_offset(&h.t, alias, 0), Err(descriptor::Error::Busy));
            match mode {
                1 => {
                    h.receipt(0, Outcome::Unknown).unwrap();
                    assert!(h.s.viewing());
                    assert_eq!(h.d.retire(action), Err(lease::Error::Incomplete));
                    h.s.access_ended(&h.f, &h.d, &h.e, h.s.synthetic_access_ended().unwrap())
                        .unwrap();
                    assert!(!h.s.viewing());
                    assert!(h.s.source.is_some());
                    assert!(h.s.destination.is_some());
                    assert!(h.s.held_call);
                    assert_eq!(h.f.set_offset(&h.t, alias, 0), Err(descriptor::Error::Busy));
                }
                2 => {
                    assert!(!h.cancel());
                }
                3 => {
                    h.e.receipt(&mut h.d, h.invocation, execution::Unwind::Fault)
                        .unwrap();
                }
                _ => {}
            }
            // Valid stopped evidence is accepted, not rejected as malformed or
            // turned into Unknown merely because its guest result is unqualified.
            h.receipt(0, Outcome::Transferred).unwrap();
            assert_eq!(h.s.confirmed(), 0);
            assert_eq!(h.s.phase(), Phase::Terminal);
            assert_eq!(h.s.result(), Some(expected));
            assert!(h.s.closed());
            h.assert_released();
            assert_eq!(h.f.offset(&h.t, alias).unwrap(), (0, 1));
            assert_eq!(h.f.offset(&h.t, h.fd).unwrap(), (0, 1));
            assert_eq!(h.d.retire(action), Err(lease::Error::UnknownAction));
            assert_eq!(h.d.start(action), Err(lease::Error::UnknownAction));
            assert!(h.s.start(&mut h.f, &mut h.d, &mut h.e, 9, action).is_err());
            assert!(h
                .s
                .receipt(
                    &mut h.f,
                    &mut h.d,
                    &mut h.e,
                    9,
                    action,
                    0,
                    Outcome::Transferred
                )
                .is_err());
            assert_eq!(h.f.offset(&h.t, alias).unwrap(), (0, 1));
            // Clear reading reservation without manufacturing another revision.
            let prep = h.f.begin_read(&h.t, alias, 1).unwrap();
            h.f.abort_preparation(prep).unwrap();
            assert_eq!(h.f.offset(&h.t, alias).unwrap(), (0, 1));
            assert_eq!(
                h.e.finish_call(h.invocation),
                Err(execution::Error::Identity)
            );
            if mode != 3 {
                assert!(h.e.syscall_allowed(h.invocation).is_ok());
                h.e.receipt(&mut h.d, h.invocation, execution::Unwind::Fault)
                    .unwrap();
            }
            assert!(h.e.retireable());
            let change = h.d.change(h.e.binding(), 1).unwrap();
            h.d.cancel(change).unwrap();
            h.d.retire(change).unwrap();
            // After both source slots and destination slot close, exactly the
            // other two stdio descriptions remain. All six spare records admit:
            // neither source nor destination operation refs leaked on Stopped0.
            h.f.close(&h.t, h.fd).unwrap();
            h.f.close(&h.t, alias).unwrap();
            h.f.close(&h.t, 1).unwrap();
            let mut admitted = 0;
            loop {
                match h.f.open(&h.t, h.other, false) {
                    Ok(_) => admitted += 1,
                    Err(descriptor::Error::Capacity) => break,
                    other => panic!("unexpected description admission {other:?}"),
                }
            }
            assert_eq!(admitted, 6);
        }
    }
}
