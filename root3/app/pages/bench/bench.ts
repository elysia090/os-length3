import {agentCards} from '../kit/agent-cards.ts';
import {h} from '../../ui/dom.ts';
import {t} from '../../i18n/i18n.ts';
import {mark, paneMark} from '../../ui/icons.ts';
import type {MarkName} from '../../ui/icons.ts';
import {Box} from './box.ts';
import {Pane, paneWord, pluginArea} from '../kit/pane.ts';
import type {Writing} from '../kit/context.ts';
import {Reference} from './reference.ts';
import {Screen, type Rises} from './screen.ts';
import {sessionIfAny} from './sessions.ts';
import {sessionFor} from './terminal.ts';
import {Rows} from './rows.ts';
import type {Run} from './sessions.ts';

// The workbench Forge and Git share, put together from its parts: the page's own content in the large center (3/4)
// and the narrow right pane (1/4, pane.ts) with the plugin area at its top, what the center refers to (reference.ts,
// under the search box that sits over the pane, the three it shows said at rest over the rows), and what was done in
// the repo, a big row each (rows.ts), at its foot a conversation's word. On Forge's desk the Prompt is a box of its own
// with the line one types at under it; on Git the box stands at the center's foot (box.ts) and becomes the Prompt's
// screen over the center while it is in use (screen.ts), out of sight otherwise. The center's top line holds the band
// (Forge's), the search box in its middle, and at its right end the switch that puts the right pane away and brings
// it back.

export interface Bench {
  element: HTMLElement;
  reference: Reference;
  /** The repo the prompt and the reference work on; null for none (the Prompt's place is then left empty). */
  setRepo(name: string | null): void;
  /** Back on screen after another page: the Prompt is home again unless its box still has the keyboard. */
  settle(): void;
  /** On a desk (Forge's): the Prompt standing at the center's foot: what it printed and, under it, the line one types
   * at, its pill saying what that line does (Run, TODO). Null on any other bench. */
  terminal: HTMLElement | null;
  /** The Prompt's line taken to run, the keyboard in it (an ended Prompt started again): the band's >_, Ctrl+`. */
  toPrompt(): void;
  /** On a desk: the band's tools on the top line (>_, the search), the page's own put among them; null elsewhere. */
  tools: HTMLElement | null;
}

let benches = 0;
/** How long an ended Prompt stays up on a desk, its end read, before it goes back to its line. */
const TERM_GOES_MS = 900;

/** Whether `el` is laid out on the page (not in a page put away, nor out of the document). */
const onScreen = (el: HTMLElement) => el.isConnected && el.getClientRects().length > 0;

/** Each repo's rows, one for every bench: the pane on screen holds them (only one bench is on screen at a time). */
const repoRows = new Map<string, Rows>();
function rowsOf(repo: string): Rows {
  let r = repoRows.get(repo);
  if (!r) repoRows.set(repo, r = new Rows(t('Prompt'), sessionFor(repo)));
  return r;
}

/** A letter typed with no Ctrl, Alt or ⌘ (a space is a button's), or the start of a conversion. */
const letter = (e: KeyboardEvent) =>
  !e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 && e.key !== ' ' || e.key === 'Process');

/**
 * Typed with the keyboard on nothing to write in (the rail just pressed to come here, the box let go of with
 * Escape): the letters go into the box, where things here are written, never into nothing. A space or Enter on a
 * button is that button's; a field, a menu, a card or File out keep theirs.
 */
/** Whether the keyboard is in something written in (a field, a box of lines, a text made editable). */
function writing(): boolean {
  const at = document.activeElement as HTMLElement | null;
  return !!at && (at.isContentEditable || at.matches('input, textarea, select'));
}

function intoBox(box: Box) {
  const writes = writing();
  // Something out over the page says so on what brought it out (its ⌄, the person's face, File): open, it is that one's.
  const over = document.querySelector('[aria-expanded="true"]:not(.pane-toggle), .look, .tree.open');
  if (!writes && !over && !box.prompt.disabled) box.prompt.focus();
}

