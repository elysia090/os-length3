// The pinned review wire contract, shared without loading either Why's UI or the Remote.
/** A line in an immutable review diff, addressed on its old or new side. */
export interface ReviewLine { path: string; side: 'old' | 'new'; line: number }
export interface Revision { version: number; head: string }
export interface Basis extends Revision { base: string | null }

/** Stored in the existing charged, size-limited marks column. The tag is not valid at the legacy write endpoint. */
export const PIN = 'why.line/1:';
const digest = /^[a-f0-9]{64}$/;
export const lineKey = (line: ReviewLine) => JSON.stringify([line.path, line.side, line.line]);
export const stableMarks = ({version, base, head}: Basis, lines: readonly ReviewLine[]) =>
  [PIN + JSON.stringify({version, base, head, lines})];

export function isReviewLine(value: unknown): value is ReviewLine {
  if (value === null || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return typeof m.path === 'string' && !!m.path && m.path.length <= 1024 &&
    (m.side === 'old' || m.side === 'new') && typeof m.line === 'number' &&
    Number.isSafeInteger(m.line) && m.line > 0;
}

export function markBasis(version: number, marks: readonly string[]): { basis: Basis; lines: ReviewLine[] } | null {
  if (marks.length !== 1 || !marks[0]!.startsWith(PIN)) return null;
  let v: Partial<Basis> & {lines?: unknown};
  try { v = JSON.parse(marks[0]!.slice(PIN.length)); } catch { return null; }
  const {version: n, base, head, lines} = v ?? {};
  return n === version && (base === null || (typeof base === 'string' && digest.test(base))) &&
    typeof head === 'string' && digest.test(head) && Array.isArray(lines) && lines.every(isReviewLine)
    ? {basis: {version, base, head}, lines} : null;
}
