//! Retained resident sendfile cursor for the one selected capture lane.
//! No staging copy, payload view, guest memory lease or physical effect.
use super::{Context, Error};
use crate::descriptor::{OutputHold, ReadHold, Table};
use crate::execution::{Invocation, Snapshot};
use std::num::{NonZeroU64, NonZeroUsize};

pub(crate) enum Turn {
    Accepted(NonZeroUsize),
    Waiting(Resident),
}

#[must_use = "resume or cancel with the exact execution, Files and destination"]
pub(crate) struct Resident {
    invocation: Invocation,
    execution: Snapshot,
    registry: super::RegistryId,
    destination: Option<OutputHold>,
    source: Option<ReadHold>,
    length: NonZeroUsize,
}
impl Resident {
    /// The caller has already consumed the exact sequenced request. Check Q/K/R
    /// first; only a genuinely waitable call retains the original input OFD.
    pub(crate) fn admit(
        ctx: &mut Context<'_>,
        table: &Table,
        out: u32,
        input: u32,
        length: NonZeroUsize,
        invocation: Invocation,
    ) -> Result<Turn, Error> {
        enum Outcome {
            Accepted(NonZeroUsize),
            Waiting(ReadHold, Snapshot),
        }
        ctx.execution.check_domain(ctx.domain)?;
        ctx.execution.syscall_allowed(invocation)?;
        let destination = ctx.files.hold_output(table, out)?;
        ctx.execution
            .hold_call(invocation)
            .expect("checked same turn");
        let attempt = (|| -> Result<Outcome, Error> {
            let mut writer = ctx.lanes.held_writer(ctx.files, &destination)?;
            let Some(reservation) = writer.reserve_resident_when_room(length)? else {
                let execution = ctx.execution.stamp()?;
                let source = writer.reserve_resident_source(table, input, length)?;
                return Ok(Outcome::Waiting(source, execution));
            };
            let count = writer.publish_reserved_resident(table, input, length, reservation)?;
            Ok(Outcome::Accepted(count))
        })();
        match attempt {
            Ok(Outcome::Waiting(source, execution)) => Ok(Turn::Waiting(Self {
                invocation,
                execution,
                registry: ctx.lanes.id,
                destination: Some(destination),
                source: Some(source),
                length,
            })),
            settled => {
                ctx.files
                    .release_output(destination)
                    .expect("same output OFD");
                ctx.execution
                    .finish_call(invocation)
                    .expect("same retained call");
                match settled? {
                    Outcome::Accepted(count) => Ok(Turn::Accepted(count)),
                    Outcome::Waiting(..) => unreachable!("retained above"),
                }
            }
        }
    }

    pub(crate) fn id(&self) -> Option<NonZeroU64> {
        self.source.as_ref().map(|source| source.reservation)
    }
    fn check(&self, ctx: &Context<'_>, id: NonZeroU64) -> Result<(), Error> {
        if self.id() != Some(id)
            || !ctx.execution.retains_snapshot(self.execution)
            || ctx.lanes.id != self.registry
            || ctx.files.owner() != self.registry.files
        {
            return Err(Error::Identity);
        }
        ctx.execution.check_domain(ctx.domain)?;
        Ok(())
    }
    pub(crate) fn resume(
        &mut self,
        ctx: &mut Context<'_>,
        id: NonZeroU64,
    ) -> Result<Option<NonZeroUsize>, Error> {
        self.check(ctx, id)?;
        ctx.execution.check_held_call_live(self.invocation)?;
        let mut writer = ctx.lanes.held_writer(
            ctx.files,
            self.destination.as_ref().expect("pending output"),
        )?;
        let Some(reservation) = writer.reserve_resident_when_room(self.length)? else {
            return Ok(None);
        };
        let source = self.source.take().expect("matching retained cursor");
        let accepted =
            writer
                .queue
                .accept_resident_prefix(writer.files, reservation, source, self.length);
        self.release_destination(ctx);
        accepted.map(Some).map_err(Into::into)
    }
    pub(crate) fn cancel(&mut self, ctx: &mut Context<'_>, id: NonZeroU64) -> Result<(), Error> {
        self.check(ctx, id)?;
        ctx.files
            .abort_read(self.source.take().expect("matching retained cursor"));
        self.release_destination(ctx);
        Ok(())
    }
    fn release_destination(&mut self, ctx: &mut Context<'_>) {
        ctx.files
            .release_output(self.destination.take().expect("pending output"))
            .expect("same output OFD");
        ctx.execution
            .finish_call(self.invocation)
            .expect("same retained call");
    }
}
