//! A receive loan selects the exact first accepted entry of its destination.
//! The raw fixture transport additionally retains the entire owner and
//! globally excludes mutation/growth until the exact lexical receipt.
#[cfg(all(target_arch = "wasm32", feature = "queued-worker-probe"))]
use super::{sink, Files, Key, QueueProbe, QueueProbeError};
use super::{Error, Head, HeadBytes, Queue, Reader, Ticket};
#[cfg(all(target_arch = "wasm32", feature = "queued-worker-probe"))]
use crate::effect::Token;
use std::num::NonZeroUsize;

enum CopyDisposition {
    OwnedResult,
    SinkEscrow,
}

impl Reader<'_> {
    fn selected_head(queue: &Queue, ticket: Ticket) -> Result<Head<'_>, Error> {
        let index = queue.head.ok_or(Error::BadHead)?;
        if ticket != queue.front_ticket(index) {
            return Err(Error::BadHead);
        }
        Ok(Queue::head(Some(index), &queue.entries, &queue.pins).expect("exact live head"))
    }

    fn receive_head(&self) -> Result<Option<(Ticket, NonZeroUsize)>, Error> {
        let queue = &self.queue;
        let Some(head) = Queue::head(queue.head, &queue.entries, &queue.pins) else {
            return Ok(None);
        };
        if matches!(head.bytes, HeadBytes::Escrowed(_)) {
            return Err(Error::ExternalHead);
        }
        Ok(Some((queue.front_ticket(head.index), head.bytes.len())))
    }

    fn receive_bytes(&mut self, ticket: Ticket) -> Result<&[u8], Error> {
        Self::selected_head(self.queue, ticket)?
            .bytes
            .bytes(self.files)
    }

    /// Caller must retain the exact view and its ended-access evidence. This
    /// changes only the Rust FIFO, not the physical sink's observed progress.
    fn receive_commit(&mut self, ticket: Ticket, dest: CopyDisposition) -> Result<(), Error> {
        let head = Self::selected_head(self.queue, ticket)?;
        if matches!(head.bytes, HeadBytes::Escrowed(_)) {
            return Err(Error::ExternalHead);
        }
        let length = head.bytes.len();
        let removal = head.removal(self.queue.used, length);
        match dest {
            CopyDisposition::OwnedResult => self.queue.remove_head(removal),
            CopyDisposition::SinkEscrow => {
                self.escrow(removal, length);
            }
        }
        Ok(())
    }
}

#[cfg(all(target_arch = "wasm32", feature = "queued-worker-probe"))]
fn stamp(lane: u32, index: usize) -> u64 {
    (u64::from(lane) << 32) | u64::from(u32::try_from(index).expect("wasm32 entry slot"))
}

#[cfg(all(target_arch = "wasm32", feature = "queued-worker-probe"))]
fn probe_ticket(dst: &Reader<'_>, lane: u32, word: u64, generation: u64) -> Result<Ticket, Error> {
    if word >> 32 != u64::from(lane) {
        return Err(Error::BadHead);
    }
    Ok(Ticket {
        destination: dst.queue.id,
        key: Key {
            index: word as u32 as usize,
            generation,
        },
    })
}

#[cfg(all(target_arch = "wasm32", feature = "queued-worker-probe"))]
impl QueueProbe {
    pub(crate) fn sink_bind(&mut self, lane: u32) -> Result<(), QueueProbeError> {
        if self.sink_lane.is_some() {
            return Err(QueueProbeError::Busy);
        }
        if lane > 1 || (lane == 1 && self.separate.is_none()) {
            return Err(QueueProbeError::Range);
        }
        self.sink_lane = Some(lane);
        Ok(())
    }

    fn check_route(&self, lane: u32, sink: bool) -> Result<(), QueueProbeError> {
        if (self.sink_lane == Some(lane)) != sink {
            return Err(QueueProbeError::Busy);
        }
        Ok(())
    }

