//! One sequenced continuation owns its captured call. The probe transport no
//! longer stores the call itself; only an exact raw lexical-view fence.
use super::{capture, Continuation, Error, Step, Table};
use capture::{CallId, Context, Finished, Request, WriteCall};

impl Continuation {
    pub(crate) fn admit_capture_write(
        &mut self,
        mut ctx: Context<'_>,
        table: &Table,
        request: Request,
    ) -> Result<Step, Error> {
        let (domain, execution) = ctx.admission_owners();
        self.admit_request(
            domain,
            execution,
            request.invocation,
            Some(request.sequence),
        )?;
        let (at, length) = (request.at, request.length.get() as u64);
        let pending = WriteCall::admit(&mut ctx, table, request).map_err(Error::Capture)?;
        let call = pending.id();
        self.captured_write = Some(pending);
        Ok(Step::CaptureWrite { call, at, length })
    }

    fn capture_call_mut(&mut self, id: CallId) -> Result<&mut WriteCall, Error> {
        self.captured_write
            .as_mut()
            .filter(|p| p.id() == id)
            .ok_or(Error::State)
    }

    #[cfg(test)]
    pub(crate) fn fill_native_capture(
        &mut self,
        ctx: Context<'_>,
        id: CallId,
        input: &[u8],
    ) -> Result<u64, Error> {
        self.capture_call_mut(id)?
            .fill_native(ctx, id, input)
            .map_err(Error::Capture)
    }

    #[cfg(all(target_arch = "wasm32", feature = "queued-worker-probe"))]
    pub(crate) fn start_raw_capture(
        &mut self,
        ctx: Context<'_>,
        id: CallId,
    ) -> Result<(usize, u64, usize), Error> {
        self.capture_call_mut(id)?
            .raw_start(ctx, id)
            .map_err(Error::Capture)
    }

    pub(crate) fn cancel_capture(
        &mut self,
        ctx: &mut Context<'_>,
        id: CallId,
    ) -> Result<bool, Error> {
        let ended = self
            .capture_call_mut(id)?
            .cancel(ctx, id)
            .map_err(Error::Capture)?;
        self.closed = true;
        if ended {
            self.captured_write = None;
        }
        Ok(ended)
    }

    fn observe_capture_finish(
        &mut self,
        result: Result<Finished, capture::Error>,
    ) -> Result<Finished, Error> {
        let finish = result.map_err(Error::Capture)?;
        if finish != Finished::Waiting {
            self.captured_write = None;
        }
        Ok(finish)
    }

    #[cfg(test)]
    pub(crate) fn finish_native_capture(
        &mut self,
        ctx: &mut Context<'_>,
        id: CallId,
        receipt: capture::Receipt,
    ) -> Result<Finished, Error> {
        let result = self.capture_call_mut(id)?.finish(ctx, id, receipt);
        self.observe_capture_finish(result)
    }

    #[cfg(all(target_arch = "wasm32", feature = "queued-worker-probe"))]
    pub(crate) fn finish_raw_capture(
        &mut self,
        ctx: &mut Context<'_>,
        id: CallId,
        proof: crate::wasm::FinishEvidence,
    ) -> Result<Finished, Error> {
        let result = self.capture_call_mut(id)?.raw_finish(ctx, id, proof);
        self.observe_capture_finish(result)
    }
}
