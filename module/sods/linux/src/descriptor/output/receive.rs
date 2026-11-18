//! Exact-head read/commit for the rejected Worker fixture. A raw borrower
//! must also retain the entire owner and globally exclude mutations/growth.
use super::{sink, Files, Head, HeadBytes, Queue, QueueProbe, QueueProbeError, Reader};
use crate::effect::Token;

fn stamp(lane: u32, index: usize) -> u64 {
    (u64::from(lane) << 32) | u64::from(u32::try_from(index).expect("wasm32 entry slot"))
}

impl QueueProbe {
    pub(crate) fn sink_bind(&mut self, lane: u32) -> Result<(), QueueProbeError> {
        if self.sink_lane.is_some() {
            return Err(QueueProbeError::Busy);
        }
        self.consumers
            .get(lane as usize)
            .ok_or(QueueProbeError::Range)?;
        self.sink_lane = Some(lane);
        Ok(())
    }

    fn check_route(&self, lane: u32, sink: bool) -> Result<(), QueueProbeError> {
        if (self.sink_lane == Some(lane)) != sink {
            return Err(QueueProbeError::Busy);
        }
        Ok(())
    }

    fn receiver<'a>(
        &'a mut self,
        files: &'a mut Files,
        lane: u32,
    ) -> Result<Reader<'a>, QueueProbeError> {
        let consumer = self
            .consumers
            .get(lane as usize)
            .ok_or(QueueProbeError::Range)?;
        Ok(self.registry.reader(files, consumer)?)
    }

    pub(crate) fn receive_head(
        &mut self,
        files: &mut Files,
        lane: u32,
        sink: bool,
    ) -> Result<Option<(u64, u64, usize)>, QueueProbeError> {
        self.check_route(lane, sink)?;
        let reader = self.receiver(files, lane)?;
        let queue = reader.queue;
        let Some(head) = Queue::head(queue.head, &queue.entries, &queue.pins) else {
            return Ok(None);
        };
        if matches!(head.bytes, HeadBytes::Escrowed(_)) {
            return Err(QueueProbeError::Busy);
        }
        Ok(Some((
            stamp(lane, head.index),
            queue.entries.cells[head.index].generation,
            head.bytes.len().get(),
        )))
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
        let reader = self.receiver(files, lane)?;
        let head = exact_head(reader.queue, lane, tag, generation)?;
        let bytes = head
            .bytes
            .bytes(reader.files)
            .map_err(QueueProbeError::from)?;
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
        let mut reader = self.receiver(files, lane)?;
        let queue = &mut reader.queue;
        let head = exact_head(queue, lane, tag, generation)?;
        if matches!(head.bytes, HeadBytes::Escrowed(_)) {
            return Err(QueueProbeError::Busy);
        }
        let length = head.bytes.len();
        let removal = head.removal(queue.used, length);
        if sink {
            reader.escrow(removal, length);
        } else {
            queue.remove_head(removal);
        }
        Ok(())
    }

    fn escrowed<'a>(
        &'a mut self,
        files: &'a mut Files,
        lane: u32,
        tag: u64,
        generation: u64,
    ) -> Result<(Reader<'a>, super::Ticket), QueueProbeError> {
        self.check_route(lane, true)?;
        let reader = self.receiver(files, lane)?;
        let head =
            exact_head(reader.queue, lane, tag, generation).map_err(|_| QueueProbeError::Busy)?;
        if !matches!(head.bytes, HeadBytes::Escrowed(_)) {
            return Err(QueueProbeError::Busy);
        }
        let ticket = reader.queue.front_ticket(head.index);
        Ok((reader, ticket))
    }

    pub(crate) fn sink_offer(
        &mut self,
        files: &mut Files,
        lane: u32,
        tag: u64,
        generation: u64,
    ) -> Result<(u64, std::ops::Range<usize>), QueueProbeError> {
        let (mut reader, head) = self.escrowed(files, lane, tag, generation)?;
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
        let (mut reader, head) = self.escrowed(files, lane, tag, generation)?;
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
        let (mut reader, head) = self.escrowed(files, lane, tag, generation)?;
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
        let (mut reader, head) = self.escrowed(files, lane, tag, generation)?;
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
        let queue = self.receiver(files, lane)?.queue;
        queue.close_admission();
        Ok(queue.used == 0)
    }
}

fn exact_head(
    queue: &Queue,
    lane: u32,
    tag: u64,
    generation: u64,
) -> Result<Head<'_>, QueueProbeError> {
    let index = queue.head.ok_or(QueueProbeError::Owner)?;
    if tag != stamp(lane, index) || queue.entries.cells[index].generation != generation {
        return Err(QueueProbeError::Owner);
    }
    Ok(Queue::head(Some(index), &queue.entries, &queue.pins).expect("exact live head"))
}
