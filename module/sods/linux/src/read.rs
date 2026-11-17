//! Prepared-file read coordinator: original OFD reservation, Store-issued lazy
//! command, execution identity, and short memory-copy admission. Host loader
//! execution is external; Loading has no core view or guest span and an unknown
//! loader completion cannot be retired by cancellation alone. Requested ranges
//! are checked exactly before loading, not with guest read's prefix/errno rules.
//! No guest syscall, scheduler, mapping or readv integration is claimed. Sealed
//! Files exposes no arbitrary source mutation. No core view crosses a callback.
use crate::descriptor::{self, Files, LoadRequest, ReadHold, ReadPreparation, Table};
use crate::effect::{Completion, Token};
use crate::execution::{self, Execution, Snapshot};
use crate::lease::{self, Domain};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Error {
    Files(descriptor::Error),
    Execution(execution::Error),
    Lease(lease::Error),
    Capacity,
    BadRead,
    State,
    Range,
    Busy,
}
impl From<descriptor::Error> for Error {
    fn from(e: descriptor::Error) -> Self {
        Self::Files(e)
    }
}
impl From<lease::Error> for Error {
    fn from(e: lease::Error) -> Self {
        Self::Lease(e)
    }
}
impl From<execution::Error> for Error {
    fn from(e: execution::Error) -> Self {
        Self::Execution(e)
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Ready,
    Executing,
    Unknown,
    Finished,
    Cancelled,
    LoadingReady,
    Loading,
    Failed,
}
struct Pending {
    id: u64,
    hold: Option<ReadHold>,
    token: Option<Token>,
    preparation: Option<ReadPreparation>,
    load: Option<LoadRequest>,
    execution: Option<Snapshot>,
    binding: u64,
    domain: u64,
    at: u64,
    length: u64,
    confirmed: u64,
    phase: Phase,
    cancel: bool,
}
pub(crate) struct ReadCapacity(Vec<Option<Pending>>);
impl ReadCapacity {
    pub(crate) fn new(max: usize) -> Result<Self, Error> {
        let mut slots = Vec::new();
        slots.try_reserve_exact(max).map_err(|_| Error::Capacity)?;
        slots.resize_with(max, || None);
        Ok(Self(slots))
    }
}
pub(crate) struct Reads {
    owner: u64,
    slots: Vec<Option<Pending>>,
    next: Option<u64>,
    viewing: bool,
}
impl Reads {
    pub(crate) fn new(files: &Files, capacity: ReadCapacity) -> Self {
        Self {
            owner: files.owner(),
            slots: capacity.0,
            next: Some(1),
            viewing: false,
        }
    }
    // Files incarnation IDs are unique within the managed owner; never reused.
    // Check before any Domain transition, not after consuming effect permission.
    fn check_owner(&self, files: &Files) -> Result<(), Error> {
        if files.owner() == self.owner {
            Ok(())
        } else {
            Err(Error::Files(descriptor::Error::BadHandle))
        }
    }
    pub(crate) fn viewing(&self) -> bool {
        self.viewing
    }
    pub(crate) fn owns(&self, token: Token) -> bool {
        self.slots.iter().flatten().any(|p| p.token == Some(token))
    }
    fn index(&self, id: u64) -> Result<usize, Error> {
        self.slots
            .iter()
            .position(|p| p.as_ref().is_some_and(|p| p.id == id))
            .ok_or(Error::BadRead)
    }
    /// Exact requested-range admission is performed before any source attempt.
    /// This private contract is NOT guest read's partial-range clamp/errno ordering.
    pub(crate) fn begin_managed(
        &mut self,
        files: &mut Files,
        table: &Table,
        domain: &mut Domain,
        execution: &Execution,
        fd: u32,
        at: u64,
        requested: u64,
    ) -> Result<u64, Error> {
        self.check_owner(files)?;
        if self.viewing {
            return Err(Error::Busy);
        }
        let slot = self
            .slots
            .iter()
            .position(Option::is_none)
            .ok_or(Error::Capacity)?;
        let id = self.next.ok_or(Error::Capacity)?;
        execution.check_domain(domain)?;
        let snapshot = execution.stamp()?;
        let binding = execution.binding();
        domain.range(binding, if requested == 0 { 0 } else { at }, requested)?;
        let mut preparation = files.begin_read(table, fd, requested)?;
        let load = match files.prepare_read(&mut preparation) {
            Ok(load) => load,
            Err(error) => {
                // Even a source failure owns its original OFD until this abort.
                if let Err((cleanup, preparation)) = files.abort_preparation(preparation) {
                    self.next = id.checked_add(1);
                    self.slots[slot] = Some(Pending {
                        id,
                        hold: None,
                        token: None,
                        preparation: Some(preparation),
                        load: None,
                        execution: Some(snapshot),
                        binding,
                        domain: domain.id(),
                        at,
                        length: 0,
                        confirmed: 0,
                        phase: Phase::Failed,
                        cancel: false,
                    });
                    return Err(cleanup.into());
                }
                return Err(error.into());
            }
        };
        let mut pending = Pending {
            id,
            hold: None,
            token: None,
            preparation: Some(preparation),
            load,
            execution: Some(snapshot),
            binding,
            domain: domain.id(),
            at,
            length: 0,
            confirmed: 0,
            phase: Phase::LoadingReady,
            cancel: false,
        };
        if pending.load.is_none() {
            // A clean admission failure publishes no read; unexpected retained
            // obligations remain quarantined in the bounded internal slot.
            if let Err(error) = Self::prepare_copy(files, domain, execution, &mut pending) {
                if pending.preparation.is_some()
                    || pending.hold.is_some()
                    || pending.token.is_some()
                {
                    self.next = id.checked_add(1);
                    self.slots[slot] = Some(pending);
                }
                return Err(error);
            }
        }
        self.next = id.checked_add(1);
        self.slots[slot] = Some(pending);
        Ok(id)
    }
    fn abort_preparation(files: &mut Files, p: &mut Pending) -> Result<(), Error> {
        if let Some(preparation) = p.preparation.take() {
            if let Err((error, preparation)) = files.abort_preparation(preparation) {
                p.preparation = Some(preparation);
                return Err(error.into());
            }
        }
        Ok(())
    }
    fn prepare_copy(
        files: &mut Files,
        domain: &mut Domain,
        execution: &Execution,
        p: &mut Pending,
    ) -> Result<(), Error> {
        if let Err(error) = execution.check(p.execution.expect("managed identity")) {
            p.phase = Phase::Failed;
            Self::abort_preparation(files, p)?;
            return Err(error.into());
        }
        let preparation = p.preparation.take().expect("owned preparation");
        let hold = match files.capture_read(preparation) {
            Ok(hold) => hold,
            Err((error, preparation)) => {
                p.preparation = Some(preparation);
                p.phase = Phase::Failed;
                Self::abort_preparation(files, p)?;
                return Err(error.into());
            }
        };
        let length = hold.length() as u64;
        let token = match domain.span(p.binding, if length == 0 { 0 } else { p.at }, length) {
            Ok(token) => token,
            Err(error) => {
                files.abort_read(hold);
                p.phase = Phase::Failed;
                return Err(error.into());
            }
        };
        p.hold = Some(hold);
        p.token = Some(token);
        p.length = length;
        p.phase = Phase::Ready;
        Ok(())
    }
    /// Consumes exactly one permission to invoke the synchronous/async loader.
    /// Unknown host completion means no finish call: the source and OFD stay held.
    pub(crate) fn load_start(
        &mut self,
        files: &mut Files,
        execution: &Execution,
        id: u64,
    ) -> Result<(u32, u32), Error> {
        self.check_owner(files)?;
        if self.viewing {
            return Err(Error::Busy);
        }
        let i = self.index(id)?;
        let p = self.slots[i].as_mut().unwrap();
        if p.phase != Phase::LoadingReady {
            return Err(Error::State);
        }
        let snapshot = p.execution.unwrap();
        if !execution.owns_snapshot(snapshot) {
            return Err(Error::Execution(execution::Error::Identity));
        }
        if let Err(error) = execution.check(snapshot) {
            let attempt = p.load.as_ref().unwrap().attempt;
            let mut empty = Vec::new();
            let _ = files.finish_load(p.preparation.as_mut().unwrap(), attempt, false, &mut empty);
            p.phase = Phase::Failed;
            Self::abort_preparation(files, p)?;
            return Err(error.into());
        }
        let request = p.load.as_ref().unwrap();
        p.phase = Phase::Loading;
        Ok((request.source, request.attempt))
    }
    pub(crate) fn load_finish(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &Execution,
        id: u64,
        attempt: u32,
        success: bool,
        bytes: &mut Vec<u8>,
    ) -> Result<(), Error> {
        self.check_owner(files)?;
        if self.viewing {
            return Err(Error::Busy);
        }
        let i = self.index(id)?;
        let p = self.slots[i].as_mut().unwrap();
        if p.domain != domain.id() {
            return Err(Error::State);
        }
        if p.phase != Phase::Loading || p.load.as_ref().unwrap().attempt != attempt {
            return Err(Error::State);
        }
        let snapshot = p.execution.unwrap();
        if !execution.owns_snapshot(snapshot) {
            return Err(Error::Execution(execution::Error::Identity));
        }
        let identity = execution.check(snapshot);
        // A cancelled/stale result is retired without adopting any returned bytes.
        let adopt = success && !p.cancel && identity.is_ok();
        let loaded = files.finish_load(p.preparation.as_mut().unwrap(), attempt, adopt, bytes);
        if matches!(
            loaded,
            Err(descriptor::Error::Source(crate::inode::Error::Payload(
                sods_file_store::store::Error::BadCompletion
            )))
        ) {
            // The core's active attempt no longer matches: retain every owner.
            // Do not guess that this completion stopped that other attempt.
            identity?;
            return loaded.map_err(Into::into);
        }
        p.load = None;
        if !adopt || loaded.is_err() {
            p.phase = if identity.is_err() || (!p.cancel && (!success || loaded.is_err())) {
                Phase::Failed
            } else {
                Phase::Cancelled
            };
            Self::abort_preparation(files, p)?;
            identity?; // Execution loss wins over a simultaneous source failure.
            loaded?;
            return Ok(());
        }
        Self::prepare_copy(files, domain, execution, p)
    }
    pub(crate) fn start_managed(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        execution: &Execution,
        id: u64,
    ) -> Result<(usize, u64), Error> {
        self.check_owner(files)?;
        if self.viewing {
            return Err(Error::Busy);
        }
        let i = self.index(id)?;
        let p = self.slots[i].as_mut().unwrap();
        if p.domain != domain.id() {
            return Err(Error::State);
        }
        if p.phase != Phase::Ready {
            return Err(Error::State);
        }
        let snapshot = p.execution.ok_or(Error::State)?;
        if !execution.owns_snapshot(snapshot) {
            return Err(Error::Execution(execution::Error::Identity));
        }
        if let Err(error) = execution.check(snapshot) {
            domain.cancel(p.token.unwrap())?;
            domain.retire(p.token.take().unwrap())?;
            files.abort_read(p.hold.take().unwrap());
            p.phase = Phase::Failed;
            return Err(error.into());
        }
        self.start_copy(files, domain, id)
    }
    pub(crate) fn begin(
        &mut self,
        files: &mut Files,
        table: &Table,
        domain: &mut Domain,
        fd: u32,
        binding: u64,
        at: u64,
        requested: u64,
    ) -> Result<u64, Error> {
        self.check_owner(files)?;
        if self.viewing {
            return Err(Error::Busy);
        }
        let slot = self
            .slots
            .iter()
            .position(Option::is_none)
            .ok_or(Error::Capacity)?;
        let id = self.next.ok_or(Error::Capacity)?;
        let hold = files.reserve_read(table, fd, requested)?;
        let length = hold.length() as u64;
        let token = match domain.span(binding, if length == 0 { 0 } else { at }, length) {
            Ok(t) => t,
            Err(error) => {
                files.abort_read(hold);
                return Err(error.into());
            }
        };
        self.next = id.checked_add(1);
        self.slots[slot] = Some(Pending {
            id,
            hold: Some(hold),
            token: Some(token),
            preparation: None,
            load: None,
            execution: None,
            binding,
            domain: domain.id(),
            at,
            length,
            confirmed: 0,
            phase: Phase::Ready,
            cancel: false,
        });
        Ok(id)
    }
    pub(crate) fn start(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        id: u64,
    ) -> Result<(usize, u64), Error> {
        self.check_owner(files)?;
        let i = self.index(id)?;
        if self.slots[i].as_ref().unwrap().execution.is_some() {
            return Err(Error::State);
        }
        self.start_copy(files, domain, id)
    }
    fn start_copy(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        id: u64,
    ) -> Result<(usize, u64), Error> {
        if self.viewing {
            return Err(Error::Busy);
        }
        let i = self.index(id)?;
        let p = self.slots[i].as_mut().unwrap();
        if p.domain != domain.id() {
            return Err(Error::State);
        }
        if p.phase != Phase::Ready {
            return Err(Error::State);
        }
        domain.start(p.token.expect("ready copy span"))?;
        p.phase = Phase::Executing;
        self.viewing = true;
        let bytes = files.read_bytes(p.hold.as_ref().unwrap());
        Ok((
            if bytes.is_empty() {
                0
            } else {
                bytes.as_ptr() as usize
            },
            p.length,
        ))
    }
    /// Unknown also ends the private host's short core-view interval. It does
    /// not certify a guest copy count or release any operation/backing obligation.
    pub(crate) fn receipt(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        id: u64,
        confirmed: u64,
        completion: Completion,
    ) -> Result<(), Error> {
        self.check_owner(files)?;
        let i = self.index(id)?;
        let p = self.slots[i].as_mut().unwrap();
        if p.domain != domain.id() {
            return Err(Error::State);
        }
        if self.viewing && p.phase != Phase::Executing {
            return Err(Error::Busy);
        }
        if !matches!(p.phase, Phase::Executing | Phase::Unknown) {
            return Err(Error::State);
        }
        if confirmed < p.confirmed || confirmed > p.length {
            return Err(Error::Range);
        }
        domain.receipt(p.token.expect("active copy span"), confirmed, completion)?;
        if p.phase == Phase::Executing {
            self.viewing = false;
        }
        p.confirmed = confirmed;
        if completion == Completion::Unknown {
            p.phase = Phase::Unknown;
        } else {
            // All fallible preflight happened before copy. The pending reference
            // pins this description even if its last descriptor slot has closed.
            files.finish_read(p.hold.take().unwrap(), confirmed);
            // This coordinator alone owns the span token; no callback or other
            // core call can run between stopped receipt and retirement.
            assert_eq!(
                domain
                    .retire(p.token.take().unwrap())
                    .expect("stopped owned span"),
                None
            );
            p.phase = Phase::Finished;
        }
        Ok(())
    }
    pub(crate) fn cancel(
        &mut self,
        files: &mut Files,
        domain: &mut Domain,
        id: u64,
    ) -> Result<(), Error> {
        self.check_owner(files)?;
        let i = self.index(id)?;
        let p = self.slots[i].as_mut().unwrap();
        if p.domain != domain.id() {
            return Err(Error::State);
        }
        if self.viewing && p.phase != Phase::Executing {
            return Err(Error::Busy);
        }
        if matches!(p.phase, Phase::Finished | Phase::Cancelled | Phase::Failed) {
            return Ok(());
        }
        if matches!(p.phase, Phase::LoadingReady | Phase::Loading) {
            p.cancel = true;
            if p.phase == Phase::LoadingReady {
                let attempt = p.load.as_ref().unwrap().attempt;
                let mut empty = Vec::new();
                let result =
                    files.finish_load(p.preparation.as_mut().unwrap(), attempt, false, &mut empty);
                Self::abort_preparation(files, p)?;
                p.phase = Phase::Cancelled;
                result?;
            }
            return Ok(());
        }
        domain.cancel(p.token.expect("ready or active copy span"))?;
        p.cancel = true;
        if p.phase == Phase::Ready {
            files.abort_read(p.hold.take().unwrap());
            assert_eq!(
                domain
                    .retire(p.token.take().unwrap())
                    .expect("cancelled ready owned span"),
                None
            );
            p.phase = Phase::Cancelled;
        }
        Ok(())
    }
    pub(crate) fn query(&self, id: u64) -> Result<(u64, u64, u32), Error> {
        let p = self.slots[self.index(id)?].as_ref().unwrap();
        let state = match p.phase {
            Phase::Ready => 0,
            Phase::Executing => 1,
            Phase::Unknown => 2,
            Phase::Finished => 3,
            Phase::Cancelled => 4,
            Phase::LoadingReady => 5,
            Phase::Loading => 6,
            Phase::Failed => 7,
        };
        Ok((
            p.confirmed,
            p.length,
            state | if p.cancel { 256 } else { 0 },
        ))
    }
    pub(crate) fn retire(&mut self, id: u64) -> Result<(), Error> {
        if self.viewing {
            return Err(Error::Busy);
        }
        let i = self.index(id)?;
        let p = self.slots[i].as_ref().unwrap();
        if !matches!(p.phase, Phase::Finished | Phase::Cancelled | Phase::Failed)
            || p.preparation.is_some()
            || p.hold.is_some()
            || p.token.is_some()
        {
            return Err(Error::State);
        }
        // Terminal records retain observations only. Their source/OFD/span
        // obligations were released atomically at stopped receipt or cancellation.
        self.slots[i] = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::descriptor::Limits;
    use crate::inode::{Inode, Tree};
    fn setup() -> (Reads, Files, Table, Domain, u64, u32, Inode) {
        let mut tree = Tree::new(2, 4, 4, 32).unwrap();
        let root = tree.root();
        let a = tree
            .file_take(root, b"a", 0o600, &mut b"abcd".to_vec())
            .unwrap();
        let b = tree
            .file_take(root, b"b", 0o600, &mut b"xyz".to_vec())
            .unwrap();
        let mut files = Files::new(
            3,
            tree,
            Limits {
                contexts: 0,
                tables: 2,
                descriptions: 4,
                slots: 8,
            },
        );
        let table = files.table(8).unwrap();
        let fd = files.open(&table, a, false).unwrap();
        let reads = Reads::new(&files, ReadCapacity::new(3).unwrap());
        let mut domain = Domain::new(1, 1, 3).unwrap();
        let binding = domain.bind(16).unwrap();
        (reads, files, table, domain, binding, fd, b)
    }
    fn lazy_setup() -> (Reads, Files, Table, Domain, Execution, u32, Inode) {
        let mut tree = Tree::new(12, 8, 8, 32).unwrap();
        let lazy = tree.lazy_file(tree.root(), b"lazy", 0o600, 7, 1).unwrap();
        let other = tree
            .file_take(tree.root(), b"other", 0o600, &mut b"xyz".to_vec())
            .unwrap();
        let mut files = Files::new(
            13,
            tree,
            Limits {
                contexts: 0,
                tables: 2,
                descriptions: 8,
                slots: 16,
            },
        );
        let table = files.table(16).unwrap();
        let fd = files.open(&table, lazy, false).unwrap();
        let reads = Reads::new(&files, ReadCapacity::new(6).unwrap());
        let mut domain = Domain::new(11, 2, 8).unwrap();
        let binding = domain.bind(16).unwrap();
        let mut execution = Execution::new(14, binding);
        execution.image_begin(&mut domain, 16).unwrap();
        execution
            .image_finish(&mut domain, execution::ImageResult::Installed)
            .unwrap();
        (reads, files, table, domain, execution, fd, other)
    }
    #[test]
    fn managed_preflight_before_loading_and_copy_uses_actual_size() {
        let (mut r, mut f, t, mut d, e, fd, _) = lazy_setup();
        assert!(matches!(
            r.begin_managed(&mut f, &t, &mut d, &e, fd, 15, 4),
            Err(Error::Lease(lease::Error::Range))
        ));
        f.set_offset(&t, fd, 0).unwrap(); // failed admission acquired neither OFD nor loader
        let id = r.begin_managed(&mut f, &t, &mut d, &e, fd, 0, 4).unwrap();
        assert_eq!(r.query(id).unwrap().2, 5);
        let (source, attempt) = r.load_start(&mut f, &e, id).unwrap();
        assert_eq!(source, 7);
        assert_eq!(r.load_start(&mut f, &e, id), Err(Error::State));
        let mut bytes = b"abcd".to_vec();
        assert_eq!(
            r.load_finish(&mut f, &mut d, &e, id, attempt + 1, true, &mut bytes),
            Err(Error::State)
        );
        assert_eq!(bytes, b"abcd");
        r.load_finish(&mut f, &mut d, &e, id, attempt, true, &mut bytes)
            .unwrap();
        assert!(bytes.is_empty());
        assert_eq!(r.start(&mut f, &mut d, id), Err(Error::State));
        let (ptr, len) = r.start_managed(&mut f, &mut d, &e, id).unwrap();
        assert_eq!(len, 4); // hint was one byte
        assert_eq!(
            unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) },
            b"abcd"
        );
        r.receipt(&mut f, &mut d, id, 4, Completion::Stopped)
            .unwrap();
        assert_eq!(f.offset(&t, fd).unwrap().0, 4);
        r.retire(id).unwrap();
        f.set_offset(&t, fd, 0).unwrap();
        let warm = r.begin_managed(&mut f, &t, &mut d, &e, fd, 0, 1).unwrap();
        assert_eq!(r.query(warm).unwrap().2, 0); // retained source does not imply unloaded
        r.cancel(&mut f, &mut d, warm).unwrap();
    }
    #[test]
    fn managed_loader_cancel_after_start_holds_until_stopped_and_old_fd_only() {
        let (mut r, mut f, t, mut d, e, fd, other) = lazy_setup();
        let alias = f.dup(&t, fd, 0, false).unwrap();
        let id = r.begin_managed(&mut f, &t, &mut d, &e, fd, 0, 4).unwrap();
        let (_, attempt) = r.load_start(&mut f, &e, id).unwrap();
        r.cancel(&mut f, &mut d, id).unwrap();
        assert_eq!(r.query(id).unwrap().2, 262);
        assert_eq!(f.set_offset(&t, alias, 0), Err(descriptor::Error::Busy));
        assert_eq!(r.retire(id), Err(Error::State));
        f.close(&t, fd).unwrap();
        assert_eq!(f.open(&t, other, false).unwrap(), fd);
        let mut bytes = b"late".to_vec();
        r.load_finish(&mut f, &mut d, &e, id, attempt, true, &mut bytes)
            .unwrap();
        assert_eq!(bytes, b"late");
        assert_eq!(r.query(id).unwrap().2, 260);
        assert_eq!(f.offset(&t, fd).unwrap().0, 0);
        f.set_offset(&t, alias, 0).unwrap();
        r.retire(id).unwrap();
        let retry = r
            .begin_managed(&mut f, &t, &mut d, &e, alias, 0, 1)
            .unwrap();
        let (_, next) = r.load_start(&mut f, &e, retry).unwrap();
        assert_ne!(attempt, next);
        assert_eq!(
            r.load_finish(&mut f, &mut d, &e, retry, attempt, true, &mut bytes),
            Err(Error::State)
        );
        r.load_finish(&mut f, &mut d, &e, retry, next, false, &mut bytes)
            .unwrap();
        assert_eq!(r.query(retry).unwrap().2, 7);
    }
    #[test]
    fn managed_zero_and_cancel_before_loader_do_not_dispatch() {
        let (mut r, mut f, t, mut d, e, fd, _) = lazy_setup();
        let zero = r
            .begin_managed(&mut f, &t, &mut d, &e, fd, u64::MAX, 0)
            .unwrap();
        assert_eq!(r.start_managed(&mut f, &mut d, &e, zero), Ok((0, 0)));
        r.receipt(&mut f, &mut d, zero, 0, Completion::Stopped)
            .unwrap();
        r.retire(zero).unwrap();
        let id = r.begin_managed(&mut f, &t, &mut d, &e, fd, 0, 2).unwrap();
        r.cancel(&mut f, &mut d, id).unwrap();
        assert_eq!(r.load_start(&mut f, &e, id), Err(Error::State));
        assert_eq!(r.query(id).unwrap().2, 260);
        let retry = r.begin_managed(&mut f, &t, &mut d, &e, fd, 0, 2).unwrap();
        assert_eq!(r.query(retry).unwrap().2, 5);
    }
    #[test]
    fn managed_image_change_wins_over_loader_failure_and_blocks_copy() {
        let (mut r, mut f, t, mut d, mut e, fd, _) = lazy_setup();
        let id = r.begin_managed(&mut f, &t, &mut d, &e, fd, 0, 2).unwrap();
        let (_, attempt) = r.load_start(&mut f, &e, id).unwrap();
        e.image_begin(&mut d, 16).unwrap();
        e.image_finish(&mut d, execution::ImageResult::Installed)
            .unwrap();
        let mut bytes = b"late".to_vec();
        assert!(matches!(
            r.load_finish(&mut f, &mut d, &e, id, attempt, false, &mut bytes),
            Err(Error::Execution(_))
        ));
        assert_eq!(bytes, b"late");
        assert_eq!(r.query(id).unwrap().2, 7);
        f.set_offset(&t, fd, 0).unwrap();
        r.retire(id).unwrap();
    }
    #[test]
    fn managed_same_inode_nested_load_poisons_outer_but_unrelated_read_works() {
        let (mut r, mut f, t, mut d, e, fd, other) = lazy_setup();
        let inode = f.inode(&t, fd).unwrap();
        let other_ofd = f.open(&t, inode, false).unwrap();
        let unrelated = f.open(&t, other, false).unwrap();
        let id = r.begin_managed(&mut f, &t, &mut d, &e, fd, 0, 2).unwrap();
        let (_, attempt) = r.load_start(&mut f, &e, id).unwrap();
        assert!(r
            .begin_managed(&mut f, &t, &mut d, &e, other_ofd, 0, 2)
            .is_err());
        let nested = r
            .begin_managed(&mut f, &t, &mut d, &e, unrelated, 4, 1)
            .unwrap();
        r.start_managed(&mut f, &mut d, &e, nested).unwrap();
        r.receipt(&mut f, &mut d, nested, 1, Completion::Stopped)
            .unwrap();
        let mut bytes = b"ab".to_vec();
        assert!(r
            .load_finish(&mut f, &mut d, &e, id, attempt, true, &mut bytes)
            .is_err());
        assert_eq!(r.query(id).unwrap().2, 7);
        assert_eq!(bytes, b"ab");
        f.set_offset(&t, fd, 0).unwrap();
    }
    #[test]
    fn managed_exit_after_load_releases_copy_reservation_without_effect() {
        let (mut r, mut f, t, mut d, mut e, fd, _) = lazy_setup();
        let id = r.begin_managed(&mut f, &t, &mut d, &e, fd, 0, 2).unwrap();
        let (_, attempt) = r.load_start(&mut f, &e, id).unwrap();
        r.load_finish(&mut f, &mut d, &e, id, attempt, true, &mut b"ab".to_vec())
            .unwrap();
        let invocation = e.start(&mut d).unwrap();
        e.request_exit(invocation, 0).unwrap();
        e.receipt(&mut d, invocation, execution::Unwind::Exit)
            .unwrap();
        assert!(matches!(
            r.start_managed(&mut f, &mut d, &e, id),
            Err(Error::Execution(_))
        ));
        assert_eq!(r.query(id).unwrap().2, 7);
        assert_eq!(f.offset(&t, fd).unwrap().0, 0);
        f.set_offset(&t, fd, 0).unwrap();
        assert!(d.change(e.binding(), 32).is_ok());
        r.retire(id).unwrap();
    }
    #[test]
    fn managed_copy_span_revalidates_binding_after_unretained_loader_wait() {
        let (mut r, mut f, t, mut d, e, fd, _) = lazy_setup();
        let id = r.begin_managed(&mut f, &t, &mut d, &e, fd, 0, 2).unwrap();
        let (_, attempt) = r.load_start(&mut f, &e, id).unwrap();
        let change = d.change(e.binding(), 32).unwrap();
        d.start(change).unwrap();
        d.receipt(change, 1, Completion::Stopped).unwrap();
        d.retire(change).unwrap();
        assert!(matches!(
            r.load_finish(&mut f, &mut d, &e, id, attempt, true, &mut b"ab".to_vec()),
            Err(Error::Lease(lease::Error::UnknownMemory))
        ));
        assert_eq!(r.query(id).unwrap().2, 7);
        assert_eq!(f.offset(&t, fd).unwrap().0, 0);
        f.set_offset(&t, fd, 0).unwrap();
        r.retire(id).unwrap();
    }
    #[test]
    fn wrong_domain_completion_cannot_adopt_or_consume_loader_bytes() {
        let (mut r, mut f, t, mut d, e, fd, _) = lazy_setup();
        let mut other = Domain::new(999, 2, 8).unwrap();
        other.bind(16).unwrap();
        assert!(matches!(
            r.begin_managed(&mut f, &t, &mut other, &e, fd, 0, 2),
            Err(Error::Execution(_))
        ));
        let id = r.begin_managed(&mut f, &t, &mut d, &e, fd, 0, 2).unwrap();
        let (_, attempt) = r.load_start(&mut f, &e, id).unwrap();
        let mut bytes = b"ab".to_vec();
        assert_eq!(
            r.load_finish(&mut f, &mut other, &e, id, attempt, true, &mut bytes),
            Err(Error::State)
        );
        assert_eq!(bytes, b"ab");
        assert_eq!(r.query(id).unwrap().2, 6);
        r.load_finish(&mut f, &mut d, &e, id, attempt, true, &mut bytes)
            .unwrap();
        r.cancel(&mut f, &mut d, id).unwrap();
    }
    #[test]
    fn foreign_execution_cannot_retire_another_read_or_adopt_its_source() {
        let (mut r, mut f, t, mut d, e, fd, _) = lazy_setup();
        let foreign = Execution::new(999, e.binding());
        let id = r.begin_managed(&mut f, &t, &mut d, &e, fd, 0, 2).unwrap();
        assert!(matches!(
            r.load_start(&mut f, &foreign, id),
            Err(Error::Execution(execution::Error::Identity))
        ));
        assert_eq!(r.query(id).unwrap().2, 5);
        let (_, attempt) = r.load_start(&mut f, &e, id).unwrap();
        let mut bytes = b"ab".to_vec();
        assert!(matches!(
            r.load_finish(&mut f, &mut d, &foreign, id, attempt, true, &mut bytes),
            Err(Error::Execution(execution::Error::Identity))
        ));
        assert_eq!(bytes, b"ab");
        assert_eq!(r.query(id).unwrap().2, 6);
        r.load_finish(&mut f, &mut d, &e, id, attempt, true, &mut bytes)
            .unwrap();
        assert!(matches!(
            r.start_managed(&mut f, &mut d, &foreign, id),
            Err(Error::Execution(execution::Error::Identity))
        ));
        assert_eq!(r.query(id).unwrap().2, 0);
        assert_eq!(f.set_offset(&t, fd, 0), Err(descriptor::Error::Busy));
        r.start_managed(&mut f, &mut d, &e, id).unwrap();
        r.receipt(&mut f, &mut d, id, 2, Completion::Stopped)
            .unwrap();
        assert_eq!(f.offset(&t, fd).unwrap().0, 2);
    }
    #[test]
    fn canonical_copy_commits_original_description_after_fd_reuse() {
        let (mut r, mut files, table, mut d, m, fd, b) = setup();
        let alias = files.dup(&table, fd, 0, false).unwrap();
        let read = r.begin(&mut files, &table, &mut d, fd, m, 0, 3).unwrap();
        files.close(&table, fd).unwrap();
        assert_eq!(files.open(&table, b, false).unwrap(), fd);
        let (ptr, len) = r.start(&mut files, &mut d, read).unwrap();
        let copied = unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) }.to_vec();
        assert_eq!(copied, b"abc");
        r.receipt(&mut files, &mut d, read, 3, Completion::Stopped)
            .unwrap();
        assert_eq!(files.offset(&table, fd), Ok((0, 0)));
        assert_eq!(files.offset(&table, alias), Ok((3, 1)));
        assert_eq!(r.query(read), Ok((3, 3, 3)));
        r.retire(read).unwrap();
        assert_eq!(r.query(read), Err(Error::BadRead));
    }
    #[test]
    fn failed_span_rolls_back_only_read_preparation() {
        let (mut r, mut files, table, mut d, m, fd, _) = setup();
        assert_eq!(
            r.begin(&mut files, &table, &mut d, fd, m, 15, 4),
            Err(Error::Lease(lease::Error::Range))
        );
        assert_eq!(files.offset(&table, fd), Ok((0, 0)));
        files.set_offset(&table, fd, 1).unwrap();
        assert!(r.begin(&mut files, &table, &mut d, fd, m, 0, 3).is_ok());
    }
    #[test]
    fn unknown_copy_retains_offset_reservation_until_stopped() {
        let (mut r, mut files, table, mut d, m, fd, _) = setup();
        let read = r.begin(&mut files, &table, &mut d, fd, m, 0, 4).unwrap();
        r.start(&mut files, &mut d, read).unwrap();
        r.receipt(&mut files, &mut d, read, 2, Completion::Unknown)
            .unwrap();
        assert!(!r.viewing());
        assert_eq!(files.offset(&table, fd), Ok((0, 0)));
        assert_eq!(
            files.set_offset(&table, fd, 0),
            Err(descriptor::Error::Busy)
        );
        assert_eq!(r.start(&mut files, &mut d, read), Err(Error::State));
        r.cancel(&mut files, &mut d, read).unwrap();
        assert_eq!(r.query(read), Ok((2, 4, 258)));
        assert_eq!(r.retire(read), Err(Error::State));
        assert_eq!(d.change(m, 32), Err(lease::Error::Busy));
        assert_eq!(
            r.receipt(&mut files, &mut d, read, 1, Completion::Stopped),
            Err(Error::Range)
        );
        r.receipt(&mut files, &mut d, read, 3, Completion::Stopped)
            .unwrap();
        assert_eq!(files.offset(&table, fd), Ok((3, 1)));
        assert_eq!(r.query(read), Ok((3, 4, 259)));
        assert_eq!(
            r.receipt(&mut files, &mut d, read, 4, Completion::Stopped),
            Err(Error::State)
        );
        // Result observation need not block already-proven-safe memory mutation.
        assert!(d.change(m, 32).is_ok());
        r.retire(read).unwrap();
    }
    #[test]
    fn ready_cancel_does_not_advance_offset_and_remains_queryable() {
        let (mut r, mut files, table, mut d, m, fd, _) = setup();
        let read = r.begin(&mut files, &table, &mut d, fd, m, 0, 4).unwrap();
        r.cancel(&mut files, &mut d, read).unwrap();
        assert_eq!(r.query(read), Ok((0, 4, 260)));
        assert_eq!(files.offset(&table, fd), Ok((0, 0)));
        assert_eq!(r.start(&mut files, &mut d, read), Err(Error::State));
        r.retire(read).unwrap();
        assert!(r.begin(&mut files, &table, &mut d, fd, m, 0, 4).is_ok());
    }
    #[test]
    fn cancelled_result_observation_does_not_hold_guest_backing() {
        let (mut r, mut files, table, mut d, m, fd, _) = setup();
        let id = r.begin(&mut files, &table, &mut d, fd, m, 0, 2).unwrap();
        r.cancel(&mut files, &mut d, id).unwrap();
        assert_eq!(r.query(id), Ok((0, 2, 260)));
        assert!(d.change(m, 32).is_ok());
        r.retire(id).unwrap();
    }

    #[test]
    fn zero_requested_and_eof_do_not_touch_target_or_narrow_large_offset() {
        let (mut r, mut files, table, mut d, m, fd, _) = setup();
        let zero = r
            .begin(&mut files, &table, &mut d, fd, m, u64::MAX, 0)
            .unwrap();
        assert_eq!(r.start(&mut files, &mut d, zero), Ok((0, 0)));
        r.receipt(&mut files, &mut d, zero, 0, Completion::Stopped)
            .unwrap();
        assert_eq!(files.offset(&table, fd), Ok((0, 0)));
        r.retire(zero).unwrap();
        files.set_offset(&table, fd, u64::MAX).unwrap();
        let eof = r
            .begin(&mut files, &table, &mut d, fd, m, u64::MAX, u64::MAX)
            .unwrap();
        assert_eq!(r.start(&mut files, &mut d, eof), Ok((0, 0)));
        r.receipt(&mut files, &mut d, eof, 0, Completion::Stopped)
            .unwrap();
        assert_eq!(files.offset(&table, fd), Ok((u64::MAX, 2)));
    }
    #[test]
    fn read_budget_and_single_copy_interval_are_enforced() {
        let (mut r, mut files, table, mut d, m, fd, b) = setup();
        let other = files.open(&table, b, false).unwrap();
        let first = r.begin(&mut files, &table, &mut d, fd, m, 0, 2).unwrap();
        let second = r.begin(&mut files, &table, &mut d, other, m, 2, 2).unwrap();
        r.start(&mut files, &mut d, first).unwrap();
        assert_eq!(r.start(&mut files, &mut d, second), Err(Error::Busy));
        assert_eq!(r.cancel(&mut files, &mut d, second), Err(Error::Busy));
        assert_eq!(r.query(first), Ok((0, 2, 1)));
        r.receipt(&mut files, &mut d, first, 2, Completion::Stopped)
            .unwrap();
        r.cancel(&mut files, &mut d, second).unwrap();
        let third = r.begin(&mut files, &table, &mut d, fd, m, 4, 2).unwrap();
        assert_eq!(
            r.begin(&mut files, &table, &mut d, other, m, 6, 2),
            Err(Error::Capacity)
        );
        r.cancel(&mut files, &mut d, third).unwrap();
        r.retire(first).unwrap();
        assert!(r.begin(&mut files, &table, &mut d, other, m, 6, 2).is_ok());
    }
    #[test]
    fn foreign_files_rejected_before_effect_transitions() {
        let (mut r, mut files, table, mut d, m, fd, _) = setup();
        let mut foreign = Files::new(
            99,
            Tree::new(98, 2, 2, 32).unwrap(),
            Limits {
                contexts: 0,
                tables: 2,
                descriptions: 2,
                slots: 4,
            },
        );
        let foreign_table = foreign.table(4).unwrap();
        let bad = Error::Files(descriptor::Error::BadHandle);
        assert_eq!(
            r.begin(&mut foreign, &foreign_table, &mut d, fd, m, 0, 2),
            Err(bad)
        );
        assert_eq!(
            r.begin(&mut files, &foreign_table, &mut d, fd, m, 0, 2),
            Err(Error::Files(descriptor::Error::BadHandle))
        );
        let id = r.begin(&mut files, &table, &mut d, fd, m, 0, 2).unwrap();
        assert_eq!(
            r.start(&mut foreign, &mut d, id),
            Err(Error::Files(descriptor::Error::BadHandle))
        );
        assert_eq!(
            r.cancel(&mut foreign, &mut d, id),
            Err(Error::Files(descriptor::Error::BadHandle))
        );
        assert_eq!(r.query(id), Ok((0, 2, 0)));
        r.start(&mut files, &mut d, id).unwrap();
        assert_eq!(
            r.receipt(&mut foreign, &mut d, id, 2, Completion::Stopped),
            Err(Error::Files(descriptor::Error::BadHandle))
        );
        assert!(r.viewing());
        assert_eq!(r.query(id), Ok((0, 2, 1)));
        assert_eq!(d.change(m, 32), Err(lease::Error::Busy));
        r.receipt(&mut files, &mut d, id, 1, Completion::Unknown)
            .unwrap();
        assert_eq!(
            r.receipt(&mut foreign, &mut d, id, 2, Completion::Stopped),
            Err(Error::Files(descriptor::Error::BadHandle))
        );
        assert_eq!(r.query(id), Ok((1, 2, 2)));
        r.receipt(&mut files, &mut d, id, 2, Completion::Stopped)
            .unwrap();
        assert_eq!(files.offset(&table, fd), Ok((2, 1)));
        assert!(d.change(m, 32).is_ok());
    }
    #[test]
    fn separate_tables_share_reserved_description_without_becoming_read_owners() {
        let (mut r, mut files, table, mut d, m, fd, _) = setup();
        let child = files.fork(&table).unwrap();
        let id = r.begin(&mut files, &child, &mut d, fd, m, 0, 2).unwrap();
        assert_eq!(
            files.set_offset(&table, fd, 3),
            Err(descriptor::Error::Busy)
        );
        files.close(&child, fd).unwrap();
        r.start(&mut files, &mut d, id).unwrap();
        r.receipt(&mut files, &mut d, id, 2, Completion::Stopped)
            .unwrap();
        assert_eq!(files.offset(&table, fd), Ok((2, 1)));
        r.retire(id).unwrap();
        files.let_go(child).unwrap();
    }
}
