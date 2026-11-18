//! Private execution/image identity for the managed owner. No scheduler, syscall
//! dispatcher or guest runner is implemented here. Host unwind evidence is trusted;
//! exit requests and traps alone never release a running backing. The embedding
//! owns exactly one execution per ID and does not recreate IDs in a live domain.
use crate::effect::{Completion, Token};
use crate::lease::{self, Domain, RunHold};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Error {
    State,
    Identity,
    Exhausted,
    Lease(lease::Error),
}
impl From<lease::Error> for Error {
    fn from(e: lease::Error) -> Self {
        Self::Lease(e)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Phase {
    Empty,
    Ready,
    Running,
    Uncertain,
    Suspended,
    Exited,
    Failed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Snapshot {
    domain: u64,
    execution: u64,
    image: u64,
    binding: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Invocation {
    identity: Snapshot,
    number: u64,
}
impl Invocation {
    pub(crate) fn number(self) -> u64 {
        self.number
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ImageResult {
    Installed,
    Untouched,
    PoisonedStopped,
    Unknown,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Unwind {
    Yield(u64),
    Exit,
    Fault,
    Unknown,
}
struct ImageChange {
    initializing: bool,
    extent: u64,
    token: Token,
    generation: u64,
    prior: Phase,
}

pub(crate) struct Execution {
    id: u64,
    domain: Option<u64>,
    binding: u64,
    image: u64,
    next_image: Option<u64>,
    next_invocation: Option<u64>,
    phase: Phase,
    changing: Option<ImageChange>,
    running: Option<(Invocation, RunHold)>,
    pending_call: Option<Invocation>,
    exit_requested: Option<u32>,
    exit_status: Option<u32>,
    resume_at: Option<u64>,
}
impl Execution {
    pub(crate) fn new(id: u64, binding: u64) -> Self {
        Self {
            id,
            domain: None,
            binding,
            image: 0,
            next_image: Some(1),
            next_invocation: Some(1),
            phase: Phase::Empty,
            changing: None,
            running: None,
            pending_call: None,
            exit_requested: None,
            exit_status: None,
            resume_at: None,
        }
    }
    pub(crate) fn phase(&self) -> Phase {
        self.phase
    }
    /// Host stop evidence has settled the invocation/image, independently of
    /// pending syscall cleanup. Result observation does not create a run hold.
    pub(crate) fn stopped(&self) -> bool {
        matches!(self.phase, Phase::Exited | Phase::Failed)
            && self.changing.is_none()
            && self.running.is_none()
    }
    pub(crate) fn retireable(&self) -> bool {
        self.stopped() && self.pending_call.is_none()
    }
    /// Trusted host receipt: the admitted host has actually stopped before its
    /// first invocation. Read/source obligations are checked separately by owner.
    pub(crate) fn unstarted_stopped(&mut self) -> Result<(), Error> {
        if self.phase != Phase::Ready
            || self.next_invocation != Some(1)
            || self.changing.is_some()
            || self.running.is_some()
            || self.pending_call.is_some()
        {
            return Err(Error::State);
        }
        self.phase = Phase::Failed;
        Ok(())
    }
    pub(crate) fn initialization(&self) -> Option<(u64, u64)> {
        self.changing
            .as_ref()
            .filter(|c| c.initializing)
            .map(|c| (c.generation, c.extent))
    }
    pub(crate) fn binding(&self) -> u64 {
        self.binding
    }
    pub(crate) fn status(&self) -> Option<u32> {
        self.exit_status
    }
    pub(crate) fn resume_at(&self) -> Option<u64> {
        self.resume_at
    }
    pub(crate) fn owns(&self, token: Token) -> bool {
        self.changing.as_ref().is_some_and(|c| c.token == token)
    }
    pub(crate) fn identity(&self) -> Result<Snapshot, Error> {
        if self.changing.is_some()
            || !matches!(self.phase, Phase::Ready | Phase::Running | Phase::Suspended)
        {
            return Err(Error::State);
        }
        Ok(Snapshot {
            domain: self.domain.ok_or(Error::Identity)?,
            execution: self.id,
            image: self.image,
            binding: self.binding,
        })
    }
    pub(crate) fn check_domain(&self, domain: &Domain) -> Result<(), Error> {
        if self.domain == Some(domain.id()) {
            Ok(())
        } else {
            Err(Error::Identity)
        }
    }
    pub(crate) fn stamp(&self) -> Result<Snapshot, Error> {
        self.identity()
    }
    pub(crate) fn owns_snapshot(&self, snapshot: Snapshot) -> bool {
        self.domain == Some(snapshot.domain) && self.id == snapshot.execution
    }
    /// Exact retained metadata identity, including stopped/uncertain phases.
    /// This is not admission to run or access memory. New operations must still
    /// use check/syscall_allowed; an in-progress or installed reimage rejects.
    pub(crate) fn retains_snapshot(&self, snapshot: Snapshot) -> bool {
        self.changing.is_none()
            && self.domain == Some(snapshot.domain)
            && self.id == snapshot.execution
            && self.image == snapshot.image
            && self.binding == snapshot.binding
    }
    pub(crate) fn check(&self, identity: Snapshot) -> Result<(), Error> {
        if self.identity()? == identity {
            Ok(())
        } else {
            Err(Error::Identity)
        }
    }
    /// Admission immediately consumes host mutation permission. No callback or
    /// physical initialization may occur before this returns successfully.
    pub(crate) fn image_begin(&mut self, domain: &mut Domain, extent: u64) -> Result<(), Error> {
        if self.changing.is_some()
            || self.running.is_some()
            || self.pending_call.is_some()
            || self.phase == Phase::Exited
        {
            return Err(Error::State);
        }
        if self.domain.is_some_and(|id| id != domain.id()) {
            return Err(Error::Identity);
        }
        let generation = self.next_image.ok_or(Error::Exhausted)?;
        let token = domain.change(self.binding, extent)?;
        self.domain = Some(domain.id());
        domain.start(token).expect("new private image change");
        self.next_image = generation.checked_add(1);
        self.changing = Some(ImageChange {
            initializing: true,
            extent,
            token,
            generation,
            prior: self.phase,
        });
        Ok(())
    }
    /// Unknown retains exclusive change admission. PoisonedStopped means the
    /// physical mutation ended, NOT that a usable image was successfully built.
    pub(crate) fn image_finish(
        &mut self,
        domain: &mut Domain,
        outcome: ImageResult,
    ) -> Result<(), Error> {
        if self.domain != Some(domain.id()) {
            return Err(Error::Identity);
        }
        let c = self.changing.as_ref().ok_or(Error::State)?;
        let changed = matches!(
            outcome,
            ImageResult::Installed | ImageResult::PoisonedStopped
        );
        domain.receipt(
            c.token,
            u64::from(changed),
            if outcome == ImageResult::Unknown {
                Completion::Unknown
            } else {
                Completion::Stopped
            },
        )?;
        if outcome == ImageResult::Unknown {
            self.changing
                .as_mut()
                .expect("existing image change")
                .initializing = false;
            return Ok(());
        }
        let replacement = domain
            .retire(c.token)
            .expect("private stopped image change");
        let c = self.changing.take().unwrap();
        if changed {
            self.binding = replacement.expect("changed image incarnation");
            self.image = c.generation;
            self.phase = if outcome == ImageResult::Installed {
                Phase::Ready
            } else {
                Phase::Failed
            };
            self.resume_at = None;
            self.exit_requested = None;
        } else {
            self.phase = c.prior;
        }
        Ok(())
    }
    pub(crate) fn start(&mut self, domain: &mut Domain) -> Result<Invocation, Error> {
        if self.pending_call.is_some() || !matches!(self.phase, Phase::Ready | Phase::Suspended) {
            return Err(Error::State);
        }
        if self.domain != Some(domain.id()) {
            return Err(Error::Identity);
        }
        let identity = self.identity()?;
        let number = self.next_invocation.ok_or(Error::Exhausted)?;
        let hold = domain.hold_run(self.binding)?;
        let invocation = Invocation { identity, number };
        self.next_invocation = number.checked_add(1);
        self.running = Some((invocation, hold));
        self.phase = Phase::Running;
        Ok(invocation)
    }
    /// Recover only the current invocation, never construct a token from host IDs.
    pub(crate) fn invocation(&self, number: u64) -> Result<Invocation, Error> {
        self.running
            .as_ref()
            .map(|(i, _)| *i)
            .filter(|i| i.number == number)
            .ok_or(Error::Identity)
    }
    fn matches(&self, invocation: Invocation) -> Result<(), Error> {
        if self.running.as_ref().is_some_and(|(i, _)| *i == invocation) {
            Ok(())
        } else {
            Err(Error::Identity)
        }
    }
    pub(crate) fn fail_suspended(&mut self) -> Result<(), Error> {
        if self.phase != Phase::Suspended || self.running.is_some() || self.pending_call.is_some() {
            return Err(Error::State);
        }
        self.phase = Phase::Failed;
        Ok(())
    }
    pub(crate) fn syscall_allowed(&self, invocation: Invocation) -> Result<(), Error> {
        self.matches(invocation)?;
        if self.phase != Phase::Running
            || self.pending_call.is_some()
            || self.exit_requested.is_some()
        {
            return Err(Error::State);
        }
        Ok(())
    }
    pub(crate) fn hold_call(&mut self, invocation: Invocation) -> Result<(), Error> {
        self.syscall_allowed(invocation)?;
        self.pending_call = Some(invocation);
        Ok(())
    }
    /// Execution half of first-publication preflight. The operation owner must
    /// separately exclude a cancelled/closed sequence in the same Core turn.
    /// This neither acquires nor ends a call, and is not a stop receipt.
    pub(crate) fn check_held_call_live(&self, invocation: Invocation) -> Result<(), Error> {
        if self.pending_call != Some(invocation) {
            return Err(Error::Identity);
        }
        // Admission captured the current invocation and a pending call blocks
        // start/reimage. Only Running retains that current invocation live.
        if self.phase != Phase::Running || self.exit_requested.is_some() {
            return Err(Error::State);
        }
        Ok(())
    }
    pub(crate) fn finish_call(&mut self, invocation: Invocation) -> Result<(), Error> {
        if self.pending_call != Some(invocation) {
            return Err(Error::Identity);
        }
        self.pending_call = None;
        Ok(())
    }
    pub(crate) fn request_exit(
        &mut self,
        invocation: Invocation,
        status: u32,
    ) -> Result<(), Error> {
        self.matches(invocation)?;
        if self.phase != Phase::Running || self.exit_requested.is_some() {
            return Err(Error::State);
        }
        self.exit_requested = Some(status);
        Ok(())
    }
    /// Called only after the matching invocation has unwound, or with Unknown
    /// when that fact is unavailable. A host trap callback alone is insufficient.
    pub(crate) fn receipt(
        &mut self,
        domain: &mut Domain,
        invocation: Invocation,
        unwind: Unwind,
    ) -> Result<(), Error> {
        self.matches(invocation)?;
        if self.domain != Some(domain.id()) {
            return Err(Error::Identity);
        }
        if unwind == Unwind::Unknown {
            self.phase = Phase::Uncertain;
            return Ok(());
        }
        if unwind == Unwind::Exit && self.exit_requested.is_none() {
            return Err(Error::State);
        }
        if matches!(unwind, Unwind::Yield(_)) && self.exit_requested.is_some() {
            return Err(Error::State);
        }
        let (i, hold) = self.running.take().unwrap();
        if let Err((e, hold)) = domain.release_run(hold) {
            self.running = Some((i, hold));
            return Err(e.into());
        }
        match unwind {
            Unwind::Yield(at) => {
                self.phase = Phase::Suspended;
                self.resume_at = Some(at);
            }
            Unwind::Exit => {
                self.phase = Phase::Exited;
                self.exit_status = self.exit_requested.take();
            }
            Unwind::Fault => {
                self.phase = Phase::Failed;
                self.exit_requested = None;
            }
            Unwind::Unknown => unreachable!(),
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ready() -> (Domain, Execution) {
        let mut d = Domain::new(1, 1, 4).unwrap();
        let b = d.bind(16).unwrap();
        let mut e = Execution::new(7, b);
        e.image_begin(&mut d, 16).unwrap();
        e.image_finish(&mut d, ImageResult::Installed).unwrap();
        (d, e)
    }
    #[test]
    fn running_holds_lifetime_but_allows_read_span() {
        let (mut d, mut e) = ready();
        let i = e.start(&mut d).unwrap();
        assert_eq!(d.change(e.binding(), 32), Err(lease::Error::Busy));
        let read = d.span(e.binding(), 0, 4).unwrap();
        d.start(read).unwrap();
        e.request_exit(i, 3).unwrap();
        assert_eq!(e.phase(), Phase::Running);
        assert_eq!(d.change(e.binding(), 16), Err(lease::Error::Busy));
        e.receipt(&mut d, i, Unwind::Exit).unwrap();
        assert_eq!(e.status(), Some(3));
        assert_eq!(d.change(e.binding(), 16), Err(lease::Error::Busy));
        d.receipt(read, 4, Completion::Stopped).unwrap();
        d.retire(read).unwrap();
        assert!(d.change(e.binding(), 16).is_ok());
        assert_eq!(e.receipt(&mut d, i, Unwind::Exit), Err(Error::Identity));
    }
    #[test]
    fn uncertain_invocation_is_not_replayed_or_released() {
        let (mut d, mut e) = ready();
        let i = e.start(&mut d).unwrap();
        e.receipt(&mut d, i, Unwind::Unknown).unwrap();
        assert_eq!(e.start(&mut d), Err(Error::State));
        assert_eq!(d.change(e.binding(), 16), Err(lease::Error::Busy));
        e.receipt(&mut d, i, Unwind::Fault).unwrap();
        assert_eq!(e.phase(), Phase::Failed);
        assert!(e.stamp().is_err());
        assert!(d.change(e.binding(), 16).is_ok());
    }
    #[test]
    fn yield_resume_rejects_old_receipt_and_exit_without_request() {
        let (mut d, mut e) = ready();
        let stamp = e.stamp().unwrap();
        let first = e.start(&mut d).unwrap();
        assert_eq!(e.receipt(&mut d, first, Unwind::Exit), Err(Error::State));
        e.receipt(&mut d, first, Unwind::Yield(123)).unwrap();
        assert_eq!(e.resume_at(), Some(123));
        e.check(stamp).unwrap();
        let second = e.start(&mut d).unwrap();
        assert_ne!(first, second);
        assert_eq!(
            e.receipt(&mut d, first, Unwind::Fault),
            Err(Error::Identity)
        );
        assert_eq!(d.change(e.binding(), 16), Err(lease::Error::Busy));
        e.receipt(&mut d, second, Unwind::Fault).unwrap();
    }
    #[test]
    fn renew_same_extent_invalidates_snapshot_and_failed_image_is_not_ready() {
        let (mut d, mut e) = ready();
        let old = e.stamp().unwrap();
        let binding = e.binding();
        e.image_begin(&mut d, 16).unwrap();
        assert!(e.check(old).is_err());
        e.image_finish(&mut d, ImageResult::Unknown).unwrap();
        assert_eq!(d.span(binding, 0, 1), Err(lease::Error::Busy));
        e.image_finish(&mut d, ImageResult::PoisonedStopped)
            .unwrap();
        assert_eq!(e.phase(), Phase::Failed);
        assert_ne!(e.binding(), binding);
        assert_eq!(e.start(&mut d), Err(Error::State));
        e.image_begin(&mut d, 16).unwrap();
        e.image_finish(&mut d, ImageResult::Installed).unwrap();
        assert_eq!(e.check(old), Err(Error::Identity));
        assert_eq!(
            e.image_finish(&mut d, ImageResult::Installed),
            Err(Error::State)
        );
    }
    #[test]
    fn untouched_initialization_preserves_prior_image_and_foreign_domain_cannot_release() {
        let (mut d, mut e) = ready();
        let old = e.stamp().unwrap();
        e.image_begin(&mut d, 16).unwrap();
        e.image_finish(&mut d, ImageResult::Untouched).unwrap();
        e.check(old).unwrap();
        let mut foreign = Domain::new(2, 1, 4).unwrap();
        foreign.bind(16).unwrap();
        let i = e.start(&mut d).unwrap();
        assert_eq!(
            e.receipt(&mut foreign, i, Unwind::Fault),
            Err(Error::Identity)
        );
        assert_eq!(e.phase(), Phase::Running);
        assert_eq!(d.change(e.binding(), 16), Err(lease::Error::Busy));
        e.receipt(&mut d, i, Unwind::Fault).unwrap();
    }
    #[test]
    fn nonretaining_range_and_run_capacity_do_not_alias_copy_actions() {
        let mut d = Domain::new(10, 1, 1).unwrap();
        let b = d.bind(8).unwrap();
        d.range(b, 8, 0).unwrap();
        assert_eq!(d.range(b, 8, 1), Err(lease::Error::Range));
        let hold = d.hold_run(b).unwrap();
        assert!(matches!(d.hold_run(b), Err(lease::Error::Capacity)));
        let span = d.span(b, 0, 1).unwrap();
        d.cancel(span).unwrap();
        d.retire(span).unwrap();
        d.release_run(hold).unwrap();
        assert!(d.change(b, 8).is_ok());
        assert_eq!(d.range(b, 0, 0), Err(lease::Error::Busy));
    }
    #[test]
    fn foreign_image_finish_preserves_pending_change_and_invocation_lookup_is_current_only() {
        let (mut d, mut e) = ready();
        let mut foreign = Domain::new(2, 1, 4).unwrap();
        foreign.bind(16).unwrap();
        e.image_begin(&mut d, 16).unwrap();
        assert_eq!(
            e.image_finish(&mut foreign, ImageResult::Installed),
            Err(Error::Identity)
        );
        e.image_finish(&mut d, ImageResult::Installed).unwrap();
        let i = e.start(&mut d).unwrap();
        assert_eq!(e.invocation(i.number()), Ok(i));
        e.receipt(&mut d, i, Unwind::Yield(1)).unwrap();
        assert_eq!(e.invocation(i.number()), Err(Error::Identity));
        let j = e.start(&mut d).unwrap();
        assert_eq!(e.invocation(i.number()), Err(Error::Identity));
        e.request_exit(j, 0).unwrap();
        assert_eq!(e.receipt(&mut d, j, Unwind::Yield(2)), Err(Error::State));
        e.receipt(&mut d, j, Unwind::Exit).unwrap();
    }
    #[test]
    fn equal_numeric_execution_and_binding_in_foreign_domain_are_not_same_identity() {
        let (mut d, mut e) = ready();
        let stamp = e.stamp().unwrap();
        let mut foreign = Domain::new(44, 1, 4).unwrap();
        let binding = foreign.bind(16).unwrap();
        let mut other = Execution::new(7, binding);
        other.image_begin(&mut foreign, 16).unwrap();
        other
            .image_finish(&mut foreign, ImageResult::Installed)
            .unwrap();
        assert_eq!(other.binding(), e.binding());
        assert!(!other.owns_snapshot(stamp));
        assert_eq!(other.check(stamp), Err(Error::Identity));
        let invocation = e.start(&mut d).unwrap();
        other.start(&mut foreign).unwrap();
        assert_eq!(other.request_exit(invocation, 0), Err(Error::Identity));
    }
}

#[cfg(test)]
mod initialization_tests {
    use super::*;
    #[test]
    fn unknown_initialization_revokes_stack_construction_but_allows_late_stop() {
        let mut d = Domain::new(81, 1, 2).unwrap();
        let binding = d.bind(65536).unwrap();
        let mut e = Execution::new(82, binding);
        assert_eq!(e.initialization(), None);
        e.image_begin(&mut d, 131072).unwrap();
        assert_eq!(e.initialization().unwrap().1, 131072);
        e.image_finish(&mut d, ImageResult::Unknown).unwrap();
        assert_eq!(e.initialization(), None);
        e.image_finish(&mut d, ImageResult::PoisonedStopped)
            .unwrap();
        assert_eq!(e.initialization(), None);
    }
}

#[cfg(test)]
mod retirement_tests {
    use super::*;
    #[test]
    fn retirement_requires_stop_and_pending_call_completion() {
        let mut d = Domain::new(90, 1, 4).unwrap();
        let binding = d.bind(65536).unwrap();
        let mut e = Execution::new(1, binding);
        assert!(!e.retireable());
        e.image_begin(&mut d, 65536).unwrap();
        e.image_finish(&mut d, ImageResult::Installed).unwrap();
        assert!(!e.retireable());
        let invocation = e.start(&mut d).unwrap();
        e.hold_call(invocation).unwrap();
        e.receipt(&mut d, invocation, Unwind::Unknown).unwrap();
        assert!(!e.stopped());
        e.receipt(&mut d, invocation, Unwind::Fault).unwrap();
        assert!(e.stopped());
        assert!(!e.retireable());
        e.finish_call(invocation).unwrap();
        assert!(e.retireable());
    }

    #[test]
    fn live_held_call_admission_is_not_a_same_image_snapshot_or_call_acquisition() {
        let mut d = Domain::new(90, 1, 4).unwrap();
        let binding = d.bind(65536).unwrap();
        let mut e = Execution::new(1, binding);
        e.image_begin(&mut d, 65536).unwrap();
        e.image_finish(&mut d, ImageResult::Installed).unwrap();
        let first = e.start(&mut d).unwrap();
        assert_eq!(e.check_held_call_live(first), Err(Error::Identity));
        e.hold_call(first).unwrap();
        assert_eq!(e.check_held_call_live(first), Ok(()));
        assert_eq!(e.hold_call(first), Err(Error::State));
        e.receipt(&mut d, first, Unwind::Yield(7)).unwrap();
        assert_eq!(e.check_held_call_live(first), Err(Error::State));
        e.finish_call(first).unwrap();
        let second = e.start(&mut d).unwrap();
        assert_eq!(first.identity, second.identity);
        assert_ne!(first.number(), second.number());
        e.hold_call(second).unwrap();
        assert_eq!(e.check_held_call_live(first), Err(Error::Identity));
        assert_eq!(e.check_held_call_live(second), Ok(()));
        e.finish_call(second).unwrap();
        assert_eq!(e.check_held_call_live(second), Err(Error::Identity));
    }

    #[test]
    fn exit_or_uncertain_invocation_cannot_admit_first_publication_but_keeps_cleanup() {
        for (incarnation, unwind) in [(90, Unwind::Fault), (91, Unwind::Exit)] {
            let mut d = Domain::new(incarnation, 1, 4).unwrap();
            let binding = d.bind(65536).unwrap();
            let mut e = Execution::new(1, binding);
            e.image_begin(&mut d, 65536).unwrap();
            e.image_finish(&mut d, ImageResult::Installed).unwrap();
            let invocation = e.start(&mut d).unwrap();
            e.hold_call(invocation).unwrap();
            if unwind == Unwind::Exit {
                e.request_exit(invocation, 0).unwrap();
                assert_eq!(e.phase(), Phase::Running);
                assert_eq!(e.check_held_call_live(invocation), Err(Error::State));
            }
            e.receipt(&mut d, invocation, Unwind::Unknown).unwrap();
            assert_eq!(e.check_held_call_live(invocation), Err(Error::State));
            assert!(!e.stopped());
            e.receipt(&mut d, invocation, unwind).unwrap();
            assert_eq!(e.check_held_call_live(invocation), Err(Error::State));
            assert!(!e.retireable());
            e.finish_call(invocation).unwrap();
            assert!(e.retireable());
        }
    }
}

#[cfg(test)]
mod unstarted_stop_tests {
    use super::*;
    #[test]
    fn receipt_is_only_for_ready_never_invoked_image() {
        let mut d = Domain::new(91, 1, 4).unwrap();
        let binding = d.bind(65536).unwrap();
        let mut e = Execution::new(1, binding);
        assert_eq!(e.unstarted_stopped(), Err(Error::State));
        e.image_begin(&mut d, 65536).unwrap();
        assert_eq!(e.unstarted_stopped(), Err(Error::State));
        e.image_finish(&mut d, ImageResult::Installed).unwrap();
        assert_eq!(e.unstarted_stopped(), Ok(()));
        assert!(e.retireable());
        assert_eq!(e.unstarted_stopped(), Err(Error::State));
    }
    #[test]
    fn invocation_history_survives_unwind_and_new_image() {
        let mut d = Domain::new(92, 1, 4).unwrap();
        let binding = d.bind(65536).unwrap();
        let mut e = Execution::new(1, binding);
        e.image_begin(&mut d, 65536).unwrap();
        e.image_finish(&mut d, ImageResult::Installed).unwrap();
        let invocation = e.start(&mut d).unwrap();
        assert_eq!(e.unstarted_stopped(), Err(Error::State));
        e.receipt(&mut d, invocation, Unwind::Unknown).unwrap();
        assert_eq!(e.unstarted_stopped(), Err(Error::State));
        e.receipt(&mut d, invocation, Unwind::Yield(123)).unwrap();
        assert_eq!(e.unstarted_stopped(), Err(Error::State));
        e.image_begin(&mut d, 65536).unwrap();
        e.image_finish(&mut d, ImageResult::Installed).unwrap();
        assert_eq!(e.phase(), Phase::Ready);
        assert_eq!(e.unstarted_stopped(), Err(Error::State));
    }
}