    pub(crate) fn receive_head(
        &mut self,
        files: &mut Files,
        lane: u32,
        sink: bool,
    ) -> Result<Option<(u64, u64, usize)>, QueueProbeError> {
        self.check_route(lane, sink)?;
        Ok(self
            .receiver(files, lane as usize)?
            .receive_head()?
            .map(|(ticket, length)| {
                (
                    stamp(lane, ticket.key.index),
                    ticket.key.generation,
                    length.get(),
                )
            }))
    }

    pub(crate) fn receive_start(
        &mut self,
        files: &mut Files,
        lane: u32,
        tag: u64,
        generation: u64,
        sink: bool,
    ) -> Result<(*const u8, usize), QueueProbeError> {
        self.check_route(lane, sink)?;
        let mut reader = self.receiver(files, lane as usize)?;
        let ticket = probe_ticket(&reader, lane, tag, generation)?;
        let bytes = reader.receive_bytes(ticket)?;
        Ok((bytes.as_ptr(), bytes.len()))
    }

    pub(crate) fn receive_commit(
        &mut self,
        files: &mut Files,
        lane: u32,
        tag: u64,
        generation: u64,
        sink: bool,
    ) -> Result<(), QueueProbeError> {
        self.check_route(lane, sink)?;
        let mut reader = self.receiver(files, lane as usize)?;
        let ticket = probe_ticket(&reader, lane, tag, generation)?;
        let disposition = if sink {
            CopyDisposition::SinkEscrow
        } else {
            CopyDisposition::OwnedResult
        };
        Ok(reader.receive_commit(ticket, disposition)?)
    }

