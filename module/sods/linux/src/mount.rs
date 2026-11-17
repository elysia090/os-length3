//! Single private namespace, leaf mount views only. Not mount syscalls: no
//! stacking, recursive clones, propagation, pivot, path resolution or credentials.
//! Place is a position, not a hold. Tickets and descriptions hold views; root and
//! attachments keep topology alive independently. Storage remains owned by Files.
//! Bounded arena scans cost O(mount high water) per admission/topology operation.
//! Record/hold caps do not bound Vec spare allocation. Names are copied before
//! mutation; payloads are never copied. Explicit ticket release is required;
//! dropping a ticket retains its hold until the entire Files owner is dropped.
use super::inode::Inode;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Id {
    owner: u64,
    slot: usize,
    generation: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Error {
    BadPlace,
    Capacity,
    Overflow,
    Unsupported,
    Attached,
    Type,
}
#[derive(Clone, Copy)]
pub(crate) struct Limits {
    pub views: usize,
    pub holds: usize,
}
/// Non-owning position; no arbitrary inode/view constructor is exposed to callers.
#[derive(PartialEq, Eq)]
pub(crate) struct Place {
    view: Id,
    inode: Inode,
    parent: Option<Inode>,
    name: Vec<u8>,
}
#[must_use = "release the view ticket explicitly; drop retains it until Files ends"]
pub(crate) struct Ticket(Id);
/// One description's hold. Dup/fork/read refs share that description.
pub(crate) struct Hold {
    location: Place,
}
/// Topology decision only. Tree parent/search semantics stay in Files.
pub(crate) enum ParentStep<'a> {
    Fixed,
    TreeParent,
    Across(&'a Place),
}
struct View {
    root: Inode,
    root_parent: Option<Inode>,
    root_name: Vec<u8>,
    directory: bool,
    point: Option<Place>,
    holds: u64,
}
struct Cell {
    generation: u64,
    view: Option<View>,
}
pub(crate) struct Mounts {
    owner: u64,
    cells: Vec<Cell>,
    limits: Limits,
    holds: usize,
}
fn copy(bytes: &[u8]) -> Result<Vec<u8>, Error> {
    let mut out = Vec::new();
    out.try_reserve_exact(bytes.len())
        .map_err(|_| Error::Capacity)?;
    out.extend_from_slice(bytes);
    Ok(out)
}
impl Place {
    pub(crate) fn inode(&self) -> Inode {
        self.inode
    }
}
impl Mounts {
    pub(crate) fn new(owner: u64, root: Inode, limits: Limits) -> Result<(Self, Ticket), Error> {
        if limits.views == 0 || limits.holds == 0 {
            return Err(Error::Capacity);
        }
        let mut cells = Vec::new();
        cells.try_reserve(1).map_err(|_| Error::Capacity)?;
        cells.push(Cell {
            generation: 1,
            view: Some(View {
                root,
                root_parent: None,
                root_name: Vec::new(),
                directory: true,
                point: None,
                holds: 1,
            }),
        });
        Ok((
            Self {
                owner,
                cells,
                limits,
                holds: 1,
            },
            Ticket(Id {
                owner,
                slot: 0,
                generation: 1,
            }),
        ))
    }
    fn view(&self, id: Id) -> Result<&View, Error> {
        let cell = self.cells.get(id.slot).ok_or(Error::BadPlace)?;
        if id.owner != self.owner || cell.generation != id.generation {
            return Err(Error::BadPlace);
        }
        cell.view.as_ref().ok_or(Error::BadPlace)
    }
    pub(crate) fn validate(&self, place: &Place) -> Result<(), Error> {
        self.view(place.view).map(|_| ())
    }
    fn root_id(&self, id: Id) -> Result<Place, Error> {
        let view = self.view(id)?;
        Ok(Place {
            view: id,
            inode: view.root,
            parent: view.root_parent,
            name: copy(&view.root_name)?,
        })
    }
    pub(crate) fn root(&self, ticket: &Ticket) -> Result<Place, Error> {
        self.root_id(ticket.0)
    }
    /// Files supplies only the result of a checked direct component lookup.
    pub(crate) fn component(
        &self,
        from: &Place,
        name: &[u8],
        inode: Inode,
    ) -> Result<Place, Error> {
        self.validate(from)?;
        for (slot, cell) in self.cells.iter().enumerate() {
            if let Some(view) = &cell.view {
                if view.point.as_ref().is_some_and(|p| {
                    p.view == from.view && p.parent == Some(from.inode) && p.name == name
                }) {
                    return self.root_id(Id {
                        owner: self.owner,
                        slot,
                        generation: cell.generation,
                    });
                }
            }
        }
        Ok(Place {
            view: from.view,
            inode,
            parent: Some(from.inode),
            name: copy(name)?,
        })
    }
    /// Root confinement compares location identity, not route-name provenance.
    pub(crate) fn same_position(&self, a: &Place, b: &Place) -> Result<bool, Error> {
        self.validate(a)?;
        self.validate(b)?;
        Ok(a.view == b.view && a.inode == b.inode)
    }
    pub(crate) fn copy_position(&self, from: &Place) -> Result<Place, Error> {
        self.validate(from)?;
        Ok(Place {
            view: from.view,
            inode: from.inode,
            parent: from.parent,
            name: copy(&from.name)?,
        })
    }
    /// No search permissions or BENEATH/IN_ROOT/NO_XDEV policy here. Caller
    /// checks directory type even when a boundary or detached root clamps.
    pub(crate) fn parent_step<'a>(
        &'a self,
        from: &Place,
        boundary: &Place,
    ) -> Result<ParentStep<'a>, Error> {
        if self.same_position(from, boundary)? {
            return Ok(ParentStep::Fixed);
        }
        let view = self.view(from.view)?;
        if from.inode != view.root {
            return Ok(ParentStep::TreeParent);
        }
        match &view.point {
            Some(point) => {
                self.validate(point)?;
                Ok(ParentStep::Across(point))
            }
            None => Ok(ParentStep::Fixed),
        }
    }
    /// Files supplies an actual Tree parent and its own borrowed provenance.
    /// At a bind root preserve the view's provenance, not the backing-tree path.
    pub(crate) fn parent_position(
        &self,
        from: &Place,
        inode: Inode,
        provenance: Option<(Inode, &[u8])>,
        boundary: &Place,
    ) -> Result<Place, Error> {
        let view = self.view(from.view)?;
        self.validate(boundary)?;
        // Root overmount is unsupported, so no coverage can supersede this view root.
        if inode == view.root {
            return self.root_id(from.view);
        }
        let parent = provenance.map(|p| p.0);
        let name = provenance.map_or(&[][..], |p| p.1);
        if from.view != boundary.view || inode != boundary.inode {
            // Existing leaf coverage. O(M) scan, using borrowed name bytes;
            // only the ultimately returned Place allocates its provenance.
            for (slot, cell) in self.cells.iter().enumerate() {
                if let Some(view) = &cell.view {
                    if view.point.as_ref().is_some_and(|p| {
                        p.view == from.view
                            && p.parent == parent
                            && p.name == name
                            && p.inode == inode
                    }) {
                        return self.root_id(Id {
                            owner: self.owner,
                            slot,
                            generation: cell.generation,
                        });
                    }
                }
            }
        }
        Ok(Place {
            view: from.view,
            inode,
            parent,
            name: copy(name)?,
        })
    }

    fn has_children(&self, id: Id) -> bool {
        self.cells.iter().any(|c| {
            c.view
                .as_ref()
                .is_some_and(|v| v.point.as_ref().is_some_and(|p| p.view == id))
        })
    }
    fn admit_hold(&self, id: Id) -> Result<u64, Error> {
        let count = self.view(id)?.holds.checked_add(1).ok_or(Error::Overflow)?;
        if self.holds >= self.limits.holds {
            return Err(Error::Capacity);
        }
        Ok(count)
    }
    pub(crate) fn hold(&mut self, place: &Place) -> Result<Hold, Error> {
        let count = self.admit_hold(place.view)?;
        let location = Place {
            view: place.view,
            inode: place.inode,
            parent: place.parent,
            name: copy(&place.name)?,
        };
        self.cells[place.view.slot].view.as_mut().unwrap().holds = count;
        self.holds += 1;
        Ok(Hold { location })
    }
    /// Borrowed only within Rust; the hold stays owned throughout the lookup.
    pub(crate) fn position_ref<'a>(&self, hold: &'a Hold) -> Result<&'a Place, Error> {
        self.validate(&hold.location)?;
        Ok(&hold.location)
    }
    pub(crate) fn copy_hold(&mut self, hold: &Hold) -> Result<Hold, Error> {
        let position = self.position_ref(hold)?;
        self.hold(position)
    }
    fn collect(&mut self, id: Id) {
        if id.slot == 0 {
            return;
        } // bootstrap namespace owns its root view
        let view = self.cells[id.slot].view.as_ref().unwrap();
        if view.holds == 0 && view.point.is_none() && !self.has_children(id) {
            self.cells[id.slot].view = None;
        }
    }
    pub(crate) fn release_hold(&mut self, hold: Hold) {
        self.release_id(hold.location.view);
    }
    fn release_id(&mut self, id: Id) {
        let view = self.cells[id.slot].view.as_mut().unwrap();
        assert!(view.holds > 0);
        view.holds -= 1;
        self.holds -= 1;
        self.collect(id);
    }
    pub(crate) fn release_ticket(&mut self, ticket: Ticket) -> Result<(), (Error, Ticket)> {
        if let Err(error) = self.view(ticket.0) {
            return Err((error, ticket));
        }
        self.release_id(ticket.0);
        Ok(())
    }
    pub(crate) fn clone_view(&mut self, source: &Place, directory: bool) -> Result<Ticket, Error> {
        self.validate(source)?;
        if self.has_children(source.view) {
            return Err(Error::Unsupported);
        }
        self.create_view(source.inode, source.parent, &source.name, directory)
    }
    /// Files validates that root is the root of an admitted filesystem.
    pub(crate) fn filesystem_root(&mut self, root: Inode) -> Result<Ticket, Error> {
        self.create_view(root, None, &[], true)
    }
    fn create_view(
        &mut self,
        root: Inode,
        root_parent: Option<Inode>,
        name: &[u8],
        directory: bool,
    ) -> Result<Ticket, Error> {
        if self.holds >= self.limits.holds {
            return Err(Error::Capacity);
        }
        let root_name = copy(name)?;
        let vacant = self
            .cells
            .iter()
            .position(|c| c.view.is_none() && c.generation < u64::MAX);
        let slot = match vacant {
            Some(slot) => slot,
            None => {
                if self.cells.len() >= self.limits.views {
                    return Err(Error::Capacity);
                }
                self.cells.try_reserve(1).map_err(|_| Error::Capacity)?;
                self.cells.len()
            }
        };
        let generation = if slot == self.cells.len() {
            1
        } else {
            self.cells[slot].generation + 1
        };
        let cell = Cell {
            generation,
            view: Some(View {
                root,
                root_parent,
                root_name,
                directory,
                point: None,
                holds: 1,
            }),
        };
        if slot == self.cells.len() {
            self.cells.push(cell);
        } else {
            self.cells[slot] = cell;
        }
        self.holds += 1;
        Ok(Ticket(Id {
            owner: self.owner,
            slot,
            generation,
        }))
    }
    pub(crate) fn attach(
        &mut self,
        ticket: &Ticket,
        to: &Place,
        directory: bool,
    ) -> Result<(), Error> {
        let source = self.view(ticket.0)?;
        let target = self.view(to.view)?;
        if source.point.is_some() || ticket.0.slot == 0 {
            return Err(Error::Attached);
        }
        if self.has_children(ticket.0) || to.inode == target.root {
            return Err(Error::Unsupported);
        }
        // Only bootstrap or attached destinations are in this namespace. Leaf
        // sources cannot contain their target; no disconnected topology is built.
        if to.view.slot != 0 && target.point.is_none() {
            return Err(Error::Unsupported);
        }
        if source.directory != directory {
            return Err(Error::Type);
        }
        if self.cells.iter().any(|c| {
            c.view.as_ref().is_some_and(|v| {
                v.point.as_ref().is_some_and(|p| {
                    p.view == to.view && p.parent == to.parent && p.name == to.name
                })
            })
        }) {
            return Err(Error::Attached);
        }
        let point = Place {
            view: to.view,
            inode: to.inode,
            parent: to.parent,
            name: copy(&to.name)?,
        };
        self.cells[ticket.0.slot].view.as_mut().unwrap().point = Some(point);
        Ok(())
    }
    pub(crate) fn detach(&mut self, place: &Place) -> Result<(), Error> {
        let view = self.view(place.view)?;
        if place.inode != view.root || place.view.slot == 0 || view.point.is_none() {
            return Err(Error::Unsupported);
        }
        if self.has_children(place.view) {
            return Err(Error::Unsupported);
        }
        let parent = view.point.as_ref().unwrap().view;
        self.cells[place.view.slot].view.as_mut().unwrap().point = None;
        self.collect(place.view);
        self.collect(parent);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inode::Tree;
    #[test]
    fn stale_generation_foreign_view_and_capacity_do_not_alias() {
        let tree = Tree::new(1, 1, 0, 0).unwrap();
        let (mut mounts, root) =
            Mounts::new(2, tree.root(), Limits { views: 2, holds: 3 }).unwrap();
        let place = mounts.root(&root).unwrap();
        let ticket = mounts.clone_view(&place, true).unwrap();
        let stale = mounts.root(&ticket).unwrap();
        let old_id = ticket.0;
        assert!(mounts.release_ticket(ticket).is_ok());
        let fresh = mounts.clone_view(&place, true).unwrap();
        assert_ne!(fresh.0, old_id);
        assert!(matches!(mounts.hold(&stale), Err(Error::BadPlace)));
        assert!(matches!(
            mounts.clone_view(&place, true),
            Err(Error::Capacity)
        ));
        let foreign = Place {
            view: Id {
                owner: 99,
                ..fresh.0
            },
            inode: place.inode,
            parent: None,
            name: Vec::new(),
        };
        assert!(matches!(mounts.hold(&foreign), Err(Error::BadPlace)));
        mounts.cells[fresh.0.slot].view.as_mut().unwrap().holds = u64::MAX;
        let current = mounts.root(&fresh).unwrap();
        assert!(matches!(mounts.hold(&current), Err(Error::Overflow)));
        mounts.cells[fresh.0.slot].view.as_mut().unwrap().holds = 1;
        assert!(mounts.release_ticket(fresh).is_ok());
        mounts.cells[1].generation = u64::MAX;
        assert!(matches!(
            mounts.clone_view(&place, true),
            Err(Error::Capacity)
        ));
        assert!(mounts.release_ticket(root).is_ok());
    }
    #[test]
    fn parent_boundary_ignores_name_provenance_but_validates_view_incarnation() {
        let tree = Tree::new(901, 1, 0, 0).unwrap();
        let (mut mounts, ticket) =
            Mounts::new(902, tree.root(), Limits { views: 2, holds: 3 }).unwrap();
        let root = mounts.root(&ticket).unwrap();
        let variant = Place {
            view: root.view,
            inode: root.inode,
            parent: Some(root.inode),
            name: b"different".to_vec(),
        };
        assert!(matches!(
            mounts.parent_step(&variant, &root),
            Ok(ParentStep::Fixed)
        ));
        let view = mounts.clone_view(&root, true).unwrap();
        let detached = mounts.root(&view).unwrap();
        assert!(!mounts.same_position(&root, &detached).unwrap());
        assert!(matches!(
            mounts.parent_step(&detached, &root),
            Ok(ParentStep::Fixed)
        ));
        let foreign = Place {
            view: Id {
                owner: 999,
                ..root.view
            },
            inode: root.inode,
            parent: None,
            name: Vec::new(),
        };
        assert!(matches!(
            mounts.parent_step(&root, &foreign),
            Err(Error::BadPlace)
        ));
        assert!(matches!(
            mounts.parent_step(&foreign, &root),
            Err(Error::BadPlace)
        ));
        assert!(mounts.release_ticket(view).is_ok());
        assert!(matches!(
            mounts.parent_step(&detached, &root),
            Err(Error::BadPlace)
        ));
        assert!(matches!(
            mounts.parent_step(&root, &detached),
            Err(Error::BadPlace)
        ));
        assert!(mounts.release_ticket(ticket).is_ok());
    }
    #[test]
    fn view_and_description_keep_file_location_provenance() {
        let tree = Tree::new(11, 1, 0, 0).unwrap();
        let (mut mounts, root) =
            Mounts::new(12, tree.root(), Limits { views: 2, holds: 3 }).unwrap();
        let place = mounts.root(&root).unwrap();
        // component is called only after Files checked the tree lookup.
        let child = mounts.component(&place, b"name", tree.root()).unwrap();
        let ticket = mounts.clone_view(&child, false).unwrap();
        let view = mounts.root(&ticket).unwrap();
        assert_eq!(view.parent, Some(tree.root()));
        assert_eq!(view.name, b"name");
        let hold = mounts.hold(&view).unwrap();
        assert_eq!(hold.location.parent, Some(tree.root()));
        assert_eq!(hold.location.name, b"name");
        mounts.release_hold(hold);
        assert!(mounts.release_ticket(ticket).is_ok());
        assert!(mounts.release_ticket(root).is_ok());
    }
}
