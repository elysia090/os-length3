import {h} from '../dom.ts';
import {mark} from '../icons.ts';

// A short word beside the control that caused it, with at most one thing to
// do next. It stays for LINGER (longer while the pointer is on it), and goes
// on its ×, Escape, or once its action is taken. One at a time.

const LINGER = 8000;
let current: {element: HTMLElement; close(): void} | null = null;

export function notice(anchor: HTMLElement | null, text: string, action?: {label: string; run(): void}) {
  current?.close();
  const close = () => {
    clearTimeout(timer);
    element.remove();
    document.removeEventListener('keydown', onKey);
    if (current?.element === element) current = null;
  };
  const shut = h('button', {type: 'button', class: 'pill-close', 'aria-label': '閉じる'}, mark('close'));
  shut.addEventListener('click', close);
  const go = action ? h('button', {type: 'button', class: 'chip'}, action.label) : null;
  go?.addEventListener('click', () => { close(); action!.run(); });
  const element = h('div', {class: 'notice', role: 'status'}, h('span', {}, text), go, shut);
  document.body.append(element);
  if (anchor) {
    const at = anchor.getBoundingClientRect();
    element.style.left = `${at.right + 12}px`;
    element.style.top = `${at.top + at.height / 2 - element.offsetHeight / 2}px`;
  }
  let timer = window.setTimeout(close, LINGER);
  element.addEventListener('pointerenter', () => clearTimeout(timer));
  element.addEventListener('pointerleave', () => { clearTimeout(timer); timer = window.setTimeout(close, LINGER); });
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  current = {element, close};
}
