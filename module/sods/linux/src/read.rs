//! Resident prepared-file read coordinator. No guest syscall, lazy callback,
//! mapping or process/image generation is connected yet. The sealed Files owner
//! exposes no source mutation. No core pointer survives a host copy interval.
use crate::descriptor::{self, Files, ReadHold, Table};
use crate::effect::{Completion, Token};
use crate::lease::{self, Domain};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Error {
    Files(descriptor::Error),
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
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Ready,
    Executing,
    Unknown,
    Finished,
    Cancelled,
}
struct Pending {
    id: u64,
    hold: Option<ReadHold>,
    token: Token,
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
    pub(crate) files: Files,
    pub(crate) table: Table,
    slots: Vec<Option<Pending>>,
    next: Option<u64>,
    viewing: bool,
}
impl Reads {
    pub(crate) fn new(files: Files, table: Table, capacity: ReadCapacity) -> Self {
        Self {
            files,
            table,
            slots: capacity.0,
            next: Some(1),
            viewing: false,
        }
    }
    pub(crate) fn viewing(&self) -> bool {
        self.viewing
    }
    pub(crate) fn owns(&self, token: Token) -> bool {
        self.slots.iter().flatten().any(|p| p.token == token)
    }
    fn index(&self, id: u64) -> Result<usize, Error> {
        self.slots
            .iter()
            .position(|p| p.as_ref().is_some_and(|p| p.id == id))
            .ok_or(Error::BadRead)
    }
    pub(crate) fn begin(
        &mut self,
        domain: &mut Domain,
        fd: u32,
        binding: u64,
        at: u64,
        requested: u64,
    ) -> Result<u64, Error> {
        if self.viewing {
            return Err(Error::Busy);
        }
        let slot = self
            .slots
            .iter()
            .position(Option::is_none)
            .ok_or(Error::Capacity)?;
        let id = self.next.ok_or(Error::Capacity)?;
        let hold = self.files.reserve_read(&self.table, fd, requested)?;
        let length = hold.length() as u64;
        let token = match domain.span(binding, if length == 0 { 0 } else { at }, length) {
            Ok(t) => t,
            Err(error) => {
                self.files.abort_read(hold);
                return Err(error.into());
            }
        };
        self.next = id.checked_add(1);
        self.slots[slot] = Some(Pending {
            id,
            hold: Some(hold),
            token,
            length,
            confirmed: 0,
            phase: Phase::Ready,
            cancel: false,
        });
        Ok(id)
    }
    pub(crate) fn start(&mut self, domain: &mut Domain, id: u64) -> Result<(usize, u64), Error> {
        if self.viewing {
            return Err(Error::Busy);
        }
        let i = self.index(id)?;
        let p = self.slots[i].as_mut().unwrap();
        if p.phase != Phase::Ready {
            return Err(Error::State);
        }
        domain.start(p.token)?;
        p.phase = Phase::Executing;
        self.viewing = true;
        let bytes = self.files.read_bytes(p.hold.as_ref().unwrap());
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
        domain: &mut Domain,
        id: u64,
        confirmed: u64,
        completion: Completion,
    ) -> Result<(), Error> {
        let i = self.index(id)?;
        let p = self.slots[i].as_mut().unwrap();
        if self.viewing && p.phase != Phase::Executing {
            return Err(Error::Busy);
        }
        if !matches!(p.phase, Phase::Executing | Phase::Unknown) {
            return Err(Error::State);
        }
        if confirmed < p.confirmed || confirmed > p.length {
            return Err(Error::Range);
        }
        domain.receipt(p.token, confirmed, completion)?;
        if p.phase == Phase::Executing {
            self.viewing = false;
        }
        p.confirmed = confirmed;
        if completion == Completion::Unknown {
            p.phase = Phase::Unknown;
        } else {
            // All fallible preflight happened before copy. The pending reference
            // pins this description even if its last descriptor slot has closed.
            self.files.finish_read(p.hold.take().unwrap(), confirmed);
            // This coordinator alone owns the span token; no callback or other
            // core call can run between stopped receipt and retirement.
            assert_eq!(domain.retire(p.token).expect("stopped owned span"), None);
            p.phase = Phase::Finished;
        }
        Ok(())
    }
    pub(crate) fn cancel(&mut self, domain: &mut Domain, id: u64) -> Result<(), Error> {
        let i = self.index(id)?;
        let p = self.slots[i].as_mut().unwrap();
        if self.viewing && p.phase != Phase::Executing {
            return Err(Error::Busy);
        }
        if matches!(p.phase, Phase::Finished | Phase::Cancelled) {
            return Ok(());
        }
        domain.cancel(p.token)?;
        p.cancel = true;
        if p.phase == Phase::Ready {
            self.files.abort_read(p.hold.take().unwrap());
            assert_eq!(
                domain.retire(p.token).expect("cancelled ready owned span"),
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
        if !matches!(p.phase, Phase::Finished | Phase::Cancelled) {
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
    fn setup() -> (Reads, Domain, u64, u32, Inode) {
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
                tables: 2,
                descriptions: 4,
                slots: 8,
            },
        );
        let table = files.table(8).unwrap();
        let fd = files.open(&table, a, false).unwrap();
        let reads = Reads::new(files, table, ReadCapacity::new(3).unwrap());
        let mut domain = Domain::new(1, 1, 3).unwrap();
        let binding = domain.bind(16).unwrap();
        (reads, domain, binding, fd, b)
    }
    #[test]
    fn canonical_copy_commits_original_description_after_fd_reuse() {
        let (mut r, mut d, m, fd, b) = setup();
        let alias = r.files.dup(&r.table, fd, 0, false).unwrap();
        let read = r.begin(&mut d, fd, m, 0, 3).unwrap();
        r.files.close(&r.table, fd).unwrap();
        assert_eq!(r.files.open(&r.table, b, false).unwrap(), fd);
        let (ptr, len) = r.start(&mut d, read).unwrap();
        let copied = unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) }.to_vec();
        assert_eq!(copied, b"abc");
        r.receipt(&mut d, read, 3, Completion::Stopped).unwrap();
        assert_eq!(r.files.offset(&r.table, fd), Ok((0, 0)));
        assert_eq!(r.files.offset(&r.table, alias), Ok((3, 1)));
        assert_eq!(r.query(read), Ok((3, 3, 3)));
        r.retire(read).unwrap();
        assert_eq!(r.query(read), Err(Error::BadRead));
    }
    #[test]
    fn failed_span_rolls_back_only_read_preparation() {
        let (mut r, mut d, m, fd, _) = setup();
        assert_eq!(
            r.begin(&mut d, fd, m, 15, 4),
            Err(Error::Lease(lease::Error::Range))
        );
        assert_eq!(r.files.offset(&r.table, fd), Ok((0, 0)));
        r.files.set_offset(&r.table, fd, 1).unwrap();
        assert!(r.begin(&mut d, fd, m, 0, 3).is_ok());
    }
    #[test]
    fn unknown_copy_retains_offset_reservation_until_stopped() {
        let (mut r, mut d, m, fd, _) = setup();
        let read = r.begin(&mut d, fd, m, 0, 4).unwrap();
        r.start(&mut d, read).unwrap();
        r.receipt(&mut d, read, 2, Completion::Unknown).unwrap();
        assert!(!r.viewing());
        assert_eq!(r.files.offset(&r.table, fd), Ok((0, 0)));
        assert_eq!(
            r.files.set_offset(&r.table, fd, 0),
            Err(descriptor::Error::Busy)
        );
        assert_eq!(r.start(&mut d, read), Err(Error::State));
        r.cancel(&mut d, read).unwrap();
        assert_eq!(r.query(read), Ok((2, 4, 258)));
        assert_eq!(r.retire(read), Err(Error::State));
        assert_eq!(d.change(m, 32), Err(lease::Error::Busy));
        assert_eq!(
            r.receipt(&mut d, read, 1, Completion::Stopped),
            Err(Error::Range)
        );
        r.receipt(&mut d, read, 3, Completion::Stopped).unwrap();
        assert_eq!(r.files.offset(&r.table, fd), Ok((3, 1)));
        assert_eq!(r.query(read), Ok((3, 4, 259)));
        assert_eq!(
            r.receipt(&mut d, read, 4, Completion::Stopped),
            Err(Error::State)
        );
        // Result observation need not block already-proven-safe memory mutation.
        assert!(d.change(m, 32).is_ok());
        r.retire(read).unwrap();
    }
    #[test]
    fn ready_cancel_does_not_advance_offset_and_remains_queryable() {
        let (mut r, mut d, m, fd, _) = setup();
        let read = r.begin(&mut d, fd, m, 0, 4).unwrap();
        r.cancel(&mut d, read).unwrap();
        assert_eq!(r.query(read), Ok((0, 4, 260)));
        assert_eq!(r.files.offset(&r.table, fd), Ok((0, 0)));
        assert_eq!(r.start(&mut d, read), Err(Error::State));
        r.retire(read).unwrap();
        assert!(r.begin(&mut d, fd, m, 0, 4).is_ok());
    }
    #[test]
    fn cancelled_result_observation_does_not_hold_guest_backing() {
        let (mut r, mut d, m, fd, _) = setup();
        let id = r.begin(&mut d, fd, m, 0, 2).unwrap();
        r.cancel(&mut d, id).unwrap();
        assert_eq!(r.query(id), Ok((0, 2, 260)));
        assert!(d.change(m, 32).is_ok());
        r.retire(id).unwrap();
    }

