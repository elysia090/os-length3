//! Private v1 byte effects. Explicit encoding, never a Rust struct's memory layout.
//! Backing bounds are necessary, not sufficient: the owner must separately check
//! instance identity, mapping permissions/epochs and an active allocation lease.

pub const SIZE: usize = 96;
const VERSION: u32 = 1;
const WASM32_LIMIT: u64 = 1 << 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Capture,
    CopyOut,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Effect {
    pub direction: Direction,
    pub operation: u64,
    pub slot: u64,
    pub slot_generation: u64,
    pub process: u64,
    pub image_generation: u64,
    pub region: u64,
    pub guest_address: u64,
    pub core_offset: u32,
    pub capacity: u32,
    pub length: u32,
    pub guest_epoch: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Size,
    Version,
    Direction,
    Flags,
    Reserved,
    Capacity,
    CoreBounds,
    GuestBounds,
    Identity,
    Count,
    AlreadyCompleted,
}

impl Effect {
    fn validate_shape(&self) -> Result<(), Error> {
        if self.operation == 0 || self.slot == 0 || self.slot_generation == 0 {
            return Err(Error::Identity);
        }
        if self.length > self.capacity {
            return Err(Error::Capacity);
        }
        Ok(())
    }

    /// Checks backing extents only; never grants a mapping or slot capability.
    pub fn validate_backing_bounds(&self, core_bytes: u64, guest_bytes: u64) -> Result<(), Error> {
        self.validate_shape()?;
        let end = u64::from(self.core_offset) + u64::from(self.capacity);
        if core_bytes > WASM32_LIMIT || end > core_bytes {
            return Err(Error::CoreBounds);
        }
        let end = self
            .guest_address
            .checked_add(u64::from(self.length))
            .ok_or(Error::GuestBounds)?;
        if end > guest_bytes {
            return Err(Error::GuestBounds);
        }
        Ok(())
    }

    pub fn encode(&self) -> [u8; SIZE] {
        let mut out = [0; SIZE];
        for (at, value) in [
            (0, VERSION),
            (
                4,
                match self.direction {
                    Direction::Capture => 1,
                    Direction::CopyOut => 2,
                },
            ),
            (12, SIZE as u32),
            (72, self.core_offset),
            (76, self.capacity),
            (80, self.length),
        ] {
            out[at..at + 4].copy_from_slice(&value.to_le_bytes());
        }
        for (at, value) in [
            (16, self.operation),
            (24, self.slot),
            (32, self.slot_generation),
            (40, self.process),
            (48, self.image_generation),
            (56, self.region),
            (64, self.guest_address),
            (88, self.guest_epoch),
        ] {
            out[at..at + 8].copy_from_slice(&value.to_le_bytes());
        }
        out
    }

    /// Parses the wire structure. Call validate_backing_bounds against fresh
    /// extents and consult the owner's pending record before acting on it.
    pub fn decode(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() != SIZE {
            return Err(Error::Size);
        }
        let u32_at = |at| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        let u64_at = |at| u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
        if u32_at(0) != VERSION {
            return Err(Error::Version);
        }
        if u32_at(12) != SIZE as u32 {
            return Err(Error::Size);
        }
        if u32_at(8) != 0 {
            return Err(Error::Flags);
        }
        if u32_at(84) != 0 {
            return Err(Error::Reserved);
        }
        let direction = match u32_at(4) {
            1 => Direction::Capture,
            2 => Direction::CopyOut,
            _ => return Err(Error::Direction),
        };
        let effect = Self {
            direction,
            operation: u64_at(16),
            slot: u64_at(24),
            slot_generation: u64_at(32),
            process: u64_at(40),
            image_generation: u64_at(48),
            region: u64_at(56),
            guest_address: u64_at(64),
            core_offset: u32_at(72),
            capacity: u32_at(76),
            length: u32_at(80),
            guest_epoch: u64_at(88),
        };
        effect.validate_shape()?;
        Ok(effect)
    }
}

/// Copy progress, not guest syscall acceptance or external delivery.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Copied(u32),
    BoundsBeforeEffect,
    StaleBeforeEffect,
    /// No guessed byte count: output may already be externally visible.
    UnknownEffect,
}

/// An owner's once-only completion record. No host memory or allocator access.
/// The runtime must bind this record to its core instance and live lease.
#[derive(Debug)]
pub struct Pending {
    effect: Effect,
    complete: bool,
}

impl Pending {
    pub fn new(effect: Effect) -> Result<Self, Error> {
        effect.validate_shape()?;
        Ok(Self {
            effect,
            complete: false,
        })
    }

