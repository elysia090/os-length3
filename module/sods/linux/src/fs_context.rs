//! CLONE_FS ownership only: root/cwd each hold one mount, plus shared umask.
//! Credentials, FD tables, address spaces and namespace membership are separate.
//! No chdir/chroot authorization or path confinement is implemented here.
//! Arena record count is bounded; Vec spare capacity may exceed it. Admission
//! scans record high water. Copy acquires two holds/name copies; share acquires
//! no mount hold. All fallible work precedes publication or position exchange.
use super::mount::{self, Hold, Mounts, Place};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Id {
    owner: u64,
    slot: usize,
    generation: u64,
}
#[must_use = "release the Fs holder explicitly; drop retains it until Files ends"]
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Ticket(Id);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Base {
    Root,
    Cwd,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Error {
    BadHandle,
    Capacity,
    Overflow,
    Mount(mount::Error),
}
impl From<mount::Error> for Error {
    fn from(e: mount::Error) -> Self {
        Self::Mount(e)
    }
}
struct Context {
    root: Hold,
    cwd: Hold,
    umask: u32,
    holders: u64,
}
struct Cell {
    generation: u64,
    context: Option<Context>,
}
pub(crate) struct Contexts {
    owner: u64,
    capacity: usize,
    cells: Vec<Cell>,
}
impl Contexts {
    pub(crate) fn new(owner: u64, capacity: usize) -> Self {
        Self {
            owner,
            capacity,
            cells: Vec::new(),
        }
    }
    fn get(&self, ticket: &Ticket) -> Result<&Context, Error> {
        let cell = self.cells.get(ticket.0.slot).ok_or(Error::BadHandle)?;
        if ticket.0.owner != self.owner || ticket.0.generation != cell.generation {
            return Err(Error::BadHandle);
        }
        cell.context.as_ref().ok_or(Error::BadHandle)
    }
    fn prepare(&mut self) -> Result<Id, Error> {
        for (slot, cell) in self.cells.iter().enumerate() {
            if cell.context.is_none() && cell.generation < u64::MAX {
                return Ok(Id {
                    owner: self.owner,
                    slot,
                    generation: cell.generation + 1,
                });
            }
        }
        if self.cells.len() >= self.capacity {
            return Err(Error::Capacity);
        }
        self.cells.try_reserve(1).map_err(|_| Error::Capacity)?;
        Ok(Id {
            owner: self.owner,
            slot: self.cells.len(),
            generation: 1,
        })
    }
    fn publish(&mut self, id: Id, root: Hold, cwd: Hold, umask: u32) -> Ticket {
        let cell = Cell {
            generation: id.generation,
            context: Some(Context {
                root,
                cwd,
                umask: umask & 0o777,
                holders: 1,
            }),
        };
        if id.slot == self.cells.len() {
            self.cells.push(cell);
        } else {
            self.cells[id.slot] = cell;
        }
        Ticket(id)
    }
    pub(crate) fn create(
        &mut self,
        mounts: &mut Mounts,
        root: &Place,
        cwd: &Place,
        umask: u32,
    ) -> Result<Ticket, Error> {
        let id = self.prepare()?;
        let root = mounts.hold(root)?;
        let cwd = match mounts.hold(cwd) {
            Ok(cwd) => cwd,
            Err(error) => {
                mounts.release_hold(root);
                return Err(error.into());
            }
        };
        Ok(self.publish(id, root, cwd, umask))
    }
    pub(crate) fn share(&mut self, ticket: &Ticket) -> Result<Ticket, Error> {
        let holders = self
            .get(ticket)?
            .holders
            .checked_add(1)
            .ok_or(Error::Overflow)?;
        self.cells[ticket.0.slot].context.as_mut().unwrap().holders = holders;
        Ok(Ticket(ticket.0))
    }
    pub(crate) fn copy(&mut self, mounts: &mut Mounts, ticket: &Ticket) -> Result<Ticket, Error> {
        self.get(ticket)?;
        let id = self.prepare()?;
        let context = self.get(ticket)?;
        let umask = context.umask;
        let root = mounts.copy_hold(&context.root)?;
        let cwd = match mounts.copy_hold(&context.cwd) {
            Ok(cwd) => cwd,
            Err(error) => {
                mounts.release_hold(root);
                return Err(error.into());
            }
        };
        Ok(self.publish(id, root, cwd, umask))
    }
    pub(crate) fn position_ref<'a>(
        &'a self,
        mounts: &Mounts,
        ticket: &Ticket,
        base: Base,
    ) -> Result<&'a Place, Error> {
        let context = self.get(ticket)?;
        mounts
            .position_ref(match base {
                Base::Root => &context.root,
                Base::Cwd => &context.cwd,
            })
            .map_err(Into::into)
    }
    pub(crate) fn change(
        &mut self,
        mounts: &mut Mounts,
        ticket: &Ticket,
        base: Base,
        to: &Place,
    ) -> Result<(), Error> {
        self.get(ticket)?;
        mounts.validate(to)?;
        // FsContext has no change epoch. Equality includes mount incarnation,
        // inode and full parent/name provenance, not merely backing storage.
        if self.position_ref(mounts, ticket, base)? == to {
            return Ok(());
        }
        let new = mounts.hold(to)?;
        let context = self.cells[ticket.0.slot].context.as_mut().unwrap();
        let old = std::mem::replace(
            match base {
                Base::Root => &mut context.root,
                Base::Cwd => &mut context.cwd,
            },
            new,
        );
        mounts.release_hold(old);
        Ok(())
    }
    pub(crate) fn umask(&self, ticket: &Ticket) -> Result<u32, Error> {
        Ok(self.get(ticket)?.umask)
    }
    pub(crate) fn set_umask(&mut self, ticket: &Ticket, mask: u32) -> Result<u32, Error> {
        let old = self.get(ticket)?.umask;
        self.cells[ticket.0.slot].context.as_mut().unwrap().umask = mask & 0o777;
        Ok(old)
    }
    pub(crate) fn release(
        &mut self,
        mounts: &mut Mounts,
        ticket: Ticket,
    ) -> Result<(), (Error, Ticket)> {
        let context = match self.get(&ticket) {
            Ok(context) => context,
            Err(error) => return Err((error, ticket)),
        };
        if context.holders > 1 {
            self.cells[ticket.0.slot].context.as_mut().unwrap().holders -= 1;
        } else {
            let context = self.cells[ticket.0.slot].context.take().unwrap();
            mounts.release_hold(context.root);
            mounts.release_hold(context.cwd);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inode::Tree;
    fn mounts(holds: usize) -> (Mounts, mount::Ticket, Place) {
        let tree = Tree::new(501, 1, 0, 0).unwrap();
        let (mounts, ticket) =
            Mounts::new(502, tree.root(), mount::Limits { views: 1, holds }).unwrap();
        let root = mounts.root(&ticket).unwrap();
        (mounts, ticket, root)
    }
    #[test]
    fn failed_second_hold_rolls_back_for_create_and_copy() {
        let (mut mounts, root_ticket, root) = mounts(4);
        let mut contexts = Contexts::new(503, 2);
        let fs = contexts.create(&mut mounts, &root, &root, 0o022).unwrap();
        assert_eq!(
            contexts.copy(&mut mounts, &fs),
            Err(Error::Mount(mount::Error::Capacity))
        );
        assert_eq!(contexts.umask(&fs), Ok(0o022));
        let spare = mounts.hold(&root).unwrap(); // failed copy returned its first hold
        assert!(matches!(mounts.hold(&root), Err(mount::Error::Capacity)));
        mounts.release_hold(spare);
        assert!(contexts.release(&mut mounts, fs).is_ok());
        assert!(mounts.release_ticket(root_ticket).is_ok());

        let (mut mounts, root_ticket, root) = self::mounts(2);
        let mut contexts = Contexts::new(504, 1);
        assert_eq!(
            contexts.create(&mut mounts, &root, &root, 0),
            Err(Error::Mount(mount::Error::Capacity))
        );
        let spare = mounts.hold(&root).unwrap();
        mounts.release_hold(spare);
        assert!(contexts.cells.iter().all(|cell| cell.context.is_none()));
        assert!(mounts.release_ticket(root_ticket).is_ok());
    }
    #[test]
    fn identical_position_is_noop_but_same_inode_alias_is_not() {
        let (mut mounts, root_ticket, root) = mounts(3);
        // Private representation test: distinct route provenance to the same
        // inode must not be collapsed. It does not add directory hardlinks.
        let a = mounts.component(&root, b"a", root.inode()).unwrap();
        let b = mounts.component(&root, b"b", root.inode()).unwrap();
        let mut contexts = Contexts::new(506, 1);
        let fs = contexts.create(&mut mounts, &root, &a, 0).unwrap();
        assert_eq!(contexts.change(&mut mounts, &fs, Base::Cwd, &a), Ok(()));
        assert_eq!(contexts.change(&mut mounts, &fs, Base::Root, &root), Ok(()));
        assert_eq!(
            contexts.change(&mut mounts, &fs, Base::Cwd, &b),
            Err(Error::Mount(mount::Error::Capacity))
        );
        assert!(contexts.position_ref(&mounts, &fs, Base::Cwd).unwrap() == &a);
        assert!(contexts.release(&mut mounts, fs).is_ok());
        assert!(mounts.release_ticket(root_ticket).is_ok());
    }
    #[test]
    fn stale_foreign_capacity_and_holder_overflow_preserve_owners() {
        let (mut mounts, root_ticket, root) = mounts(8);
        let mut contexts = Contexts::new(505, 1);
        let fs = contexts.create(&mut mounts, &root, &root, 0o022).unwrap();
        assert_eq!(contexts.copy(&mut mounts, &fs), Err(Error::Capacity));
        let foreign = Ticket(Id { owner: 999, ..fs.0 });
        assert_eq!(contexts.share(&foreign), Err(Error::BadHandle));
        contexts.cells[fs.0.slot].context.as_mut().unwrap().holders = u64::MAX;
        assert_eq!(contexts.share(&fs), Err(Error::Overflow));
        contexts.cells[fs.0.slot].context.as_mut().unwrap().holders = 1;
        let stale = Ticket(fs.0); // fabricated only in this private regression
        assert!(contexts.release(&mut mounts, fs).is_ok());
        let fresh = contexts.create(&mut mounts, &root, &root, 0o077).unwrap();
        assert_eq!(contexts.umask(&stale), Err(Error::BadHandle));
        assert_eq!(contexts.umask(&fresh), Ok(0o077));
        assert!(contexts.release(&mut mounts, fresh).is_ok());
        contexts.cells[0].generation = u64::MAX;
        assert_eq!(
            contexts.create(&mut mounts, &root, &root, 0),
            Err(Error::Capacity)
        );
        assert!(mounts.release_ticket(root_ticket).is_ok());
    }
}
