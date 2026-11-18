//! One guest task/mm/thread-group per selected execution, not a PID scheduler.
//!
//! The embedding provides a fresh private Memory, one runner, and no guest
//! clone/fork/mm-sharing route. Physical SharedArrayBuffer users are not extra
//! Linux guest mm users. This scope has guest tid/tgid 1 in its execution-local
//! task context; neither a Node Worker ID nor an execution number is a Linux TID.
//! Registration captures an arbitrary u64 pointer without dereferencing it.
//! There is one guest mm user, so retirement drops this metadata without a
//! clear-tid store or futex wake. Supporting a shared guest mm requires a different
//! task/mm owner and physical completion protocol, not setting a boolean here.
use crate::execution::{self, Execution, Invocation, Snapshot};

pub(crate) struct SingleTask {
    owner: Snapshot,
    clear_child_tid: u64,
}
pub(crate) struct Registration {
    pub(crate) tid: u32,
    pub(crate) clear_child_tid: u64,
}
impl SingleTask {
    pub(crate) fn new(execution: &Execution) -> Result<Self, execution::Error> {
        Ok(Self {
            owner: execution.stamp()?,
            clear_child_tid: 0,
        })
    }
    fn check(&self, execution: &Execution, invocation: Invocation) -> Result<(), execution::Error> {
        // Continuation's general domain/execution check alone would accept a
        // raw diagnostic reimage. Task state must not leak into a new image.
        execution.check(self.owner)?;
        execution.syscall_allowed(invocation)
    }
    /// Private metadata observation, not permission to access the pointer. The
    /// record survives unwind/final-reply loss until its resource owner retires.
    pub(crate) fn registration(
        &self,
        execution: &Execution,
    ) -> Result<Registration, execution::Error> {
        if !execution.retains_snapshot(self.owner) {
            return Err(execution::Error::Identity);
        }
        Ok(Registration {
            tid: 1,
            clear_child_tid: self.clear_child_tid,
        })
    }
    pub(crate) fn register(
        &mut self,
        execution: &Execution,
        invocation: Invocation,
        pointer: u64,
    ) -> Result<u32, execution::Error> {
        self.check(execution, invocation)?;
        self.clear_child_tid = pointer;
        Ok(1)
    }
    pub(crate) fn exit_group(
        &self,
        execution: &mut Execution,
        invocation: Invocation,
        status: u64,
    ) -> Result<(), execution::Error> {
        self.check(execution, invocation)?;
        execution.request_exit(invocation, (status & 255) as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution::{ImageResult, Unwind};
    use crate::lease::Domain;
    fn live(id: u64) -> (Domain, Execution, Invocation, SingleTask) {
        live_with_ids(id, id)
    }
    fn live_with_ids(
        domain_id: u64,
        execution_id: u64,
    ) -> (Domain, Execution, Invocation, SingleTask) {
        let mut domain = Domain::new(domain_id, 1, 2).unwrap();
        let binding = domain.bind(16).unwrap();
        let mut execution = Execution::new(execution_id, binding);
        execution.image_begin(&mut domain, 16).unwrap();
        execution
            .image_finish(&mut domain, ImageResult::Installed)
            .unwrap();
        let task = SingleTask::new(&execution).unwrap();
        let invocation = execution.start(&mut domain).unwrap();
        (domain, execution, invocation, task)
    }
    fn observed(task: &SingleTask, execution: &Execution) -> (u32, u64) {
        let record = task.registration(execution).unwrap();
        (record.tid, record.clear_child_tid)
    }
    #[test]
    fn registration_is_an_exact_pointer_value_not_memory_access_or_host_id() {
        let (mut domain, mut execution, invocation, mut task) = live(419);
        assert_eq!(task.clear_child_tid, 0);
        for pointer in [0, 1, 15, 16, u32::MAX as u64, u64::MAX] {
            assert_eq!(task.register(&execution, invocation, pointer), Ok(1));
            assert_eq!(task.clear_child_tid, pointer);
        }
        // It creates no byte span or host effect slot. The running guest is
        // still owned independently and an exit request is not unwind evidence.
        let a = domain.effect(execution.binding(), 1).unwrap();
        let b = domain.effect(execution.binding(), 1).unwrap();
        domain.cancel(a).unwrap();
        domain.retire(a).unwrap();
        domain.cancel(b).unwrap();
        domain.retire(b).unwrap();
        task.exit_group(&mut execution, invocation, 279).unwrap();
        assert!(!execution.stopped());
        assert_eq!(task.clear_child_tid, u64::MAX);
        execution
            .receipt(&mut domain, invocation, Unwind::Exit)
            .unwrap();
        assert_eq!(execution.status(), Some(23));
        assert_eq!(
            task.clear_child_tid,
            u64::MAX,
            "unwind does not drop task metadata"
        );
        assert!(task.register(&execution, invocation, 0).is_err());
        // Only the containing execution resource holder's retirement drops task.
    }
    #[test]
    fn foreign_invocation_and_reimage_do_not_retarget_the_task_record() {
        let (mut domain, mut execution, invocation, mut task) = live(420);
        let (_, other, foreign, _) = live(421);
        task.register(&execution, invocation, 77).unwrap();
        assert!(task.register(&other, foreign, 88).is_err());
        assert!(task.register(&execution, foreign, 88).is_err());
        assert!(task.exit_group(&mut execution, foreign, 0).is_err());
        assert_eq!(task.clear_child_tid, 77);
        execution
            .receipt(&mut domain, invocation, Unwind::Fault)
            .unwrap();
        execution.image_begin(&mut domain, 16).unwrap();
        execution
            .image_finish(&mut domain, ImageResult::Installed)
            .unwrap();
        let next = execution.start(&mut domain).unwrap();
        assert!(task.register(&execution, next, 88).is_err());
        assert!(task.exit_group(&mut execution, next, 0).is_err());
        assert_eq!(task.clear_child_tid, 77);
    }

    #[test]
    fn retained_observation_survives_unwind_but_never_authorizes_new_operations() {
        // These are synthetic owner receipts, not native/physical Worker exits.
        for unwind in [
            Unwind::Fault,
            Unwind::Unknown,
            Unwind::Exit,
            Unwind::Yield(17),
        ] {
            let (mut domain, mut execution, invocation, mut task) = live(430);
            task.register(&execution, invocation, u64::MAX).unwrap();
            if unwind == Unwind::Exit {
                task.exit_group(&mut execution, invocation, 0).unwrap();
            }
            execution.receipt(&mut domain, invocation, unwind).unwrap();
            assert_eq!(observed(&task, &execution), (1, u64::MAX));
            assert!(task.register(&execution, invocation, 0).is_err());
            assert!(task.exit_group(&mut execution, invocation, 0).is_err());
            assert_eq!(observed(&task, &execution), (1, u64::MAX));
            if unwind == Unwind::Unknown {
                assert!(!execution.stopped());
                execution
                    .receipt(&mut domain, invocation, Unwind::Fault)
                    .unwrap();
                assert_eq!(observed(&task, &execution), (1, u64::MAX));
            }
        }
    }

    #[test]
    fn untouched_reimage_restores_exact_snapshot_but_installed_reimage_never_inherits_it() {
        let (mut domain, mut execution, invocation, mut task) = live(431);
        task.register(&execution, invocation, 77).unwrap();
        execution
            .receipt(&mut domain, invocation, Unwind::Yield(19))
            .unwrap();
        execution.image_begin(&mut domain, 16).unwrap();
        assert_eq!(
            task.registration(&execution).err(),
            Some(execution::Error::Identity)
        );
        assert!(task.register(&execution, invocation, 88).is_err());
        execution
            .image_finish(&mut domain, ImageResult::Untouched)
            .unwrap();
        assert_eq!(observed(&task, &execution), (1, 77));
        let next = execution.start(&mut domain).unwrap();
        assert_eq!(task.register(&execution, next, 88), Ok(1));
        assert_eq!(observed(&task, &execution), (1, 88));

        execution.receipt(&mut domain, next, Unwind::Fault).unwrap();
        execution.image_begin(&mut domain, 16).unwrap();
        assert_eq!(
            task.registration(&execution).err(),
            Some(execution::Error::Identity)
        );
        execution
            .image_finish(&mut domain, ImageResult::Installed)
            .unwrap();
        assert_eq!(
            task.registration(&execution).err(),
            Some(execution::Error::Identity)
        );
        let installed = execution.start(&mut domain).unwrap();
        assert_eq!(
            task.register(&execution, installed, 99),
            Err(execution::Error::Identity)
        );
        assert_eq!(
            task.exit_group(&mut execution, installed, 0),
            Err(execution::Error::Identity)
        );
        assert_eq!(task.clear_child_tid, 88);
        let mut fresh = SingleTask::new(&execution).unwrap();
        assert_eq!(observed(&fresh, &execution), (1, 0));
        fresh.register(&execution, installed, 99).unwrap();
        assert_eq!(observed(&fresh, &execution), (1, 99));
        assert_eq!(task.clear_child_tid, 88);
    }

    #[test]
    fn unknown_and_poisoned_image_changes_revoke_observation_without_mutating_the_old_record() {
        let (mut domain, mut execution, invocation, mut task) = live(432);
        task.register(&execution, invocation, 0x1_0000_0003)
            .unwrap();
        execution
            .receipt(&mut domain, invocation, Unwind::Fault)
            .unwrap();
        execution.image_begin(&mut domain, 16).unwrap();
        execution
            .image_finish(&mut domain, ImageResult::Unknown)
            .unwrap();
        assert_eq!(
            task.registration(&execution).err(),
            Some(execution::Error::Identity)
        );
        assert!(task.register(&execution, invocation, 0).is_err());
        execution
            .image_finish(&mut domain, ImageResult::PoisonedStopped)
            .unwrap();
        assert_eq!(
            task.registration(&execution).err(),
            Some(execution::Error::Identity)
        );
        assert_eq!(task.clear_child_tid, 0x1_0000_0003);
    }

    #[test]
    fn pending_call_and_foreign_domain_with_equal_execution_number_cannot_change_registration() {
        let (_domain, mut execution, invocation, mut task) = live_with_ids(433, 99);
        let (_, mut other, foreign, _) = live_with_ids(434, 99);
        task.register(&execution, invocation, 41).unwrap();
        assert_eq!(
            task.registration(&other).err(),
            Some(execution::Error::Identity)
        );
        assert!(task.register(&other, foreign, 42).is_err());
        assert!(task.register(&execution, foreign, 42).is_err());
        assert!(task.exit_group(&mut other, foreign, 0).is_err());
        execution.hold_call(invocation).unwrap();
        assert_eq!(observed(&task, &execution), (1, 41));
        assert_eq!(
            task.register(&execution, invocation, u64::MAX),
            Err(execution::Error::State)
        );
        assert_eq!(
            task.exit_group(&mut execution, invocation, 0),
            Err(execution::Error::State)
        );
        assert_eq!(observed(&task, &execution), (1, 41));
        execution.finish_call(invocation).unwrap();
        assert_eq!(task.register(&execution, invocation, 42), Ok(1));
        assert_eq!(observed(&task, &execution), (1, 42));
    }

    #[test]
    fn logical_tid_one_is_execution_local_and_group_exit_cannot_stop_another_context() {
        let mut domain = Domain::new(435, 2, 4).unwrap();
        let a_binding = domain.bind(16).unwrap();
        let b_binding = domain.bind(16).unwrap();
        let mut a_execution = Execution::new(4351, a_binding);
        let mut b_execution = Execution::new(4352, b_binding);
        for execution in [&mut a_execution, &mut b_execution] {
            execution.image_begin(&mut domain, 16).unwrap();
            execution
                .image_finish(&mut domain, ImageResult::Installed)
                .unwrap();
        }
        let mut a = SingleTask::new(&a_execution).unwrap();
        let mut b = SingleTask::new(&b_execution).unwrap();
        let a_invocation = a_execution.start(&mut domain).unwrap();
        let b_invocation = b_execution.start(&mut domain).unwrap();
        assert_eq!(a.register(&a_execution, a_invocation, 11), Ok(1));
        assert_eq!(b.register(&b_execution, b_invocation, 22), Ok(1));
        assert_eq!(
            a.registration(&b_execution).err(),
            Some(execution::Error::Identity)
        );
        assert_eq!(
            b.registration(&a_execution).err(),
            Some(execution::Error::Identity)
        );
        a.exit_group(&mut a_execution, a_invocation, 257).unwrap();
        assert_eq!(a_execution.status(), None);
        assert!(!a_execution.stopped());
        a_execution
            .receipt(&mut domain, a_invocation, Unwind::Exit)
            .unwrap();
        assert_eq!(a_execution.status(), Some(1));
        assert_eq!(observed(&a, &a_execution), (1, 11));
        assert_eq!(b_execution.status(), None);
        assert!(!b_execution.stopped());
        assert_eq!(b.register(&b_execution, b_invocation, 33), Ok(1));
        assert_eq!(observed(&b, &b_execution), (1, 33));
    }

    #[test]
    fn group_exit_masks_status_but_request_is_not_unwind_and_blocks_late_registration() {
        for status in [0, 255, 256, 279, u64::MAX, 0x123456] {
            let (mut domain, mut execution, invocation, mut task) = live(437);
            task.register(&execution, invocation, 3).unwrap();
            assert_eq!(
                execution.receipt(&mut domain, invocation, Unwind::Exit),
                Err(execution::Error::State)
            );
            task.exit_group(&mut execution, invocation, status).unwrap();
            assert!(!execution.stopped());
            assert_eq!(execution.status(), None);
            assert!(task.register(&execution, invocation, 0).is_err());
            assert!(task.exit_group(&mut execution, invocation, 0).is_err());
            assert_eq!(observed(&task, &execution), (1, 3));
            execution
                .receipt(&mut domain, invocation, Unwind::Exit)
                .unwrap();
            assert_eq!(execution.status(), Some((status & 255) as u32));
            assert!(execution.retireable());
            assert_eq!(observed(&task, &execution), (1, 3));
            assert!(task.register(&execution, invocation, 4).is_err());
        }
    }
}