    fn sink_reader<'a>(
        &'a mut self,
        files: &'a mut Files,
        lane: u32,
        tag: u64,
        generation: u64,
    ) -> Result<(Reader<'a>, super::Ticket), QueueProbeError> {
        self.check_route(lane, true)?;
        let reader = self.receiver(files, lane as usize)?;
        // The external ledger independently matches the exact retained
        // frontier ticket and action; it never consumes a copied result.
        let ticket =
            probe_ticket(&reader, lane, tag, generation).map_err(|_| QueueProbeError::Busy)?;
        Ok((reader, ticket))
    }

    pub(crate) fn sink_offer(
        &mut self,
        files: &mut Files,
        lane: u32,
        tag: u64,
        generation: u64,
    ) -> Result<(u64, std::ops::Range<usize>), QueueProbeError> {
        let (mut reader, head) = self.sink_reader(files, lane, tag, generation)?;
        let offer = reader.offer_head(head)?;
        Ok((offer.id.action.sequence(), offer.range))
    }

    pub(crate) fn sink_receipt(
        &mut self,
        files: &mut Files,
        lane: u32,
        tag: u64,
        generation: u64,
        action: u64,
        confirmed: u32,
        evidence: sink::Evidence,
    ) -> Result<sink::Outcome, QueueProbeError> {
        let (mut reader, head) = self.sink_reader(files, lane, tag, generation)?;
        let action = Token::from_parts(reader.files.owner(), action);
        Ok(reader.sink_receipt(sink::Attempt { head, action }, confirmed as usize, evidence)?)
    }

    pub(crate) fn sink_cancel(
        &mut self,
        files: &mut Files,
        lane: u32,
        tag: u64,
        generation: u64,
        action: u64,
    ) -> Result<(), QueueProbeError> {
        let (mut reader, head) = self.sink_reader(files, lane, tag, generation)?;
        let action = Token::from_parts(reader.files.owner(), action);
        Ok(reader.cancel_offer(sink::Attempt { head, action })?)
    }

    pub(crate) fn sink_discard(
        &mut self,
        files: &mut Files,
        lane: u32,
        tag: u64,
        generation: u64,
    ) -> Result<usize, QueueProbeError> {
        let (mut reader, head) = self.sink_reader(files, lane, tag, generation)?;
        Ok(reader.discard_suffix_head(head)?)
    }

    /// Close future admissions, not a native handle. Q covers all live handoff
    /// and output reservations reachable through this fixture. It cannot
    /// certify independent R-only pins in a different producer profile.
    pub(crate) fn sink_shutdown(
        &mut self,
        files: &mut Files,
        lane: u32,
    ) -> Result<bool, QueueProbeError> {
        self.check_route(lane, true)?;
        let queue = self.receiver(files, lane as usize)?.queue;
        queue.close_admission();
        Ok(queue.used == 0)
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        sink,
        tests::{files, n},
        LaneRegistry, Limits,
    };
    use super::*;

    #[test]
    fn exact_receive_rejects_equal_local_keys_from_other_registry_and_reused_head() {
        let (mut files, _, _, table, _) = files(1807);
        files.let_go(table).unwrap();
        // One Files, two independently minted registries, and identical
        // first lane/index/generation. A scalar-only match has an ABA here.
        let mut left = LaneRegistry::new(&mut files, 1).unwrap();
        let mut right = LaneRegistry::new(&mut files, 1).unwrap();
        let limits = || Limits {
            pins: 0,
            entries: 1,
            bytes: 1,
        };
        let (lp, lc) = left.destination(limits()).unwrap();
        let (rp, rc) = right.destination(limits()).unwrap();
        for (reg, producer, byte) in [(&mut left, &lp, b"A"), (&mut right, &rp, b"B")] {
            let mut writer = reg.writer(&mut files, producer).unwrap();
            let reservation = writer.reserve(n(1)).unwrap();
            writer.publish_copy(reservation, byte).unwrap();
        }
        let (alien, _) = left
            .reader(&mut files, &lc)
            .unwrap()
            .receive_head()
            .unwrap()
            .unwrap();
        let mut reader = right.reader(&mut files, &rc).unwrap();
        let (old, len) = reader.receive_head().unwrap().unwrap();
        assert_eq!(alien.key, old.key);
        assert_ne!(alien.destination, old.destination);
        assert_eq!(len, n(1));
        assert_eq!(reader.receive_bytes(alien), Err(Error::BadHead));
        assert_eq!(
            reader.receive_commit(alien, CopyDisposition::SinkEscrow),
            Err(Error::BadHead)
        );
        assert_eq!(reader.receive_bytes(old), Ok(&b"B"[..]));
        reader
            .receive_commit(old, CopyDisposition::OwnedResult)
            .unwrap();
        assert_eq!(reader.receive_head(), Ok(None));
        let mut writer = right.writer(&mut files, &rp).unwrap();
        let replacement = writer.reserve(n(1)).unwrap();
        writer.publish_copy(replacement, b"C").unwrap();
        let mut reader = right.reader(&mut files, &rc).unwrap();
        let (head, _) = reader.receive_head().unwrap().unwrap();
        assert_eq!(head.key.index, old.key.index);
        assert_ne!(head.key.generation, old.key.generation);
        assert_eq!(
            reader.receive_commit(old, CopyDisposition::OwnedResult),
            Err(Error::BadHead)
        );
        assert_eq!(reader.receive_bytes(head), Ok(&b"C"[..]));
        assert_eq!(reader.offer_head(head).err(), Some(Error::ExternalHead));
        reader
            .receive_commit(head, CopyDisposition::SinkEscrow)
            .unwrap();
        assert_eq!(reader.receive_head(), Err(Error::ExternalHead));
        assert_eq!(reader.offer_head(old).err(), Some(Error::ExternalHead));
        let issued = reader.offer_head(head).unwrap().id;
        let wrong = sink::Attempt {
            head: old,
            action: issued.action,
        };
        assert_eq!(
            reader.sink_receipt(wrong, 1, sink::Evidence::AccessAndEffectsEnded),
            Err(Error::ExternalHead)
        );
        assert_eq!(
            reader.sink_receipt(issued, 1, sink::Evidence::AccessEnded),
            Ok(sink::Outcome::Waiting)
        );
        assert_eq!(reader.receive_head(), Err(Error::ExternalHead));
        assert_eq!(
            reader.sink_receipt(issued, 1, sink::Evidence::AccessAndEffectsEnded),
            Ok(sink::Outcome::Complete)
        );
        assert_eq!(reader.receive_head(), Ok(None));
    }
}
