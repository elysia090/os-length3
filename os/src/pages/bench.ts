import {h} from '../dom.ts';
import {t} from '../i18n.ts';
import {complete, pathWord, Recall} from '../recall.ts';
import {onChange, store, type Entry} from '../repos.ts';
import {Reference} from './reference.ts';
import {sessionFor, sessionIfAny, terminalFor} from './terminal.ts';

// The workbench Forge and Git share: the page's own content in the large
// center (3/4) with a prompt box at its foot, and a narrow right pane (1/4)
// with the search box and a reference switched freely on top and the Prompt
// (the repo's sh) below. Using the prompt box sends the Prompt flying up
// over the center, just above the box, and the reference grows down into the
// room it leaves. Enter is a new line and Ctrl+Enter sends, as in every box
// one writes in. A Prompt that ended says so in its place, with Start again;
// sending to it starts it again too.
//
// What is written in the box belongs to the repo it was written for: each
// repo keeps its own while the app runs, so going to another page and back
// keeps it, and switching repos swaps it for that repo's (or an empty box).
// Until something is run in the repo's Prompt it holds only its prompt line,
// so the reference takes the side's room; from the first run on, the Prompt
// has its 3 parts. While one reads (the center turned by the wheel, a touch
// or the keys) and the box is empty and not written in, the box steps back
// and lets what is under it be pressed; the keyboard reaching it, a press on
// the Prompt, or the pointer coming down to the center's foot brings it back
// where it was. Something written in it keeps it out.
//
// ↑ on the box's first line and ↓ on its last walk the repo's earlier
// lines (the Prompt's runs), and a run pressed in Output is put back in the
// box to be changed or sent again. Tab completes the path before the caret
// from the repo's tree, and says the choices under the box when there are
// several; with no path to complete, Tab moves on as everywhere.

const MOVE = 280;
/** Choices said under the box after Tab, at most. */
const CHOICES = 24;

/** What was written in the prompt box for each repo and not sent. */
const drafts = new Map<string, string>();

/** Move `el` into `to`, animating from where it was (FLIP). */
function fly(el: HTMLElement, to: HTMLElement) {
  const from = el.getBoundingClientRect();
  to.append(el);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const at = el.getBoundingClientRect();
  if (!at.width || !from.width) return;
  el.animate([
    {transformOrigin: 'top left', transform: `translate(${from.left - at.left}px, ${from.top - at.top}px) scale(${from.width / at.width}, ${from.height / at.height})`},
    {transformOrigin: 'top left', transform: 'none'},
  ], {duration: MOVE, easing: 'cubic-bezier(.2, .9, .25, 1.06)'});
}

export interface Bench {
  element: HTMLElement;
  reference: Reference;
  /** The repo the prompt and the reference work on; null for none (the Prompt's place is then left empty). */
  setRepo(name: string | null): void;
  /** Back on screen after another page: the Prompt is home again unless its box still has the keyboard. */
  settle(): void;
}

