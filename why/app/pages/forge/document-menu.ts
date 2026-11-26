import {h} from '../../ui/dom.ts';
import {t} from '../../../text/i18n.ts';

type Direction = 'forward' | 'backward' | 'none';
type Selection = {value: string; selectionStart: number; selectionEnd: number; selectionDirection: Direction};
type Point = {x: number; y: number};
type Edit = 'Cut' | 'Copy' | 'Paste' | 'Select All';
export const selectionOf = (area: Selection): Selection => ({
  value: area.value, selectionStart: area.selectionStart, selectionEnd: area.selectionEnd, selectionDirection: area.selectionDirection,
});
export const sameSelection = (a: Selection, b: Selection) =>
  a.value === b.value && a.selectionStart === b.selectionStart && a.selectionEnd === b.selectionEnd && a.selectionDirection === b.selectionDirection;

export function menuPosition(at: Point, width: number, height: number, room: DOMRectInit): Point {
  const x = room.x ?? 0, y = room.y ?? 0;
  const fit = (to: number, size: number, start: number, extent: number) =>
    Math.max(start + 6, Math.min(start + extent - size - 6, to + size + 11 <= start + extent ? to + 5 : to - size - 5));
  return {x: fit(at.x, width, x, room.width ?? 0), y: fit(at.y, height, y, room.height ?? 0)};
}

type Clipboard = Pick<globalThis.Clipboard, 'readText' | 'writeText'>;
type Plan = {kind: 'done' | 'stale' | 'denied'} | {kind: 'replace'; text: string};

/** Clipboard access can outlast the menu, file ownership or range. Only the caller can apply a still-owned plan. */
export async function clipboardEdit(edit: Exclude<Edit, 'Select All'>, selection: Selection,
  clipboard: Clipboard | undefined, owned: () => boolean): Promise<Plan> {
  if (!owned()) return {kind: 'stale'};
  try {
    if (!clipboard) return {kind: 'denied'};
    if (edit === 'Paste') {
      const text = await clipboard.readText();
      return !owned() ? {kind: 'stale'} : text ? {kind: 'replace', text} : {kind: 'done'};
    }
    const {value, selectionStart, selectionEnd} = selection;
    if (selectionStart === selectionEnd) return {kind: 'done'};
    await clipboard.writeText(value.slice(selectionStart, selectionEnd));
    return !owned() ? {kind: 'stale'} : edit === 'Cut' ? {kind: 'replace', text: ''} : {kind: 'done'};
  } catch { return {kind: owned() ? 'denied' : 'stale'}; }
}

let closeActive: (() => void) | undefined;

export interface BesideOption {
  checked: boolean;
  /** Whether action may still restore the caller's focus, including after an acknowledgment. */
  toggle(ownsFocus: () => boolean): Promise<boolean> | boolean;
}

