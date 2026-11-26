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

interface Menu {
  close(back?: boolean): void;
  fit(): void;
  enabled(): boolean;
  signal: AbortSignal;
  item(name: string, run: () => void, options?: {disabled?: boolean; checked?: boolean}): HTMLButtonElement;
  divide(): void;
  say(message: string): void;
}

let closeActive: (() => void) | undefined;

/** One contextual menu on the desk. The object under the pointer supplies actions, not its own popup. */
export function pointerMenu(at: Point, label: string, owns: () => boolean, restore: () => void,
  items: (menu: Menu) => void, firstFocus = false) {
  closeActive?.();
  const layer = new AbortController();
  const options = {signal: layer.signal};
  const menu = h('div', {class: 'forge-menu forge-document-menu', role: 'menu', 'aria-label': label, tabindex: '-1'});
  const status = h('span', {class: 'forge-menu-status', role: 'status'});
  const buttons: HTMLButtonElement[] = [];
  const enabled = () => !layer.signal.aborted && owns();
  const cancel = () => close();
  function close(back = false) {
    const go = back && enabled();
    layer.abort();
    menu.remove();
    if (closeActive === cancel) closeActive = undefined;
    if (go) restore();
  }
  closeActive = cancel;

  const viewport = window.visualViewport;
  function fit() {
    const {x, y} = menuPosition(at, menu.offsetWidth, menu.offsetHeight, viewport ? {
      x: viewport.offsetLeft, y: viewport.offsetTop, width: viewport.width, height: viewport.height,
    } : {width: innerWidth, height: innerHeight});
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }
  items({close, fit, enabled, signal: layer.signal, item(name, run, opts) {
    const check = opts?.checked;
    const b = h('button', {class: 'forge-menu-item', type: 'button', role: check === undefined ? 'menuitem' : 'menuitemcheckbox',
      ...(check === undefined ? {} : {'aria-checked': String(check)})}, name) as HTMLButtonElement;
    b.disabled = opts?.disabled ?? false;
    b.addEventListener('click', () => { if (enabled()) run(); }, options);
    buttons.push(b);
    menu.append(b);
    return b;
  }, divide() { menu.append(h('hr', {role: 'separator'})); }, say(message) { status.textContent = message; fit(); }});
  menu.append(status);
  document.body.append(menu);
  fit();
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(true); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const keys = buttons.filter((b) => !b.disabled);
      const current = keys.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1
        : event.key === 'ArrowDown' ? (current + 1) % keys.length
        : (current < 0 ? keys.length - 1 : (current - 1 + keys.length) % keys.length);
      keys[next]?.focus({preventScroll: true});
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
  window.addEventListener('resize', fit, options);
  viewport?.addEventListener('resize', fit, options);
  viewport?.addEventListener('scroll', fit, options);
  ((firstFocus && buttons.find((b) => !b.disabled)) || menu).focus({preventScroll: true});
  return close;
}

export interface BesideOption {
  checked: boolean;
  /** Whether action may still restore the caller's focus, including after an acknowledgment. */
  toggle(ownsFocus: () => boolean): Promise<boolean> | boolean;
}

const showable = (owner: HTMLElement) => owner.isConnected && !owner.closest('[hidden], [inert]');
const paper = (at: EventTarget | null) => at instanceof HTMLElement
  && !at.closest('button, a, input, select, [contenteditable], [data-raw], [data-hushed]');
const menuKey = (e: KeyboardEvent) => !e.isComposing && (e.key === 'ContextMenu' || e.shiftKey && e.key === 'F10');

interface EditActions {beside?: () => BesideOption | null; close?: () => void}
function editableItems(menu: Menu, area: HTMLTextAreaElement, selected: Selection, owns: () => boolean, actions: EditActions) {
  let busy = false;
  const run = async (edit: Edit) => {
    if (busy || !menu.enabled()) return;
    if (edit === 'Select All') { menu.close(true); area.select(); return; }
    if (edit !== 'Copy' && area.readOnly) return;
    busy = true;
    const result = await clipboardEdit(edit, selected, navigator.clipboard, menu.enabled);
    busy = false;
    if (!menu.enabled()) { menu.close(); return; }
    if (result.kind === 'denied') {
      menu.say(t('Clipboard access unavailable. No text was changed.'));
      return;
    }
    menu.close(true);
    if (result.kind !== 'replace' || area.readOnly || !owns()) return;
    // Prefer the native edit and its undo stack; otherwise the real editor must hear a normal input event.
    const native = result.text ? document.execCommand('insertText', false, result.text) : document.execCommand('delete');
    if (!native) {
      area.setRangeText(result.text, selected.selectionStart, selected.selectionEnd, 'end');
      area.dispatchEvent(new Event('input', {bubbles: true}));
    }
  };
  for (const edit of ['Cut', 'Copy', 'Paste', 'Select All'] as const) {
    const disabled = ((edit === 'Cut' || edit === 'Copy') && selected.selectionStart === selected.selectionEnd)
      || (area.readOnly && (edit === 'Cut' || edit === 'Paste')) || (edit === 'Select All' && !selected.value);
    menu.item(t(edit), () => { void run(edit); }, {disabled});
  }
  const view = actions.beside?.();
  if (view) {
    const toggle = menu.item(t('Beside'), async () => {
      if (busy || !menu.enabled()) return;
      busy = toggle.disabled = true;
      const done = await view.toggle(menu.enabled);
      if (menu.signal.aborted) return;
      if (done) { menu.close(!view.checked); return; }
      busy = toggle.disabled = false;
      menu.say(view.checked ? t('Could not save changes. Beside stays open.') : t('This file cannot be opened beside itself.'));
      toggle.focus({preventScroll: true});
    }, {checked: view.checked});
  }
  if (actions.close) {
    menu.divide();
    menu.item(t('Close'), () => { menu.close(); actions.close?.(); });
  }
  area.addEventListener('input', () => menu.close(), {signal: menu.signal});
}

