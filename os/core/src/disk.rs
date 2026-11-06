//! Files on this device, as the OS keeps its own: written private and whole (write.rs), measured where the host
//! measures them (room.rs), and named by their bytes (digest.rs).

pub mod digest;
pub mod room;
pub mod write;
