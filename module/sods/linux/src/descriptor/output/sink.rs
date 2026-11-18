//! Private ledger for an exact external head. The filesystem Core keeps the
//! ordering/credit frontier; a separate owner holds the copied payload. The
//! methods neither install a host handle nor manufacture stop evidence.

use super::{Chunk, Entry, Error, HeadBytes, Queue, Reader, Removal, Ticket};
use crate::effect::{Action, Completion, Token};
use std::num::NonZeroUsize;
use std::ops::Range;

#[derive(Default)]
pub(super) struct Drain {
    held: Option<Held>,
}
struct Held {
    head: Ticket,
    length: NonZeroUsize,
    confirmed: usize,
    was_stopped: bool,
    attempt: Option<Action>,
}
impl Drain {
    fn active(&mut self, id: Attempt) -> Result<&mut Held, Error> {
        self.held
            .as_mut()
            .filter(|h| {
                h.head == id.head && h.attempt.as_ref().is_some_and(|a| a.token() == id.action)
            })
            .ok_or(Error::ExternalHead)
    }
}

/// Host-owned backing in the native witness. Host transport must separately
/// retain the matching owner object for every issued but unresolved offer.
#[derive(Debug)]
#[cfg(test)]
struct Payload {
    head: Ticket,
    bytes: Vec<u8>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Attempt {
    pub(super) head: Ticket,
    pub(super) action: Token,
}
#[must_use = "an issued effect owns its offer until an exact receipt"]
pub(super) struct Offer {
    pub(super) id: Attempt,
    pub(super) range: Range<usize>,
}
#[cfg(test)]
impl Offer {
    fn bytes(self, payload: &Payload) -> Option<&[u8]> {
        (self.id.head == payload.head).then(|| &payload.bytes[self.range])
    }
}
#[derive(Clone, Copy, Debug)]
pub(crate) enum Evidence {
    Unknown,
    AccessEnded,
    EffectsStopped,
    AccessAndEffectsEnded,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Waiting,
    Suffix(Range<usize>),
    Complete,
}

impl Reader<'_> {
    #[cfg(test)]
    fn handoff_to_sink(&mut self, mut buffer: Vec<u8>) -> Result<Payload, (Error, Vec<u8>)> {
        let q = &mut self.queue;
        if q.external.held.is_some() {
            return Err((Error::ExternalHead, buffer));
        }
        let Some(head) = Queue::head(q.head, &q.entries, &q.pins) else {
            return Err((Error::ExternalHead, buffer));
        };
        let length = head.bytes.len();
        if !buffer.is_empty() {
            return Err((Error::ReceiverNotEmpty, buffer));
        }
        if buffer.capacity() != length.get() {
            return Err((Error::ReceiverCapacity, buffer));
        }
        let to_escrow = head.removal(q.used, length);
        let bytes = match head.bytes.bytes(self.files) {
            Ok(bytes) => bytes,
            Err(error) => return Err((error, buffer)),
        };
        buffer.extend_from_slice(bytes);
        let head = self.escrow(to_escrow, length);
        Ok(Payload {
            head,
            bytes: buffer,
        })
    }

    /// After exact, stopped copy; the caller ensures the external allocation
    /// is retained and that this removal names the current non-escrowed head.
    pub(super) fn escrow(&mut self, to_escrow: Removal, length: NonZeroUsize) -> Ticket {
        let q = &mut self.queue;
        let head = q.front_ticket(to_escrow.index);
        let Entry::Queued { chunk, .. } = q.entries.live_mut(to_escrow.index) else {
            unreachable!("own frontier");
        };
        *chunk = Chunk::Escrowed(length);
        if let Some(pin) = to_escrow.pin {
            q.pins.remove(pin);
        }
        q.external.held = Some(Held {
            head,
            length,
            confirmed: 0,
            was_stopped: false,
            attempt: None,
        });
        head
    }

    #[cfg(test)]
    fn offer(&mut self, payload: &Payload) -> Result<Offer, Error> {
        self.offer_head(payload.head)
    }

