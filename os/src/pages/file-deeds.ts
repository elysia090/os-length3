import {h} from '../ui/dom.ts';
import {nudge, putAway} from '../ui/glide.ts';
import {t} from '../i18n.ts';
import {plainPart, plainPath, store} from '../repos/repos.ts';
import {answers, askFoot, menuItem, menuRule, SETTLE} from './common.ts';
import type {MarkName} from '../ui/icons.ts';
import {errorText} from '../app/errors.ts';

// What can be done to a file or a folder of a repo, as one menu (the person's menu, `.pop`), wherever it is brought
// out: File's row, and Forge's files button for the file in front. Its name over its deeds; a deed pressed becomes
// the field or the ask in its own place. What follows a deed (a tree drawn again, a file opened in Forge) is the
// caller's.

/** A path in a repo joined under a folder of it ('' for its top). */
export const joined = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
/** A path in a repo as its folder and its name. */
export const split = (path: string) => (path.includes('/') ? [path.slice(0, path.lastIndexOf('/')), path.slice(path.lastIndexOf('/') + 1)] : ['', path]);

/** Whether `child` is in the folder `inside` of `repo` already (asked of the store, not of what was last shown; no folder, no). */
const there = async (repo: string, inside: string, child: string) => (await store.tree(repo, inside).catch(() => [])).some((x) => x.name === child);
const taken = (child: string) => new Error(t('"{name}" already exists', {name: child}));

/**
 * `written` as the path `path` of `repo` goes to (a name, or a path that moves it: notes/plan.md), put plainly; thrown
 * if it is no path or something is there already.
 */
export async function renaming(repo: string, path: string, written: string): Promise<string> {
  const to = written.replace(/^\/+|\/+$/g, '');
  if (!plainPath(to)) throw new Error(t('Paths joined by "/", segments cannot start with "."'));
  const [inside, name] = split(to);
  if (to !== path && await there(repo, inside, name)) throw taken(name);
  return to;
}

interface Deeds {
  repo: string;
  /** Its path in the repo ('' for the repo itself), the name it is shown by, and whether it is a folder. */
  path: string;
  name: string;
  dir: boolean;
  /** About to be made in `folder` (a path in the repo): told before the store writes it. */
  opening?(folder: string): void;
  /** Made: the new file's (or folder's) path in the repo. */
  made(path: string, file: boolean): Promise<void> | void;
  /** Its new path written (a name, or a path that moves it): moving it is the caller's. */
  move(to: string): Promise<void>;
  /** Deleted from the store. */
  removed(): Promise<void> | void;
  /** Not now: put back as it was; the keyboard goes back to what had it. */
  back(): void;
}

