/// <reference path="./terminal-view-css.d.ts" />
import {guestScreen, ScreenView} from './vt-screen.ts';
import {terminalStream} from './terminal-stream.mts';
import {acceptsControlC, controlC, rawEditor, rawPaste, type TerminalPost} from './terminal-input.mts';
import {terminalResize, watchTerminalGrid, type ResizeRequest} from './terminal-resize.mts';
import './terminal-view.css';

const ICANON = 2, ECHO = 8, ISIG = 1, ICRNL = 0x100, OPOST = 1, ONLCR = 4;
const arrows = new Map([['ArrowUp','A'],['ArrowDown','B'],['ArrowRight','C'],['ArrowLeft','D']]);
const rawKeys = new Map([['Escape','\x1b'],['Backspace','\x7f'],['Tab','\t'],['Delete','\x1b[3~']]);

export function mountTerminal(section: HTMLElement, output: HTMLElement, line: HTMLInputElement,
  submit: HTMLButtonElement, post: (message: TerminalPost) => void, fail: () => void,
  fit?: {post: (request: ResizeRequest) => void; fail: () => void}) {
  const cols = 80, rows = 24, encode = new TextEncoder();
  let phase = 'off', stopped = false, frame = 0;
  let tty = {iflag: ICRNL, oflag: OPOST | ONLCR, lflag: ICANON | ECHO | ISIG};
  const events = new AbortController(), signal = events.signal;
  const send = (text: string) => {
    if (!stopped && text) post({type: 'input', bytes: encode.encode(text)});
  };
  const model = guestScreen(cols, rows, send);
  const stream = terminalStream(text => model.write(text), () => model.discardPartial());
  const view = new ScreenView(model);
  view.element.id = output.id;
  view.element.setAttribute('aria-label', 'Guest shell output');
  view.element.setAttribute('aria-live', 'off');
  output.replaceWith(view.element);
  section.dataset.terminal = 'screen';
  const resize = fit && typeof ResizeObserver === 'function' ? terminalResize({cols, rows}, fit.post, (grid, sentBytes) => {
    stream.cut(sentBytes);
    model.resize(grid.cols, grid.rows);
    schedule();
  }, reason => {
    stopWatching?.();
    section.dataset.terminalResize = reason;
    if (reason === 'rejected') delete view.element.dataset.fit;
    else fit.fail();
  }) : undefined;
  const stopWatching = resize && watchTerminalGrid(view.element, resize.offer);
  const interrupt = document.createElement('button');
  interrupt.type = 'button';
  interrupt.textContent = 'Interrupt (Ctrl+C)';
  const feedback = document.createElement('span');
  feedback.setAttribute('aria-live', 'polite');
  submit.after(interrupt, feedback);

  const raw = () => !(tty.lflag & ICANON);
  const live = () => !stopped && (phase === 'input' || phase === 'running');
  const masked = () => !raw() && !(tty.lflag & ECHO);
  const capturingRaw = () => live() && raw() && line.ownerDocument.activeElement === line;
  const draft = rawEditor(capturingRaw, () => {
    const value = line.value;
    line.value = '';
    if (value.length <= line.maxLength) send(value);
  });

  function clearDraft() { draft.fence(); line.value = ''; feedback.textContent = ''; }
  function configure() {
    line.disabled = !live();
    interrupt.disabled = !live() || !acceptsControlC(tty.lflag);
    submit.disabled = !live() || phase !== 'input' || raw();
    line.type = masked() ? 'password' : 'text';
    section.dataset.terminalInput = raw() ? 'raw' : 'line';
  }
  function draw() {
    frame = 0;
    view.draw();
    if (resize) view.element.dataset.grid = model.cols + 'x' + model.rows;
    view.element.dataset.screen = model.alternate ? 'alternate' : 'primary';
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(() => { try { draw(); } catch { fail(); } });
  }
  function ctrlC() {
    if (!live()) return;
    const message = controlC(tty.lflag, () => {
      clearDraft();
      return stream.flush();
    });
    if (message) post(message);
  }

  interrupt.addEventListener('click', ctrlC, {signal});
  line.addEventListener('keydown', e => {
    if (!live() || e.isComposing) return;
    if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'c') {
      if (!raw() && line.selectionStart !== line.selectionEnd) return;
      if (acceptsControlC(tty.lflag)) { e.preventDefault(); ctrlC(); }
      return;
    }
    if (!raw() || e.ctrlKey || e.altKey || e.metaKey || (e.key === 'Tab' && e.shiftKey)) return;
    const direction = arrows.get(e.key);
    const key = direction ? '\x1b' + (model.appCursor ? 'O' : '[') + direction :
      e.key === 'Enter' ? (tty.iflag & ICRNL ? '\n' : '\r') : rawKeys.get(e.key);
    if (key !== undefined) { e.preventDefault(); send(key); }
  }, {signal});
  line.addEventListener('blur', () => { if (raw()) clearDraft(); else draft.fence(); }, {signal});
  line.addEventListener('compositionstart', () => draft.begin(), {signal});
  line.addEventListener('compositionend', () => draft.finish(), {signal});
  line.addEventListener('input', event => {
    const e = event as InputEvent;
    if (e.inputType !== 'insertFromPaste') draft.input(e.isComposing);
  }, {signal});
  line.addEventListener('paste', event => {
    if (!capturingRaw()) return;
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    clearDraft();
    const proposed = rawPaste(text, line.maxLength, model.bracketed);
    if ('text' in proposed) send(proposed.text);
    else feedback.textContent = proposed.message;
  }, {signal});

  configure();
  schedule();
  return {
    cols, rows, resize,
    phase(value: string) {
      phase = value;
      configure();
      if (phase === 'input') resize?.activate();
    },
    echoCooked(value: string) {
      if (live() && phase === 'input' && !raw() && (tty.lflag & ECHO)) {
        model.echoLine(value);
        schedule();
      }
    },
    mode(next: typeof tty) {
      const wasRaw = raw(), wasMasked = masked();
      tty = next;
      model.newline = !!(next.oflag & OPOST) && !!(next.oflag & ONLCR);
      // Clear before changing the field type so a formerly hidden draft never
      // becomes visible or joins a different TTY mode.
      if (wasRaw || raw() || wasMasked !== masked()) clearDraft();
      configure();
    },
    output(bytes: Uint8Array, tag: number) {
      if (stream.accept(bytes, tag)) schedule();
    },
    seal(sentBytes: number) {
      resize?.close();
      stopWatching?.();
      stream.seal(sentBytes);
    },
    get sealed() { return stream.sealed; },
    close() {
      if (stopped) return;
      stopped = true;
      resize?.close();
      stopWatching?.();
      events.abort();
      if (frame) cancelAnimationFrame(frame);
      clearDraft();
      configure();
      stream.close();
      draw();
    },
  };
}