    #[test]
    fn zero_requested_and_eof_do_not_touch_target_or_narrow_large_offset() {
        let (mut r, mut d, m, fd, _) = setup();
        let zero = r.begin(&mut d, fd, m, u64::MAX, 0).unwrap();
        assert_eq!(r.start(&mut d, zero), Ok((0, 0)));
        r.receipt(&mut d, zero, 0, Completion::Stopped).unwrap();
        assert_eq!(r.files.offset(&r.table, fd), Ok((0, 0)));
        r.retire(zero).unwrap();
        r.files.set_offset(&r.table, fd, u64::MAX).unwrap();
        let eof = r.begin(&mut d, fd, m, u64::MAX, u64::MAX).unwrap();
        assert_eq!(r.start(&mut d, eof), Ok((0, 0)));
        r.receipt(&mut d, eof, 0, Completion::Stopped).unwrap();
        assert_eq!(r.files.offset(&r.table, fd), Ok((u64::MAX, 2)));
    }
    #[test]
    fn read_budget_and_single_copy_interval_are_enforced() {
        let (mut r, mut d, m, fd, b) = setup();
        let other = r.files.open(&r.table, b, false).unwrap();
        let first = r.begin(&mut d, fd, m, 0, 2).unwrap();
        let second = r.begin(&mut d, other, m, 2, 2).unwrap();
        r.start(&mut d, first).unwrap();
        assert_eq!(r.start(&mut d, second), Err(Error::Busy));
        assert_eq!(r.cancel(&mut d, second), Err(Error::Busy));
        assert_eq!(r.query(first), Ok((0, 2, 1)));
        r.receipt(&mut d, first, 2, Completion::Stopped).unwrap();
        r.cancel(&mut d, second).unwrap();
        let third = r.begin(&mut d, fd, m, 4, 2).unwrap();
        assert_eq!(r.begin(&mut d, other, m, 6, 2), Err(Error::Capacity));
        r.cancel(&mut d, third).unwrap();
        r.retire(first).unwrap();
        assert!(r.begin(&mut d, other, m, 6, 2).is_ok());
    }
}
