//! One host action owned by one pending Linux operation.
//!
//! No queue, host callbacks, memory pointers or Linux scheduling live here. The
//! operation retains its reservations/backing until `reclaimable`. Tokens identify
//! actions; they are not security credentials. A domain must not reuse its ID.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Token {
    domain: u64,
    sequence: u64,
}

impl Token {
    pub(crate) fn from_parts(domain: u64, sequence: u64) -> Self {
        Self { domain, sequence }
    }

    pub(crate) fn sequence(self) -> u64 {
        self.sequence
    }
}

/// A domain-local sequence, exhausted rather than wrapped or reused.
/// The future domain owner must construct exactly one Issuer for its unique ID
/// and retain it until the domain ends; recreating it would reuse action tokens.
pub(crate) struct Issuer {
    domain: u64,
    next: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Error {
    Exhausted,
    WrongAction,
    NotReady,
    NotExecuting,
    InvalidProgress,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Ready,
    Executing,
    Uncertain,
    Finished,
    Cancelled,
}

/// Host evidence, not inferred from the byte count. Stopped certifies BOTH that
/// no further effects occur beyond the confirmed prefix AND that access to this
/// action's backing has ended. Unknown promises neither; it must not be replayed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Completion {
    Stopped,
    Unknown,
}

pub(crate) struct Action {
    token: Token,
    units: u64,
    confirmed: u64,
    phase: Phase,
    cancel_requested: bool,
}

impl Issuer {
    pub(crate) fn new(domain: u64) -> Self {
        Self {
            domain,
            next: Some(0),
        }
    }

    pub(crate) fn reserve(&mut self, units: u64) -> Result<Action, Error> {
        let sequence = self.next.ok_or(Error::Exhausted)?;
        self.next = sequence.checked_add(1);
        Ok(Action {
            token: Token {
                domain: self.domain,
                sequence,
            },
            units,
            confirmed: 0,
            phase: Phase::Ready,
            cancel_requested: false,
        })
    }
}

impl Action {
    pub(crate) fn token(&self) -> Token {
        self.token
    }

    fn check(&self, token: Token) -> Result<(), Error> {
        if token == self.token {
            Ok(())
        } else {
            Err(Error::WrongAction)
        }
    }

    /// Consume permission BEFORE entering host code. A throw must report evidence
    /// through receipt, never restore Ready. Reentrant starts are therefore denied.
    pub(crate) fn start(&mut self, token: Token) -> Result<(), Error> {
        self.check(token)?;
        if self.phase != Phase::Ready {
            return Err(Error::NotReady);
        }
        self.phase = Phase::Executing;
        Ok(())
    }

    /// Cancellation is not completion evidence once an action may have started.
    /// Ready still owns a reservation: the owner must release it after cancellation.
    pub(crate) fn cancel(&mut self, token: Token) -> Result<(), Error> {
        self.check(token)?;
        if matches!(self.phase, Phase::Finished | Phase::Cancelled) {
            return Ok(());
        }
        self.cancel_requested = true;
        if self.phase == Phase::Ready {
            self.phase = Phase::Cancelled;
        }
        Ok(())
    }

    /// Cumulative confirmed units, not an increment. A late receipt can settle
    /// an uncertain remainder without consuming the confirmed prefix twice.
    /// Unknown includes possible ongoing access, even when all units are confirmed.
    pub(crate) fn receipt(
        &mut self,
        token: Token,
        confirmed: u64,
        remainder: Completion,
    ) -> Result<(), Error> {
        self.check(token)?;
        if !matches!(self.phase, Phase::Executing | Phase::Uncertain) {
            return Err(Error::NotExecuting);
        }
        if confirmed < self.confirmed || confirmed > self.units {
            return Err(Error::InvalidProgress);
        }
        self.confirmed = confirmed;
        self.phase = match remainder {
            Completion::Stopped => Phase::Finished,
            Completion::Unknown => Phase::Uncertain,
        };
        Ok(())
    }

    pub(crate) fn confirmed(&self) -> u64 {
        self.confirmed
    }
    pub(crate) fn cancellation_requested(&self) -> bool {
        self.cancel_requested
    }

