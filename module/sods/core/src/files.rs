//! Owned regular-file payloads. Namespace, permissions and shared mappings are
//! deliberately not implemented here. IDs are never reused within a store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    BadHandle,
    TooLarge,
    NoMemory,
    Exhausted,
}
#[derive(Debug)]
pub struct Files {
    files: Vec<Option<Vec<u8>>>,
    max_file: usize,
}
impl Files {
    pub fn new(max_file: usize) -> Self {
        Self {
            files: Vec::new(),
            max_file,
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
        self.files.push(Some(bytes));
        Ok(self.files.len() as u32)
    }
    fn file(&self, id: u32) -> Result<&Vec<u8>, Error> {
        self.files
            .get(id.wrapping_sub(1) as usize)
            .and_then(Option::as_ref)
            .ok_or(Error::BadHandle)
    }
    fn file_mut(&mut self, id: u32) -> Result<&mut Vec<u8>, Error> {
        self.files
            .get_mut(id.wrapping_sub(1) as usize)
            .and_then(Option::as_mut)
            .ok_or(Error::BadHandle)
    }
    pub fn read(&self, id: u32, at: usize, length: usize) -> Result<&[u8], Error> {
        let bytes = self.file(id)?;
        let start = at.min(bytes.len());
        Ok(&bytes[start..start + length.min(bytes.len() - start)])
    }
    pub fn write(&mut self, id: u32, at: usize, input: &[u8]) -> Result<(), Error> {
        self.file(id)?;
        let end = at
            .checked_add(input.len())
            .filter(|n| *n <= self.max_file)
            .ok_or(Error::TooLarge)?;
        let bytes = self.file_mut(id)?;
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
        self.file(id)?;
        if length > self.max_file {
            return Err(Error::TooLarge);
        }
        let bytes = self.file_mut(id)?;
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
