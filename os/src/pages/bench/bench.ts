import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {mark, paneMark} from '../../ui/icons.ts';
import {Box} from './box.ts';
import {Pane, paneWord, pluginArea} from '../pane.ts';
import type {Writing} from '../forge/reader.ts';
import {Reference} from '../forge/reference.ts';
import {Screen} from './screen.ts';

// The workbench Forge and Git share, put together from its parts: the page's own content in the large center (3/4)
// with the box at its foot (box.ts), which becomes the Prompt's screen over the center while the Prompt is in use
// (screen.ts); and the narrow right pane (1/4, pane.ts) with the plugin area at its top, what the center refers to
// (reference.ts, under the search box that sits over the pane), the Prompt (the repo's sh) under it, and at its foot
// a conversation's word. The center's top line holds the band (Forge's), the search box in its middle, and at its
// right end the switch that puts the right pane away and brings it back. Until something is run in the repo's
// Prompt it holds only its prompt line, so the reference takes the pane's room; from the first run on, the Prompt
// has its 3 parts.

export interface Bench {
  element: HTMLElement;
  reference: Reference;
  /** The repo the prompt and the reference work on; null for none (the Prompt's place is then left empty). */
  setRepo(name: string | null): void;
  /** Back on screen after another page: the Prompt is home again unless its box still has the keyboard. */
  settle(): void;
}

let benches = 0;

/** A letter typed with no Ctrl, Alt or ⌘ (a space is a button's), or the start of a conversion. */
const letter = (e: KeyboardEvent) =>
  !e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 && e.key !== ' ' || e.key === 'Process');

/**
 * Typed with the keyboard on nothing to write in (the rail just pressed to come here, the box let go of with
 * Escape): the letters go into the box, where things here are written, never into nothing. A space or Enter on a
 * button is that button's; a field, a menu, a card or File out keep theirs.
 */
function intoBox(box: Box) {
  const at = document.activeElement as HTMLElement | null;
  const writes = !!at && (at.isContentEditable || at.matches('input, textarea, select'));
  // Something out over the page says so on what brought it out (its ⌄, the person's face, File): open, it is that one's.
  const over = document.querySelector('[aria-expanded="true"]:not(.pane-toggle), .look, .tree.open');
  if (!writes && !over && !box.prompt.disabled) box.prompt.focus();
}

/**
 * The keys an editor's hands already know, wherever this bench is on screen (Ctrl, or ⌘ on a Mac, held with them):
 * K or P (or Shift+F) to the search, ` to the prompt box, G to the box editing the file in front (Go to line, as
 * editors have it), B to put the right pane away or bring it back.
 */
function editorKey(event: KeyboardEvent, box: Box, pane: Pane, reference: Reference) {
  const k = event.key.toLowerCase();
  if ((k === 'k' || k === 'p') && !event.shiftKey || (k === 'f' && event.shiftKey)) {
    event.preventDefault();
    if (pane.shown || pane.narrow) reference.findNow(); else { pane.set(true); requestAnimationFrame(() => reference.findNow()); }
    return;
  }
  if (event.key === '`' && box.summon()) { event.preventDefault(); return; }
  if (k === 'g' && !event.shiftKey && box.edit()) { event.preventDefault(); return; }
  if (k === 'b' && !event.shiftKey) { event.preventDefault(); pane.set(!pane.shown); }
}

/** The Prompt's own box, its head and where it lives in the pane (where the repo's terminal stands, up or at rest). */
function promptBox() {
  // Named for what one does there: type at the prompt of the repo's sh. Up as a screen, a lamp at its head is lit
  // while its shell runs (styles.css).
  // Up, its × puts it back as Escape does (box.ts), the way down it came up.
  const termHead = h('div', {class: 'term-head'}, h('h2', {}, 'Prompt'), h('span', {class: 'lamp', 'aria-hidden': 'true'}),
    h('button', {type: 'button', class: 'term-shut', tabindex: '-1', 'aria-label': t('Put the Prompt back'), 'aria-keyshortcuts': 'Escape'}, mark('close')));
  const term = h('section', {class: 'term-box', 'aria-label': 'Prompt'}, termHead);
  const termHome = h('div', {class: 'term-home'}, term);
  return {termHead, term, termHome};
}

/** The screen the box becomes while the Prompt is up (screen.ts), at the top of its dock: `term` comes up into it
 * from `home`. */
