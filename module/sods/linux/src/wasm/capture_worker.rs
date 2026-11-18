//! Rejected-artifact fixture boundary for one captured write. Raw callers are
//! trusted relay code. No view or fixture selection is exposed in memoryHost.
use super::{execution_index, step, token, with_state, with_state_access, Access, State};
use crate::descriptor::{
    capture::{Access as CopyAccess, CallId, Finished, Receipt, Request, WriteCall},
    Target,
};
use crate::effect::Token;
use crate::syscall::Step;
use std::num::NonZeroUsize;

pub(super) struct Active {
    execution: u64,
    call: WriteCall,
    viewing: bool,
}
impl Active {
    pub(super) fn blocks(&self, access: Access) -> bool {
        self.viewing && access != self.finish_access()
    }
    pub(super) fn owns(&self, action: Token) -> bool {
        self.call.id().action == action
    }
    fn finish_access(&self) -> Access {
        Access::CaptureFinish {
            execution: self.execution,
            call: self.call.id(),
        }
    }
}

/// Only this raw fixture adapter can construct the claim after matching the
/// exclusive exact view. This is not a public or hardware-minted receipt.
pub(crate) struct FinishEvidence(Receipt);
impl FinishEvidence {
    pub(crate) fn receipt(self) -> Receipt {
        self.0
    }
}

#[no_mangle]
pub extern "C" fn linux_queued_worker_probe_write(
    execution: u64,
    invocation: u64,
    sequence: u32,
    fd: u64,
    at: u64,
    length: u64,
) -> i32 {
    with_state(false, |s| {
        if s.capture_write.is_some() {
            return Err(-4);
        }
        let index = execution_index(s, execution)?;
        let slot = s.executions[index].live_mut()?;
        let invocation = slot.execution.invocation(invocation).map_err(|_| -11)?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        let table = slot.resources.table()?;
        let fd = fd as u32;
        if r.files.target(table, fd).map_err(|_| -12)? != Target::CapturedOutput {
            return Err(-12);
        }
        let queue = r.queue_probe.as_mut().ok_or(-9)?;
        let length = usize::try_from(length)
            .ok()
            .filter(|n| *n <= 4)
            .and_then(NonZeroUsize::new)
            .ok_or(-5)?;
        // Reuse the existing exact sequence/continuation preflight and the
        // tagged nonphysical branch. A different target never reaches it.
        let admitted = slot
            .continuation
            .as_mut()
            .ok_or(-11)?
            .enter_sequenced(
                &mut r.files,
                table,
                None,
                &mut r.reads,
                &mut s.domain,
                &mut slot.execution,
                invocation,
                sequence,
                1,
                [u64::from(fd), at, length.get() as u64, 0, 0, 0],
                0,
            )
            .map_err(|_| -12)?;
        if admitted != Step::Unsupported(1) {
            return Err(-12);
        }
        let call = WriteCall::admit(
            &mut queue.capture_context(&mut r.files, &mut s.domain, &mut slot.execution),
            table,
            Request {
                invocation,
                sequence,
                fd,
                at,
                length,
            },
        )
        .map_err(|_| -12)?;
        let action = call.id().action;
        s.capture_write = Some(Active {
            execution,
            call,
            viewing: false,
        });
        s.state = 13;
        s.auxiliary = at;
        s.length = length.get() as u64;
        Ok(action.sequence())
    })
}

#[no_mangle]
pub extern "C" fn linux_queued_worker_probe_start(
    execution: u64,
    sequence: u32,
    action: u64,
) -> i32 {
    with_state(false, |s| {
        let index = execution_index(s, execution)?;
        let slot = s.executions[index].live_mut()?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        let id = CallId {
            sequence,
            action: token(action),
        };
        let p = s
            .capture_write
            .as_mut()
            .filter(|p| p.execution == execution)
            .ok_or(-4)?;
        let q = r.queue_probe.as_mut().ok_or(-9)?;
        let (pointer, at, length) = p
            .call
            .raw_start(
                q.capture_context(&mut r.files, &mut s.domain, &mut slot.execution),
                id,
            )
            .map_err(|_| -12)?;
        // One scalar checks this exact view before other execution scans. No
        // pointer escapes until the guard is installed; the guard is not stop.
        p.viewing = true;
        s.auxiliary = at;
        s.length = length as u64;
        Ok(pointer as u64)
    })
}

#[no_mangle]
pub extern "C" fn linux_queued_worker_probe_finish(
    execution: u64,
    sequence: u32,
    action: u64,
    evidence: u32,
    count: u32,
) -> i32 {
    let id = CallId {
        sequence,
        action: token(action),
    };
    let access = Access::CaptureFinish {
        execution,
        call: id,
    };
    with_state_access(access, |s| {
        let index = execution_index(s, execution)?;
        let slot = s.executions[index].live_mut()?;
        let r = s.sealed.as_mut().ok_or(-9)?;
        let p = s
            .capture_write
            .as_mut()
            .filter(|p| p.viewing && p.finish_access() == access)
            .ok_or(-4)?;
        let (complete, access) = match evidence {
            0 => (Some(count as usize), CopyAccess::BothEnded),
            1 if count == 0 => (None, CopyAccess::BothEnded),
            2 => ((count != 0).then_some(count as usize), CopyAccess::Unknown),
            3 => (
                (count != 0).then_some(count as usize),
                CopyAccess::SourceEnded,
            ),
            4 => (
                (count != 0).then_some(count as usize),
                CopyAccess::StageEnded,
            ),
            _ => return Err(-5),
        };
        let receipt = FinishEvidence(Receipt { complete, access });
        let q = r.queue_probe.as_mut().ok_or(-9)?;
        let finish = p
            .call
            .raw_finish(
                &mut q.capture_context(&mut r.files, &mut s.domain, &mut slot.execution),
                id,
                receipt,
            )
            .map_err(|_| -12)?;
        let command = match finish {
            Finished::Waiting => return Ok(step(s, Step::Waiting)),
            Finished::Accepted(length) => Step::Return(length.get() as i64),
            Finished::Discarded | Finished::Rejected(_) => Step::Waiting,
        };
        s.capture_write = None;
        Ok(step(s, command))
    })
}

pub(super) fn abandon(s: &mut State, execution: u64) -> Result<bool, i32> {
    let Some(p) = s
        .capture_write
        .as_ref()
        .filter(|p| p.execution == execution)
    else {
        return Ok(true);
    };
    let id = p.call.id();
    let index = execution_index(s, execution)?;
    let slot = s.executions[index].live_mut()?;
    let r = s.sealed.as_mut().ok_or(-9)?;
    let q = r.queue_probe.as_mut().ok_or(-9)?;
    let ended = s
        .capture_write
        .as_mut()
        .expect("same exact active capture")
        .call
        .cancel(
            &mut q.capture_context(&mut r.files, &mut s.domain, &mut slot.execution),
            id,
        )
        .map_err(|_| -12)?;
    if ended {
        s.capture_write = None;
    }
    Ok(ended)
}
