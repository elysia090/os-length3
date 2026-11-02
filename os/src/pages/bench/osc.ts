// What a shell says to its terminal rather than to the person: operating system commands (OSC, ESC ] … BEL or
// ESC \). The Prompt reads them and shows none of them; they arrive in pieces as output does, so one begun in a piece
// and ended in a later one is held until it ends.

/** An OSC, whole. */
export const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** A run's end, as shell integration says it: OSC 133 D, with its exit status. */
export const RAN = /\x1b\]133;D(?:;(\d+))?(?:\x07|\x1b\\)/g;
/** Text put on the clipboard (OSC 52, as `clip` and tmux send it): its base64. A query (`?`) is no text and is never
 * answered: a program in a Prompt may write the clipboard, as terminals let it, but not read it. */
const CLIP = /\x1b\]52;[a-z0-9]*;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/g;
/** The most of an unfinished OSC held for its end (a clipboard of a few MB); past it, what was held goes. */
const HOLD_MOST = 8 << 20;

/** Output with an OSC it ends in, unfinished, held back for the next piece: what can be read now, and what is held. */
export function heldBack(held: string, piece: string): {now: string; held: string} {
  const s = held + piece, open = s.lastIndexOf('\x1b]');
  if (open < 0 || /\x07|\x1b\\/.test(s.slice(open))) return {now: s, held: ''};
  const rest = s.slice(open);
  return {now: s.slice(0, open), held: rest.length > HOLD_MOST ? '' : rest};
}

/** The texts output puts on the clipboard, in order, each decoded from its base64 as UTF-8. */
export function clips(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(CLIP)) {
    try {
      out.push(new TextDecoder('utf-8', {fatal: true}).decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0))));
    } catch { /* not base64 of UTF-8 text: nothing is put there */ }
  }
  return out;
}
