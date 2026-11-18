/** Private single-execution transport, not a Linux syscall definition. */
export const SLOT_BYTES = 112;
export const IDLE = 0, REQUEST = 1, RETURN = 2, LEAVE = 3;
// A subround of the same paused request, never a new Linux syscall/sequence.
export const APPLY_FS = 4, FS_APPLYING = 5, FS_ACK = 6;
export const MAX_SEQUENCE = 0x7fffffff;
export interface GuestRequest {
  invocation: bigint;
  sequence: number;
  nr: bigint;
  args: [bigint, bigint, bigint, bigint, bigint, bigint];
  next: bigint;
}
export type GuestReply = {kind: 'return'; value: bigint} | {kind: 'leave'};
export type RegisterResult = 'applied' | 'not-applied' | 'unknown';
export type GuestOutcome = {kind: 'left' | 'returned'; unwound: true} | {kind: 'failed'; unwound: boolean; error: unknown};
