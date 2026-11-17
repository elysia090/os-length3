/** Private host boundary. A failed request and a confirmed exit are independent facts. */
export class WorkerStop {
  requested = false;
  exitCode: number | undefined;
  failure: {error: unknown} | undefined;
  notificationFailure: {error: unknown} | undefined;
  private readonly terminate: () => Promise<number>;
  readonly stopped: Promise<number>;
  private resolve!: (code: number) => void;
  constructor(terminate: () => Promise<number>, observe: (exit: (code: number) => void) => void) {
    this.terminate = terminate;
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
    const record = (error: unknown): void => { this.failure = {error}; try { failed(error); } catch (error) { this.notificationFailure = {error}; } };
    let pending: Promise<number>;
    try { pending = this.terminate(); }
    catch (error) { record(error); throw error; }
    // Consume rejection immediately. Only the observed exit, never fulfillment
    // of an arbitrary adapter promise, authorizes a stopped result.
    void pending.then(undefined, record);
  }
}
