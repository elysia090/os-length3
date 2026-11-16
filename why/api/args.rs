//! A command's arguments, as a page gives them: an object read by name.

use serde::de::DeserializeOwned;
use serde_json::Value;

/// A command's arguments, read by name; one missing or of the wrong kind is said by its name.
pub(super) struct Args<'a>(pub(super) &'a Value);

impl Args<'_> {
    pub(super) fn get<T: DeserializeOwned>(&self, key: &str) -> crate::Result<T> {
        serde_json::from_value(self.0.get(key).cloned().unwrap_or(Value::Null))
            .map_err(|e| crate::tr!("{}: {}", "{}：{}", key, e))
    }
    pub(super) fn opt<T: DeserializeOwned>(&self, key: &str) -> crate::Result<Option<T>> { self.get(key) }
    pub(super) fn s(&self, key: &str) -> crate::Result<String> { self.get(key) }
    pub(super) fn list(&self, key: &str) -> crate::Result<Vec<String>> {
        Ok(self.opt::<Vec<String>>(key)?.unwrap_or_default())
    }
}
