import {GUEST_SCREEN_LIMITS} from './vt-screen.ts';

type Grid = {cols: number; rows: number};
export type ResizeRequest = {type: 'terminal-resize'; request: number} & Grid;
const same = (a: Grid, b: Grid) => a.cols === b.cols && a.rows === b.rows;
const valid = ({cols, rows}: Grid) => Number.isInteger(cols) && Number.isInteger(rows) &&
  cols >= 2 && cols <= GUEST_SCREEN_LIMITS.columns && rows >= 1 && rows <= GUEST_SCREEN_LIMITS.rows;

/** A hidden or undersized viewport isn't a zero-sized TTY. All sizes are CSS pixels, not DPR. */
export function fitTerminalGrid(width: number, height: number, cellWidth: number, cellHeight: number): Grid | undefined {
  if (![width, height, cellWidth, cellHeight].every(n => Number.isFinite(n) && n > 0)) return;
  const cols = Math.min(GUEST_SCREEN_LIMITS.columns, Math.floor(width / cellWidth));
  const rows = Math.min(GUEST_SCREEN_LIMITS.rows, Math.floor(height / cellHeight));
  if (cols >= 2 && rows >= 1) return {cols, rows};
}

export function terminalResize(initial: Grid, post: (request: ResizeRequest) => void,
  apply: (grid: Grid, sentBytes: number) => void, stop: (reason: 'rejected' | 'error') => void) {
  let applied = initial, latest: Grid | undefined, pending: ResizeRequest | undefined, sequence = 0;
  let active = false, closed = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  function close() {
    closed = true;
    latest = pending = undefined;
    clearTimeout(deadline);
  }
  function end(reason: 'rejected' | 'error') { close(); stop(reason); }
  function request() {
    if (!active || closed || pending || !latest || same(applied, latest)) return;
    const next: ResizeRequest = {type: 'terminal-resize', request: ++sequence, ...latest};
    pending = next;
    // Without the cut, the guest could already be using unknown geometry.
    deadline = setTimeout(() => end('error'), 5000);
    try { post(next); } catch { end('error'); }
  }
  return {
    activate() { active = true; request(); },
    offer(grid: Grid | undefined) { latest = grid && valid(grid) ? grid : undefined; request(); },
    marker(message: {request?: unknown; cols?: unknown; rows?: unknown; sentBytes?: unknown}) {
      if (closed) return;
      const cut = pending;
      const {sentBytes} = message;
      if (!cut || message.request !== cut.request || message.cols !== cut.cols || message.rows !== cut.rows ||
          typeof sentBytes !== 'number' || !Number.isSafeInteger(sentBytes) || sentBytes < 0) {
        end('error');
        return;
      }
      try { apply({cols: cut.cols, rows: cut.rows}, sentBytes); } catch { end('error'); return; }
      applied = cut;
      pending = undefined;
      clearTimeout(deadline);
      request();
    },
    reply(message: {request?: unknown; error?: unknown}) {
      if (closed) return;
      // The marker, not the advisory positive ACK, completes a resize. Its
      // ACK may be missing or still queued when another resize is posted.
      if (typeof message.request !== 'number' || !Number.isSafeInteger(message.request) ||
          message.request < 1 || message.request > sequence) { end('error'); return; }
      if (message.request !== pending?.request) {
        if (message.error !== undefined) end('error');
        return;
      }
      // A typed refusal before the cut had no effect; keep the last grid
      // and disable automatic sizing rather than sending a retry loop.
      switch (message.error) {
        case 'inactive': case 'closed': case 'stale': case 'invalid-size': case 'busy':
          end('rejected'); return;
        default: end('error'); // Includes a positive ACK without its required cut.
      }
    },
    close,
  };
}

/** Watch the fixed CSS output box and its font metric, never the guest row elements. */
export function watchTerminalGrid(output: HTMLElement, offer: (grid: Grid | undefined) => void): () => void {
  output.dataset.fit = '';
  const cell = output.ownerDocument.createElement('span');
  cell.className = 'vt-measure';
  cell.setAttribute('aria-hidden', 'true');
  output.append(cell);
  let box: DOMRectReadOnly | undefined;
  let closed = false;
  const observer = new ResizeObserver(entries => {
    if (closed) return;
    for (const entry of entries) if (entry.target === output) box = entry.contentRect;
    if (box) {
      const cellBox = cell.getBoundingClientRect();
      offer(fitTerminalGrid(box.width, box.height, cellBox.width, cellBox.height));
    }
  });
  observer.observe(output);
  observer.observe(cell);
  return () => {
    closed = true;
    observer.disconnect();
    cell.remove();
  };
}
