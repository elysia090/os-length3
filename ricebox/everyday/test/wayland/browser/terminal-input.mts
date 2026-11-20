// A queued raw composition can commit only to the same active editor epoch.
export function rawEditor(active: () => boolean, commit: () => void) {
  let generation = 0, composing: number | null = null;
  return {
    fence() { generation++; composing = null; },
    begin() { if (active()) composing = generation; },
    input(isComposing: boolean) { if (active() && !isComposing && composing === null) commit(); },
    finish() {
      const began = composing;
      composing = null;
      if (began !== null) queueMicrotask(() => {
        if (began === generation && active()) commit();
      });
    },
  };
}

/** A single-line editor never silently strips a raw paste's line endings. */
export function rawPaste(text: string, maxUnits: number, bracketed: boolean):
  {text: string} | {message: string} {
  if (text.length > maxUnits) return {message: 'Raw paste exceeds the command field limit.'};
  if (!bracketed && /[\r\n]/.test(text)) return {message: 'Multiline raw paste requires bracketed mode.'};
  return {text: bracketed && text ? '\x1b[200~' + text + '\x1b[201~' : text};
}

export type TerminalPost =
  | {type: 'input'; bytes: Uint8Array}
  | {type: 'interrupt'; sig: 2; flush?: number};

const ISIG = 1, ICANON = 2, NOFLSH = 0x80;

export function acceptsControlC(lflag: number): boolean {
  return !!(lflag & ISIG) || !(lflag & ICANON);
}

/** The keyboard and the visible button implement one guest input contract. */
export function controlC(lflag: number, flush: () => number): TerminalPost | null {
  if (!(lflag & ISIG)) return lflag & ICANON ? null : {type: 'input', bytes: Uint8Array.of(3)};
  return lflag & NOFLSH ? {type: 'interrupt', sig: 2} : {type: 'interrupt', sig: 2, flush: flush()};
}
