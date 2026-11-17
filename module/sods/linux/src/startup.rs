//! Initial launch ownership only. No ELF/module validator, guest stack installer,
//! scheduler, FD/Fs bootstrap or exec/fork replacement is provided here. The outer
//! bounded owner supplies a non-reused id. Files and physical binding storage are
//! never cloned/reclaimed by this coordinator.
use crate::{
    credentials::Decision,
    descriptor::{self, Executable, Files, LoadRequest, Program, ReadyProgram},
    execution::{self, Execution, ImageResult},
    lease::Domain,
    stack,
};

#[derive(Debug)]
pub(crate) enum Error {
    Identity,
    State,
    Facts,
    Arguments(stack::Error),
    Source(descriptor::Error),
    Execution(execution::Error),
}
impl From<descriptor::Error> for Error {
    fn from(e: descriptor::Error) -> Self {
        Self::Source(e)
    }
}
impl From<execution::Error> for Error {
    fn from(e: execution::Error) -> Self {
        Self::Execution(e)
    }
}
/// Trusted translator facts, not proof of Module imports/operators/segments.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Facts {
    pub entry: u64,
    pub phdr: u64,
    pub phent: u64,
    pub phnum: u64,
    pub extent: u64,
}
impl Facts {
    fn validate(self) -> Result<(), Error> {
        if self.extent == 0
            || self.extent > (1u64 << 32)
            || self.extent % 65536 != 0
            || self.entry >= self.extent
            || self
                .phdr
                .checked_add(self.phent.checked_mul(self.phnum).ok_or(Error::Facts)?)
                .ok_or(Error::Facts)?
                > self.extent
        {
            return Err(Error::Facts);
        }
        Ok(())
    }
}
struct Arguments {
    bytes: Vec<u8>,
    ranges: Vec<std::ops::Range<usize>>,
    argc: usize,
    limits: stack::Limits,
}
impl Arguments {
    fn capture(
        execfn: &[u8],
        argv: &[&[u8]],
        env: &[&[u8]],
        limits: stack::Limits,
    ) -> Result<Self, stack::Error> {
        stack::validate_arguments(execfn, argv, env, limits)?;
        let count = argv
            .len()
            .checked_add(env.len())
            .ok_or(stack::Error::Overflow)?;
        let bytes_len = argv.iter().chain(env).try_fold(0usize, |n, s| {
            n.checked_add(s.len()).ok_or(stack::Error::Overflow)
        })?;
        let mut bytes = Vec::new();
        let mut ranges = Vec::new();
        bytes
            .try_reserve_exact(bytes_len)
            .map_err(|_| stack::Error::Capacity)?;
        ranges
            .try_reserve_exact(count)
            .map_err(|_| stack::Error::Capacity)?;
        for s in argv.iter().chain(env) {
            let at = bytes.len();
            bytes.extend_from_slice(s);
            ranges.push(at..bytes.len());
        }
        Ok(Self {
            bytes,
            ranges,
            argc: argv.len(),
            limits,
        })
    }
    fn build(
        &self,
        p: &ReadyProgram,
        f: Facts,
        low: u64,
        top: u64,
        random: &[u8],
    ) -> Result<stack::Stack, stack::Error> {
        let mut refs = Vec::new();
        refs.try_reserve_exact(self.ranges.len())
            .map_err(|_| stack::Error::Capacity)?;
        for r in &self.ranges {
            refs.push(&self.bytes[r.clone()]);
        }
        stack::build(stack::Input {
            execfn: p.execfn(),
            argv: &refs[..self.argc],
            env: &refs[self.argc..],
            facts: stack::Facts {
                entry: f.entry,
                phdr: f.phdr,
                phent: f.phent,
                phnum: f.phnum,
            },
            credentials: p.stack_credentials(),
            random,
            region: stack::Region {
                low,
                top,
                extent: f.extent,
            },
            limits: self.limits,
        })
    }
}
pub(crate) struct Live {
    pub execution: Execution,
    pub executable: Executable,
    pub decision: Decision,
    pub facts: Facts,
}
enum State {
    Source(Program),
    Loading(Program),
    Ready(ReadyProgram),
    Translating(ReadyProgram),
    Translated(ReadyProgram, Facts),
    Image(ReadyProgram, Facts, Execution, bool, stack::Stack),
    FailedProgram(Program),
    FailedReady(ReadyProgram),
    FailedImage(ReadyProgram, Execution),
    Live(Live),
    Done,
}
/// Cancellation does not establish completion. Loading, translation and physical
/// initialization keep their owned resources until a matching stopped receipt.
pub(crate) struct Startup {
    id: u64,
    owner: u64,
    cancelled: bool,
    arguments: Arguments,
    state: State,
}
impl Startup {
    pub(crate) fn new(
        id: u64,
        files: &Files,
        program: Program,
        argv: &[&[u8]],
        env: &[&[u8]],
        limits: stack::Limits,
    ) -> Result<Self, (Error, Program)> {
        if id == 0 {
            return Err((Error::Identity, program));
        }
        if let Err(e) = files.check_unstarted_program(&program) {
            return Err((e.into(), program));
        }
        let arguments = match Arguments::capture(program.execfn(), argv, env, limits) {
            Ok(a) => a,
            Err(e) => return Err((Error::Arguments(e), program)),
        };
        Ok(Self {
            arguments,
            id,
            owner: files.owner(),
            cancelled: false,
            state: State::Source(program),
        })
    }
    pub(crate) fn binding(&self) -> Option<u64> {
        match &self.state {
            State::Image(_, _, e, _, _) | State::FailedImage(_, e) => Some(e.binding()),
            State::Live(live) => Some(live.execution.binding()),
            _ => None,
        }
    }
    pub(crate) fn owns(&self, token: crate::effect::Token) -> bool {
        match &self.state {
            State::Image(_, _, e, _, _) => e.owns(token),
            _ => false,
        }
    }
    /// Admission query only: not evidence that a source/translator has stopped.
    pub(crate) fn continuable(&self) -> bool {
        !self.cancelled
            && matches!(
                self.state,
                State::Source(_)
                    | State::Loading(_)
                    | State::Ready(_)
                    | State::Translating(_)
                    | State::Translated(_, _)
                    | State::Image(_, _, _, false, _)
            )
    }
    fn check(&self, files: &Files, id: u64) -> Result<(), Error> {
        if self.id != id || self.owner != files.owner() {
            Err(Error::Identity)
        } else {
            Ok(())
        }
    }
    pub(crate) fn source_start(&mut self, files: &mut Files) -> Result<Option<LoadRequest>, Error> {
        self.check(files, self.id)?;
        if self.cancelled || !matches!(self.state, State::Source(_)) {
            return Err(Error::State);
        }
        let State::Source(mut p) = std::mem::replace(&mut self.state, State::Done) else {
            unreachable!()
        };
        match files.prepare_program_source(&mut p) {
            Ok(Some(request)) => {
                self.state = State::Loading(p);
                Ok(Some(request))
            }
            Ok(None) => match files.ready_program(p) {
                Ok(p) => {
                    self.state = State::Ready(p);
                    Ok(None)
                }
                Err((e, p)) => {
                    self.state = State::FailedProgram(p);
                    Err(e.into())
                }
            },
            Err(e) => {
                self.state = State::FailedProgram(p);
                Err(e.into())
            }
        }
    }
    pub(crate) fn source_finish(
        &mut self,
        files: &mut Files,
        id: u64,
        attempt: u32,
        success: bool,
        bytes: &mut Vec<u8>,
    ) -> Result<(), Error> {
        self.check(files, id)?;
        let State::Loading(p) = &mut self.state else {
            return Err(Error::State);
        };
        // Files leaves stale completion untouched. Matching failure is not a
        // license to retry delivery; cleanup retains the Program on any error.
        let result = files.finish_program_source(p, attempt, success && !self.cancelled, bytes);
        if let Err(e) = result {
            // Preserve the original completion error. Only a validated,
            // positively stopped Program may leave Loading on an error path.
            if matches!(files.program_source_pending(p), Ok(false)) {
                let State::Loading(p) = std::mem::replace(&mut self.state, State::Done) else {
                    unreachable!()
                };
                self.state = State::FailedProgram(p);
            }
            return Err(e.into());
        }
        let State::Loading(p) = std::mem::replace(&mut self.state, State::Done) else {
            unreachable!()
        };
        if self.cancelled || !success {
            self.state = State::FailedProgram(p);
            return Ok(());
        }
        match files.ready_program(p) {
            Ok(p) => {
                self.state = State::Ready(p);
                Ok(())
            }
            Err((e, p)) => {
                self.state = State::FailedProgram(p);
                Err(e.into())
            }
        }
    }
    /// The caller must synchronously copy these bytes into translator-owned
    /// storage before returning to callbacks/await. This is not an async borrow.
    pub(crate) fn translation_start<'a>(
        &mut self,
        files: &'a mut Files,
    ) -> Result<&'a [u8], Error> {
        self.check(files, self.id)?;
        if self.cancelled || !matches!(self.state, State::Ready(_)) {
            return Err(Error::State);
        }
        let State::Ready(p) = &self.state else {
            unreachable!()
        };
        // Validate once before publishing the host-work obligation.
        let bytes = files.ready_program_bytes(p)?;
        let State::Ready(p) = std::mem::replace(&mut self.state, State::Done) else {
            unreachable!()
        };
        self.state = State::Translating(p);
        Ok(bytes)
    }
    /// None is a stopped translation failure, not an unknown/cancellation receipt.
    pub(crate) fn translation_finish(
        &mut self,
        id: u64,
        facts: Option<Facts>,
    ) -> Result<(), Error> {
        if id != self.id {
            return Err(Error::Identity);
        }
        if !matches!(self.state, State::Translating(_)) {
            return Err(Error::State);
        }
        let valid = match facts {
            Some(f) => f.validate().map(|_| Some(f)),
            None => Ok(None),
        };
        let State::Translating(p) = std::mem::replace(&mut self.state, State::Done) else {
            unreachable!()
        };
        match valid {
            Ok(Some(f)) if !self.cancelled => {
                self.state = State::Translated(p, f);
                Ok(())
            }
            Ok(_) => {
                self.state = State::FailedReady(p);
                Ok(())
            }
            Err(e) => {
                self.state = State::FailedReady(p);
                Err(e)
            }
        }
    }
    pub(crate) fn image_begin(
        &mut self,
        domain: &mut Domain,
        binding: u64,
        low: u64,
        top: u64,
        random: &[u8],
    ) -> Result<(), Error> {
        if self.cancelled {
            return Err(Error::State);
        }
        let State::Translated(program, facts) = &self.state else {
            return Err(Error::State);
        };
        let stack = self
            .arguments
            .build(program, *facts, low, top, random)
            .map_err(Error::Arguments)?;
        let mut execution = Execution::new(self.id, binding);
        execution.image_begin(domain, facts.extent)?;
        // The complete owned stack now replaces the input snapshot. Keep no
        // duplicate argv/env payload across physical initialization or host await.
        self.arguments.bytes = Vec::new();
        self.arguments.ranges = Vec::new();
        self.arguments.argc = 0;
        let State::Translated(p, f) = std::mem::replace(&mut self.state, State::Done) else {
            unreachable!()
        };
        self.state = State::Image(p, f, execution, false, stack);
        Ok(())
    }
    /// Short immutable borrow for physical initialization only. No reuse after
    /// cancellation/Unknown; never exposed while a guest can run.
    pub(crate) fn stack(&self) -> Result<&stack::Stack, Error> {
        match &self.state {
            State::Image(_, _, _, false, stack) if !self.cancelled => Ok(stack),
            _ => Err(Error::State),
        }
    }
    pub(crate) fn image_finish(
        &mut self,
        domain: &mut Domain,
        outcome: ImageResult,
    ) -> Result<(), Error> {
        let State::Image(_, _, execution, uncertain, _) = &mut self.state else {
            return Err(Error::State);
        };
        // Installed only attests initialization, not actual Worker shutdown.
        // After cancellation only an explicit stopped-poison receipt can retire.
        if (self.cancelled || *uncertain)
            && !matches!(outcome, ImageResult::Unknown | ImageResult::PoisonedStopped)
        {
            return Err(Error::State);
        }
        execution.image_finish(domain, outcome)?;
        if outcome == ImageResult::Unknown {
            *uncertain = true;
            return Ok(());
        }
        let State::Image(p, facts, execution, _, _) =
            std::mem::replace(&mut self.state, State::Done)
        else {
            unreachable!()
        };
        if outcome == ImageResult::Installed {
            let (executable, decision) = p.publish();
            self.state = State::Live(Live {
                execution,
                executable,
                decision,
                facts,
            });
        } else {
            self.state = State::FailedImage(p, execution);
        }
        Ok(())
    }
    /// Move stopped physical-binding evidence to the outer owner. This does not
    /// reclaim Domain binding capacity or physical memory. Failed release retains both.
    /// This transition itself attests a stopped initialization. Untouched returns
    /// an Empty Execution (stopped() is false because no run/image was installed);
    /// the outer owner must not confuse execution phase with this receipt evidence.
    pub(crate) fn take_failed_image(
        &mut self,
        files: &mut Files,
    ) -> Result<Option<Execution>, Error> {
        self.check(files, self.id)?;
        if !matches!(self.state, State::FailedImage(_, _)) {
            return Ok(None);
        }
        let State::FailedImage(p, execution) = std::mem::replace(&mut self.state, State::Done)
        else {
            unreachable!()
        };
        match files.release_ready(p) {
            Ok(()) => Ok(Some(execution)),
            Err((e, p)) => {
                self.state = State::FailedImage(p, execution);
                Err(e.into())
            }
        }
    }
    pub(crate) fn take_live(&mut self) -> Option<Live> {
        if !matches!(self.state, State::Live(_)) {
            return None;
        }
        let State::Live(live) = std::mem::replace(&mut self.state, State::Done) else {
            unreachable!()
        };
        Some(live)
    }
    pub(crate) fn cancel(&mut self, files: &mut Files) -> Result<bool, Error> {
        self.check(files, self.id)?;
        if matches!(self.state, State::Live(_)) {
            return Err(Error::State);
        }
        self.cancelled = true;
        // No further stack may be built after cancellation. Source/translation
        // obligations own executable bytes, not this argument snapshot.
        self.arguments.bytes = Vec::new();
        self.arguments.ranges = Vec::new();
        self.arguments.argc = 0;
        let old = std::mem::replace(&mut self.state, State::Done);
        match old {
            State::Loading(p) => match files.release_program(p) {
                Ok(()) => Ok(true),
                Err((e, p)) => {
                    self.state = State::Loading(p);
                    if matches!(e, descriptor::Error::Busy) {
                        Ok(false)
                    } else {
                        Err(e.into())
                    }
                }
            },
            State::Source(p) | State::FailedProgram(p) => match files.release_program(p) {
                Ok(()) => Ok(true),
                Err((e, p)) => {
                    self.state = State::FailedProgram(p);
                    Err(e.into())
                }
            },
            State::Ready(p) | State::Translated(p, _) | State::FailedReady(p) => {
                match files.release_ready(p) {
                    Ok(()) => Ok(true),
                    Err((e, p)) => {
                        self.state = State::FailedReady(p);
                        Err(e.into())
                    }
                }
            }
            State::Translating(p) => {
                self.state = State::Translating(p);
                Ok(false)
            }
            State::Image(p, f, e, uncertain, stack) => {
                self.state = State::Image(p, f, e, uncertain, stack);
                Ok(false)
            }
            State::FailedImage(p, e) => {
                self.state = State::FailedImage(p, e);
                Ok(false)
            }
            State::Done => Ok(true),
            State::Live(_) => unreachable!(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        credentials::Credentials,
        fs_context,
        inode::{Creation, Tree},
        mount,
    };
    fn limits() -> stack::Limits {
        stack::Limits {
            max_string_bytes: 1024,
            max_input_bytes: 4096,
            max_pointers: 64,
        }
    }
    fn setup(owner: u64, lazy: bool) -> (Files, fs_context::Ticket, Startup) {
        let mut tree = Tree::new(
            owner,
            4,
            4,
            64,
            Creation {
                mode: 0o755,
                uid: 0,
                gid: 0,
            },
        )
        .unwrap();
        let root = tree.root();
        let meta = Creation {
            mode: 0o4755,
            uid: 1000,
            gid: 0,
        };
        if lazy {
            tree.lazy_file(root, b"p", meta, 7, 2).unwrap();
        } else {
            tree.file_take(root, b"p", meta, &mut b"elf".to_vec())
                .unwrap();
        }
        let mut files = Files::new(
            owner + 1,
            tree,
            descriptor::Limits {
                contexts: 1,
                tables: 0,
                descriptions: 0,
                slots: 0,
            },
        );
        let view = files
            .bootstrap_mount(
                root,
                mount::Limits { views: 1, holds: 4 },
                mount::ViewPolicy {
                    no_exec: false,
                    no_suid: false,
                    no_symfollow: false,
                },
            )
            .unwrap();
        let place = files.view_root(&view).unwrap();
        let fs = files.create_fs(&place, &place, 0o022).unwrap();
        assert!(files.release_view(view).is_ok());
        let program = files
            .prepare_program(&fs, &Credentials::initial_root(), b"/p")
            .unwrap();
        let startup =
            Startup::new(1, &files, program, &[], &[], limits()).unwrap_or_else(|_| panic!("new"));
        (files, fs, startup)
    }
    fn facts() -> Facts {
        Facts {
            entry: 64,
            phdr: 0,
            phent: 56,
            phnum: 1,
            extent: 65536,
        }
    }
    fn translate(files: &mut Files, s: &mut Startup) {
        assert!(s.source_start(files).unwrap().is_none());
        assert_eq!(s.translation_start(files).unwrap(), b"elf");
        s.translation_finish(1, Some(facts())).unwrap();
    }
    #[test]
    fn successful_admission_moves_credentials_and_hold_only_after_installed() {
        let (mut f, fs, mut s) = setup(300, false);
        f.release_fs(fs).unwrap(); // Program is now the only retained view.
        assert!(s.continuable());
        assert_eq!(s.binding(), None);
        translate(&mut f, &mut s);
        let mut d = Domain::new(400, 1, 4).unwrap();
        let b = d.bind(65536).unwrap();
        assert!(s.take_live().is_none());
        s.image_begin(&mut d, b, 4096, 65536, &[7; 16]).unwrap();
        assert!(s.take_live().is_none());
        s.image_finish(&mut d, ImageResult::Installed).unwrap();
        assert!(!s.continuable());
        let installed_binding = s.binding().unwrap();
        let live = s.take_live().unwrap();
        assert_eq!(installed_binding, live.execution.binding());
        assert_eq!(s.binding(), None);
        assert_eq!(live.decision.credentials.user().effective, 1000);
        assert!(live.decision.secure);
        assert_eq!(live.execution.phase(), execution::Phase::Ready);
        assert_eq!(live.facts.extent, 65536);
        f.release_executable(live.executable).unwrap();
        assert!(s.take_live().is_none());
    }
    #[test]
    fn cancelled_source_needs_matching_receipt_and_does_not_adopt_success() {
        let (mut f, fs, mut s) = setup(310, true);
        let req = s.source_start(&mut f).unwrap().unwrap();
        assert!(!s.cancel(&mut f).unwrap());
        let mut bytes = b"late".to_vec();
        assert!(s
            .source_finish(&mut f, 2, req.attempt, true, &mut bytes)
            .is_err());
        assert!(s
            .source_finish(&mut f, 1, req.attempt + 1, true, &mut bytes)
            .is_err());
        assert!(!s.cancel(&mut f).unwrap());
        s.source_finish(&mut f, 1, req.attempt, true, &mut bytes)
            .unwrap();
        assert_eq!(bytes, b"late");
        assert!(s.cancel(&mut f).unwrap());
        f.release_fs(fs).unwrap();
    }
    #[test]
    fn cancel_translation_and_invalid_facts_cannot_admit_image() {
        let (mut f, fs, mut s) = setup(320, false);
        s.source_start(&mut f).unwrap();
        s.translation_start(&mut f).unwrap();
        assert!(!s.cancel(&mut f).unwrap());
        assert!(s.translation_finish(2, Some(facts())).is_err());
        s.translation_finish(1, Some(facts())).unwrap();
        let mut d = Domain::new(420, 1, 4).unwrap();
        let b = d.bind(65536).unwrap();
        assert!(s.image_begin(&mut d, b, 4096, 65536, &[7; 16]).is_err());
        assert!(s.cancel(&mut f).unwrap());
        f.release_fs(fs).unwrap();
        let (mut f, fs, mut s) = setup(330, false);
        s.source_start(&mut f).unwrap();
        s.translation_start(&mut f).unwrap();
        let mut invalid = facts();
        invalid.phnum = u64::MAX;
        assert!(s.translation_finish(1, Some(invalid)).is_err());
        assert!(s.cancel(&mut f).unwrap());
        f.release_fs(fs).unwrap();
    }
    #[test]
    fn cancelled_image_unknown_requires_explicit_stop_and_foreign_domain_is_inert() {
        let (mut f, fs, mut s) = setup(340, false);
        translate(&mut f, &mut s);
        let mut d = Domain::new(440, 1, 4).unwrap();
        let b = d.bind(65536).unwrap();
        s.image_begin(&mut d, b, 4096, 65536, &[7; 16]).unwrap();
        assert!(!s.cancel(&mut f).unwrap());
        assert!(s.image_finish(&mut d, ImageResult::Installed).is_err());
        s.image_finish(&mut d, ImageResult::Unknown).unwrap();
        let mut foreign = Domain::new(441, 1, 4).unwrap();
        assert!(s
            .image_finish(&mut foreign, ImageResult::PoisonedStopped)
            .is_err());
        assert!(!s.cancel(&mut f).unwrap());
        s.image_finish(&mut d, ImageResult::PoisonedStopped)
            .unwrap();
        assert!(s.take_live().is_none());
        assert!(!s.cancel(&mut f).unwrap());
        let failed = s.take_failed_image(&mut f).unwrap().unwrap();
        assert_ne!(failed.binding(), b);
        assert_eq!(failed.phase(), execution::Phase::Failed);
        assert!(s.cancel(&mut f).unwrap());
        f.release_fs(fs).unwrap();
    }
    #[test]
    fn unknown_without_cancel_cannot_publish_even_on_late_installed() {
        let (mut f, fs, mut s) = setup(370, false);
        translate(&mut f, &mut s);
        let mut d = Domain::new(470, 1, 4).unwrap();
        let b = d.bind(65536).unwrap();
        s.image_begin(&mut d, b, 4096, 65536, &[7; 16]).unwrap();
        s.image_finish(&mut d, ImageResult::Unknown).unwrap();
        assert!(!s.continuable());
        assert!(s.binding().is_some());
        assert!(s.image_finish(&mut d, ImageResult::Installed).is_err());
        assert!(s.image_finish(&mut d, ImageResult::Untouched).is_err());
        assert!(s.take_live().is_none());
        s.image_finish(&mut d, ImageResult::PoisonedStopped)
            .unwrap();
        assert!(!s.cancel(&mut f).unwrap());
        assert!(s.take_failed_image(&mut f).unwrap().is_some());
        assert!(s.cancel(&mut f).unwrap());
        f.release_fs(fs).unwrap();
    }
    #[test]
    fn untouched_image_returns_original_binding_without_claiming_reclamation() {
        let (mut f, fs, mut s) = setup(390, false);
        translate(&mut f, &mut s);
        let mut d = Domain::new(490, 1, 4).unwrap();
        let b = d.bind(65536).unwrap();
        s.image_begin(&mut d, b, 4096, 65536, &[7; 16]).unwrap();
        s.image_finish(&mut d, ImageResult::Untouched).unwrap();
        assert!(!s.cancel(&mut f).unwrap());
        let failed = s.take_failed_image(&mut f).unwrap().unwrap();
        assert_eq!(failed.binding(), b);
        assert_eq!(failed.phase(), execution::Phase::Empty);
        assert!(d.bind(65536).is_err()); // capacity remains owned by Domain
        assert!(s.cancel(&mut f).unwrap());
        f.release_fs(fs).unwrap();
    }
    #[test]
    fn matching_oversize_and_poison_errors_preserve_input_and_allow_cleanup() {
        let (mut f, fs, mut s) = setup(380, true);
        let req = s.source_start(&mut f).unwrap().unwrap();
        let mut bytes = vec![1; 65];
        assert!(s
            .source_finish(&mut f, 1, req.attempt, true, &mut bytes)
            .is_err());
        assert_eq!(bytes.len(), 65);
        assert!(matches!(s.state, State::FailedProgram(_)));
        assert!(s.cancel(&mut f).unwrap());
        let other = f
            .prepare_program(&fs, &Credentials::initial_root(), b"/p")
            .unwrap();
        let mut a =
            Startup::new(2, &f, other, &[], &[], limits()).unwrap_or_else(|_| panic!("new"));
        let req = a.source_start(&mut f).unwrap().unwrap();
        let other = f
            .prepare_program(&fs, &Credentials::initial_root(), b"/p")
            .unwrap();
        let mut b =
            Startup::new(3, &f, other, &[], &[], limits()).unwrap_or_else(|_| panic!("new"));
        assert!(b.source_start(&mut f).is_err());
        assert!(b.cancel(&mut f).unwrap());
        let mut bytes = b"elf".to_vec();
        assert!(a
            .source_finish(&mut f, 2, req.attempt, true, &mut bytes)
            .is_err());
        assert_eq!(bytes, b"elf");
        assert!(matches!(a.state, State::FailedProgram(_)));
        assert!(a.cancel(&mut f).unwrap());
        f.release_fs(fs).unwrap();
    }
    #[test]
    fn admission_rejects_started_ready_failed_programs_losslessly() {
        let (mut f, fs, mut unused) = setup(400, true);
        assert!(unused.cancel(&mut f).unwrap());
        let mut p = f
            .prepare_program(&fs, &Credentials::initial_root(), b"/p")
            .unwrap();
        let req = f.prepare_program_source(&mut p).unwrap().unwrap();
        let (_, mut p) = Startup::new(2, &f, p, &[], &[], limits())
            .err()
            .expect("Loading rejected");
        f.finish_program_source(&mut p, req.attempt, false, &mut Vec::new())
            .unwrap();
        let (_, mut p) = Startup::new(2, &f, p, &[], &[], limits())
            .err()
            .expect("Failed rejected");
        // Failed remains releasable by the original owner, not stranded in Startup.
        f.release_program(p).unwrap();
        p = f
            .prepare_program(&fs, &Credentials::initial_root(), b"/p")
            .unwrap();
        let req = f.prepare_program_source(&mut p).unwrap().unwrap();
        f.finish_program_source(&mut p, req.attempt, true, &mut b"elf".to_vec())
            .unwrap();
        let (_, p) = Startup::new(2, &f, p, &[], &[], limits())
            .err()
            .expect("Ready rejected");
        assert_eq!(f.program_bytes(&p).unwrap(), b"elf");
        f.release_program(p).unwrap();
        f.release_fs(fs).unwrap();
    }
    fn word(stack: &stack::Stack, index: usize) -> u64 {
        u64::from_le_bytes(stack.bytes[index * 8..index * 8 + 8].try_into().unwrap())
    }
    fn text<'a>(stack: &'a stack::Stack, at: u64) -> &'a [u8] {
        let bytes = &stack.bytes[(at - stack.pointer) as usize..];
        &bytes[..bytes.iter().position(|b| *b == 0).unwrap()]
    }
    #[test]
    fn captured_arguments_program_path_credentials_and_unknown_share_one_image() {
        let (mut f, fs, mut unused) = setup(410, false);
        unused.cancel(&mut f).unwrap();
        let p = f
            .prepare_program(&fs, &Credentials::initial_root(), b"/p")
            .unwrap();
        let mut argument = b"alias".to_vec();
        let mut env = b"A=1".to_vec();
        let mut s = Startup::new(2, &f, p, &[&argument], &[&env], limits())
            .unwrap_or_else(|_| panic!("new"));
        argument.fill(b'x');
        env.fill(b'x');
        s.source_start(&mut f).unwrap();
        s.translation_start(&mut f).unwrap();
        s.translation_finish(2, Some(facts())).unwrap();
        let mut d = Domain::new(510, 1, 4).unwrap();
        let b = d.bind(65536).unwrap();
        assert!(s.image_begin(&mut d, b, 65535, 65536, &[7; 16]).is_err());
        assert!(s.stack().is_err());
        s.image_begin(&mut d, b, 4096, 65536, &[7; 16]).unwrap();
        let stack = s.stack().unwrap();
        assert_eq!(text(stack, word(stack, 1)), b"alias");
        assert_eq!(text(stack, word(stack, 3)), b"A=1");
        let aux = 5; // argc/argv/null/env/null
        assert_eq!(word(stack, aux + 5 * 2 + 1), 0); // AT_UID
        assert_eq!(word(stack, aux + 6 * 2 + 1), 1000); // AT_EUID from Program Decision
        assert_eq!(word(stack, aux + 9 * 2 + 1), 1); // AT_SECURE
        assert_eq!(text(stack, word(stack, aux + 11 * 2 + 1)), b"/p"); // not argv[0]
        s.image_finish(&mut d, ImageResult::Unknown).unwrap();
        assert!(s.stack().is_err());
        s.image_finish(&mut d, ImageResult::PoisonedStopped)
            .unwrap();
        s.take_failed_image(&mut f).unwrap();
        f.release_fs(fs).unwrap();
    }
    #[test]
    fn bad_arguments_reject_before_source_and_return_original_program() {
        let (mut f, fs, mut unused) = setup(420, true);
        unused.cancel(&mut f).unwrap();
        let p = f
            .prepare_program(&fs, &Credentials::initial_root(), b"/p")
            .unwrap();
        let (_, p) = Startup::new(2, &f, p, &[b"bad\0arg"], &[], limits())
            .err()
            .expect("NUL rejected");
        assert!(f.check_unstarted_program(&p).is_ok());
        let mut small = limits();
        small.max_pointers = 0;
        let (_, p) = Startup::new(2, &f, p, &[], &[], small)
            .err()
            .expect("normalized empty argv counted");
        let mut small = limits();
        small.max_input_bytes = 1;
        let (_, p) = Startup::new(2, &f, p, &[], &[], small)
            .err()
            .expect("path counts toward budget");
        assert!(f.check_unstarted_program(&p).is_ok());
        f.release_program(p).unwrap();
        f.release_fs(fs).unwrap();
    }
    #[test]
    fn cancellation_before_dispatch_and_failed_source_release() {
        let (mut f, fs, mut s) = setup(350, true);
        assert!(s.cancel(&mut f).unwrap());
        assert!(s.source_start(&mut f).is_err());
        f.release_fs(fs).unwrap();
        let (mut f, fs, mut s) = setup(360, true);
        let req = s.source_start(&mut f).unwrap().unwrap();
        s.source_finish(&mut f, 1, req.attempt, false, &mut Vec::new())
            .unwrap();
        assert!(s.cancel(&mut f).unwrap());
        f.release_fs(fs).unwrap();
    }
}