/**
 * The keys an editor's hands already know, wherever this bench is on screen (Ctrl, or ⌘ on a Mac, held with them):
 * K or P (or Shift+F) to the search (`onBand`: it lies on the band, not the pane), ` to the prompt box, G to the box editing the file in front, B to put the right pane away or bring it back.
 */
function editorKey(event: KeyboardEvent, box: Box, pane: Pane, reference: Reference, onBand: boolean) {
  const k = event.key.toLowerCase();
  if ((k === 'k' || k === 'p') && !event.shiftKey || (k === 'f' && event.shiftKey)) {
    event.preventDefault();
    // The search on the band is there with the pane away; the pane's is brought out with it.
    if (onBand || pane.shown || pane.narrow) reference.findNow(); else { pane.set(true); requestAnimationFrame(() => reference.findNow()); }
    return;
  }
  if (event.key === '`' && box.summon()) { event.preventDefault(); return; }
  if (k === 'g' && !event.shiftKey && box.edit()) { event.preventDefault(); return; }
  if (k === 'b' && !event.shiftKey) { event.preventDefault(); pane.set(!pane.shown); }
}

/**
 * The run a line pressed in the pane stands for (its prompt line's pill, or its words): of the runs of those words,
 * the one as many from the last as there are lines of the same words run after it, the screen and the runs both
 * keeping the last ones in the order they ran. None when the runs kept no longer go back that far.
 */
function runPressed(line: HTMLElement, runs: readonly Run[]): Run | undefined {
  const cmd = line.classList.contains('cmd') ? line : line.nextElementSibling?.classList.contains('cmd') ? line.nextElementSibling : null;
  if (!cmd) return undefined;
  const words = (cmd.textContent ?? '').trimEnd();
  let after = 0;
  for (let n = cmd.nextElementSibling; n; n = n.nextElementSibling) if (n.classList.contains('cmd') && (n.textContent ?? '').trimEnd() === words) after++;
  return runs.filter((r) => r.line === words).at(-1 - after);
}

/** The Prompt's own box, its head, and where it is kept while it is not up (out of sight: the pane has its rows). */
function promptBox() {
  // Named for what one does there: type at the prompt of the repo's sh. Up as a screen, a lamp at its head is lit
  // while its shell runs (styles.css).
  // Up, its × puts it back as Escape does (box.ts), the way down it came up.
  const termHead = h('div', {class: 'term-head'}, h('h2', {}, 'Prompt'), h('span', {class: 'lamp', 'aria-hidden': 'true'}),
    h('button', {type: 'button', class: 'term-shut', tabindex: '-1', 'aria-label': t('Close Prompt'), 'aria-keyshortcuts': 'Escape'}, mark('close')));
  const term = h('section', {class: 'term-box', 'aria-label': 'Prompt'}, termHead);
  const termHome = h('div', {class: 'term-home'}, term);
  return {termHead, term, termHome};
}

/**
 * The Prompt standing at a desk's foot (`terminal`: what it printed, the box's line): up, all of it; at rest, the
 * line alone. It stands in the center's own flow under the desk, on plain ground as the band over the desk is: the
 * desk ends above it, so nothing of the desk passes under it. It goes up as the box asks (its line taken to run, a
 * line run) and stays till it is put away; `told` hears whether it is up, each time that changes.
 */