export function bench(parts: {strip?: HTMLElement; main: HTMLElement; reveal(path: string, line?: number): void}): Bench {
  let repo: string | null = null;
  // Named for what one does there: type at the prompt of the repo's sh.
  const termTitle = h('div', {class: 'term-head'}, h('h2', {}, 'Prompt'));
  const termBox = h('section', {class: 'term-box', 'aria-label': 'Prompt'}, termTitle);
  const termHome = h('div', {class: 'term-home'}, termBox);
  const termSlot = h('div', {class: 'term-slot'});
  const prompt = h('textarea', {class: 'prompt-in', rows: '1', 'aria-label': t('Prompt box'), spellcheck: 'false', autocapitalize: 'off'}) as HTMLTextAreaElement;
  const note = h('p', {class: 'prompt-note muted small', role: 'status'});
  const dock = h('div', {class: 'dock'}, termSlot, h('form', {class: 'prompt'}, prompt), note);
  const center = h('div', {class: 'center'}, parts.main, dock);
  const reference = new Reference({reveal: parts.reveal, recall: (line) => {
    if (!repo || prompt.disabled) return;
    put(line);
    prompt.focus();
  }});
  const side = h('aside', {class: 'side', 'aria-label': t('Reference and Prompt')}, reference.element, termHome);
  const work = h('div', {class: parts.strip ? 'work' : 'work no-strip'}, ...(parts.strip ? [parts.strip] : []), center, side);

  /** The box stepped back while one reads. */
  const rest = (on: boolean) => {
    if (on && (prompting || prompt.value || note.textContent || document.activeElement === prompt)) return;
    dock.classList.toggle('resting', on);
  };
  const reading = () => rest(true);
  parts.main.addEventListener('wheel', reading, {passive: true});
  parts.main.addEventListener('touchmove', reading, {passive: true});
  parts.main.addEventListener('keydown', (event) => { if (['PageDown', 'PageUp', ' ', 'Home', 'End', 'ArrowDown', 'ArrowUp'].includes(event.key) && !(event.target as HTMLElement).closest('textarea, input')) reading(); });
  center.addEventListener('pointermove', (event) => {
    if (dock.classList.contains('resting') && event.clientY >= dock.getBoundingClientRect().top - 24) rest(false);
  });
  prompt.addEventListener('focus', () => rest(false));
  let prompting = false;
  const setPrompting = (on: boolean) => {
    if (on === prompting) return;
    prompting = on;
    work.classList.toggle('prompting', on);
    fly(termBox, on ? termSlot : termHome);
  };
  const fit = () => { prompt.style.height = 'auto'; prompt.style.height = `${prompt.scrollHeight}px`; };
  prompt.addEventListener('focus', () => setPrompting(true));
  const keep = () => { if (repo) { if (prompt.value) drafts.set(repo, prompt.value); else drafts.delete(repo); } };
  /** What Tab last said under the box, which goes as soon as anything else is done there. */
  let choices = false;
  const unsay = () => { if (choices) { choices = false; note.textContent = ''; note.classList.remove('paths'); } };
  /** `text` in the box as if written there, the caret at its end. */
  const put = (text: string) => {
    prompt.value = text;
    prompt.setSelectionRange(text.length, text.length);
    keep();
    unsay();
    fit();
  };
  prompt.addEventListener('input', () => {
    fit();
    keep();
    walk.reset();
    unsay();
    look();
  });
  /** The repo's earlier lines, oldest first. */
  const walk = new Recall();
  const lines = () => (repo ? sessionIfAny(repo)?.runs.map((r) => r.line) ?? [] : []);
  // The repo's directories as Tab reads them: read ahead as a path is
  // written (so Tab can answer at once), and again once anything changes.
  const listed = new Map<string, Entry[] | Promise<Entry[]>>();
  onChange((c) => { if (c.repo === repo) listed.clear(); });
  const list = (dir: string): Entry[] | Promise<Entry[]> => {
    const r = repo!, key = `${r}\n${dir}`;
    let got = listed.get(key);
    if (!got) {
      got = store.tree(r, dir).catch(() => [] as Entry[]);
      listed.set(key, got);
      void got.then((e) => { if (listed.get(key) instanceof Promise) listed.set(key, e); });
    }
    return got;
  };
  const look = () => {
    const w = repo && prompt.selectionStart === prompt.selectionEnd ? pathWord(prompt.value, prompt.selectionStart, repo) : null;
    if (w) void list(w.dir);
  };
  /** Complete the path before the caret; false when there is none to complete. */
  const tab = (): boolean => {
    if (!repo || prompt.selectionStart !== prompt.selectionEnd) return false;
    const at = prompt.selectionStart, w = pathWord(prompt.value, at, repo);
    if (!w) return false;
    const fill = (entries: Entry[]) => {
      const c = complete(w.name, entries);
      if (!c) return false;
      if (c.insert) {
        prompt.setRangeText(c.insert, at, at, 'end');
        keep();
        walk.reset();
        fit();
        look();
      }
      if (c.choices.length) {
        choices = true;
        note.classList.add('paths');
        note.textContent = c.choices.slice(0, CHOICES).join('  ') + (c.choices.length > CHOICES ? '  …' : '');
      }
      else unsay();
      return true;
    };
    const got = list(w.dir);
    if (!(got instanceof Promise)) return fill(got);
    // Not read yet (rare: it is read while the path is written): completed once it is.
    void got.then((entries) => { if (prompt.value.length >= at && prompt.selectionStart === at) fill(entries); });
    return true;
  };
  prompt.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') unsay();
    if (event.key === 'Escape') { setPrompting(false); prompt.blur(); return; }
    const plain = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && !event.isComposing;
    if (event.key === 'Tab' && plain) { if (tab()) event.preventDefault(); return; }
    // ↑ on the first line and ↓ on the last walk earlier lines; elsewhere they move the caret.
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && plain && prompt.selectionStart === prompt.selectionEnd) {
      const line = walk.arrow(event.key, prompt.value, prompt.selectionStart, lines());
      if (line === null) return;
      event.preventDefault();
      put(line);
      return;
    }
    // Ctrl-C with nothing selected (so not a copy) interrupts what runs, as in a terminal.
    if (event.key === 'c' && event.ctrlKey && !event.altKey && !event.metaKey && prompt.selectionStart === prompt.selectionEnd && repo) {
      event.preventDefault();
      sessionFor(repo).interrupt();
      return;
    }
    // Enter is a new line; Ctrl+Enter (⌘+Enter) sends.
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
    event.preventDefault();
    if (!repo) return;
    const s = sessionIfAny(repo);
    // Ended: started again, and what was written waits in the box to be sent once it is up.
    if (s?.ended) { s.restart(); note.textContent = t('Still starting'); return; }
    if (!sessionFor(repo).send(prompt.value)) { note.textContent = t('Still starting'); return; }
    unsay();
    note.textContent = '';
    prompt.value = '';
    drafts.delete(repo);
    walk.reset();
    room();
    fit();
  });
  // Leaving the prompt and the Prompt sends it home; losing the window's focus does not.
  dock.addEventListener('focusout', (event) => {
    const to = event.relatedTarget as Node | null;
    if (to && !dock.contains(to)) setPrompting(false);
  });
  termBox.addEventListener('pointerdown', (event) => {
    if (prompting || (event.target as HTMLElement).closest('button')) return;
    event.preventDefault();
    prompt.focus();
  });

  const setRepo = (name: string | null) => {
    if (name === repo && name) return;
    repo = name;
    reference.setRepo(name);
    termBox.replaceChildren(termTitle, ...(name ? [terminalFor(name)] : []));
    prompt.disabled = !name;
    prompt.placeholder = name ? t('Run in {name}', {name}) : t('Open a repo to run in it');
    prompt.value = name ? drafts.get(name) ?? '' : '';
    unsay();
    note.textContent = '';
    walk.reset();
    room();
    requestAnimationFrame(fit);
  };
  /** Whether the repo's Prompt has run anything yet, which is what gives it room. */
  const room = () => work.classList.toggle('unrun', !!repo && !sessionIfAny(repo)?.runs.length);
  setRepo(null);
  // A page taken off the screen loses its focus without a focusout, so the Prompt may still be up.
  const settle = () => {
    room();
    reference.resume();
    if (!prompting || dock.contains(document.activeElement)) return;
    prompting = false;
    work.classList.remove('prompting');
    termHome.append(termBox);
  };
  return {element: work, reference, setRepo, settle};
}
