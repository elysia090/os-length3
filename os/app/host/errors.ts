/** What went wrong, as a person reads it: an Error's sentence (never "Error: …"), or what was thrown, as text. */
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Why the Remote did not give what was asked, when it was not the Remote saying no: it was not reached (or not
 * in time), it is there but not taking requests (a gateway's 502, 503 or 504), or what answered is not its reply
 * (a page, as a host's fallback or a proxy gives, or words that do not read as its JSON).
 */
type Trouble = 'unreached' | 'unavailable' | 'malformed';

/** The Remote's refusal, as a page catches it: its status, its words, what it said besides, and its Trouble when it
 * was not the Remote saying no. */
export class RemoteError extends Error {
  readonly status: number;
  readonly detail: Record<string, unknown>;
  readonly trouble?: Trouble;
  constructor(status: number, message: string, detail: Record<string, unknown> = {}, trouble?: Trouble) {
    super(message); this.status = status; this.detail = detail; this.trouble = trouble;
  }
}
