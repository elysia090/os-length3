//! Exact-head read/commit for the rejected Worker fixture. A raw borrower
//! must also retain the entire owner and globally exclude mutations/growth.
use super::{Files, Head, Queue, QueueProbe, QueueProbeError, Reader};

fn stamp(lane: u32, index: usize) -> u64 {
    (u64::from(lane) << 32) | u64::from(u32::try_from(index).expect("wasm32 entry slot"))
}

impl QueueProbe {
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
    ) -> Result<Option<(u64, u64, usize)>, QueueProbeError> {
        let reader = self.receiver(files, lane)?;
        let queue = reader.queue;
        Ok(
            Queue::head(queue.head, &queue.entries, &queue.pins).map(|head| {
                (
                    stamp(lane, head.index),
                    queue.entries.cells[head.index].generation,
                    head.bytes.len().get(),
                )
            }),
        )
    }

    pub(crate) fn receive_start(
        &mut self,
        files: &mut Files,
        lane: u32,
        tag: u64,
        generation: u64,
    ) -> Result<(*const u8, usize), QueueProbeError> {
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
    ) -> Result<(), QueueProbeError> {
        let reader = self.receiver(files, lane)?;
        let queue = reader.queue;
        let head = exact_head(queue, lane, tag, generation)?;
        let removal = head.removal(queue.used, head.bytes.len());
        queue.remove_head(removal);
        Ok(())
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
