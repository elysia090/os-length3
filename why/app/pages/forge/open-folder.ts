import {errorText} from '../../../api/errors.ts';
import {t} from '../../../text/i18n.ts';
import {arrowKeys, h} from '../../ui/dom.ts';

type Opened = boolean | void;

interface Sources {
  storeNames(): Promise<readonly string[]>;
  remoteNames(): readonly string[];
  bring(name: string): Promise<void>;
  open(name: string): Opened | Promise<Opened>;
  create(): Opened | Promise<Opened>;
  allowed(): boolean;
}

interface Options extends Sources {
  anchor: HTMLElement;
  root: HTMLElement;
}

interface Folder { name: string; remote: boolean }

type State =
  | {kind: 'loading'}
  | {kind: 'list'; folders: readonly Folder[]; busy?: string; error?: string}
  | {kind: 'error'; error: string}
  | {kind: 'closed'};

function folders(local: readonly string[], remote: readonly string[]): Folder[] {
  const here = new Set(local);
  return [...Array.from(here, (name) => ({name, remote: false})),
    ...Array.from(new Set(remote.filter((name) => !here.has(name))), (name) => ({name, remote: true}))];
}

/** The chooser admits only an offered managed name, not a host path from the UI. */
export function folderChoice(sources: Sources, draw: (state: State) => void) {
  let state: State = {kind: 'loading'};
  let busy = false;
  const paint = (next: State) => { state = next; draw(next); };
  const close = () => { if (state.kind !== 'closed') paint({kind: 'closed'}); };
  const live = () => {
    if (state.kind === 'closed') return false;
    if (!sources.allowed()) { close(); return false; }
    return true;
  };
  const namesNow = async () => folders(await sources.storeNames(), sources.remoteNames());
  const load = async () => {
    if (busy || !live()) return;
    busy = true;
    paint({kind: 'loading'});
    try {
      const current = await namesNow();
      if (live()) paint({kind: 'list', folders: current});
    } catch (error) {
      if (live()) paint({kind: 'error', error: errorText(error)});
    } finally { busy = false; }
  };
  const choose = async (name: string | null) => {
    if (busy || !live() || state.kind !== 'list') return;
    const offered = state.folders;
    if (name === null ? offered.length !== 0 : !offered.some((folder) => folder.name === name)) return;
    busy = true;
    paint({kind: 'list', folders: offered, busy: name ?? ''});
    try {
      const current = await namesNow();
      if (!live()) return;
      const selected = current.find((folder) => folder.name === name);
      if (name === null ? current.length !== 0 : !selected) {
        paint({kind: 'list', folders: current, error: t('Available folders changed. Choose again.')});
        return;
      }
      if (selected?.remote) {
        await sources.bring(selected.name);
        if (!live()) return;
      }
      const result = name === null ? await sources.create() : await sources.open(name);
      if (!live()) return;
      if (result === false) paint({kind: 'list', folders: current, error: t('The folder was not opened.')});
      else close();
    } catch (error) {
      if (live()) paint({kind: 'list', folders: offered, error: errorText(error)});
    } finally { busy = false; }
  };
  return {load, choose, close};
}

let serial = 0;

/** Visible Open Folder and its context equivalent share this one managed-folder chooser. */
export function openFolder(options: Options): () => void {
  const {anchor, root} = options;
  let at = anchor.getBoundingClientRect();
  const prior = document.activeElement;
  const id = `forge-folders-${++serial}`;
  const popup = h('section', {id, class: 'forge-menu forge-folders', role: 'dialog', 'aria-label': t('Open Folder')});
  const status = h('div', {class: 'forge-folder-status', role: 'status'});
  const choices = h('div', {class: 'forge-folder-choices'});
  const button = (label: string, take: () => void) => {
    const item = h('button', {type: 'button', class: 'forge-menu-item'}, label) as HTMLButtonElement;
    item.addEventListener('click', take);
    return item;
  };
  const cancel = button(t('Cancel'), () => { controller.close(); returnFocus(); });
  const returnFocus = () => {
    if (!root.isConnected || !options.allowed()) return;
    const target = anchor.isConnected ? anchor : prior instanceof HTMLElement && prior.isConnected ? prior : null;
    target?.focus({preventScroll: true});
  };
  const controller = folderChoice({...options, allowed: () => root.isConnected && options.allowed()}, (state) => {
    if (state.kind === 'closed') {
      popup.remove();
      if (anchor.getAttribute('aria-controls') === id) {
        if (previousControls === null) anchor.removeAttribute('aria-controls'); else anchor.setAttribute('aria-controls', previousControls);
        if (previousExpanded === null) anchor.removeAttribute('aria-expanded'); else anchor.setAttribute('aria-expanded', previousExpanded);
      }
      listeners.abort();
      return;
    }
    const was = document.activeElement;
    const inChoices = choices.contains(was);
    const held = (was as HTMLElement | null)?.dataset?.folder;
    choices.replaceChildren();
    status.textContent = state.kind === 'loading' ? t('Loading…') : (state.kind === 'error' ? state.error : state.error ?? '');
    if (state.kind === 'error') choices.append(button(t('Try again'), () => void controller.load()));
    if (state.kind === 'list') {
      if (state.busy !== undefined) status.textContent = t('Opening…');
      if (!state.folders.length) {
        if (!status.textContent) status.textContent = t('No repos yet');
        const item = button(t('Create your first repo'), () => void controller.choose(null));
        item.disabled = state.busy !== undefined;
        choices.append(item);
      }
      for (const {name, remote} of state.folders) {
        const item = button(name, () => void controller.choose(name));
        item.dataset.folder = name;
        item.disabled = state.busy !== undefined;
        if (remote) item.append(h('small', {class: 'muted'}, 'Remote'));
        choices.append(item);
      }
    }
    if (inChoices || (was === cancel && firstList)) {
      if (state.kind !== 'loading') firstList = false;
      const enabled = [...choices.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      (enabled.find((item) => item.dataset.folder === held) ?? enabled[0] ?? cancel).focus({preventScroll: true});
    }
    position();
  });

  const previousControls = anchor.getAttribute('aria-controls');
  const previousExpanded = anchor.getAttribute('aria-expanded');
  const listeners = new AbortController();
  let firstList = true;
  const position = () => {
    if (anchor.isConnected) at = anchor.getBoundingClientRect();
    const r = at;
    const {width, height} = popup.getBoundingClientRect();
    const edge = 8;
    popup.style.left = `${Math.max(edge, Math.min(innerWidth - width - edge, r.left))}px`;
    const below = r.bottom + 4, above = r.top - height - 4;
    popup.style.top = `${Math.max(edge, Math.min(innerHeight - height - edge, below + height <= innerHeight - edge ? below : above))}px`;
  };
  anchor.setAttribute('aria-controls', id);
  anchor.setAttribute('aria-expanded', 'true');
  popup.append(status, choices, cancel);
  root.append(popup);
  arrowKeys(popup, 'button:not(:disabled)');
  document.addEventListener('pointerdown', (event) => {
    if (event.target instanceof Node && !popup.contains(event.target) && !anchor.contains(event.target)) controller.close();
  }, {capture: true, signal: listeners.signal});
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    controller.close();
    returnFocus();
  }, {signal: listeners.signal});
  window.addEventListener('resize', position, {signal: listeners.signal});
  cancel.focus({preventScroll: true});
  void controller.load();
  return controller.close;
}
