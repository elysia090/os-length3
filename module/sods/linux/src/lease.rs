//! Bounded host-span and non-byte effect obligations for one execution domain.
//!
//! A binding ID is its incarnation, not an address or a reusable slot number.
//! This controls host admission only: ordinary guest stores may still race.
//! The embedding must register an actual memory only once and route every
//! lifetime mutation through `change`; no actual memory is owned by this module.
use crate::effect::{self, Action, Completion, Issuer, Token};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Error {
    Capacity,
    UnknownMemory,
    UnknownAction,
    Busy,
    Range,
    Exhausted,
    Incomplete,
    Effect(effect::Error),
}

impl From<effect::Error> for Error {
    fn from(value: effect::Error) -> Self {
        Self::Effect(value)
    }
}

struct Binding {
    id: u64,
    extent: u64,
    spans: usize,
    effects: usize,
    running: usize,
    changing: bool,
}

enum Kind {
    Span,
    Effect,
    Change { next_id: u64, extent: u64 },
}

struct Pending {
    action: Action,
    memory: usize,
    kind: Kind,
}

/// Non-copy execution lifetime ticket. Dropping it is not stopping evidence.
/// Only the owning execution may release it after its host invocation unwinds.
#[derive(Debug)]
pub(crate) struct RunHold {
    domain: u64,
    binding: u64,
}

pub(crate) struct Domain {
    id: u64,
    runs: usize,
    issuer: Issuer,
    next_memory: Option<u64>,
    memories: Vec<Binding>,
    memory_limit: usize,
    actions: Vec<Option<Pending>>,
}

impl Domain {
    /// Allocates fixed action slots once. IDs are domain-local; the embedding
    /// must not recreate a domain under an ID still referenced by host actions.
    pub(crate) fn new(id: u64, max_memories: usize, max_actions: usize) -> Result<Self, Error> {
        let mut memories = Vec::new();
        memories
            .try_reserve_exact(max_memories)
            .map_err(|_| Error::Capacity)?;
        let mut actions = Vec::new();
        actions
            .try_reserve_exact(max_actions)
            .map_err(|_| Error::Capacity)?;
        actions.resize_with(max_actions, || None);
        Ok(Self {
            id,
            runs: 0,
            issuer: Issuer::new(id),
            next_memory: Some(1),
            memories,
            memory_limit: max_memories,
            actions,
        })
    }

    pub(crate) fn id(&self) -> u64 {
        self.id
    }

    /// Run capacity uses the configured action count as a separate upper bound.
    /// No action or byte-progress record is created; ordinary guest writes and
    /// host read spans remain permitted. A ticket never crosses the host ABI.
    pub(crate) fn hold_run(&mut self, binding: u64) -> Result<RunHold, Error> {
        let i = self.memory(binding)?;
        if self.memories[i].changing {
            return Err(Error::Busy);
        }
        if self.runs == self.actions.len() {
            return Err(Error::Capacity);
        }
        self.runs += 1;
        self.memories[i].running += 1;
        Ok(RunHold {
            domain: self.id,
            binding,
        })
    }
    pub(crate) fn release_run(&mut self, hold: RunHold) -> Result<(), (Error, RunHold)> {
        if hold.domain != self.id {
            return Err((Error::UnknownMemory, hold));
        }
        let i = match self.memory(hold.binding) {
            Ok(i) => i,
            Err(e) => return Err((e, hold)),
        };
        if self.memories[i].running == 0 {
            return Err((Error::Incomplete, hold));
        }
        self.memories[i].running -= 1;
        self.runs -= 1;
        Ok(())
    }
    fn next_id(&mut self) -> Result<u64, Error> {
        let id = self.next_memory.ok_or(Error::Exhausted)?;
        self.next_memory = id.checked_add(1);
        Ok(id)
    }