/** The file's actual editor, not a directory row, terminal, loading text, or a stale textarea. */
export function documentMenu(owner: HTMLElement, current: () => HTMLTextAreaElement | null,
  beside?: () => BesideOption | null): () => void {
  const listening = new AbortController();
  let putAway: ((back?: boolean) => void) | undefined;
  const eligible = (area: HTMLTextAreaElement | null): area is HTMLTextAreaElement =>
    !!area && owner.contains(area) && area.isConnected && !area.closest('[hidden], [inert]') && !area.disabled;

  function show(area: HTMLTextAreaElement, at: Point) {
    closeActive?.();
    const selected = selectionOf(area);
    const layer = new AbortController();
    const status = h('span', {class: 'forge-menu-status', role: 'status'});
    const menu = h('div', {class: 'forge-menu forge-document-menu', role: 'menu', 'aria-label': t('Edit text')});
    const buttons: HTMLButtonElement[] = [];
    const cancel = () => close(false);
    const owned = () => !layer.signal.aborted && current() === area && eligible(area) && sameSelection(area, selected);
    const close = (back = false) => {
      const restore = back && owned();
      layer.abort();
      menu.remove();
      if (closeActive === cancel) closeActive = undefined;
      if (putAway === close) putAway = undefined;
      if (restore) {
        area.focus({preventScroll: true});
        area.setSelectionRange(selected.selectionStart, selected.selectionEnd, selected.selectionDirection);
      }
    };
    closeActive = cancel;
    putAway = close;

    const viewport = window.visualViewport;
    const fit = () => {
      const {x, y} = menuPosition(at, menu.offsetWidth, menu.offsetHeight, viewport ? {
        x: viewport.offsetLeft, y: viewport.offsetTop, width: viewport.width, height: viewport.height,
      } : {width: innerWidth, height: innerHeight});
      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;
    };
    let busy = false;
    const run = async (edit: Edit) => {
      if (busy || !owned()) return;
      if (edit === 'Select All') { close(true); area.select(); return; }
      if (edit !== 'Copy' && area.readOnly) return;
      busy = true;
      const result = await clipboardEdit(edit, selected, navigator.clipboard, owned);
      busy = false;
      if (!owned()) { if (!layer.signal.aborted) close(); return; }
      if (result.kind === 'denied') {
        status.textContent = t('Clipboard access unavailable. No text was changed.');
        fit();
        return;
      }
      close(true);
      if (result.kind !== 'replace' || area.readOnly || current() !== area || !eligible(area) || !sameSelection(area, selected)) return;
      // Prefer the native edit and its undo stack; otherwise the real editor must hear a normal input event.
      const native = result.text ? document.execCommand('insertText', false, result.text) : document.execCommand('delete');
      if (!native) {
        area.setRangeText(result.text, selected.selectionStart, selected.selectionEnd, 'end');
        area.dispatchEvent(new Event('input', {bubbles: true}));
      }
    };
    for (const edit of ['Cut', 'Copy', 'Paste', 'Select All'] as const) {
      const b = h('button', {class: 'forge-menu-item', type: 'button', role: 'menuitem'}, t(edit)) as HTMLButtonElement;
      b.disabled = ((edit === 'Cut' || edit === 'Copy') && selected.selectionStart === selected.selectionEnd)
        || (area.readOnly && (edit === 'Cut' || edit === 'Paste')) || (edit === 'Select All' && !selected.value);
      b.addEventListener('click', () => { void run(edit); });
      buttons.push(b);
    }
    const view = beside?.();
    if (view) {
      const toggle = h('button', {class: 'forge-menu-item', type: 'button', role: 'menuitemcheckbox',
        'aria-checked': String(view.checked)}, t('Beside')) as HTMLButtonElement;
      toggle.addEventListener('click', async () => {
        if (busy || !owned()) return;
        busy = true;
        toggle.disabled = true;
        const done = await view.toggle(owned);
        if (layer.signal.aborted) return;
        if (done) { close(!view.checked); return; }
        busy = toggle.disabled = false;
        status.textContent = view.checked ? t('Could not save changes. Beside stays open.') : t('This file cannot be opened beside itself.');
        fit();
        toggle.focus({preventScroll: true});
      });
      buttons.push(toggle);
    }
    menu.append(...buttons, status);
    menu.tabIndex = -1;
    document.body.append(menu);
    fit();
    const options = {signal: layer.signal};
    menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(true); }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const enabled = buttons.filter((b) => !b.disabled);
        const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
          : event.key === 'ArrowDown' ? (current + 1) % enabled.length
          : (current < 0 ? enabled.length - 1 : (current - 1 + enabled.length) % enabled.length);
        enabled[next]?.focus({preventScroll: true});
        event.preventDefault();
      }
      event.stopPropagation();
    }, options);
    document.addEventListener('pointerdown', (event) => {
      if (!event.composedPath().includes(menu)) close();
    }, {...options, capture: true});
    document.addEventListener('focusin', (event) => {
      if (!event.composedPath().includes(menu)) close();
    }, options);
    area.addEventListener('input', () => close(), options);
    window.addEventListener('resize', fit, options);
    viewport?.addEventListener('resize', fit, options);
    viewport?.addEventListener('scroll', fit, options);
    menu.focus({preventScroll: true});
  }

  const options = {signal: listening.signal};
  const paper = (at: EventTarget | null) =>
    at instanceof HTMLElement && !at.closest('button, a, input, select, [contenteditable]');
  owner.addEventListener('pointerdown', (event) => {
    // In particular right-pressing outside the current selection may otherwise collapse it before contextmenu.
    if (event.button === 2 && paper(event.target) && eligible(current())) event.preventDefault();
  }, {...options, capture: true});
  owner.addEventListener('contextmenu', (event) => {
    const area = current();
    if (!paper(event.target) || !eligible(area)) return;
    event.preventDefault(); event.stopPropagation();
    show(area, {x: event.clientX, y: event.clientY});
  }, options);
  owner.addEventListener('keydown', (event) => {
    const area = current();
    if (event.isComposing || event.target !== area || !eligible(area)
      || !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return;
    event.preventDefault(); event.stopPropagation();
    const r = area.getBoundingClientRect();
    show(area, {x: r.left, y: r.top + 24});
  }, options);
  return () => { putAway?.(); listening.abort(); };
}