    /// This action no longer needs backing. Other owners may still need it.
    /// Does not itself free memory, release reservations or claim domain closure.
    pub(crate) fn reclaimable(&self) -> bool {
        matches!(self.phase, Phase::Finished | Phase::Cancelled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_consumes_permission_before_reentry() {
        let mut a = Issuer::new(7).reserve(8).unwrap();
        let t = a.token();
        assert!(!a.reclaimable());
        assert_eq!(a.start(t), Ok(()));
        assert_eq!(a.start(t), Err(Error::NotReady));
        assert!(!a.reclaimable());
    }

    #[test]
    fn cancel_before_start_releases_only_this_reservation() {
        let mut a = Issuer::new(7).reserve(8).unwrap();
        let t = a.token();
        a.cancel(t).unwrap();
        assert!(a.reclaimable());
        assert!(a.cancellation_requested());
        assert_eq!(a.start(t), Err(Error::NotReady));
        assert_eq!(
            a.receipt(t, 8, Completion::Stopped),
            Err(Error::NotExecuting)
        );
    }

    #[test]
    fn cancel_and_throw_do_not_reissue_or_release_unknown_action() {
        let mut a = Issuer::new(7).reserve(8).unwrap();
        let t = a.token();
        a.start(t).unwrap();
        a.cancel(t).unwrap();
        a.receipt(t, 3, Completion::Unknown).unwrap();
        assert!(!a.reclaimable());
        assert_eq!(a.start(t), Err(Error::NotReady));
        a.receipt(t, 5, Completion::Stopped).unwrap();
        assert_eq!(a.confirmed(), 5);
        assert!(a.reclaimable());
        assert_eq!(
            a.receipt(t, 8, Completion::Stopped),
            Err(Error::NotExecuting)
        );
    }

    #[test]
    fn invalid_receipt_does_not_change_evidence() {
        let mut a = Issuer::new(7).reserve(8).unwrap();
        let t = a.token();
        a.start(t).unwrap();
        a.receipt(t, 3, Completion::Unknown).unwrap();
        for count in [2, 9] {
            assert_eq!(
                a.receipt(t, count, Completion::Stopped),
                Err(Error::InvalidProgress)
            );
            assert_eq!(a.confirmed(), 3);
            assert!(!a.reclaimable());
        }
    }

    #[test]
    fn foreign_and_old_tokens_cannot_touch_new_action() {
        let mut issuer = Issuer::new(7);
        let old = issuer.reserve(8).unwrap().token();
        let foreign = Issuer::new(8).reserve(8).unwrap().token();
        let mut a = issuer.reserve(8).unwrap();
        for token in [old, foreign] {
            assert_eq!(a.start(token), Err(Error::WrongAction));
            assert_eq!(a.cancel(token), Err(Error::WrongAction));
            assert_eq!(
                a.receipt(token, 8, Completion::Stopped),
                Err(Error::WrongAction)
            );
        }
        assert_eq!(a.start(a.token()), Ok(()));
    }

    #[test]
    fn all_units_and_zero_units_still_require_access_completion() {
        for units in [0, 8] {
            let mut a = Issuer::new(7).reserve(units).unwrap();
            let t = a.token();
            a.start(t).unwrap();
            a.receipt(t, units, Completion::Unknown).unwrap();
            assert!(!a.reclaimable());
            a.receipt(t, units, Completion::Stopped).unwrap();
            assert!(a.reclaimable());
        }
    }

    #[test]
    fn cancel_after_completion_does_not_claim_prior_cancellation() {
        let mut a = Issuer::new(7).reserve(1).unwrap();
        let t = a.token();
        a.start(t).unwrap();
        a.receipt(t, 1, Completion::Stopped).unwrap();
        a.cancel(t).unwrap();
        assert!(!a.cancellation_requested());
        assert!(a.reclaimable());
    }

    #[test]
    fn sequence_exhaustion_never_wraps() {
        let mut issuer = Issuer {
            domain: 7,
            next: Some(u64::MAX),
        };
        assert_eq!(issuer.reserve(1).unwrap().token().sequence, u64::MAX);
        assert!(matches!(issuer.reserve(1), Err(Error::Exhausted)));
    }
}