    /// Rejected completions leave the record pending. A valid failure retires it
    /// as surely as success; cleanup must not replay a possibly performed copy.
    pub fn complete(
        &mut self,
        operation: u64,
        slot: u64,
        generation: u64,
        outcome: Outcome,
    ) -> Result<Outcome, Error> {
        if self.complete {
            return Err(Error::AlreadyCompleted);
        }
        if (operation, slot, generation)
            != (
                self.effect.operation,
                self.effect.slot,
                self.effect.slot_generation,
            )
        {
            return Err(Error::Identity);
        }
        if let Outcome::Copied(n) = outcome {
            if n != self.effect.length {
                return Err(Error::Count);
            }
        }
        self.complete = true;
        Ok(outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn effect() -> Effect {
        Effect {
            direction: Direction::Capture,
            operation: u64::MAX,
            slot: 2,
            slot_generation: 3,
            process: 4,
            image_generation: 5,
            region: 6,
            guest_address: 4096,
            core_offset: 128,
            capacity: 64,
            length: 32,
            guest_epoch: 7,
        }
    }

    #[test]
    fn explicit_layout_round_trips_without_losing_64_bit_identity() {
        let e = effect();
        let b = e.encode();
        assert_eq!(&b[16..24], &u64::MAX.to_le_bytes());
        assert_eq!(&b[72..76], &128u32.to_le_bytes());
        assert_eq!(Effect::decode(&b), Ok(e));
        assert_eq!(
            Effect::decode(
                &Effect {
                    direction: Direction::CopyOut,
                    ..e
                }
                .encode()
            )
            .unwrap()
            .direction,
            Direction::CopyOut
        );
    }
    #[test]
    fn rejects_unknown_wire_fields_and_truncated_records() {
        for (at, value, error) in [
            (0, 2, Error::Version),
            (4, 3, Error::Direction),
            (8, 1, Error::Flags),
            (12, 95, Error::Size),
            (84, 1, Error::Reserved),
            (80, 65, Error::Capacity),
        ] {
            let mut b = effect().encode();
            b[at..at + 4].copy_from_slice(&(value as u32).to_le_bytes());
            assert_eq!(Effect::decode(&b), Err(error));
        }
        for n in 0..SIZE {
            assert_eq!(Effect::decode(&effect().encode()[..n]), Err(Error::Size));
        }
        assert_eq!(Effect::decode(&[0; SIZE + 1]), Err(Error::Size));
    }
    #[test]
    fn bounds_cover_capacity_and_detect_guest_overflow() {
        let e = effect();
        assert_eq!(e.validate_backing_bounds(192, 4128), Ok(()));
        assert_eq!(e.validate_backing_bounds(191, 4128), Err(Error::CoreBounds));
        assert_eq!(
            e.validate_backing_bounds(192, 4127),
            Err(Error::GuestBounds)
        );
        assert_eq!(
            Effect {
                guest_address: u64::MAX,
                ..e
            }
            .validate_backing_bounds(192, u64::MAX),
            Err(Error::GuestBounds)
        );
        assert_eq!(
            e.validate_backing_bounds(WASM32_LIMIT + 1, 4128),
            Err(Error::CoreBounds)
        );
        assert_eq!(
            Effect {
                core_offset: u32::MAX,
                capacity: 2,
                length: 1,
                ..e
            }
            .validate_backing_bounds(WASM32_LIMIT, 4128),
            Err(Error::CoreBounds)
        );
        assert_eq!(
            Effect {
                core_offset: u32::MAX,
                capacity: 1,
                length: 1,
                ..e
            }
            .validate_backing_bounds(WASM32_LIMIT, 4128),
            Ok(())
        );
    }
    #[test]
    fn invalid_completion_does_not_consume_pending_record() {
        let e = effect();
        let mut p = Pending::new(e).unwrap();
        assert_eq!(
            p.complete(0, 2, 3, Outcome::Copied(32)),
            Err(Error::Identity)
        );
        assert_eq!(
            p.complete(e.operation, 2, 4, Outcome::Copied(32)),
            Err(Error::Identity)
        );
        assert_eq!(
            p.complete(e.operation, 2, 3, Outcome::Copied(31)),
            Err(Error::Count)
        );
        assert_eq!(
            p.complete(e.operation, 2, 3, Outcome::Copied(32)),
            Ok(Outcome::Copied(32))
        );
        assert_eq!(
            p.complete(e.operation, 2, 3, Outcome::Copied(32)),
            Err(Error::AlreadyCompleted)
        );
    }
    #[test]
    fn zero_ids_and_invalid_direct_capacity_cannot_become_pending() {
        for e in [
            Effect {
                operation: 0,
                ..effect()
            },
            Effect {
                slot: 0,
                ..effect()
            },
            Effect {
                slot_generation: 0,
                ..effect()
            },
        ] {
            assert_eq!(Effect::decode(&e.encode()), Err(Error::Identity));
            assert!(matches!(Pending::new(e), Err(Error::Identity)));
        }
        let e = Effect {
            length: 65,
            ..effect()
        };
        assert_eq!(e.validate_backing_bounds(192, 8192), Err(Error::Capacity));
        assert!(matches!(Pending::new(e), Err(Error::Capacity)));
    }
    #[test]
    fn empty_span_can_end_at_backing_boundary() {
        let e = Effect {
            core_offset: 192,
            capacity: 0,
            length: 0,
            guest_address: 4096,
            ..effect()
        };
        assert_eq!(e.validate_backing_bounds(192, 4096), Ok(()));
        assert_eq!(e.validate_backing_bounds(191, 4096), Err(Error::CoreBounds));
        assert_eq!(
            e.validate_backing_bounds(192, 4095),
            Err(Error::GuestBounds)
        );
        let mut p = Pending::new(e).unwrap();
        assert_eq!(
            p.complete(e.operation, e.slot, e.slot_generation, Outcome::Copied(0)),
            Ok(Outcome::Copied(0))
        );
    }
    #[test]
    fn failure_retires_once_without_inventing_zero_progress() {
        for outcome in [
            Outcome::BoundsBeforeEffect,
            Outcome::StaleBeforeEffect,
            Outcome::UnknownEffect,
        ] {
            let e = effect();
            let mut p = Pending::new(e).unwrap();
            assert_eq!(p.complete(e.operation, 2, 3, outcome), Ok(outcome));
            assert_eq!(
                p.complete(e.operation, 2, 3, Outcome::Copied(32)),
                Err(Error::AlreadyCompleted)
            );
        }
    }
}
