//! Figures measured of folders, kept for as long as this process lives, so asking again costs a look-up, not a walk:
//! the list of repos and Storage answer from them at once, and the page asks for them measured afresh just after (the
//! person sees the numbers at once, and the true ones a moment later). root3 lives for one command, so it measures each
//! folder the once it asks.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// One kind of figure, by the folder it was measured of.
pub struct Kept<T>(Mutex<Option<HashMap<PathBuf, T>>>);

impl<T: Clone> Default for Kept<T> {
    fn default() -> Kept<T> {
        Kept::new()
    }
}

impl<T: Clone> Kept<T> {
    pub const fn new() -> Kept<T> {
        Kept(Mutex::new(None))
    }

    /// The figure kept of `at` (and true: it was kept, so it may be older than now), else the one `measure` makes
    /// now, kept from then on; `fresh`: measured again whatever was kept.
    pub fn of(&self, at: &Path, fresh: bool, measure: impl FnOnce() -> T) -> (T, bool) {
        if !fresh {
            if let Some(v) = self.0.lock().ok().and_then(|k| k.as_ref()?.get(at).cloned()) { return (v, true); }
        }
        let v = measure();
        if let Ok(mut k) = self.0.lock() { k.get_or_insert_with(HashMap::new).insert(at.to_path_buf(), v.clone()); }
        (v, false)
    }

    /// Nothing kept: what this process just took away is measured again when next asked.
    pub fn forget(&self) {
        if let Ok(mut k) = self.0.lock() { *k = None; }
    }
}

#[cfg(test)]
#[path = "tests/kept.rs"]
mod tests;