    /// Synchronous host preflight before allocating an engine object. The host
    /// must not yield/reenter between this check and bind; bind checks again.
    pub(crate) fn binding_room(&self) -> Result<(), Error> {
        if self.memories.len() == self.memory_limit {
            Err(Error::Capacity)
        } else if self.next_memory.is_none() {
            Err(Error::Exhausted)
        } else {
            Ok(())
        }
    }

    /// Binding admission only; creating or aliasing a physical object is host work.
    pub(crate) fn bind(&mut self, extent: u64) -> Result<u64, Error> {
        if self.memories.len() == self.memory_limit {
            return Err(Error::Capacity);
        }
        if extent > 1u64 << 32 {
            return Err(Error::Range);
        }
        let id = self.next_id()?;
        self.memories.push(Binding {
            id,
            extent,
            spans: 0,
            effects: 0,
            running: 0,
            changing: false,
        });
        Ok(id)
    }

    fn memory(&self, binding: u64) -> Result<usize, Error> {
        self.memories
            .iter()
            .position(|m| m.id == binding)
            .ok_or(Error::UnknownMemory)
    }

    fn vacant(&self) -> Result<usize, Error> {
        self.actions
            .iter()
            .position(Option::is_none)
            .ok_or(Error::Capacity)
    }

    fn pending(&mut self, token: Token) -> Result<&mut Pending, Error> {
        self.actions
            .iter_mut()
            .filter_map(Option::as_mut)
            .find(|p| p.action.token() == token)
            .ok_or(Error::UnknownAction)
    }

    /// Non-retaining extent query; callers must acquire admission before access.
    pub(crate) fn extent(&self, binding: u64) -> Result<u64, Error> {
        Ok(self.memories[self.memory(binding)?].extent)
    }

    /// Non-retaining exact-span preflight. It neither clamps guest syscall
    /// lengths nor protects a later access; span admission must check again.
    pub(crate) fn range(&self, binding: u64, offset: u64, length: u64) -> Result<(), Error> {
        let m = &self.memories[self.memory(binding)?];
        if m.changing {
            return Err(Error::Busy);
        }
        if offset > m.extent || length > m.extent - offset {
            return Err(Error::Range);
        }
        Ok(())
    }

    /// Reserve a span before any host access. Even a zero-length span has an
    /// access lifetime; it blocks reuse until cancelled/completed and retired.
    pub(crate) fn span(&mut self, binding: u64, offset: u64, length: u64) -> Result<Token, Error> {
        let memory = self.memory(binding)?;
        let m = &self.memories[memory];
        if m.changing {
            return Err(Error::Busy);
        }
        if offset > m.extent || length > m.extent - offset {
            return Err(Error::Range);
        }
        let slot = self.vacant()?;
        let action = self.issuer.reserve(length)?;
        let token = action.token();
        self.memories[memory].spans += 1; // bounded by allocated action slots
        self.actions[slot] = Some(Pending {
            action,
            memory,
            kind: Kind::Span,
        });
        Ok(token)
    }

    /// Reserve a non-byte effect on this exact binding incarnation. Units are
    /// operation-defined progress, independent of guest memory extent; no byte
    /// range/access is admitted here. Even zero units retain a real obligation.
    /// The same finite slots and sole issuer as spans/changes prevent token reuse
    /// or a second namespace. Runs and spans may coexist, but a lifetime mutation
    /// cannot start until this action is terminal AND explicitly retired.
    /// Started/Unknown cancellation is not stopped evidence or permission to
    /// replay. This unit has no target-destruction shortcut: retain uncertainty.
    pub(crate) fn effect(&mut self, binding: u64, units: u64) -> Result<Token, Error> {
        let memory = self.memory(binding)?;
        if self.memories[memory].changing {
            return Err(Error::Busy);
        }
        let slot = self.vacant()?;
        let action = self.issuer.reserve(units)?;
        let token = action.token();
        self.memories[memory].effects += 1; // bounded by allocated action slots
        self.actions[slot] = Some(Pending {
            action,
            memory,
            kind: Kind::Effect,
        });
        Ok(token)
    }

