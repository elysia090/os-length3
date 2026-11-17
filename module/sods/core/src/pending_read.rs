//! One synchronous exported read at a time. This lease owns core scratch, not
//! guest memory or a descriptor offset. IDs are never reused in this instance.
use crate::files::Error;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Read {
    pub operation: u32,
    pub file: u32,
    pub offset: usize,
    pub requested: usize,
    pub length: usize,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyResult {
    Copied(usize),
    Unknown,
}
#[derive(Debug, Default)]
pub struct Reads {
    next: u32,
    pending: Option<Read>,
}
impl Reads {
    pub fn idle(&self) -> Result<(), Error> {
        if self.pending.is_some() {
            Err(Error::Busy)
        } else {
            Ok(())
        }
    }
    pub fn can_begin(&self) -> Result<(), Error> {
        self.idle()?;
        if self.next == i32::MAX as u32 {
            Err(Error::Exhausted)
        } else {
            Ok(())
        }
    }
    pub fn begin(
        &mut self,
        file: u32,
        offset: usize,
        requested: usize,
        length: usize,
    ) -> Result<u32, Error> {
        self.can_begin()?;
        if file == 0 || length > requested {
            return Err(Error::BadCompletion);
        }
        self.next += 1;
        self.pending = Some(Read {
            operation: self.next,
            file,
            offset,
            requested,
            length,
        });
        Ok(self.next)
    }
    pub fn finish(&mut self, operation: u32, result: CopyResult) -> Result<usize, Error> {
        let pending = self.pending.ok_or(Error::BadCompletion)?;
        if pending.operation != operation
            || matches!(result, CopyResult::Copied(n) if n != pending.length)
        {
            return Err(Error::BadCompletion);
        }
        self.pending = None;
        Ok(match result {
            CopyResult::Copied(n) => n,
            CopyResult::Unknown => 0,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_matching_complete_copy_releases_a_read() {
        let mut reads = Reads::default();
        let op = reads.begin(7, 12, 99, 3).unwrap();
        assert_eq!(reads.pending.unwrap().file, 7);
        assert_eq!(reads.begin(8, 0, 1, 1), Err(Error::Busy));
        assert_eq!(
            reads.finish(op + 1, CopyResult::Copied(3)),
            Err(Error::BadCompletion)
        );
        assert_eq!(
            reads.finish(op, CopyResult::Copied(2)),
            Err(Error::BadCompletion)
        );
        assert_eq!(reads.idle(), Err(Error::Busy));
        assert_eq!(reads.finish(op, CopyResult::Copied(3)), Ok(3));
        assert_eq!(
            reads.finish(op, CopyResult::Copied(3)),
            Err(Error::BadCompletion)
        );
        let next = reads.begin(7, 99, 4, 0).unwrap();
        assert_ne!(op, next);
        assert_eq!(reads.finish(next, CopyResult::Unknown), Ok(0));
        assert_eq!(reads.idle(), Ok(()));
    }
    #[test]
    fn identities_do_not_wrap() {
        let mut reads = Reads {
            next: i32::MAX as u32,
            pending: None,
        };
        assert_eq!(reads.begin(1, 0, 0, 0), Err(Error::Exhausted));
    }
}
