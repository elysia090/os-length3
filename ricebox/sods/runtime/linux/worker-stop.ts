/** Private host boundary. A failed request and a confirmed exit are independent facts. */
export class WorkerStop {
  requested = false;
  exitCode: number | undefined;
  failure: {error: unknown} | undefined;
  notificationFailure: {error: unknown} | undefined;
  private readonly terminate: () => Promise<number>;
  readonly stopped: Promise<number>;
  private readonly requestFinished: Promise<void>;
  private finishRequest!: () => void;
  private requestSettled = false;
  private evidenceWait: Promise<unknown> | undefined;
  private resolve!: (code: number) => void;
  constructor(terminate: () => Promise<number>, observe: (exit: (code: number) => void) => void) {
    this.terminate = terminate;
    this.requestFinished = new Promise(resolve => { this.finishRequest = () => { this.requestSettled = true; resolve(); }; });
    this.stopped = new Promise(resolve => { this.resolve = resolve; });
    observe(code => {
      if (this.exitCode !== undefined) return;
      this.exitCode = code;
      this.resolve(code);
    });
  }
  /** The recipient belongs to this request, not a later adopter of the Worker. */
  request(failed: (error: unknown) => void): void {
    if (this.requested || this.exitCode !== undefined) return;
    this.requested = true;
    const record = (error: unknown): void => { this.failure = {error}; try { failed(error); } catch (error) { this.notificationFailure = {error}; } this.finishRequest(); };
    let pending: Promise<number>;
    try { pending = this.terminate(); }
    catch (error) { record(error); throw error; }
    // Consume rejection immediately. Only the observed exit, never fulfillment
    // of an arbitrary adapter promise, authorizes a stopped result.
    void pending.then(() => { this.finishRequest(); }, record);
  }
  /** A request can finish unsuccessfully without an exit. Report that promptly;
   * a later call can still observe a late matching exit, with failure preserved. */
  async evidence(): Promise<{stopped: boolean; exitCode?: number; requestFailure?: unknown; notificationFailure?: unknown}> {
    if (this.exitCode === undefined && this.requested && !this.requestSettled) {
      this.evidenceWait ??= Promise.race([this.stopped, this.requestFinished]);
      await this.evidenceWait;
    }
    return {stopped: this.exitCode !== undefined, ...(this.exitCode !== undefined ? {exitCode: this.exitCode} : {}),
      ...(this.failure ? {requestFailure: this.failure.error} : {}),
      ...(this.notificationFailure ? {notificationFailure: this.notificationFailure.error} : {})};
  }

}
