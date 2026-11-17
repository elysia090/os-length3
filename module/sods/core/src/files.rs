//! Owned regular-file payloads. Namespace, permissions and shared mappings are
//! deliberately not implemented here. IDs are never reused within a store.
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
}
#[derive(Debug)]
struct Slot {
    bytes: Vec<u8>,
    source: Option<Source>,
}
#[derive(Debug)]
pub struct Files {
    files: Vec<Option<Slot>>,
    next_load: u32,
    max_file: usize,
}
impl Files {
    pub fn new(max_file: usize) -> Self {
        Self {
            files: Vec::new(),
            max_file,
            next_load: 0,
        }
    }
    pub fn create(&mut self, input: &[u8]) -> Result<u32, Error> {
        if input.len() > self.max_file {
            return Err(Error::TooLarge);
        }
        if self.files.len() >= i32::MAX as usize {
            return Err(Error::Exhausted);
        }
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(input.len())
            .map_err(|_| Error::NoMemory)?;
        bytes.extend_from_slice(input);
        self.files.try_reserve(1).map_err(|_| Error::NoMemory)?;
        self.files.push(Some(Slot {
            bytes,
            source: None,
        }));
        Ok(self.files.len() as u32)
    }
    fn slot_mut(&mut self, id: u32) -> Result<&mut Slot, Error> {
        self.files
            .get_mut(id.wrapping_sub(1) as usize)
            .and_then(Option::as_mut)
            .ok_or(Error::BadHandle)
    }
    fn ready(&mut self, id: u32) -> Result<&mut Vec<u8>, Error> {
        let slot = self.slot_mut(id)?;
        if let Some(source) = &mut slot.source {
            if source.operation.is_some() {
                source.poisoned = true;
            }
            return Err(Error::LoadConflict);
        }
        Ok(&mut slot.bytes)
    }
    pub fn create_lazy(&mut self, source: u32) -> Result<u32, Error> {
        if source == 0 || source > i32::MAX as u32 {
            return Err(Error::BadHandle);
        }
        let id = self.create(&[])?;
        self.slot_mut(id)?.source = Some(Source {
            id: source,
            operation: None,
            poisoned: false,
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
        Ok(self.slot_mut(id)?.bytes.len())
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
        if input.len() > limit {
            return Err(Error::TooLarge);
        }
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(input.len())
            .map_err(|_| Error::NoMemory)?;
        bytes.extend_from_slice(input);
        slot.bytes = bytes;
        slot.source = None;
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
        Ok(())
    }
    pub fn close(&mut self, id: u32) -> Result<(), Error> {
        let slot = self
            .files
            .get_mut(id.wrapping_sub(1) as usize)
            .ok_or(Error::BadHandle)?;
        *slot = None;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lazy_load_poison_retry_and_stale_completion() {
        let mut f = Files::new(8);
        let id = f.create_lazy(12).unwrap();
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
        assert_eq!(f.load_source(id), Ok(0));
        assert_eq!(f.size(id), Ok(4));
        assert_eq!(f.read(id, 0, 8).unwrap(), b"good");
    }
    #[test]
    fn lazy_mutation_conflicts_and_failure_retry() {
        let mut f = Files::new(4);
        let id = f.create_lazy(1).unwrap();
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
        let a = f.create_lazy(1).unwrap();
        let b = f.create_lazy(2).unwrap();
        let oa = f.load_begin(a).unwrap();
        let ob = f.load_begin(b).unwrap();
        f.load_finish(b, ob, true, b"B").unwrap();
        assert_eq!(f.read(b, 0, 8).unwrap(), b"B");
        f.close(a).unwrap();
        assert_eq!(f.load_finish(a, oa, true, b"A"), Err(Error::BadHandle));
        assert_eq!(f.load_begin(a), Err(Error::BadHandle));
        let c = f.create_lazy(3).unwrap();
        assert_ne!(a, c);
    }
    #[test]
    fn load_operations_do_not_wrap() {
        let mut f = Files::new(8);
        let id = f.create_lazy(1).unwrap();
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