    /// Exclusive lifetime mutation reservation. The host must not grow, restore,
    /// rebind or reuse before start succeeds. Success is one unit; no effect is
    /// zero. Partial/uncertain mutation must retain Unknown until settled.
    /// Retire publishes the new incarnation only after confirmed success + stop.
    pub(crate) fn change(&mut self, binding: u64, extent: u64) -> Result<Token, Error> {
        let memory = self.memory(binding)?;
        let m = &self.memories[memory];
        if m.changing || m.spans != 0 || m.effects != 0 || m.running != 0 {
            return Err(Error::Busy);
        }
        if extent > 1u64 << 32 {
            return Err(Error::Range);
        }
        let slot = self.vacant()?;
        let next_id = self.next_id()?;
        let action = self.issuer.reserve(1)?;
        let token = action.token();
        self.memories[memory].changing = true;
        self.actions[slot] = Some(Pending {
            action,
            memory,
            kind: Kind::Change { next_id, extent },
        });
        Ok(token)
    }

    pub(crate) fn start(&mut self, token: Token) -> Result<(), Error> {
        self.pending(token)?.action.start(token).map_err(Into::into)
    }

    pub(crate) fn cancel(&mut self, token: Token) -> Result<(), Error> {
        self.pending(token)?
            .action
            .cancel(token)
            .map_err(Into::into)
    }

    pub(crate) fn receipt(
        &mut self,
        token: Token,
        confirmed: u64,
        completion: Completion,
    ) -> Result<(), Error> {
        self.pending(token)?
            .action
            .receipt(token, confirmed, completion)
            .map_err(Into::into)
    }