/** The menu of `d`, to be laid where its caller lays it (the first deed is for the keyboard to go to). */
export function fileDeeds(d: Deeds): HTMLElement {
  const {repo, path} = d;
  const pop = h('div', {class: 'pop tree-pop', role: 'menu', 'aria-label': d.name});
  const entry = (label: string, name: MarkName, then: (b: HTMLButtonElement) => void, gone = false) => {
    const b = menuItem(label, name, gone);
    b.addEventListener('click', () => then(b));
    return b;
  };
  /**
   * A name written in the deed's place, with Not now and the deed at its foot, as every ask has: the deed or Enter
   * makes it; Not now (or Escape) puts it back. A name it cannot be is said under it and keeps the keyboard in it,
   * to be put right there.
   */
  const field = (b: HTMLElement, label: string, value: string, deed: string, go: (name: string) => Promise<void>, asPath = false) => {
    const input = h('input', {class: 'line-in mono', placeholder: label, 'aria-label': label, autocapitalize: 'off', spellcheck: 'false'}) as HTMLInputElement;
    input.value = value;
    const error = h('p', {class: 'error small', role: 'alert'});
    const no = h('button', {type: 'button', class: 'button small-button'}, t('Cancel')) as HTMLButtonElement;
    const yes = h('button', {type: 'button', class: 'button small-button primary'}, deed) as HTMLButtonElement;
    const make = async () => {
      const v = input.value.trim();
      if (!v || input.disabled) return;
      error.textContent = '';
      if (asPath ? !plainPath(v.replace(/^\/+|\/+$/g, '')) : !plainPart(v)) {
        error.textContent = asPath ? t('Paths joined by "/", segments cannot start with "."') : t('Name cannot contain "/" or start with "."');
        input.focus();
        nudge(input);
        return;
      }
      input.disabled = yes.disabled = true;
      try { await go(v); } catch (err) { input.disabled = yes.disabled = false; error.textContent = errorText(err); input.focus(); nudge(input); }
    };
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      void make();
    });
    yes.addEventListener('click', () => void make());
    const box = h('div', {class: 'pop-field'}, input, error, answers(no, yes));
    no.addEventListener('click', () => { box.replaceWith(b); b.focus(); d.back(); });
    b.replaceWith(box);
    input.focus();
    // A new name is written over the old one's stem, its ending and the folders it is in kept.
    const from = value.lastIndexOf('/') + 1, dot = value.lastIndexOf('.');
    input.setSelectionRange(from, dot > from && !d.dir ? dot : value.length);
  };
  // A folder takes a new file or folder in it; a file, one beside it in its folder.
  const into = d.dir ? path : split(path)[0];
  const rows: HTMLElement[] = [];
  // A new file is made at once, named as nothing yet is there (untitled, with the ending of the file it is made beside;
  // a note's, beside none), and opened to write in: its name is written over in its own head when it has one.
  const error = h('p', {class: 'error small', role: 'alert'});
  const make = async (b: HTMLButtonElement) => {
    if (b.disabled) return;
    b.disabled = true;
    try {
      const names = new Set((await store.tree(repo, into).catch(() => [])).map((x) => x.name));
      const end = (!d.dir && /\.[^.]+$/.exec(d.name)?.[0]) || '.md';
      let n = `untitled${end}`;
      for (let i = 2; names.has(n); i++) n = `untitled-${i}${end}`;
      d.opening?.(into);
      await store.add(repo, into, n, '');
      await d.made(joined(into, n), true);
    } catch (err) { b.disabled = false; error.textContent = errorText(err); b.after(error); }
  };
  rows.push(entry(t('New file'), 'new-file', (b) => void make(b)));
  rows.push(entry(t('New folder'), 'new-folder', (b) => field(b, t('Folder name'), '', t('Create'), async (n) => {
    if (await there(repo, into, n)) throw taken(n);
    d.opening?.(into);
    await store.mkdir(repo, joined(into, n));
    await d.made(joined(into, n), false);
  })));
  if (path !== '') {
    // Its path in the repo, its name to be written over: a path written moves it (notes/plan.md), its folders made.
    rows.push(entry(t('Rename'), 'pen', (b) => field(b, t('New name'), path, t('Rename'), async (written) => d.move(await renaming(repo, path, written)), true)));
    rows.push(menuRule(), entry(t('Delete'), 'trash', (b) => {
      // Asked in its place: the deed on the side it was pressed, Not now on the other.
      const foot = askFoot(b, pop);
      const no = h('button', {type: 'button', class: 'button small-button'}, t('Cancel')) as HTMLButtonElement;
      const yes = h('button', {type: 'button', class: 'button small-button primary'}, t('Delete')) as HTMLButtonElement;
      const error = h('p', {class: 'error small', role: 'alert'});
      const ask = h('div', {class: 'pop-ask'},
        h('p', {class: 'muted small'}, d.dir ? t('Delete {name} and its contents', {name: d.name}) : t('Delete {name}', {name: d.name})),
        error, foot(no, yes));
      no.addEventListener('click', () => { ask.replaceWith(b); b.focus(); d.back(); });
      const shown = performance.now();
      yes.addEventListener('click', async () => {
        if (performance.now() - shown < SETTLE) return;
        yes.disabled = true;
        try {
          await store.remove(repo, path);
          await d.removed();
        } catch (err) { yes.disabled = false; error.textContent = errorText(err); }
      });
      b.replaceWith(ask);
      yes.focus();
    }, true));
  }
  pop.append(h('div', {class: 'pop-head muted small'}, d.name), ...rows);
  // ↑ ↓ go along its rows.
  pop.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...pop.querySelectorAll<HTMLElement>('.pop-item')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    event.preventDefault();
    event.stopPropagation();
    items[(i + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  });
  return pop;
}

/**
 * `pop` laid under `at`, its left edge on `at`'s (over it where there is no room under it), out over what is there so
 * nothing moves under the pointer; Escape, a press outside it, or `at` pressed again put it away, and the keyboard goes
 * back to `at`. `gone` is told as it goes. Returned: the way to put it away (a deed done).
 */
export function deedsUnder(at: HTMLElement, pop: HTMLElement, gone: () => void): () => void {
  pop.classList.add('deeds-under');
  document.body.append(pop);
  const r = at.getBoundingClientRect();
  pop.style.left = `${Math.max(16, Math.min(r.left, innerWidth - 16 - pop.offsetWidth))}px`;
  pop.style.top = `${r.bottom + 6}px`;
  const low = pop.getBoundingClientRect().bottom - (innerHeight - 16);
  if (low > 0) pop.style.top = `${Math.max(16, r.top - 6 - pop.offsetHeight)}px`;
  at.setAttribute('aria-expanded', 'true');
  let out = true;
  const away = () => {
    if (!out) return;
    out = false;
    document.removeEventListener('pointerdown', outside, true);
    at.setAttribute('aria-expanded', 'false');
    putAway(pop, () => pop.remove());
    gone();
  };
  const outside = (event: PointerEvent) => {
    const on = event.target as Node;
    if (pop.contains(on)) return;
    // Pressed again, it goes as the press's own (the button would bring it out again otherwise).
    if (at.contains(on)) event.preventDefault();
    away();
  };
  document.addEventListener('pointerdown', outside, true);
  pop.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    away();
    at.focus();
  });
  pop.querySelector<HTMLElement>('.pop-item')?.focus();
  return away;
}