    pub(super) fn offer_head(&mut self, head: Ticket) -> Result<Offer, Error> {
        let drain = &mut self.queue.external;
        let held = drain
            .held
            .as_mut()
            .filter(|h| h.head == head && h.attempt.is_none())
            .ok_or(Error::ExternalHead)?;
        let range = held.confirmed..held.length.get();
        let mut action = self
            .files
            .output_effects
            .reserve(range.len() as u64)
            .map_err(|_| Error::Overflow)?;
        let id = Attempt {
            head: held.head,
            action: action.token(),
        };
        action.start(id.action).expect("unexposed fresh action");
        held.attempt = Some(action);
        Ok(Offer { id, range })
    }

    pub(super) fn cancel_offer(&mut self, id: Attempt) -> Result<(), Error> {
        let held = self.queue.external.active(id)?;
        held.attempt
            .as_mut()
            .expect("exact active attempt")
            .cancel(id.action)
            .expect("validated attempt");
        Ok(())
    }

    pub(super) fn sink_receipt(
        &mut self,
        id: Attempt,
        confirmed: usize,
        evidence: Evidence,
    ) -> Result<Outcome, Error> {
        let held = self.queue.external.active(id)?;
        let advance = confirmed
            .checked_sub(held.confirmed)
            .ok_or(Error::ExternalHead)?;
        let completion = if matches!(evidence, Evidence::AccessAndEffectsEnded) {
            Completion::Stopped
        } else {
            Completion::Unknown
        };
        let action = held.attempt.as_mut().expect("exact active attempt");
        action
            .receipt(id.action, advance as u64, completion)
            .map_err(|_| Error::ExternalHead)?;
        if !action.reclaimable() {
            return Ok(Outcome::Waiting);
        }
        held.attempt = None;
        if confirmed == held.length.get() {
            self.remove_external(id.head);
            return Ok(Outcome::Complete);
        }
        held.confirmed = confirmed;
        held.was_stopped = true;
        Ok(Outcome::Suffix(confirmed..held.length.get()))
    }

    #[cfg(test)]
    fn discard_suffix(&mut self, payload: &Payload) -> Result<usize, Error> {
        self.discard_suffix_head(payload.head)
    }

    pub(super) fn discard_suffix_head(&mut self, head: Ticket) -> Result<usize, Error> {
        let held = self
            .queue
            .external
            .held
            .as_ref()
            .filter(|h| h.head == head && h.was_stopped && h.attempt.is_none())
            .ok_or(Error::ExternalHead)?;
        let discarded = held.length.get() - held.confirmed;
        self.remove_external(head);
        Ok(discarded)
    }

    fn remove_external(&mut self, ticket: Ticket) {
        let q = &mut self.queue;
        let head = Queue::head(q.head, &q.entries, &q.pins).expect("owned frontier");
        assert_eq!(q.front_ticket(head.index), ticket);
        assert!(matches!(head.bytes, HeadBytes::Escrowed(_)));
        let removal = head.removal(q.used, head.bytes.len());
        q.remove_head(removal);
        q.external.held = None;
    }
}