    /// Remove only a proven terminal action. Span/effect retirement returns None;
    /// successful lifetime mutation returns its new binding ID. Unknown access
    /// keeps both the slot and obligation, so capacity cannot hide uncertainty.
    pub(crate) fn retire(&mut self, token: Token) -> Result<Option<u64>, Error> {
        let slot = self
            .actions
            .iter()
            .position(|p| p.as_ref().is_some_and(|p| p.action.token() == token))
            .ok_or(Error::UnknownAction)?;
        if !self.actions[slot].as_ref().unwrap().action.reclaimable() {
            return Err(Error::Incomplete);
        }
        let p = self.actions[slot].take().unwrap();
        let m = &mut self.memories[p.memory];
        match p.kind {
            Kind::Span => {
                m.spans -= 1;
                Ok(None)
            }
            Kind::Effect => {
                m.effects -= 1;
                Ok(None)
            }
            Kind::Change { next_id, extent } => {
                m.changing = false;
                if p.action.confirmed() == 1 {
                    m.id = next_id;
                    m.extent = extent;
                    Ok(Some(next_id))
                } else {
                    Ok(None)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn domain() -> Domain {
        Domain::new(3, 2, 2).unwrap()
    }

    #[test]
    fn span_validation_and_capacity_are_failure_atomic() {
        let mut d = domain();
        let m = d.bind(8).unwrap();
        for (at, len) in [(9, 0), (7, 2), (u64::MAX, 2)] {
            assert_eq!(d.span(m, at, len), Err(Error::Range));
        }
        let a = d.span(m, 0, 8).unwrap();
        let b = d.span(m, 8, 0).unwrap();
        assert_eq!(d.span(m, 0, 1), Err(Error::Capacity));
        assert_eq!(d.change(m, 16), Err(Error::Busy));
        d.cancel(a).unwrap();
        d.retire(a).unwrap();
        assert_eq!(d.change(m, 16), Err(Error::Busy));
        d.cancel(b).unwrap();
        d.retire(b).unwrap();
        assert!(d.change(m, 16).is_ok());
    }

    #[test]
    fn unknown_span_retains_backing_and_admission_slot() {
        let mut d = Domain::new(3, 1, 1).unwrap();
        let m = d.bind(8).unwrap();
        let a = d.span(m, 0, 8).unwrap();
        d.start(a).unwrap();
        d.receipt(a, 8, Completion::Unknown).unwrap();
        d.cancel(a).unwrap();
        assert_eq!(d.retire(a), Err(Error::Incomplete));
        assert_eq!(d.change(m, 16), Err(Error::Busy));
        assert_eq!(d.span(m, 0, 1), Err(Error::Capacity));
        d.receipt(a, 8, Completion::Stopped).unwrap();
        assert_eq!(d.retire(a), Ok(None));
        assert_eq!(d.start(a), Err(Error::UnknownAction));
        assert!(d.span(m, 0, 1).is_ok());
    }

    #[test]
    fn exclusive_change_stays_closed_until_successful_retirement() {
        let mut d = domain();
        let m = d.bind(8).unwrap();
        let c = d.change(m, 16).unwrap();
        assert_eq!(d.span(m, 0, 1), Err(Error::Busy));
        d.start(c).unwrap();
        assert_eq!(d.start(c), Err(Error::Effect(effect::Error::NotReady)));
        d.receipt(c, 1, Completion::Unknown).unwrap();
        assert_eq!(d.retire(c), Err(Error::Incomplete));
        d.receipt(c, 1, Completion::Stopped).unwrap();
        assert_eq!(d.span(m, 0, 1), Err(Error::Busy));
        let new = d.retire(c).unwrap().unwrap();
        assert_ne!(new, m);
        assert_eq!(d.span(m, 0, 1), Err(Error::UnknownMemory));
        assert!(d.span(new, 15, 1).is_ok());
    }

    #[test]
    fn cancellation_before_change_and_known_failure_preserve_old_binding() {
        let mut d = domain();
        let m = d.bind(8).unwrap();
        let c = d.change(m, 16).unwrap();
        d.cancel(c).unwrap();
        assert_eq!(d.start(c), Err(Error::Effect(effect::Error::NotReady)));
        assert_eq!(d.retire(c), Ok(None));
        let c = d.change(m, 16).unwrap();
        d.start(c).unwrap();
        d.receipt(c, 0, Completion::Stopped).unwrap();
        assert_eq!(d.retire(c), Ok(None));
        assert_eq!(d.span(m, 8, 1), Err(Error::Range));
        assert!(d.span(m, 0, 8).is_ok());
    }

    #[test]
    fn disjoint_memory_remains_available_during_unknown_mutation() {
        let mut d = domain();
        let a = d.bind(8).unwrap();
        let b = d.bind(8).unwrap();
        let c = d.change(a, 16).unwrap();
        d.start(c).unwrap();
        d.receipt(c, 0, Completion::Unknown).unwrap();
        assert!(d.span(b, 0, 8).is_ok());
        assert_eq!(d.change(a, 16), Err(Error::Busy));
        assert_eq!(d.bind(1), Err(Error::Capacity));
    }

    #[test]
    fn foreign_token_cannot_cancel_or_retire_an_obligation() {
        let mut d = domain();
        let m = d.bind(8).unwrap();
        let a = d.span(m, 0, 8).unwrap();
        let foreign = Token::from_parts(4, a.sequence());
        assert_eq!(d.cancel(foreign), Err(Error::UnknownAction));
        assert_eq!(d.retire(foreign), Err(Error::UnknownAction));
        assert_eq!(d.retire(a), Err(Error::Incomplete));
    }

    #[test]
    fn memory_incarnations_exhaust_without_reuse() {
        let mut d = domain();
        d.next_memory = Some(u64::MAX);
        let m = d.bind(8).unwrap();
        assert_eq!(m, u64::MAX);
        assert_eq!(d.change(m, 9), Err(Error::Exhausted));
        assert!(d.span(m, 0, 8).is_ok());
        assert_eq!(d.bind(1), Err(Error::Exhausted));
    }

    #[test]
    fn effect_span_and_change_share_slots_and_one_token_sequence() {
        let mut d = Domain::new(31, 2, 2).unwrap();
        let m = d.bind(2).unwrap();
        let other = d.bind(0).unwrap();
        let effect = d.effect(m, u64::MAX).unwrap();
        let span = d.span(m, 0, 2).unwrap();
        assert_eq!(span.sequence(), effect.sequence() + 1);
        assert_ne!(span, effect);
        assert_eq!(d.memories[0].effects, 1);
        assert_eq!(d.memories[0].spans, 1);
        assert_eq!(d.effect(other, 0), Err(Error::Capacity));
        assert_eq!(d.span(other, 0, 0), Err(Error::Capacity));
        assert_eq!(d.change(other, 1), Err(Error::Capacity));
        d.cancel(span).unwrap();
        assert_eq!(d.retire(span), Ok(None));
        let change = d.change(other, 1).unwrap();
        assert_eq!(change.sequence(), span.sequence() + 1);
        assert_eq!(d.effect(other, 0), Err(Error::Busy));
        d.cancel(change).unwrap();
        assert_eq!(d.retire(change), Ok(None));
        d.cancel(effect).unwrap();
        assert_eq!(d.retire(effect), Ok(None));
        assert_eq!(d.memories[0].effects, 0);
        assert_eq!(d.memories[0].spans, 0);
        let next = d.effect(other, 0).unwrap();
        assert_eq!(next.sequence(), change.sequence() + 1);
        assert_ne!(next, effect);
        assert_ne!(next, span);
        d.cancel(next).unwrap();
        d.retire(next).unwrap();
    }

    #[test]
    fn effect_unknown_binding_changing_and_capacity_fail_without_holds_or_tokens() {
        let mut d = Domain::new(32, 1, 1).unwrap();
        let m = d.bind(8).unwrap();
        assert_eq!(d.effect(999, 1), Err(Error::UnknownMemory));
        assert_eq!(d.memories[0].effects, 0);
        assert!(d.actions.iter().all(Option::is_none));
        let change = d.change(m, 16).unwrap();
        assert_eq!(change.sequence(), 0);
        assert_eq!(d.effect(m, 1), Err(Error::Busy));
        assert_eq!(d.effect(999, 0), Err(Error::UnknownMemory));
        assert_eq!(d.memories[0].effects, 0);
        d.cancel(change).unwrap();
        d.retire(change).unwrap();
        let effect = d.effect(m, 1).unwrap();
        assert_eq!(effect.sequence(), 1);
        assert_eq!(d.effect(m, 0), Err(Error::Capacity));
        assert_eq!(d.effect(999, 0), Err(Error::UnknownMemory));
        assert_eq!(d.memories[0].effects, 1);
        assert_eq!(d.memories[0].spans, 0);
        assert_eq!(d.range(m, 0, 8), Ok(()));
        d.cancel(effect).unwrap();
        d.retire(effect).unwrap();
        let next = d.effect(m, 0).unwrap();
        assert_eq!(next.sequence(), 2);
        d.cancel(next).unwrap();
        d.retire(next).unwrap();
        assert_eq!(d.memories[0].effects, 0);
    }

    #[test]
    fn unknown_effect_outlives_run_unwind_and_span_until_late_stopped_retirement() {
        let mut d = Domain::new(33, 1, 2).unwrap();
        let m = d.bind(4).unwrap();
        let run = d.hold_run(m).unwrap();
        let span = d.span(m, 0, 4).unwrap();
        let effect = d.effect(m, 3).unwrap();
        d.start(effect).unwrap();
        d.receipt(effect, 1, Completion::Unknown).unwrap();
        d.cancel(effect).unwrap();
        assert_eq!(d.start(effect), Err(Error::Effect(effect::Error::NotReady)));
        assert_eq!(d.retire(effect), Err(Error::Incomplete));
        d.release_run(run).unwrap();
        d.cancel(span).unwrap();
        d.retire(span).unwrap();
        assert_eq!(d.memories[0].running, 0);
        assert_eq!(d.memories[0].spans, 0);
        assert_eq!(d.memories[0].effects, 1);
        assert_eq!(d.range(m, 0, 4), Ok(()));
        assert_eq!(d.change(m, 8), Err(Error::Busy));
        d.receipt(effect, 2, Completion::Unknown).unwrap();
        d.receipt(effect, 3, Completion::Unknown).unwrap();
        assert_eq!(d.retire(effect), Err(Error::Incomplete));
        assert_eq!(d.change(m, 8), Err(Error::Busy));
        d.receipt(effect, 3, Completion::Stopped).unwrap();
        assert_eq!(d.change(m, 8), Err(Error::Busy));
        assert_eq!(d.retire(effect), Ok(None));
        let change = d.change(m, 8).unwrap();
        d.start(change).unwrap();
        d.receipt(change, 1, Completion::Stopped).unwrap();
        let next = d.retire(change).unwrap().unwrap();
        assert_eq!(d.effect(m, 0), Err(Error::UnknownMemory));
        assert_eq!(d.extent(next), Ok(8));
    }

    #[test]
    fn zero_and_extent_independent_effect_units_still_need_actual_stop() {
        for units in [0, u64::MAX] {
            let mut d = Domain::new(34, 1, 1).unwrap();
            let m = d.bind(0).unwrap();
            let effect = d.effect(m, units).unwrap();
            assert_eq!(d.memories[0].effects, 1);
            assert_eq!(d.memories[0].spans, 0);
            assert_eq!(d.range(m, 0, 1), Err(Error::Range));
            assert_eq!(d.span(m, 0, 1), Err(Error::Range));
            assert_eq!(d.span(m, 0, 0), Err(Error::Capacity));
            assert_eq!(d.change(m, 1), Err(Error::Busy));
            d.start(effect).unwrap();
            d.cancel(effect).unwrap();
            assert_eq!(d.retire(effect), Err(Error::Incomplete));
            assert_eq!(d.start(effect), Err(Error::Effect(effect::Error::NotReady)));
            d.receipt(effect, units, Completion::Unknown).unwrap();
            d.cancel(effect).unwrap();
            assert_eq!(d.retire(effect), Err(Error::Incomplete));
            assert_eq!(d.change(m, 1), Err(Error::Busy));
            if units == 0 {
                assert_eq!(
                    d.receipt(effect, 1, Completion::Stopped),
                    Err(Error::Effect(effect::Error::InvalidProgress))
                );
            }
            d.receipt(effect, units, Completion::Stopped).unwrap();
            assert_eq!(
                d.receipt(effect, units, Completion::Stopped),
                Err(Error::Effect(effect::Error::NotExecuting))
            );
            assert_eq!(d.retire(effect), Ok(None));
            assert_eq!(d.retire(effect), Err(Error::UnknownAction));
            assert_eq!(d.extent(m), Ok(0));
            assert_eq!(d.memories[0].effects, 0);
        }
    }

    #[test]
    fn effect_foreign_stale_and_nonmonotone_receipts_preserve_the_exact_owner() {
        let mut d = Domain::new(35, 1, 1).unwrap();
        let mut foreign = Domain::new(36, 1, 1).unwrap();
        let m = d.bind(1).unwrap();
        let other = foreign.bind(1).unwrap();
        let effect = d.effect(m, 3).unwrap();
        let foreign_effect = foreign.effect(other, 3).unwrap();
        assert_eq!(effect.sequence(), foreign_effect.sequence());
        assert_ne!(effect, foreign_effect);
        d.start(effect).unwrap();
        foreign.start(foreign_effect).unwrap();
        d.receipt(effect, 2, Completion::Unknown).unwrap();
        assert_eq!(
            d.receipt(foreign_effect, 3, Completion::Stopped),
            Err(Error::UnknownAction)
        );
        assert_eq!(
            foreign.receipt(effect, 3, Completion::Stopped),
            Err(Error::UnknownAction)
        );
        assert_eq!(d.cancel(foreign_effect), Err(Error::UnknownAction));
        assert_eq!(d.retire(foreign_effect), Err(Error::UnknownAction));
        assert_eq!(
            d.receipt(effect, 1, Completion::Stopped),
            Err(Error::Effect(effect::Error::InvalidProgress))
        );
        assert_eq!(
            d.receipt(effect, 4, Completion::Unknown),
            Err(Error::Effect(effect::Error::InvalidProgress))
        );
        assert_eq!(d.retire(effect), Err(Error::Incomplete));
        assert_eq!(d.change(m, 1), Err(Error::Busy));
        d.cancel(effect).unwrap();
        d.receipt(effect, 3, Completion::Stopped).unwrap();
        d.retire(effect).unwrap();
        let next = d.effect(m, 1).unwrap();
        assert_ne!(next, effect);
        assert_eq!(
            d.receipt(effect, 3, Completion::Stopped),
            Err(Error::UnknownAction)
        );
        assert_eq!(d.start(effect), Err(Error::UnknownAction));
        assert_eq!(d.cancel(effect), Err(Error::UnknownAction));
        assert_eq!(d.retire(effect), Err(Error::UnknownAction));
        assert_eq!(
            d.receipt(next, 0, Completion::Stopped),
            Err(Error::Effect(effect::Error::NotExecuting))
        );
        d.cancel(next).unwrap();
        d.retire(next).unwrap();
        assert_eq!(d.memories[0].effects, 0);
        assert_eq!(foreign.change(other, 1), Err(Error::Busy));
        foreign
            .receipt(foreign_effect, 3, Completion::Stopped)
            .unwrap();
        foreign.retire(foreign_effect).unwrap();
    }

    #[test]
    fn unknown_effect_does_not_block_a_disjoint_binding_or_release_its_hold() {
        let mut d = Domain::new(37, 2, 2).unwrap();
        let a = d.bind(0).unwrap();
        let b = d.bind(0).unwrap();
        let effect = d.effect(a, 1).unwrap();
        d.start(effect).unwrap();
        d.receipt(effect, 0, Completion::Unknown).unwrap();
        let change = d.change(b, 1).unwrap();
        d.start(change).unwrap();
        d.receipt(change, 1, Completion::Stopped).unwrap();
        let next_b = d.retire(change).unwrap().unwrap();
        assert_eq!(d.effect(b, 0), Err(Error::UnknownMemory));
        let other_effect = d.effect(next_b, 0).unwrap();
        d.cancel(other_effect).unwrap();
        d.retire(other_effect).unwrap();
        assert_eq!(d.memories[0].effects, 1);
        assert_eq!(d.memories[1].effects, 0);
        assert_eq!(d.change(a, 1), Err(Error::Busy));
        d.cancel(effect).unwrap();
        assert_eq!(d.retire(effect), Err(Error::Incomplete));
        d.receipt(effect, 0, Completion::Stopped).unwrap();
        d.retire(effect).unwrap();
        let change = d.change(a, 1).unwrap();
        d.cancel(change).unwrap();
        d.retire(change).unwrap();
    }

    #[test]
    fn ready_effect_cancel_releases_only_its_independent_hold_on_retirement() {
        let mut d = Domain::new(38, 1, 2).unwrap();
        let m = d.bind(8).unwrap();
        let span = d.span(m, 0, 8).unwrap();
        let effect = d.effect(m, 5).unwrap();
        d.cancel(effect).unwrap();
        assert_eq!(d.start(effect), Err(Error::Effect(effect::Error::NotReady)));
        assert_eq!(
            d.receipt(effect, 0, Completion::Stopped),
            Err(Error::Effect(effect::Error::NotExecuting))
        );
        assert_eq!(d.memories[0].effects, 1);
        assert_eq!(d.retire(effect), Ok(None));
        assert_eq!(d.memories[0].effects, 0);
        assert_eq!(d.memories[0].spans, 1);
        assert_eq!(d.change(m, 16), Err(Error::Busy));
        d.cancel(span).unwrap();
        d.retire(span).unwrap();
        let change = d.change(m, 16).unwrap();
        d.cancel(change).unwrap();
        d.retire(change).unwrap();
    }
}
