//! Owned regular-file payloads. Namespace, permissions and shared mappings are
//! deliberately not implemented here. IDs are never reused within a store.
use std::collections::{hash_map::DefaultHasher, HashMap};
use std::hash::BuildHasherDefault;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    BadHandle,
    TooLarge,
    NoMemory,
    Exhausted,
    Busy,
    BadCompletion,
    LoadConflict,
}
#[derive(Debug)]
struct Source {
    id: u32,
    operation: Option<u32>,
    poisoned: bool,
    loaded: bool,
}
#[derive(Debug)]
struct Slot {
    bytes: Vec<u8>,
    logical_size: usize,
    source: Option<Source>,
}
#[derive(Debug)]
pub struct Files {
    // Live-only index. Deterministic std hashing needs no host entropy capability;
    // keys are our monotonic IDs, not externally supplied file names.
    files: HashMap<u32, Slot, BuildHasherDefault<DefaultHasher>>,
    next_file: u32,
    next_load: u32,
    max_file: usize,
}
impl Files {
    pub fn new(max_file: usize) -> Self {
        Self {
            files: HashMap::default(),
            next_file: 0,
            max_file,
            next_load: 0,
        }
    }
    fn admit(&mut self) -> Result<u32, Error> {
        if self.next_file >= i32::MAX as u32 {
            return Err(Error::Exhausted);
        }
        self.files.try_reserve(1).map_err(|_| Error::NoMemory)?;
        Ok(self.next_file + 1)
    }
    pub fn create(&mut self, input: &[u8]) -> Result<u32, Error> {
        if input.len() > self.max_file {
            return Err(Error::TooLarge);
        }
        let id = self.admit()?;
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(input.len())
            .map_err(|_| Error::NoMemory)?;
        bytes.extend_from_slice(input);
        self.files.insert(
            id,
            Slot {
                bytes,
                logical_size: input.len(),
                source: None,
            },
        );
        self.next_file = id;
        Ok(id)
    }
    /// Transfer one already-owned payload only after all fallible admission work.
    /// On failure the caller retains its buffer, pointer and capacity unchanged.
    pub fn create_take(&mut self, input: &mut Vec<u8>) -> Result<u32, Error> {
        if input.len() > self.max_file {
            return Err(Error::TooLarge);
        }
        let id = self.admit()?;
        let logical_size = input.len();
        self.files.insert(
            id,
            Slot {
                bytes: std::mem::take(input),
                logical_size,
                source: None,
            },
        );
        self.next_file = id;
        Ok(id)
    }
    fn slot_mut(&mut self, id: u32) -> Result<&mut Slot, Error> {
        self.files.get_mut(&id).ok_or(Error::BadHandle)
    }
    fn ready(&mut self, id: u32) -> Result<&mut Vec<u8>, Error> {
        let slot = self.slot_mut(id)?;
        if let Some(source) = &mut slot.source {
            if source.operation.is_some() {
                source.poisoned = true;
                return Err(Error::LoadConflict);
            }
            if !source.loaded {
                return Err(Error::LoadConflict);
            }
        }
        Ok(&mut slot.bytes)
    }
    pub fn create_lazy(&mut self, source: u32, size: usize) -> Result<u32, Error> {
        if source == 0 || source > i32::MAX as u32 {
            return Err(Error::BadHandle);
        }
        if size > self.max_file {
            return Err(Error::TooLarge);
        }
        let id = self.create(&[])?;
        self.slot_mut(id)?.logical_size = size;
        self.slot_mut(id)?.source = Some(Source {
            id: source,
            operation: None,
            poisoned: false,
            loaded: false,
        });
        Ok(id)
    }
    pub fn load_check(&mut self, id: u32) -> Result<(), Error> {
        if let Some(source) = &mut self.slot_mut(id)?.source {
            if source.operation.is_some() {
                source.poisoned = true;
                return Err(Error::LoadConflict);
            }
        }
        Ok(())
    }
    pub fn size(&mut self, id: u32) -> Result<usize, Error> {
        Ok(self.slot_mut(id)?.logical_size)
    }
    pub fn load_source(&mut self, id: u32) -> Result<u32, Error> {
        Ok(self.slot_mut(id)?.source.as_ref().map_or(0, |s| s.id))
    }
    pub fn load_begin(&mut self, id: u32) -> Result<u32, Error> {
        let slot = self.slot_mut(id)?;
        let Some(source) = &mut slot.source else {
            return Ok(0);
        };
        if source.operation.is_some() {
            source.poisoned = true;
            return Err(Error::LoadConflict);
        }
        if source.loaded {
            return Ok(0);
        }
        if self.next_load == i32::MAX as u32 {
            return Err(Error::Exhausted);
        }
        self.next_load += 1;
        let operation = self.next_load;
        let source = self.slot_mut(id)?.source.as_mut().unwrap();
        source.operation = Some(operation);
        source.poisoned = false;
        Ok(operation)
    }
    pub fn load_finish(
        &mut self,
        id: u32,
        operation: u32,
        success: bool,
        input: &[u8],
    ) -> Result<(), Error> {
        self.finish_payload(id, operation, success, input.len(), || {
            let mut bytes = Vec::new();
            bytes
                .try_reserve_exact(input.len())
                .map_err(|_| Error::NoMemory)?;
            bytes.extend_from_slice(input);
            Ok(bytes)
        })
    }
    /// A rejected/stale completion never consumes input. A matching failed or
    /// poisoned attempt retires exactly as the borrowed completion does.
    pub fn load_finish_take(
        &mut self,
        id: u32,
        operation: u32,
        success: bool,
        input: &mut Vec<u8>,
    ) -> Result<(), Error> {
        self.finish_payload(id, operation, success, input.len(), || {
            Ok(std::mem::take(input))
        })
    }
    fn finish_payload(
        &mut self,
        id: u32,
        operation: u32,
        success: bool,
        length: usize,
        payload: impl FnOnce() -> Result<Vec<u8>, Error>,
    ) -> Result<(), Error> {
        let limit = self.max_file;
        let slot = self.slot_mut(id)?;
        let source = slot.source.as_mut().ok_or(Error::BadCompletion)?;
        if source.operation != Some(operation) {
            return Err(Error::BadCompletion);
        }
        source.operation = None;
        let poisoned = std::mem::replace(&mut source.poisoned, false);
        if !success {
            return Ok(());
        }
        if poisoned {
            return Err(Error::LoadConflict);
        }
        if length > limit {
            return Err(Error::TooLarge);
        }
        slot.bytes = payload()?;
        slot.logical_size = length;
        source.loaded = true;
        Ok(())
    }
    pub fn read(&mut self, id: u32, at: usize, length: usize) -> Result<&[u8], Error> {
        let bytes = self.ready(id)?;
        let start = at.min(bytes.len());
        Ok(&bytes[start..start + length.min(bytes.len() - start)])
    }
    pub fn write(&mut self, id: u32, at: usize, input: &[u8]) -> Result<(), Error> {
        self.ready(id)?;
        let end = at
            .checked_add(input.len())
            .filter(|n| *n <= self.max_file)
            .ok_or(Error::TooLarge)?;
        let bytes = self.ready(id)?;
        if end > bytes.len() {
            bytes
                .try_reserve_exact(end - bytes.len())
                .map_err(|_| Error::NoMemory)?;
            bytes.resize(end, 0);
        }
        bytes[at..end].copy_from_slice(input);
        let slot = self.slot_mut(id)?;
        slot.logical_size = slot.bytes.len();
        slot.source = None;
        Ok(())
    }
    pub fn truncate(&mut self, id: u32, length: usize) -> Result<(), Error> {
        self.ready(id)?;
        if length > self.max_file {
            return Err(Error::TooLarge);
        }
        let bytes = self.ready(id)?;
        if length > bytes.len() {
            bytes
                .try_reserve_exact(length - bytes.len())
                .map_err(|_| Error::NoMemory)?;
        }
        bytes.resize(length, 0);
        let slot = self.slot_mut(id)?;
        slot.logical_size = length;
        slot.source = None;
        Ok(())
    }
    /// Resident logical payload bytes, not allocator capacity or Wasm pages.
    pub fn resident(&mut self, id: u32) -> Result<usize, Error> {
        Ok(self.slot_mut(id)?.bytes.len())
    }
    pub fn release(&mut self, id: u32) -> Result<usize, Error> {
        self.load_check(id)?;
        let slot = self.slot_mut(id)?;
        let Some(source) = &mut slot.source else {
            return Ok(0);
        };
        if !source.loaded {
            return Ok(0);
        }
        let n = slot.bytes.len();
        slot.bytes = Vec::new();
        source.loaded = false;
        Ok(n)
    }
    pub fn own(&mut self, id: u32) -> Result<(), Error> {
        self.ready(id)?;
        self.slot_mut(id)?.source = None;
        Ok(())
    }
    pub fn close(&mut self, id: u32) -> Result<(), Error> {
        // Preserve idempotent close of any previously issued ID, but never let a
        // removed ID name a later file. No historical tombstone is needed.
        if id == 0 || id > self.next_file {
            return Err(Error::BadHandle);
        }
        self.files.remove(&id);
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn churn_reuses_index_capacity_without_reusing_identity() {
        let mut f = Files::new(8);
        let first = f.create(b"x").unwrap();
        let capacity = f.files.capacity();
        f.close(first).unwrap();
        for _ in 0..10_000 {
            let id = f.create(b"y").unwrap();
            assert!(id > first);
            assert_eq!(f.files.len(), 1);
            assert_eq!(f.files.capacity(), capacity);
            assert_eq!(f.read(first, 0, 1), Err(Error::BadHandle));
            f.close(id).unwrap();
        }
        assert!(f.files.is_empty());
        assert_eq!(f.close(first), Ok(()));
        assert_eq!(f.close(0), Err(Error::BadHandle));
        assert_eq!(f.close(f.next_file + 1), Err(Error::BadHandle));
    }
    #[test]
    fn rolling_live_set_does_not_retain_historical_slots() {
        let mut f = Files::new(8);
        let mut live = std::collections::VecDeque::new();
        for _ in 0..64 {
            live.push_back(f.create(b"live").unwrap());
        }
        let initial_capacity = f.files.capacity();
        for _ in 0..10_000 {
            let old = live.pop_front().unwrap();
            f.close(old).unwrap();
            live.push_back(f.create(b"next").unwrap());
            assert_eq!(f.files.len(), 64);
            // std's tombstone cleanup may grow the table, but not per past ID.
            assert!(f.files.capacity() <= 2 * initial_capacity);
            assert_eq!(f.read(old, 0, 1), Err(Error::BadHandle));
        }
        for id in live {
            assert_eq!(f.read(id, 0, 4).unwrap(), b"next");
        }
    }
    #[test]
    fn file_ids_exhaust_without_consuming_input_or_retargeting_old_handles() {
        let mut f = Files::new(8);
        let old = f.create(b"old").unwrap();
        f.close(old).unwrap();
        f.next_file = i32::MAX as u32 - 1;
        let last = f.create(b"last").unwrap();
        assert_eq!(last, i32::MAX as u32);
        let mut input = b"input".to_vec();
        let pointer = input.as_ptr();
        assert_eq!(f.create_take(&mut input), Err(Error::Exhausted));
        assert_eq!(input, b"input");
        assert_eq!(input.as_ptr(), pointer);
        assert_eq!(f.create(b"new"), Err(Error::Exhausted));
        assert_eq!(f.read(old, 0, 3), Err(Error::BadHandle));
        assert_eq!(f.read(last, 0, 4).unwrap(), b"last");
        f.close(last).unwrap();
        assert_eq!(f.create(b"new"), Err(Error::Exhausted));
    }
    #[test]
    fn take_creation_preserves_allocation_and_rejected_input() {
        let mut f = Files::new(8);
        let mut input = b"owned".to_vec();
        let pointer = input.as_ptr();
        let id = f.create_take(&mut input).unwrap();
        assert_eq!(input.capacity(), 0);
        assert_eq!(f.read(id, 0, 8).unwrap().as_ptr(), pointer);
        assert_eq!(f.read(id, 0, 8).unwrap(), b"owned");
        let mut large = vec![1; 9];
        let pointer = large.as_ptr();
        assert_eq!(f.create_take(&mut large), Err(Error::TooLarge));
        assert_eq!(large.as_ptr(), pointer);
        assert_eq!(large.len(), 9);
        assert_eq!(f.size(id), Ok(5));
        let empty = f.create_take(&mut Vec::new()).unwrap();
        assert_eq!(f.size(empty), Ok(0));
    }
    #[test]
    fn borrowed_and_taken_lazy_completions_share_failure_and_retry_contract() {
        for take in [false, true] {
            let mut f = Files::new(8);
            let id = f.create_lazy(1, 3).unwrap();
            let op = f.load_begin(id).unwrap();
            let mut input = b"new".to_vec();
            let pointer = input.as_ptr();
            let finish = |f: &mut Files, operation, success, input: &mut Vec<u8>| {
                if take {
                    f.load_finish_take(id, operation, success, input)
                } else {
                    f.load_finish(id, operation, success, input)
                }
            };
            assert_eq!(
                finish(&mut f, op + 1, true, &mut input),
                Err(Error::BadCompletion)
            );
            assert_eq!(input.as_ptr(), pointer);
            assert_eq!(f.load_check(id), Err(Error::LoadConflict)); // poisons only matching active attempt
            assert_eq!(
                finish(&mut f, op, true, &mut input),
                Err(Error::LoadConflict)
            );
            assert_eq!(input, b"new");
            let op = f.load_begin(id).unwrap();
            assert_eq!(finish(&mut f, op, false, &mut input), Ok(()));
            assert_eq!(input, b"new");
            let op = f.load_begin(id).unwrap();
            assert_eq!(
                finish(&mut f, op, true, &mut vec![1; 9]),
                Err(Error::TooLarge)
            );
            let op = f.load_begin(id).unwrap();
            assert_eq!(finish(&mut f, op, true, &mut input), Ok(()));
            assert_eq!(f.read(id, 0, 8).unwrap(), b"new");
            if take {
                assert_eq!(input.capacity(), 0);
                assert_eq!(f.read(id, 0, 8).unwrap().as_ptr(), pointer);
            } else {
                assert_eq!(input, b"new");
            }
            f.release(id).unwrap();
            let op = f.load_begin(id).unwrap();
            f.close(id).unwrap();
            let mut last = b"last".to_vec();
            assert_eq!(finish(&mut f, op, true, &mut last), Err(Error::BadHandle));
            assert_eq!(last, b"last");
        }
    }
    #[test]
    fn allocation_failure_after_matching_completion_retires_for_retry() {
        let mut f = Files::new(8);
        let id = f.create_lazy(1, 3).unwrap();
        let op = f.load_begin(id).unwrap();
        assert_eq!(
            f.finish_payload(id, op, true, 3, || Err(Error::NoMemory)),
            Err(Error::NoMemory)
        );
        assert_eq!(f.size(id), Ok(3));
        let next = f.load_begin(id).unwrap();
        assert_ne!(next, op);
        f.load_finish_take(id, next, true, &mut b"ok".to_vec())
            .unwrap();
        assert_eq!(f.read(id, 0, 8).unwrap(), b"ok");
    }
    #[test]
    fn reload_preserves_source_and_logical_size_but_not_residency() {
        let mut f = Files::new(8);
        let id = f.create_lazy(7, 5).unwrap();
        assert_eq!(f.size(id), Ok(5));
        assert_eq!(f.resident(id), Ok(0));
        assert_eq!(f.own(id), Err(Error::LoadConflict));
        let op = f.load_begin(id).unwrap();
        f.load_finish(id, op, true, b"abc").unwrap();
        assert_eq!(f.size(id), Ok(3));
        assert_eq!(f.load_source(id), Ok(7));
        assert_eq!(f.resident(id), Ok(3));
        assert_eq!(f.release(id), Ok(3));
        assert_eq!(f.size(id), Ok(3));
        assert_eq!(f.resident(id), Ok(0));
        assert_eq!(f.release(id), Ok(0));
        let next = f.load_begin(id).unwrap();
        assert_ne!(op, next);
        assert_eq!(
            f.load_finish(id, op, true, b"old"),
            Err(Error::BadCompletion)
        );
        f.load_finish(id, next, false, &[]).unwrap();
        assert_eq!(f.size(id), Ok(3));
        let retry = f.load_begin(id).unwrap();
        f.load_finish(id, retry, true, b"abc").unwrap();
        assert_eq!(f.read(id, 0, 8).unwrap(), b"abc");
    }
    #[test]
    fn mutation_detaches_source_only_on_success() {
        let mut f = Files::new(8);
        for action in 0..3 {
            let id = f.create_lazy(1, 3).unwrap();
            let op = f.load_begin(id).unwrap();
            f.load_finish(id, op, true, b"abc").unwrap();
            assert_eq!(f.write(id, 8, b"x"), Err(Error::TooLarge));
            assert_eq!(f.truncate(id, 9), Err(Error::TooLarge));
            assert_eq!(f.load_source(id), Ok(1));
            match action {
                0 => f.write(id, 0, b"x").unwrap(),
                1 => f.truncate(id, 2).unwrap(),
                _ => f.own(id).unwrap(),
            };
            assert_eq!(f.load_source(id), Ok(0));
            let size = f.size(id).unwrap();
            assert_eq!(f.release(id), Ok(0));
            assert_eq!(f.resident(id), Ok(size));
        }
    }
    #[test]
    fn empty_loaded_source_can_be_released_and_loading_release_poisons() {
        let mut f = Files::new(8);
        let id = f.create_lazy(1, 0).unwrap();
        let op = f.load_begin(id).unwrap();
        assert_eq!(f.release(id), Err(Error::LoadConflict));
        assert_eq!(f.load_finish(id, op, true, &[]), Err(Error::LoadConflict));
        let op = f.load_begin(id).unwrap();
        f.load_finish(id, op, true, &[]).unwrap();
        assert_eq!(f.load_begin(id), Ok(0));
        assert_eq!(f.release(id), Ok(0));
        assert!(f.load_begin(id).unwrap() > 0);
    }
    #[test]
    fn lazy_load_poison_retry_and_stale_completion() {
        let mut f = Files::new(8);
        let id = f.create_lazy(12, 0).unwrap();
        assert_eq!(f.read(id, 0, 1), Err(Error::LoadConflict));
        assert_eq!(f.load_check(id), Ok(()));
        let op = f.load_begin(id).unwrap();
        assert_eq!(f.load_check(id), Err(Error::LoadConflict));
        assert_eq!(f.load_source(id), Ok(12));
        assert_eq!(f.load_begin(id), Err(Error::LoadConflict));
        assert_eq!(
            f.load_finish(id, op, true, b"bad"),
            Err(Error::LoadConflict)
        );
        let retry = f.load_begin(id).unwrap();
        assert_ne!(op, retry);
        assert_eq!(
            f.load_finish(id, op, true, b"stale"),
            Err(Error::BadCompletion)
        );
        assert_eq!(f.load_finish(id, retry, true, b"good"), Ok(()));
        assert_eq!(f.load_begin(id), Ok(0));
        assert_eq!(f.load_source(id), Ok(12));
        assert_eq!(f.size(id), Ok(4));
        assert_eq!(f.read(id, 0, 8).unwrap(), b"good");
    }
    #[test]
    fn lazy_mutation_conflicts_and_failure_retry() {
        let mut f = Files::new(4);
        let id = f.create_lazy(1, 0).unwrap();
        for action in 0..3 {
            let op = f.load_begin(id).unwrap();
            let result = match action {
                0 => f.read(id, 0, 1).map(|_| ()),
                1 => f.write(id, 0, b"x"),
                _ => f.truncate(id, 1),
            };
            assert_eq!(result, Err(Error::LoadConflict));
            assert_eq!(f.load_finish(id, op, true, b"x"), Err(Error::LoadConflict));
        }
        let op = f.load_begin(id).unwrap();
        assert_eq!(f.load_finish(id, op, true, b"large"), Err(Error::TooLarge));
        let op = f.load_begin(id).unwrap();
        assert_eq!(f.load_finish(id, op, false, b""), Ok(()));
        let op = f.load_begin(id).unwrap();
        f.load_finish(id, op, true, b"ok").unwrap();
        assert_eq!(f.read(id, 0, 4).unwrap(), b"ok");
    }
    #[test]
    fn independent_loads_and_closed_source_cannot_publish() {
        let mut f = Files::new(8);
        let a = f.create_lazy(1, 0).unwrap();
        let b = f.create_lazy(2, 0).unwrap();
        let oa = f.load_begin(a).unwrap();
        let ob = f.load_begin(b).unwrap();
        f.load_finish(b, ob, true, b"B").unwrap();
        assert_eq!(f.read(b, 0, 8).unwrap(), b"B");
        f.close(a).unwrap();
        assert_eq!(f.load_finish(a, oa, true, b"A"), Err(Error::BadHandle));
        assert_eq!(f.load_begin(a), Err(Error::BadHandle));
        let c = f.create_lazy(3, 0).unwrap();
        assert_ne!(a, c);
    }
    #[test]
    fn load_operations_do_not_wrap() {
        let mut f = Files::new(8);
        let id = f.create_lazy(1, 0).unwrap();
        f.next_load = i32::MAX as u32;
        assert_eq!(f.load_begin(id), Err(Error::Exhausted));
        assert_eq!(f.size(id), Ok(0));
    }
    #[test]
    fn payload_and_failure_semantics() {
        let mut f = Files::new(8);
        let a = f.create(b"abc").unwrap();
        f.write(a, 5, b"z").unwrap();
        assert_eq!(f.read(a, 0, 99).unwrap(), b"abc\0\0z");
        assert_eq!(f.write(a, usize::MAX, b"x"), Err(Error::TooLarge));
        assert_eq!(f.truncate(a, 9), Err(Error::TooLarge));
        assert_eq!(f.read(a, 0, 99).unwrap(), b"abc\0\0z");
        f.truncate(a, 2).unwrap();
        f.truncate(a, 6).unwrap();
        assert_eq!(f.read(a, 0, 99).unwrap(), b"ab\0\0\0\0");
        assert_eq!(f.read(a, usize::MAX, 2).unwrap(), b"");
    }
    #[test]
    fn empty_payload_write_retains_current_file_primitive_growth() {
        let mut f = Files::new(8);
        let id = f.create(b"a").unwrap();
        f.write(id, 4, b"").unwrap();
        assert_eq!(f.read(id, 0, 8).unwrap(), b"a\0\0\0");
        assert_eq!(f.write(id, 9, b""), Err(Error::TooLarge));
        assert_eq!(f.read(id, 0, 8).unwrap(), b"a\0\0\0");
    }
    #[test]
    fn closed_handle_never_retargets() {
        let mut f = Files::new(8);
        let a = f.create(b"old").unwrap();
        f.close(a).unwrap();
        f.close(a).unwrap();
        let b = f.create(b"new").unwrap();
        assert_ne!(a, b);
        assert_eq!(f.read(a, 0, 3), Err(Error::BadHandle));
        assert_eq!(f.read(b, 0, 3).unwrap(), b"new");
    }
}