function editMenu(at: Point, label: string, area: HTMLTextAreaElement, current: () => HTMLTextAreaElement | null, actions: EditActions) {
  const selected = selectionOf(area);
  const owns = () => current() === area && showable(area) && !area.disabled && sameSelection(area, selected);
  return pointerMenu(at, label, owns, () => {
    area.focus({preventScroll: true});
    area.setSelectionRange(selected.selectionStart, selected.selectionEnd, selected.selectionDirection);
  }, (menu) => editableItems(menu, area, selected, owns, actions));
}

/** The file's actual editor, not a directory row, terminal, loading text, or a stale textarea. */
export function documentMenu(owner: HTMLElement, current: () => HTMLTextAreaElement | null, beside?: () => BesideOption | null): () => void {
  const listening = new AbortController();
  let putAway: (() => void) | undefined;
  const eligible = (area: HTMLTextAreaElement | null): area is HTMLTextAreaElement =>
    !!area && owner.contains(area) && showable(area) && !area.disabled;
  const options = {signal: listening.signal};
  owner.addEventListener('pointerdown', (event) => {
    // Right-pressing outside the current selection may otherwise collapse it before contextmenu.
    if (event.button === 2 && paper(event.target) && eligible(current())) event.preventDefault();
  }, {...options, capture: true});
  owner.addEventListener('contextmenu', (event) => {
    const area = current();
    if (!paper(event.target) || !eligible(area)) return;
    event.preventDefault(); event.stopPropagation();
    putAway = editMenu({x: event.clientX, y: event.clientY}, t('Edit text'), area, current, {beside});
  }, options);
  owner.addEventListener('keydown', (event) => {
    const area = current();
    if (event.target !== area || !eligible(area) || !paper(area) || !menuKey(event)) return;
    event.preventDefault(); event.stopPropagation();
    const r = area.getBoundingClientRect();
    putAway = editMenu({x: r.left, y: r.top + 24}, t('Edit text'), area, current, {beside});
  }, options);
  return () => { putAway?.(); listening.abort(); };
}

/** Draft and output share the desk's context menu. Close hides the view; it never sends a shell signal. */
export function terminalMenu(owner: HTMLElement, current: () => HTMLTextAreaElement, hide: () => void) {
  const life = new AbortController();
  let dismiss: (() => void) | undefined;
  const open = (at: Point, from: HTMLElement) => {
    const area = current();
    if (from === area) {
      dismiss = editMenu(at, t('Terminal'), area, current, {close: hide});
      return;
    }
    const restore = document.activeElement instanceof HTMLElement && owner.contains(document.activeElement) ? document.activeElement : area;
    const selection = getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    const selected = range && from.closest('.term-out')?.contains(range.commonAncestorContainer) ? range.toString() : '';
    dismiss = pointerMenu(at, t('Terminal'), () => showable(owner) && current() === area, () => {
      restore.focus({preventScroll: true});
      if (!selected || !range?.commonAncestorContainer.isConnected) return;
      selection?.removeAllRanges(); selection?.addRange(range);
    }, (menu) => {
      if (selected) {
        const copy = menu.item(t('Copy'), async () => {
          copy.disabled = true;
          try { await navigator.clipboard.writeText(selected); menu.close(true); }
          catch {
            if (menu.enabled()) {
              copy.disabled = false;
              menu.say(t('Clipboard access unavailable. No text was changed.'));
            }
          }
        });
        menu.divide();
      }
      menu.item(t('Close'), () => { menu.close(); hide(); });
    });
  };
  const options = {signal: life.signal};
  owner.addEventListener('pointerdown', (e) => {
    if (e.button === 2 && showable(owner) && paper(e.target)) e.preventDefault();
  }, {...options, capture: true});
  owner.addEventListener('contextmenu', (e) => {
    if (!showable(owner) || !paper(e.target) || !(e.target instanceof HTMLElement)) return;
    e.preventDefault(); e.stopPropagation();
    open({x: e.clientX, y: e.clientY}, e.target);
  }, options);
  owner.addEventListener('keydown', (e) => {
    if (!showable(owner) || !paper(e.target) || !(e.target instanceof HTMLElement) || !menuKey(e)) return;
    e.preventDefault(); e.stopPropagation();
    const r = e.target.getBoundingClientRect(); open({x: r.left, y: r.top + 24}, e.target);
  }, options);
  return {dismiss: () => dismiss?.(), drop: () => { dismiss?.(); life.abort(); }};
}
