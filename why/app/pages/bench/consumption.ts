import type {WriteReceipt} from './repo-copy.ts';

export interface ConsumptionResult {
  sentBytes: number;
  acceptedBytes: number;
  discardedBytes: number;
  prefixReceived: boolean;
  storeAccepted: boolean;
  excludedPaths: number;
  incompleteBatches: number;
  notificationFailures: number;
  firstFailure?: unknown;
}
type Saved = Pick<ConsumptionResult, 'storeAccepted' | 'excludedPaths' | 'incompleteBatches' | 'notificationFailures' | 'firstFailure'>;
/** One ordered Worker-to-page prefix. Acceptance means handed to the terminal
 * model, not painted. Save completion means store API acceptance, not fsync. */
export class Consumption {
  private accepted = 0;
  private discarded = 0;
  private saved: Saved = {storeAccepted: true, excludedPaths: 0, incompleteBatches: 0, notificationFailures: 0};
  private pending = 0;
  private frozen = false;
  private finishBoundary: (() => void) | null = null;
  get closed(): boolean { return this.frozen; }
  output(bytes: number, discarded: boolean): void {
    if (this.closed) throw new Error('Output arrived after its final boundary');
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(this.accepted + this.discarded + bytes)) throw new Error('Invalid output byte count');
    if (discarded) this.discarded += bytes; else this.accepted += bytes;
  }
  write(receipt: Promise<WriteReceipt>): void {
    if (this.closed) throw new Error('Repository change arrived after its final boundary');
    this.pending++;
    const finish = (result: WriteReceipt): void => {
      this.saved.storeAccepted &&= result.storeAccepted;
      this.saved.excludedPaths += result.excluded;
      this.saved.incompleteBatches += Number(!result.storeAccepted);
      this.saved.notificationFailures += Number('notificationFailure' in result);
      if (!('firstFailure' in this.saved) && 'failure' in result) this.saved.firstFailure = result.failure;
      this.pending--;
      if (!this.pending) this.finishBoundary?.();
    };
    // Aggregate each completion immediately: a slow earlier receipt does not
    // retain completed later receipts or their path arrays in a Promise chain.
    void receipt.then(finish, error => finish({storeAccepted: false, excluded: 0, skipped: [], journalCreated: false, failure: error}));
  }
  boundary(sentBytes: number): Promise<ConsumptionResult> {
    if (this.frozen) throw new Error('Duplicate final output boundary');
    this.frozen = true;
    const acceptedBytes = this.accepted, discardedBytes = this.discarded;
    const prefixReceived = Number.isSafeInteger(sentBytes) && sentBytes >= 0 && sentBytes === acceptedBytes + discardedBytes;
    return new Promise(resolve => {
      this.finishBoundary = () => {
        this.finishBoundary = null;
        resolve({sentBytes, acceptedBytes, discardedBytes, prefixReceived, ...this.saved});
      };
      if (!this.pending) this.finishBoundary();
    });
  }
}