impl Queue {
    pub(super) fn front_ticket(&self, index: usize) -> Ticket {
        Ticket {
            destination: self.id,
            key: super::Key {
                index,
                generation: self.entries.cells[index].generation,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        tests::{files, n},
        Limits, Root,
    };
    use super::*;

    #[test]
    fn unresolved_external_head_fences_take_and_preserves_original_charge() {
        let (files, _, _, table, fd) = files(1702);
        let mut root = Root::new(files, 1).ok().unwrap();
        let (producer, consumer) = root
            .destination(Limits {
                pins: 1,
                entries: 2,
                bytes: 5,
            })
            .unwrap();
        let mut w = root.writer(&producer).unwrap();
        w.publish_resident(&table, fd, n(4)).unwrap();
        let later = w.reserve(n(1)).unwrap();
        w.publish_copy(later, b"!").unwrap();
        root.files.let_go(table).unwrap();

        let mut reader = root.reader(&consumer).unwrap();
        assert_eq!(reader.front_bytes().unwrap().unwrap(), b"body");
        for capacity in [3, 5] {
            let refused = reader
                .handoff_to_sink(Vec::with_capacity(capacity))
                .unwrap_err();
            assert_eq!(refused.0, Error::ReceiverCapacity);
        }
        let final_allocation = Vec::with_capacity(4);
        let pointer = final_allocation.as_ptr();
        let payload = reader.handoff_to_sink(final_allocation).unwrap();
        assert_eq!(
            payload.bytes.as_ptr(),
            pointer,
            "handoff uses the admitted final allocation"
        );
        assert_eq!(reader.queue.used, 5);
        assert!(
            reader.queue.pins.has_room(),
            "external owner retained no Core pin"
        );
        assert!(
            !reader.queue.entries.has_room(),
            "external head still charges K"
        );
        assert!(matches!(reader.front_bytes(), Err(Error::ExternalHead)));
        assert!(
            !reader.discard_front(),
            "old discard cannot receipt an external offer"
        );
        assert!(matches!(
            reader.take_front_into(&mut Vec::with_capacity(8), 8),
            Err(Error::ExternalHead)
        ));
        let issued = reader.offer(&payload).unwrap();
        let id = issued.id;
        assert_eq!(issued.range.clone(), 0..4);
        assert_eq!(issued.bytes(&payload), Some(&b"body"[..]));
        reader.cancel_offer(id).unwrap();
        assert_eq!(reader.offer(&payload).err(), Some(Error::ExternalHead));
        assert_eq!(
            reader.sink_receipt(id, 4, Evidence::Unknown),
            Ok(Outcome::Waiting)
        );
        for partial in [Evidence::AccessEnded, Evidence::EffectsStopped] {
            assert_eq!(reader.sink_receipt(id, 4, partial), Ok(Outcome::Waiting));
            assert_eq!(reader.queue.used, 5);
            assert!(!reader.discard_front());
        }
        assert_eq!(
            reader.sink_receipt(id, 3, Evidence::AccessAndEffectsEnded),
            Err(Error::ExternalHead)
        );
        assert_eq!(
            reader.sink_receipt(id, 5, Evidence::AccessAndEffectsEnded),
            Err(Error::ExternalHead)
        );
        assert_eq!(
            reader.sink_receipt(id, 4, Evidence::AccessAndEffectsEnded),
            Ok(Outcome::Complete)
        );
        assert_eq!(
            reader.sink_receipt(id, 4, Evidence::AccessAndEffectsEnded),
            Err(Error::ExternalHead)
        );
        assert_eq!(reader.queue.used, 1);
        assert_eq!(payload.bytes, b"body");
        assert_eq!(reader.front_bytes().unwrap().unwrap(), b"!");
    }

    #[test]
    fn stopped_partial_requires_a_new_attempt_at_the_absolute_suffix() {
        let (files, _, _, _, _) = files(1802);
        let mut root = Root::new(files, 2).ok().unwrap();
        let limits = || Limits {
            pins: 0,
            entries: 1,
            bytes: 4,
        };
        let (a, read_a) = root.destination(limits()).unwrap();
        let (b, read_b) = root.destination(limits()).unwrap();
        for producer in [&a, &b] {
            let mut w = root.writer(producer).unwrap();
            let pending = w.reserve(n(4)).unwrap();
            w.publish_copy(pending, b"ABCD").unwrap();
        }
        let mut a = root.reader(&read_a).unwrap();
        let a_payload = a.handoff_to_sink(Vec::with_capacity(4)).unwrap();
        let old = a.offer(&a_payload).unwrap().id;
        assert_eq!(
            a.sink_receipt(old, 2, Evidence::AccessAndEffectsEnded),
            Ok(Outcome::Suffix(2..4))
        );
        assert_eq!(a.queue.used, 4);

        let mut b = root.reader(&read_b).unwrap();
        let b_payload = b.handoff_to_sink(Vec::with_capacity(4)).unwrap();
        let foreign = b.offer(&b_payload).unwrap().id;
        assert_eq!(
            old.head.key, foreign.head.key,
            "lane-local entry slots/generations coincide"
        );
        assert_ne!(old.head.destination, foreign.head.destination);
        assert_eq!(
            b.sink_receipt(old, 4, Evidence::AccessAndEffectsEnded),
            Err(Error::ExternalHead)
        );

        let mut a = root.reader(&read_a).unwrap();
        assert_eq!(a.offer(&b_payload).err(), Some(Error::ExternalHead));
        let next = a.offer(&a_payload).unwrap();
        assert_ne!(next.id, old);
        assert_eq!(next.range.clone(), 2..4);
        let next_id = next.id;
        assert_eq!(next.bytes(&a_payload), Some(&b"CD"[..]));
        assert_eq!(
            a.sink_receipt(old, 4, Evidence::AccessAndEffectsEnded),
            Err(Error::ExternalHead)
        );
        assert_eq!(
            a.sink_receipt(next_id, 1, Evidence::AccessAndEffectsEnded),
            Err(Error::ExternalHead)
        );
        assert_eq!(
            a.sink_receipt(next_id, 2, Evidence::AccessAndEffectsEnded),
            Ok(Outcome::Suffix(2..4))
        );
        assert_eq!(a.discard_suffix(&a_payload), Ok(2));
        assert_eq!(a.queue.used, 0);
        assert!(a.front_bytes().unwrap().is_none());
    }

    #[test]
    fn privately_owned_regular_file_receives_only_the_explicit_suffix() {
        use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
        let directory =
            std::env::temp_dir().join(format!("sods-sink-witness-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(self.0.join("data"));
                let _ = std::fs::remove_dir(&self.0);
            }
        }
        let cleanup = Cleanup(directory);
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(cleanup.0.join("data"))
            .unwrap();

        let (files, _, _, _, _) = files(1902);
        let mut root = Root::new(files, 1).ok().unwrap();
        let (producer, consumer) = root
            .destination(Limits {
                pins: 0,
                entries: 1,
                bytes: 4,
            })
            .unwrap();
        let mut writer = root.writer(&producer).unwrap();
        let reservation = writer.reserve(n(4)).unwrap();
        writer.publish_copy(reservation, b"ABCD").unwrap();
        writer.close_admission();
        let mut reader = root.reader(&consumer).unwrap();
        let payload = reader.handoff_to_sink(Vec::with_capacity(4)).unwrap();

        let first = reader.offer(&payload).unwrap();
        let first_id = first.id;
        // Impose a short accepted prefix in this synchronous witness. Only
        // the private file, not a borrowed FD or callback, receives bytes.
        let confirmed = file.write(&first.bytes(&payload).unwrap()[..2]).unwrap();
        assert_eq!(confirmed, 2);
        assert_eq!(
            reader.sink_receipt(first_id, confirmed, Evidence::AccessAndEffectsEnded),
            Ok(Outcome::Suffix(2..4))
        );
        assert_eq!(
            file.metadata().unwrap().len(),
            2,
            "partial stop does not auto-replay"
        );
        assert!(!reader.discard_front());

        let second = reader.offer(&payload).unwrap();
        let second_id = second.id;
        assert_eq!(second.range.clone(), 2..4);
        let accepted = file.write(second.bytes(&payload).unwrap()).unwrap();
        assert_eq!(accepted, 2);
        assert_eq!(
            reader.sink_receipt(
                second_id,
                confirmed + accepted,
                Evidence::AccessAndEffectsEnded
            ),
            Ok(Outcome::Complete)
        );
        assert_eq!(reader.queue.used, 0);
        file.seek(SeekFrom::Start(0)).unwrap();
        let mut actual = Vec::new();
        file.read_to_end(&mut actual).unwrap();
        assert_eq!(
            actual, b"ABCD",
            "first accepted bytes were not written twice"
        );
    }
}
