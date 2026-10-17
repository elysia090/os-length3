import {h} from '../dom.ts';
import {t} from '../i18n.ts';
import {Reference} from './reference.ts';
import {sessionFor, sessionIfAny, terminalFor} from './terminal.ts';

// The workbench Forge and Git share: the page's own content in the large
// center (3/4) with a prompt box at its foot, and a narrow right pane (1/4)
// with the search box and a reference switched freely on top and the Prompt
// (the repo's sh) below. Using the prompt box sends the Prompt flying up
// over the center, just above the box, and the reference grows down into the
// room it leaves. The Prompt's own head holds its switch, the same as a
// repo's on the Remote page: on and off.

const MOVE = 280;

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
  /** The repo the prompt and the reference work on; null for none, with what to say instead. */
  setRepo(name: string | null, none?: string): void;
}

export function bench(parts: {strip?: HTMLElement; main: HTMLElement; reveal(path: string, line?: number): void}): Bench {
  let repo: string | null = null;
  // Named for what one does there: type at the prompt of the repo's sh.
  const power = h('button', {type: 'button', class: 'power plain', role: 'switch', 'aria-checked': 'false'}, h('span', {class: 'knob'})) as HTMLButtonElement;
  const termTitle = h('div', {class: 'term-head'}, h('h2', {}, 'Prompt'), power);
  const termBox = h('section', {class: 'term-box', 'aria-label': 'Prompt'}, termTitle);
  const termHome = h('div', {class: 'term-home'}, termBox);
  const termSlot = h('div', {class: 'term-slot'});
  const prompt = h('textarea', {class: 'prompt-in', rows: '1', 'aria-label': t('Prompt box'), spellcheck: 'false', autocapitalize: 'off'}) as HTMLTextAreaElement;
  const note = h('p', {class: 'prompt-note muted small', role: 'status'});
  const dock = h('div', {class: 'dock'}, termSlot, h('form', {class: 'prompt'}, prompt), note);
  const center = h('div', {class: 'center'}, parts.main, dock);
  const reference = new Reference({reveal: parts.reveal});
  const side = h('aside', {class: 'side', 'aria-label': t('Reference and Prompt')}, reference.element, termHome);
  const work = h('div', {class: parts.strip ? 'work' : 'work no-strip'}, ...(parts.strip ? [parts.strip] : []), center, side);

  let prompting = false;
  const setPrompting = (on: boolean) => {
    if (on === prompting) return;
    prompting = on;
    work.classList.toggle('prompting', on);
    fly(termBox, on ? termSlot : termHome);
  };
  const fit = () => { prompt.style.height = 'auto'; prompt.style.height = `${prompt.scrollHeight}px`; };
  prompt.addEventListener('focus', () => setPrompting(true));
  prompt.addEventListener('input', fit);
  prompt.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { setPrompting(false); prompt.blur(); return; }
    // Ctrl-C with nothing selected (so not a copy) interrupts what runs, as in a terminal.
    if (event.key === 'c' && event.ctrlKey && !event.altKey && !event.metaKey && prompt.selectionStart === prompt.selectionEnd && repo) {
      event.preventDefault();
      sessionFor(repo).interrupt();
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (!repo) return;
    if (!sessionFor(repo).send(prompt.value)) { note.textContent = t('Still starting'); return; }
    note.textContent = '';
    prompt.value = '';
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

  // The switch: on while the repo's shell runs (or starts); off stops it, on starts a new one here.
  let unwatch: (() => void) | null = null;
  const paintPower = () => {
    const s = repo ? sessionIfAny(repo) : undefined;
    const on = Boolean(s && !s.ended);
    power.hidden = !repo;
    power.setAttribute('aria-checked', String(on));
    const label = on ? t('Turn the Prompt off') : t('Turn the Prompt on');
    power.setAttribute('aria-label', label);
    power.title = label;
  };
  const follow = () => {
    unwatch?.();
    unwatch = repo ? sessionIfAny(repo)?.watch(paintPower) ?? null : null;
    paintPower();
  };
  power.addEventListener('click', () => {
    if (!repo) return;
    const s = sessionIfAny(repo);
    if (s && !s.ended) s.stop();
    else {
      if (s) s.restart();
      const el = terminalFor(repo);
      if (!termBox.contains(el)) termBox.replaceChildren(termTitle, el);
    }
    follow();
  });

  const setRepo = (name: string | null, none = t('Runs once a repo is open')) => {
    if (name === repo && name) return;
    repo = name;
    reference.setRepo(name);
    termBox.replaceChildren(termTitle, name ? terminalFor(name) : h('div', {class: 'empty'}, none));
    follow();
    prompt.disabled = !name;
    prompt.placeholder = name ? t('Run in {name}', {name}) : '';
  };
  setRepo(null);
  return {element: work, reference, setRepo};
}