function standOf(terminal: HTMLElement, box: Box, told: (up: boolean) => void): Rises {
  const stand: Rises = {
    get up() { return terminal.classList.contains('up'); },
    raise() { if (!this.up) { terminal.classList.add('up'); box.screenChanged('up'); told(true); } },
    lower() { if (this.up) { terminal.classList.remove('up'); box.screenChanged('leaving'); told(false); } },
  };
  box.screen = stand;
  // Pressed anywhere on what it printed (not on something to press there, nor ending a selection): the keyboard in
  // its line, as a terminal pressed takes it. (What had the keyboard as the press began is where it goes back to: the
  // press itself takes it from there before the line has it.)
  let from: HTMLElement | null = null;
  terminal.addEventListener('pointerdown', () => {
    const had = document.activeElement as HTMLElement | null;
    from = had && had !== document.body && !terminal.contains(had) ? had : null;
  }, true);
  terminal.addEventListener('click', (event) => {
    const on = event.target as Element;
    if (box.dock.contains(on) || on.closest('button, a') || getSelection()?.toString() || box.prompt.disabled) return;
    box.take(from);
  });
  return stand;
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
 * On a desk, what the band's search finds is a sheet dropped under the band across the center (styles: forge-band.css):
 * measured, it knows the center's width and where the search box stands in it (the words searched for at its head are
 * the search's own: reference.ts).
 */
function dropSheet(work: HTMLElement, center: HTMLElement, search: HTMLElement) {
  new ResizeObserver(() => {
    work.style.setProperty('--center-w', `${center.clientWidth}px`);
    work.style.setProperty('--center-h', `${center.clientHeight}px`);
    work.style.setProperty('--search-x', `${search.getBoundingClientRect().left - center.getBoundingClientRect().left}px`);
  }).observe(center);
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

/**
 * A run pressed in the pane, read where it was run: the Prompt's box in hand (`terminal`), its line lit there a moment
 * and brought into view with what it printed.
 */
function litRun(terminal: HTMLElement | null, run: Run) {
  if (!terminal) return;
  terminal.querySelector<HTMLTextAreaElement>('.prompt-in')?.focus({preventScroll: true});
  const lines = [...terminal.querySelectorAll<HTMLElement>('.term-out .cmd')].filter((c) => c.textContent?.trim().endsWith(run.line.trim()));
  const at = lines.at(-1);
  if (!at) return;
  at.scrollIntoView({block: 'center'});
  at.classList.add('lit');
  setTimeout(() => at.classList.remove('lit'), 1400);
}

/** A bench put together round `main`, a page's content (Forge's, Git's): its box, the Prompt, the right pane, the keys. */
/** A square tool on the band: its mark, its name said and shown on a rest. */
function toolButton(name: MarkName, label: string, press: () => void): HTMLButtonElement {
  const b = h('button', {type: 'button', class: 'band-tool', 'aria-label': label, title: label}, mark(name)) as HTMLButtonElement;
  b.addEventListener('click', press);
  return b;
}

export function bench(parts: {strip?: HTMLElement; main: HTMLElement; reveal(path: string, line?: number, write?: Writing): void;
  /** A conversation's word in the pane pressed: open it in Inbox. */
  word?(address: string): void;
  /** A line of the box's own in the Prompt pressed: the issue it wrote (its file, in `repo`), or Home's TODO. */
  went(repo: string, to: {issue: string} | {file: string} | 'todo'): void;
  /** A page read and pressed rather than written in (Git): its box at the foot stands back until it is asked for
   * (Ctrl+`, the pointer resting at the foot), and back again once the Prompt is done with, never over a button. */
  back?: boolean;
  /** A desk (Forge's): the box at the center's foot is the Prompt's own last line, and what the Prompt printed
   * stands on it while it is up (`terminal`: one box, a line tall at rest), over the desk's foot. */
  desk?: boolean;
  /** On a desk: a file's box laid without taking the person's hand; the camera over these boxes (none: the one in hand). */
  place?(path: string): boolean;
  frame?(keys: string[]): void;
  /** On a desk: the Agent's own terminal laid as a box of `repo`'s desk. */
  besideTerm?(repo: string, element: HTMLElement): void}): Bench {
  const {termHead, term, termHome} = promptBox();
  const center = h('div', {class: 'center'}, parts.main);
  const sideId = `side-${++benches}`;
  // The pane is what was done in the repo, a big row each (rows.ts): a run pressed is read where it was run (the
  // Prompt's box, on a desk), or under the search box with all it printed (the Prompt being up only while in use).
  const openRun = (run: Run) => { if (terminal) { stand?.raise(); litRun(terminal, run); } else reference.showRun(run); };
  const none = h('div', {class: 'pane-rows'});
  // The pane's room: the reference's heads (Issue, diff, Output, Agent) over the rows.
  const room = h('div', {class: 'pane-room'}, none);
  /** The repo whose rows this pane holds. */
  let rowsOfRepo: string | null = null;
  /** The rows of `name` (none: nothing) in this pane, taken from another page's if they were there. */
  const showRows = (name: string | null) => {
    rowsOfRepo = name;
    const r = name ? rowsOf(name) : null;
    if (r) r.open = openRun;
    const next = r?.element ?? none;
    if (next.parentElement === room) return;
    // Never taken from the pane on screen by a page out of sight (one drawing itself late, after it was left).
    if (r && onScreen(r.element) && !onScreen(work)) return;
    room.querySelector(':scope > .pane-rows')?.remove();
    room.append(next);
    r?.shown();
  };
  const side = h('aside', {class: 'side', id: sideId, 'aria-label': t('Plugins and Prompt')}, pluginArea(), room, agentCards((repo, issue) => parts.went(repo, {issue: issue.replace(/^issue\//, '')})), ...(parts.word ? [paneWord(parts.word)] : []));
  const toggle = h('button', {type: 'button', class: 'pane-toggle', 'aria-label': t('Right pane'), 'aria-controls': sideId}, paneMark()) as HTMLButtonElement;
  const work = h('div', {class: `${parts.strip ? 'work bench' : 'work bench no-strip'}${parts.desk ? ' desk-bench' : ''}`});

  const box = new Box({work, main: parts.main, center, term, termHead, back: !!parts.back, went: parts.went, reveal: (path, line) => parts.reveal(path, line), desk: !!parts.desk,
    flow: (repo: string) => rowsOf(repo),
    ...(parts.place ? {place: parts.place} : {}), ...(parts.frame ? {frame: parts.frame} : {}), ...(parts.besideTerm ? {besideTerm: parts.besideTerm} : {})});
  // On a desk the Prompt stands at the center's foot, one box: the line one types at, and over it, while it is up,
  // what it printed. The band's >_ says whether it is up, and puts it up or away.
  const terminal = parts.desk ? h('section', {class: 'desk-term stand'}, term, box.dock) : null;
  const termTool = toolButton('term', t('Terminal'), () => { if (stand?.up) box.putAway(); else toPrompt(); });
  termTool.setAttribute('aria-pressed', 'false');
  // (Pressed with the pointer, the keyboard stays where it is till the Prompt has it: put away, it goes back there.)
  termTool.addEventListener('pointerdown', (event) => event.preventDefault());
  const stand = terminal ? standOf(terminal, box, (up) => termTool.setAttribute('aria-pressed', String(up))) : null;
  const shown = parts.desk ? null : screenOf(work, box, term, termHome);
  if (shown) center.append(box.dock); else { box.dock.prepend(box.form); center.append(terminal!); }
  // On a desk the box lies on a moving plane: what opens out of its pill (fixed to the window) lies on the page instead.
  if (!shown) for (const pop of box.dock.querySelectorAll<HTMLElement>(':scope > .box-modes')) work.append(pop);
  const screen = shown?.screen ?? null;
  const toPrompt = () => {
    if (!box.repo) return;
    const s = sessionIfAny(box.repo);
    if (s?.ended) s.restart();
    box.summon();
  };
  // Exited or stopped (not failed: that is read where it is), the Prompt goes back to its line after a moment, as a
  // terminal's window closes; its line taken again starts one.
  terminal?.addEventListener('term-gone', () => {
    setTimeout(() => { if (box.repo && sessionIfAny(box.repo)?.ended) stand?.lower(); }, TERM_GOES_MS);
  });
  const reference = new Reference({reveal: parts.reveal, recall: (line) => box.recall(line)}, {keeps: true, band: !!parts.desk});
  // A line run, pressed in the Prompt's box on a desk: read under the search box, with all it printed, as from Output.
  // Taken as the press begins, before the box takes it as a press to put the keyboard in it.
  terminal?.addEventListener('pointerdown', (event) => {
    const line = (event.target as Element).closest<HTMLElement>('.term-out > :is(.cmd, .ps:not(.waits))');
    const run = box.repo && line ? runPressed(line, sessionIfAny(box.repo)?.runs ?? []) : undefined;
    if (!run) return;
    event.preventDefault();
    event.stopPropagation();
    reference.showRun(run);
  }, true);
  box.onFollow = () => reference.runsAgain();
  // At rest the pane says what else the search shows, over its rows; on a desk the pane is the runs alone, and what
  // else there is to see is the search's, on the band.
  if (!parts.desk) room.prepend(reference.heads);
  // On a desk the band's tools come first on the top line: >_ for the Prompt at the desk's foot, the file deeds (the page's
  // band puts its own between), the search; the pane's switch lies at the foot, level with the person at the rail's.
  const tools = parts.desk ? h('div', {class: 'band-tools', role: 'group', 'aria-label': t('Tools')}, termTool, reference.search) : null;
  // The band's search box says what it is by a lens at its left, as a short box must; what it finds drops as a sheet
  // under the band, over the desk, the words searched for heading it (dropSheet).
  if (tools) { reference.search.querySelector('form')?.prepend(mark('search')); dropSheet(work, center, reference.search); }
  const bar = tools ? h('div', {class: 'bar'}, tools, parts.strip ?? h('span', {class: 'bar-room'}))
    : h('div', {class: 'bar'}, parts.strip ?? h('span', {class: 'bar-room'}), reference.search, toggle);
  work.append(bar, center, side, ...(tools ? [toggle] : []));
  const pane = new Pane(work, side, toggle);
  if (shown) measured(work, side, shown.element, box, reference);
  requestAnimationFrame(() => { work.dataset.shown = '1'; });

  document.addEventListener('keydown', (event) => {
    // Only while this bench is on screen, and the page is not held under something over it; never a key a terminal's
    // program reads as it comes (data-raw: every key is its, as at a terminal).
    if (!work.isConnected || work.closest('[hidden]') || document.getElementById('page')?.hasAttribute('inert')) return;
    if ((event.target as Element | null)?.closest?.('[data-raw]')) return;
    // On a desk, / on nothing to write in goes to the search on the band, as a page's / does.
    if (tools && event.key === '/' && letter(event) && !writing()) { event.preventDefault(); reference.findNow(); }
    else if (letter(event)) intoBox(box);
    else if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.isComposing) editorKey(event, box, pane, reference, !!tools);
  });

  // Come on screen (its page come to, the pan to it begun), the pane takes its rows back from the page left.
  new ResizeObserver(() => { if (onScreen(room)) showRows(rowsOfRepo); }).observe(room);
  const setRepo = (name: string | null) => {
    showRows(name);
    if (name === box.repo && name) { box.attach(); return; }
    reference.setRepo(name);
    box.setRepo(name);
  };
  setRepo(null);
  // A page taken off the screen loses its focus without a focusout, so the Prompt may still be up.
  const settle = () => {
    showRows(rowsOfRepo ?? box.repo);
    box.attach();
    box.room();
    reference.resume();
    if (screen && screen.state !== 'rest' && !box.dock.contains(document.activeElement)) screen.drop();
  };
  return {element: work, reference, setRepo, settle, terminal, tools, toPrompt};
}