function screenOf(work: HTMLElement, box: Box, term: HTMLElement, home: HTMLElement): {screen: Screen; element: HTMLElement} {
  // The screen's glass, a layer of its own under its words (styles.css): what runs out of the pill and rises.
  const glass = h('span', {class: 'glass', 'aria-hidden': 'true'});
  const slot = h('div', {class: 'term-slot'});
  const element = h('div', {class: 'screen'}, glass, slot, box.form);
  box.dock.prepend(element);
  const screen = new Screen({work, screen: element, glass, slot, term, home, form: box.form, chip: box.chip, line: box.line,
    changed: (state) => box.screenChanged(state)});
  box.screen = screen;
  return {screen, element};
}

/**
 * Measured, not queried (a box queried for its width would make a layer the search could not rise out of): the
 * bench's width, for what is laid out from it (the pane's W, which the search box and what opens under it take);
 * the search's room above the box, so the Prompt brought up over the center is never under it (issue #20); the
 * pane's Prompt level with the foot of the rail's Inbox, one line across the page; Run's width, for the line.
 */
function measured(work: HTMLElement, side: HTMLElement, screen: HTMLElement, box: Box, reference: Reference) {
  const roomy = new ResizeObserver(() => {
    work.style.setProperty('--bench-w', `${work.clientWidth}px`);
    work.style.setProperty('--search-room', `${Math.max(0, box.dock.getBoundingClientRect().top - reference.search.getBoundingClientRect().bottom - 8)}px`);
    const inbox = document.getElementById('purpose-inbox');
    const at = inbox && side.isConnected ? inbox.getBoundingClientRect().bottom - side.getBoundingClientRect().top : 0;
    if (at > 0) side.style.setProperty('--prompt-at', `${at}px`);
    screen.style.setProperty('--run-w', `${box.runIt.offsetWidth}px`);
  });
  roomy.observe(box.dock);
  roomy.observe(work);
}

/** A bench put together round `main`, a page's content (Forge's, Git's): its box, the Prompt, the right pane, the keys. */
export function bench(parts: {strip?: HTMLElement; main: HTMLElement; reveal(path: string, line?: number, write?: Writing): void;
  /** A conversation's word in the pane pressed: open it in Inbox. */
  word?(address: string): void;
  /** A line of the box's own in the Prompt pressed: the issue it wrote (its file, in `repo`), or Home's TODO. */
  went(repo: string, to: {issue: string} | 'todo'): void;
  /** A page read and pressed rather than written in (Git): its box at the foot stands back until it is asked for
   * (Ctrl+`, the pointer resting at the foot), and back again once the Prompt is done with, never over a button. */
  back?: boolean}): Bench {
  const {termHead, term, termHome} = promptBox();
  const center = h('div', {class: 'center'}, parts.main);
  const sideId = `side-${++benches}`;
  const side = h('aside', {class: 'side', id: sideId, 'aria-label': t('Plugins and Prompt')}, pluginArea(), termHome, ...(parts.word ? [paneWord(parts.word)] : []));
  const toggle = h('button', {type: 'button', class: 'pane-toggle', 'aria-label': t('Right pane'), 'aria-controls': sideId}, paneMark()) as HTMLButtonElement;
  const work = h('div', {class: parts.strip ? 'work bench' : 'work bench no-strip'});

  const box = new Box({work, main: parts.main, center, term, termHead, back: !!parts.back, went: parts.went, reveal: parts.reveal});
  const {screen, element: screenEl} = screenOf(work, box, term, termHome);
  center.append(box.dock);

  const reference = new Reference({reveal: parts.reveal, recall: (line) => box.recall(line)});
  box.onFollow = () => reference.runsAgain();
  const bar = h('div', {class: 'bar'}, parts.strip ?? h('span', {class: 'bar-room'}), reference.search, toggle);
  work.append(bar, center, side);
  const pane = new Pane(work, side, toggle);
  measured(work, side, screenEl, box, reference);
  requestAnimationFrame(() => { work.dataset.shown = '1'; });

  document.addEventListener('keydown', (event) => {
    // Only while this bench is on screen, and the page is not held under something over it.
    if (!work.isConnected || work.closest('[hidden]') || document.getElementById('page')?.hasAttribute('inert')) return;
    if (letter(event)) intoBox(box);
    else if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.isComposing) editorKey(event, box, pane, reference);
  });

  const setRepo = (name: string | null) => {
    if (name === box.repo && name) { box.attach(); return; }
    reference.setRepo(name);
    box.setRepo(name);
  };
  setRepo(null);
  // A page taken off the screen loses its focus without a focusout, so the Prompt may still be up.
  const settle = () => {
    box.attach();
    box.room();
    reference.resume();
    if (screen.state !== 'rest' && !box.dock.contains(document.activeElement)) screen.drop();
  };
  return {element: work, reference, setRepo, settle};
}
