import {fieldMoved} from '../../ui/caret.ts';
import {h} from '../../ui/dom.ts';
import {errorText} from '../../host/errors.ts';
import {keepOut, LAND, nudge, paced, putAway, still} from '../../ui/glide.ts';
import {t} from '../../i18n/i18n.ts';
import {complete, pathWord, Recall} from '../../prompt/recall.ts';
import {kindOf} from '../../repos/text.ts';
import {onChange, onRenamed, shownTree, store, type Entry} from '../../repos/repos.ts';
import {boxMode, modeHint, modeMenu, modesNow, nextIssue, onBoxMode, pillWords, sendAs, sendInto, sendTitle, sendWord, setBoxMode, turn, type Mode} from './box-modes.ts';
import type {Rises, ScreenState} from './screen.ts';
import {agentSessionFor, Session, sessionFor, terminalFor} from './terminal.ts';
import {type AgentTerm, agentTermFor} from './agent-term.ts';
import {sessionIfAny} from './sessions.ts';
import {PillLine} from './pill-line.ts';
import {EditLine} from './edit-box.ts';
import {agentKey, agentUse} from '../../account/agent-key.ts';
import {setRightPane} from '../kit/pane.ts';
import {atWork, told, type Flow} from './agent.ts';
import {Player, type Stage} from './play.ts';
import type {Hands} from '../../agent/loop.ts';
import {fileHands, tail} from '../../repos/agent-hands.ts';
import {work as workOf} from '../../repos/history.ts';
import {SPRING} from '../../ui/law.ts';

// The box at the foot of a work page's center (docs/PLACES.md, Forge, The box at the foot): one field, and at its left a
// pill that says what it does: Run in the repo's Prompt (the pill the prompt line the shell waits at, pill-line.ts),
// Write an issue, Add to TODO (box-modes.ts), Edit the file in front (edit-box.ts), and with an API key kept on this
// device, Ask the Agent (agent.ts), which never brings the Prompt up: its answer comes into the right pane, under the
// question, among what was run. Enter is a new line and Ctrl+Enter
// sends, as in every box one writes in, the keys said on caps beside the box's button while it is written in; Edit's
// lines are one line each, done with Enter. Escape gives the keyboard back to what had it before the box.
//
// What is written in it belongs to the repo and to what the box does: each keeps its own while the app runs, so going
// to another page and back keeps it, and switching repos swaps it for that repo's (or an empty box). Running, ↑ on the
// first line and ↓ on the last walk the repo's earlier lines, a run pressed in Output is put back in the box, and →
// at the end completes the path before the caret from the repo's tree (several matches said in one quiet line under the box).
//
// Where the box floats over the page (Git; not a desk, whose line stands under it): while one reads (the center turned
// by the wheel, a touch or the keys) and the box is empty and not written in, it steps back and lets what is under it
// be pressed; the keyboard reaching it, a press on the Prompt, or the pointer
// resting at the center's foot brings it back where it was. A page read rather than written in (Git) has it stepped
// back from the start.

/** Choices said under the box after → completed, at most. */
const CHOICES = 24;

/** What was written in a box and not sent: by repo for Run, by what the box does and repo otherwise. */
const drafts = new Map<string, string>();
// A repo renamed: what was half written for it is its new name's.
onRenamed((from, to) => {
  for (const [k, text] of [...drafts]) {
    const mode = k.includes('\n') ? k.slice(0, k.indexOf('\n')) : null;
    if ((mode === null ? k : k.slice(mode.length + 1)) !== from) continue;
    drafts.delete(k);
    drafts.set(mode === null ? to : `${mode}\n${to}`, text);
  }
});

/** A key pressed alone (no Ctrl, Alt, ⌘ or Shift with it), not in a conversion. */
const plain = (e: KeyboardEvent) => !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !e.isComposing;
/** Ctrl+Enter (⌘+Enter), never the Enter that confirms a conversion: what sends. */
const sends = (e: KeyboardEvent) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing;
/** Off the screen: out of the page, or in a page put away. */
const offScreen = (el: Element) => !el.isConnected || !!el.closest('[hidden]');

interface BoxParts {
  /** What carries the bench's classes (.unrun). */
  work: HTMLElement;
  /** The page's own content and the center holding it with the dock: read in, pointed at. */
  main: HTMLElement;
  center: HTMLElement;
  /** The Prompt's own box (where the repo's terminal stands, up or at rest). */
  term: HTMLElement;
  termHead: HTMLElement;
  /** Stepped back from the start, until it is asked for (Git). */
  back: boolean;
  /** A line of the box's own in the Prompt's flow pressed: the issue it wrote (its file, in `repo`), a file the Agent read or edited, or Home's TODO. */
  went(repo: string, to: {issue: string} | {file: string} | 'todo'): void;
  /** A file of the repo in front brought into view at a line (Forge's; Git's shows the file). */
  reveal(path: string, line?: number): void;
  /** Where what the box does in a repo is said: the pane's rows. */
  flow(repo: string): Flow;
  /** On a desk: a file's box laid without taking the person's hand (false: it cannot be); the camera over boxes. */
  place?(path: string): boolean;
  frame?(keys: string[]): void;
  /** On a desk: the Agent's own terminal (`element`) laid as a box of `repo`'s desk, if it is not there. */
  besideTerm?(repo: string, element: HTMLElement): void;
  /** The box is the Prompt's own last line, on a desk (Forge's): under Run, Enter runs what is written, as a
   * terminal's does (Shift+Enter a new line). */
  desk?: boolean;
}

/** The box at the foot of a bench's center: its field and pill, what is said under it, what it does with what is written. */
export class Box {
  readonly prompt = h('textarea', {class: 'prompt-in', rows: '1', 'aria-label': t('Prompt input'), spellcheck: 'false', autocapitalize: 'off'}) as HTMLTextAreaElement;
  readonly note = h('p', {class: 'prompt-note muted small', role: 'status'});
  /** Where an issue or a TODO sent went, said to be heard (seen going, so the box does not move as a line comes). */
  readonly heard = h('p', {class: 'sr-only box-said', role: 'status'});
  readonly runIt: HTMLButtonElement;
  /** The pill: the prompt line for Run, the mode's own words otherwise; pressed, what else the box can do. */
  readonly chip: HTMLButtonElement;
  /** The prompt line the shell waits at, in the pill (and up, at the line's start). */
  readonly waits = h('span', {class: 'prompt-ps', 'aria-hidden': 'true'});
  readonly form: HTMLFormElement;
  /** The dock: the box (in its screen) and what is said under it. */
  readonly dock: HTMLElement;
  /** The line's parts that stay where they are while the Prompt's glass comes under them: the pill's lamp first. */
  readonly line: HTMLElement[];

  #screen: Rises | null = null;
  #repo: string | null = null;
  #mode: Mode = boxMode();
  /** What completing last said under the box, which goes as soon as anything else is done there. */
  #choices = false;
  /** The repo's earlier lines, walked with ↑ and ↓. */
  readonly #walk = new Recall();
  /** The repo's directories as completing reads them: read ahead as a path is written, again once anything changes. */
  readonly #listed = new Map<string, Entry[] | Promise<Entry[]>>();
  readonly #modeWords = h('span', {class: 'prompt-mode', 'aria-hidden': 'true'});
  /** The key that brings the box up doing what it does now: ` for Run, G for Edit. */
  readonly #summonKey = h('kbd', {}, '`');
  /** The keys that send what is in the box, said beside its button while it is written in. */
  readonly #sends: HTMLElement;
  /** What had the keyboard before the box took it (from outside the box and what it brings out): Escape gives it back. */
  #before: HTMLElement | null = null;
  /** The issue or TODO written last, until its line is in the flow: the next waits for it, so they land as written. */
  #landing: Promise<void> = Promise.resolve();
  /** An `agent` line on its way to being asked (its key being opened): asked once, however many Enters. */
  #asking = false;
  readonly #keys: string;
  readonly #menu: ReturnType<typeof modeMenu>;
  /** Run: the repo's Prompt followed, and the prompt line its shell waits at, in the pill. */
  readonly #pillLine: PillLine;
  /** Edit: a line of the file in front, held in the box and written there as in the file. */
  readonly #edit: EditLine;

  readonly #p: BoxParts;

  constructor(p: BoxParts) {
    this.#p = p;
    if (p.desk && this.#mode === 'edit') this.#mode = 'run';
    // Run: Ctrl+Enter (⌘+Enter) is how it is done from the box, said in its title, not beside the word. Never Enter
    // alone: Enter is what confirms a Japanese conversion, and a line must not run because a word was chosen.
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    this.#keys = mac ? '⌘+Enter' : 'Ctrl+Enter';
    this.runIt = h('button', {type: 'submit', class: 'button small-button prompt-run', 'aria-keyshortcuts': mac ? 'Meta+Enter' : 'Control+Enter'}) as HTMLButtonElement;
    const lamp = h('span', {class: 'lamp'});
    this.chip = h('button', {type: 'button', class: 'prompt-chip', tabindex: '-1', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-mode': 'run'},
      lamp, this.waits, this.#modeWords) as HTMLButtonElement;
    // The keys that bring it up from anywhere, said at rest as keys are; while it is written in, in their place the
    // keys that send (Run says them in its title too): Enter is a new line here, as in every box one writes in. One
    // over the other in one place, so nothing on the line moves as the keyboard comes and goes.
    this.#sends = h('span', {class: 'prompt-sends'}, h('kbd', {}, mac ? '⌘' : 'Ctrl'), h('kbd', {}, 'Enter'));
    const caps = h('span', {class: 'prompt-caps', 'aria-hidden': 'true'},
      h('span', {class: 'prompt-keys'}, h('kbd', {}, mac ? '⌘' : 'Ctrl'), this.#summonKey), this.#sends);
    this.form = h('form', {class: 'prompt'}, this.chip, this.prompt, caps, this.runIt) as HTMLFormElement;
    this.line = [lamp, this.waits, this.prompt, this.runIt];
    this.dock = h('div', {class: 'dock'}, this.note, this.heard);
    this.#pillLine = new PillLine({chip: this.chip, waits: this.waits, repo: () => this.#repo, up: () => this.#up, desk: () => !!p.desk,
      followed: () => this.onFollow?.()});
    // Put away with Escape, the keyboard goes back to the box if it was there (the Prompt not brought up for it), else
    // nowhere.
    this.#edit = new EditLine({box: this.prompt, main: p.main, dock: this.dock, repo: () => this.#repo,
      say: (text) => { if (this.#mode === 'edit') this.#say(text); }, moved: () => { if (this.#mode === 'edit') this.#pillSays(); },
      active: () => this.#mode === 'edit' && document.activeElement === this.prompt,
      idle: () => this.#mayEdit() && document.activeElement === this.prompt,
      takeUp: () => { this.#auto = true; this.choose('edit', false, true); }});
    this.#menu = modeMenu(this.chip, {repo: () => this.#repo, at: () => this.#edit.where(), chosen: (m) => { this.choose(m); this.prompt.focus(); }, desk: !!p.desk,
      // Put away without a choice, the keyboard is where one writes (it was in the box, or the pill was pressed to
      // choose what the box does next); only from somewhere else of its own does it go nowhere in particular.
      closed: (before) => { if (!before || before === this.prompt || before === this.chip || before === document.body) this.prompt.focus(); else (document.activeElement as HTMLElement | null)?.blur(); }});
    this.dock.append(this.#menu.element);
    // Whether a key is kept here, read once, before the pill is first pressed: the Agent is among what it brings only then.
    void agentKey();
    this.#wire(caps);
    this.#stepsBack();
    this.#byItself();
    // Chosen in another page's box, this one does it too (turned there, not here: it is not on screen).
    onBoxMode((m) => this.choose(m, false));
    onChange((c) => {
      if (c.repo !== this.#repo) return;
      this.#listed.clear();
      if (this.#mode === 'issue') this.#pillSays();
    });
  }

  /** The repo the box works on. */
  get repo(): string | null { return this.#repo; }

  /** The screen the box becomes while the Prompt is up (made with the box's own parts, so given after). */
  set screen(s: Rises) { this.#screen = s; }
  get #up(): boolean { return this.#screen?.up ?? false; }

  /** As the screen goes up, starts down, or is the box's line again: what the line says, and how tall it is. */
  screenChanged(state: ScreenState) {
    this.#pillLine.said();
    this.#fit();
    // Back in the box, the Prompt is read afresh when it comes up again: what it printed is folded away.
    if (state === 'rest' && this.#repo) sessionIfAny(this.#repo)?.fold();
    if (state === 'leaving' && this.#p.back) requestAnimationFrame(() => this.#rest(true));
  }

  /** The repo the box works on; null for none (the box can do nothing then). */
  setRepo(name: string | null) {
    if (name === this.#repo && name) { this.attach(); return; }
    this.#repo = name;
    this.attach();
    this.prompt.disabled = this.runIt.disabled = !name;
    this.#edit.letGo();
    this.#edit.hide();
    this.prompt.placeholder = modeHint(this.#mode, name);
    this.prompt.value = name && this.#mode !== 'edit' ? drafts.get(this.#draft()) ?? '' : '';
    this.#pillSays();
    this.#unsay();
    this.#say('');
    this.#walk.reset();
    this.room();
    requestAnimationFrame(() => this.#fit());
  }

  /** `text` in the box as if written there, the caret at its end, the keyboard in it (a run pressed in Output). */
  recall(text: string) {
    if (!this.#repo || this.prompt.disabled) return;
    this.#put(text);
    this.prompt.focus();
  }

  /** The Prompt put away, the keyboard given back to what had it (as Escape in the box). */
  putAway() { this.#letGo(); }

  /** The keyboard into the box, come from `from` (what had it before a press took it from there on its way here):
   * given back there when the box lets go. */
  take(from: HTMLElement | null) {
    this.prompt.focus();
    if (from) this.#before = from;
  }

  /** Ctrl+`: the box runs, and has the keyboard; false when it can do nothing (no repo). */
  summon(): boolean {
    if (this.prompt.disabled) return false;
    this.choose('run');
    this.prompt.focus();
    return true;
  }

  /** Ctrl+G: the box edits the file in front, and has the keyboard; false when it can do nothing (no repo). */
  edit(): boolean {
    if (this.prompt.disabled || this.#p.desk) return false;
    this.choose('edit');
    this.prompt.focus();
    return true;
  }

  /**
   * The box made to do `m`: its pill turns to it, and what was half written for it comes back. `byItself`: taken up
   * of itself (Edit while one works in a file), not chosen: the mode one chose stays the boxes' own.
   */
  choose(m: Mode, seen = true, byItself = false) {
    // Edit chosen on another page's box: on a desk the box runs instead.
    if (m === 'edit' && this.#p.desk) m = 'run';
    if (!byItself) this.#auto = false;
    // Told to the other pages' boxes once this one has turned (it hears its own telling, and is there already).
    if (m === this.#mode) { if (!byItself) setBoxMode(m); return; }
    if (this.#up && m !== 'run') this.#screen?.lower();
    const change = () => {
      // A line held for Edit is in the file already: let go, not kept as a draft.
      if (this.#mode === 'edit') { this.#edit.letGo(); this.prompt.value = ''; }
      this.#keep();
      this.#mode = m;
      this.#pillSays();
      this.prompt.placeholder = modeHint(m, this.#repo, m === 'edit' ? this.#edit.where()?.file : null);
      this.prompt.value = this.#repo && m !== 'edit' ? drafts.get(this.#draft()) ?? '' : '';
      this.#fit();
      this.#unsay();
      this.#say('');
      this.heard.textContent = '';
      // Edit lights the line it holds on the file while the box has the keyboard; the others show nothing there.
      if (m === 'edit' && document.activeElement === this.prompt) this.#edit.show(); else this.#edit.hide();
    };
    if (seen && this.#p.work.isConnected && !this.#up) turn(this.chip, this.runIt, change); else change();
    // On a desk, run chosen with the keyboard in the line (its start pressed, Alt+1): the line is the terminal's again,
    // what it printed standing on it, as when the line is taken.
    if (this.#p.desk && m === 'run' && document.activeElement === this.prompt) this.#screen?.raise();
    if (!byItself) setBoxMode(m);
  }

  /** Edit taken up of itself while one works in a file: it goes back to the mode chosen once neither has the keyboard. */
  #auto = false;

  /** Running, nothing written, in a repo: the box may be Edit of itself (up as the Prompt, it goes down for it). */
  #mayEdit() {
    // On a desk the files are written in where they lie: the box never takes up Edit.
    return !this.#p.desk && this.#mode === 'run' && !this.prompt.value && !!this.#repo && !this.prompt.disabled;
  }

  /**
   * Working in a file of the center, with the box empty and running, the box is that line's of itself: Edit, its pill
   * saying the file and the line the caret is on, so what the box does is what one is doing (pressed into, it holds
   * that line); with the keyboard still in it (the Prompt up and empty), a line pressed is taken into it as Edit takes
   * one, the Prompt going down (edit-box.ts). Run is a key away (Ctrl+`, or its pill). Once neither the file nor the
   * box has the keyboard, it is what one chose again.
   */
  #byItself() {
    const {main} = this.#p;
    main.addEventListener('focusin', (event) => {
      if (!(event.target as Element).classList?.contains('code-edit') || !this.#mayEdit() || this.#up) return;
      this.#auto = true;
      this.choose('edit', false, true);
    });
    const left = (event: FocusEvent) => {
      if (!this.#auto) return;
      const to = event.relatedTarget as Element | null;
      if (to && (to === this.prompt || this.dock.contains(to) || (to.classList.contains('code-edit') && main.contains(to)))) return;
      this.#auto = false;
      this.choose(boxMode(), false, true);
    };
    main.addEventListener('focusout', left);
    this.prompt.addEventListener('blur', left);
  }

  /**
   * The repo's Prompt in this box. A Prompt is one element wherever it is shown, so another page's box (Git's) takes it
   * while it is there: coming back, it is put back here. A box off the screen (its page put away and still drawing
   * what it read, or not yet shown as it is come back to) leaves it with one on the screen, where a question just
   * asked would be answered out of sight, and takes it once it is on the screen itself (laid out, before it is drawn).
   */
  attach() {
    const {term, termHead, work} = this.#p;
    const el = this.#repo ? terminalFor(this.#repo) : null;
    // Whether its program in front reads each key as it comes, heard as it changes: said on the line (data-raw), where
    // the page's own keys (the desk's, the bench's) give way to it.
    this.#unwatchRaw?.();
    const session = this.#repo ? sessionIfAny(this.#repo) : null;
    this.#unwatchRaw = session ? session.watch(() => this.#rawMark()) : null;
    this.#rawMark();
    const held = !!el && el.parentElement !== term && offScreen(work) && !offScreen(el);
    if (held) this.#onScreen.observe(term);
    else if (el ? el.parentElement !== term : term.childElementCount > 1) term.replaceChildren(termHead, ...(el ? [el] : []));
    this.#pillLine.follow();
  }
  readonly #onScreen = new ResizeObserver(() => {
    if (offScreen(this.#p.work) || !this.#p.term.getClientRects().length) return;
    this.#onScreen.disconnect();
    this.attach();
  });

  #unwatchRaw: (() => void) | null = null;
  /** The repo's Prompt, while the program in front of it reads each key as it comes. */
  #raw(): Session | null {
    const s = this.#repo ? sessionIfAny(this.#repo) : null;
    return s instanceof Session && s.raw ? s : null;
  }
  #rawMark() {
    this.form.toggleAttribute('data-raw', !!this.#raw());
    // What is typed kept out of sight (a password asked for): hidden in the box, and never kept as a draft.
    const s = this.#repo ? sessionIfAny(this.#repo) : null, hushed = s instanceof Session && s.hushed;
    if (hushed && !this.form.hasAttribute('data-hushed')) drafts.delete(this.#draft());
    this.form.toggleAttribute('data-hushed', hushed);
  }

  /** Whether the repo's Prompt has run anything yet, which is what gives it room. */
  room() { this.#p.work.classList.toggle('unrun', !!this.#repo && !sessionIfAny(this.#repo)?.runs.length); }

  // ---- What it says.

  /** Its page hidden as one page goes and another comes, the field has no height to measure: fitted then, it was left
   * 0 px tall, out of sight and not to be pressed. It is fitted as soon as it is laid out again instead. */
  readonly #shown = new ResizeObserver(() => { if (this.prompt.getClientRects().length) { this.#shown.disconnect(); this.#fit(); } });
  #fit() {
    if (!this.prompt.getClientRects().length) { this.#shown.observe(this.prompt); return; }
    this.prompt.style.height = 'auto'; this.prompt.style.height = `${this.prompt.scrollHeight}px`;
  }
  /** What is half written is kept for the repo and for what the box does: an issue's words are not a line to run. */
  #draft() { return this.#mode === 'run' ? this.#repo! : `${this.#mode}\n${this.#repo}`; }
  /** What is written kept for the repo and what the box does (not Edit's: its line is the file's own). */
  #keep() { if (this.#repo && this.#mode !== 'edit' && !this.form.hasAttribute('data-hushed')) { if (this.prompt.value) drafts.set(this.#draft(), this.prompt.value); else drafts.delete(this.#draft()); } }
  /** Completing's choices go as the next key is pressed, not at once: put away as they came. */
  #unsay() {
    if (!this.#choices) return;
    this.#choices = false;
    putAway(this.note, () => { this.note.textContent = ''; this.note.classList.remove('paths'); });
  }
  /** Said under the box, at once (what was going out from there stays, saying this). */
  #say(text: string | Node[]) {
    keepOut(this.note);
    this.note.classList.remove('paths', 'refused');
    const was = this.note.textContent;
    if (typeof text === 'string') this.note.textContent = text; else this.note.replaceChildren(...text);
    // Something else said in its place comes up out of a light fade, not swapped in one frame (from nothing it is at once).
    if (was && was !== this.note.textContent && !still()) this.note.animate([{opacity: .35}, {opacity: 1}], {duration: paced(140), easing: SPRING});
  }
  /** Not done, and why: the line under the box in ink until the box is written in again, the box shaking its head. */
  #refuse(text: string) {
    this.#say(text);
    this.note.classList.add('refused');
    nudge(this.form);
    this.prompt.focus();
  }
  /** `text` in the box as if written there, the caret at its end. */
  #put(text: string) {
    this.prompt.value = text;
    this.prompt.setSelectionRange(text.length, text.length);
    this.#keep();
    this.#unsay();
    this.#fit();
    // A line put back whole (an earlier one, one pressed in Output): the caret is at its end at once, as a terminal's.
    fieldMoved();
  }

  /** The pill's words for the mode, the repo's next issue's number once it is read; the button's word and title. */
  #pillSays() {
    const mode = this.#mode, repo = this.#repo, words = this.#modeWords;
    this.#keysSay(mode);
    const n = mode === 'issue' && repo ? nextIssue(repo) : null;
    if (n instanceof Promise) {
      void n.then(() => { if (this.#mode === 'issue') this.#pillSays(); });
      // Read again (its issues changed): it keeps saying the number it said until the new one is read, never none.
      if (words.dataset.for === `${mode}\n${repo}`) return;
    }
    const was = words.querySelector('b')?.textContent;
    const at = mode === 'edit' ? this.#edit.where() : null;
    words.replaceChildren(...pillWords(mode, repo, typeof n === 'number' ? n : null, at));
    words.dataset.for = `${mode}\n${repo}`;
    if (mode === 'edit') this.prompt.placeholder = modeHint(mode, repo, at?.file ?? null);
    if (mode === 'issue') this.#numberTurns(was);
  }

  /** What the box does said where it is pressed: the pill's mode and name, the keys that bring it, Run's word and title. */
  #keysSay(mode: Mode) {
    this.chip.dataset.mode = mode;
    this.form.dataset.mode = mode;
    this.#summonKey.textContent = mode === 'edit' ? 'G' : '`';
    this.#summonKey.classList.toggle('tick', mode !== 'edit');
    this.chip.setAttribute('aria-label', t('Input box action: {what}', {what: sendWord(mode)}));
    this.runIt.textContent = sendWord(mode);
    this.runIt.title = sendTitle(mode, this.#keys);
    // Edit has nothing to send: what is typed is in the file already.
    this.runIt.hidden = mode === 'edit';
  }

  /** An issue written, the next number comes up into the pill as a counter's figure turns (from `was`, the one it said). */
  #numberTurns(was: string | null | undefined) {
    const b = this.#modeWords.querySelector('b');
    if (b && was && was !== '#' && b.textContent !== was && !still())
      b.animate([{translate: '0 11px', opacity: 0}, {translate: '0 0', opacity: 1}], {duration: paced(260), easing: LAND});
  }

  /** Told when another Prompt is followed (the reference reads its runs again). */
  onFollow: (() => void) | null = null;

  // ---- What is done in it.

  /**
   * What is in the box goes to the repo's Prompt (an ended one is started again first), is made as an issue or a TODO,
   * or is asked of the Agent.
   */
  #send() {
    const repo = this.#repo;
    if (!repo) return;
    if (this.#mode === 'edit') return;
    if (this.#mode === 'agent') { void this.#ask(repo); return; }
    if (this.#mode !== 'run') { void this.#write(this.#mode, repo); return; }
    // `agent` and what to do, run in the terminal on a desk: asked of the Agent, which works in a terminal of its own.
    const agentLine = this.#p.besideTerm ? /^\s*agent\s+(\S[\s\S]*)$/.exec(this.prompt.value) : null;
    if (agentLine) { void this.#askBeside(repo, this.prompt.value.trim(), agentLine[1].trim()); return; }
    const s = sessionIfAny(repo);
    // Ended: started again, and what was written waits in the box to be sent once it is up.
    if (s?.ended) { s.restart(); this.#pillLine.follow(); this.#say(t('Starting up…')); return; }
    if (!sessionFor(repo).send(this.prompt.value)) { this.#say(t('Starting up…')); return; }
    // Sent with the Prompt put down (Escape, or Run chosen from another of the box's deeds): it comes up, so what is
    // run is seen run, never answered out of sight.
    if (!this.#up && document.activeElement === this.prompt) this.#screen?.raise();
    this.#emptied();
  }

  /** What was written sent: the box empty for the next line, as a terminal's line is after Enter. */
  #emptied() {
    this.#unsay();
    this.#say('');
    this.prompt.value = '';
    drafts.delete(this.#draft());
    this.#walk.reset();
    this.room();
    this.#fit();
  }

  /**
   * `agent ...` run in the person's terminal on a desk (`line`, asking `question`): the line is the person's, shown
   * run there at once (refused, why, as a command says it); the Agent's own terminal is born beside it on the desk,
   * where what it was asked heads what it does, played at a person's pace while it works at its own. The person's
   * terminal is theirs again at once: nothing the Agent does is typed into it, and nothing waits on them.
   */
  async #askBeside(at: string, line: string, question: string) {
    // The line stays where it was typed until it is shown run, in the same frame as the field is emptied: never a
    // moment with neither, the line gone and come back. (Asked again meanwhile, by a second Enter, it is asked once.)
    if (this.#asking) return;
    this.#asking = true;
    const run = (output: string, status: number) => { this.#asking = false; this.#emptied(); sessionFor(at).shown(line, output, status); };
    let use;
    try { use = await agentUse(); } catch (e) { run(`agent: ${errorText(e)}`, 1); return; }
    if (!use) { run(`agent: ${t('No API key configured on this device; set one in Runtime')}`, 1); return; }
    run('', 0);
    const term = agentTermFor(at);
    this.#p.besideTerm?.(at, term.element);
    const row = term.asked(question);
    const front = this.#edit.inFront();
    const stage = this.#stageBeside(at, term);
    // Born, the camera goes with its terminal as it slides out from under the person's (desk.ts lay), and stays there
    // while its model is first asked: it has looked at nothing yet.
    stage.frame([]);
    // On an issue's work the Agent was handed it, and writes; on main it reads and runs only.
    const w = await workOf(at).catch(() => null);
    const issuePath = w?.issue ? (w.issue.startsWith('issue/') ? w.issue : `issue/${w.issue}`) : null;
    const issue = issuePath ? (await store.read(at, issuePath).catch(() => null))?.text ?? '' : null;
    const player = new Player(at, stage);
    try {
      await atWork(term, row, at, use, await told(at, front, issue), question, agentHands(at, issue !== null), player, (path) => this.#p.went(at, {file: path}));
    } finally {
      // Its work done, its hand is gone from its terminal: no caret left blinking there.
      stage.hand?.(null);
    }
  }

  /**
   * Where the Agent asked from a desk's terminal is played: its own terminal (typed into, its runs shown), its files'
   * boxes laid without taking the person's hand. The camera goes to the box at work now, at its own size, its top at
   * the eye, the rest at its sides as they lie, until the person takes a box in hand.
   */
  #stageBeside(at: string, term: AgentTerm): Stage {
    // Framed: both terminals as it is born (the camera on its own, the person's at its side); then its own and the box
    // its hand is in, the camera going to each as the hand starts there, never after: the hand waits for it (play.ts),
    // so nothing is typed into a box the camera has yet to come to. (Before: going from a box the camera had already
    // been to waited 900 ms, and one still being watched up to 2.4 s, while the hand went on typing there unseen.)
    let framed: string[] = [];
    // Its birth beside the person's terminal is seen whole before the camera goes on to its work: what is asked of the
    // camera meanwhile waits, and so does the hand.
    let born = 0, holding = 0;
    let release: (() => void) | null = null, sent: Promise<void> = Promise.resolve();
    return {
      typing: () => term.typing(),
      shown: (line, output, status) => term.shown(line, output, status),
      running: (line) => term.running(line),
      saying: () => term.saying(),
      hand: (lane) => term.element.classList.toggle('hand', lane === 'agent'),
      place: (path) => this.#repo === at && !!this.#p.place?.(path),
      frame: (keys) => {
        // (In the order they started, the Agent's terminal with them: the last to start is the one gone to.)
        const next = !framed.length ? ['term', 'agent'] : keys.includes('agent') ? keys : ['agent', ...keys];
        if (framed.length && !keys.length) return sent;
        clearTimeout(holding);
        const go = () => {
          framed = next;
          if (this.#repo === at) this.#p.frame?.(next);
          release?.();
          release = null;
        };
        if (!framed.length) born = performance.now() + 1800;
        const held = framed.length ? Math.max(0, born - performance.now()) : 0;
        if (!held) { go(); return sent; }
        if (!release) sent = new Promise<void>((r) => { release = r; });
        holding = window.setTimeout(go, held);
        return sent;
      },
    };
  }

  /**
   * An issue or a TODO written in the box: made, the box emptied, and what was written goes on into the right pane, a
   * line of its own in the repo's Prompt, among what was run there as it came (pressed, it goes to the issue or TODO).
   */
  async #write(as: 'issue' | 'todo', at: string) {
    const text = this.prompt.value;
    const land = sendInto(this.prompt);
    // Written one after another, they land in the order written, whichever was made first (a TODO before an issue).
    const before = this.#landing;
    let landed = () => {};
    this.#landing = new Promise((done) => { landed = done; });
    try {
      const sent = await sendAs(as, at, text);
      await before;
      // Nothing to make it of: said in ink, and the box shakes its head, keeping the keyboard (Fix： alone has a kind, not a title).
      if (!sent) {
        const {kind} = kindOf(text.split('\n')[0] ?? '');
        this.#refuse(kind ? t('Enter title after {kind}:', {kind}) : t('First line is the title'));
        return;
      }
      // Pressed, it goes to where it is: the issue in Git, the TODO on Home. Its line in this box's pane, never in
      // another page's that had the repo's Prompt last.
      this.attach();
      const to = sent.to;
      const row = this.#flow(at).note(sent.head, sent.words, () => this.#p.went(at, 'issue' in to ? {issue: to.issue} : 'todo'));
      if (this.prompt.value === text) { land(row); this.prompt.value = ''; drafts.delete(this.#draft()); this.#fit(); }
      this.heard.textContent = sent.said;
      this.#pillSays();
    } catch (e) { this.#say(errorText(e)); } finally { landed(); }
  }

  /**
   * A question written in the box, asked of the Agent: it goes on into the right pane (brought out for it), a line of
   * its own in the repo's flow, and the answer comes in under it as it is written; pressed, the question is back in
   * the box to be asked again or put otherwise. The box is emptied for the next.
   */
  async #ask(at: string) {
    const question = this.prompt.value.trim();
    if (!question) return;
    // A sealed key is opened by the person's passkey the first time this session; not opened, nothing is asked.
    let use;
    try { use = await agentUse(); } catch (e) { this.#refuse(errorText(e)); return; }
    if (!use) { this.#refuse(t('No API key configured on this device; set one in Runtime')); return; }
    if (this.prompt.value.trim() !== question) return;
    const front = this.#edit.inFront();
    const land = sendInto(this.prompt);
    setRightPane(true);
    // The repo's Prompt in this box's pane (another page's box may have it), where the question and its answer go.
    this.attach();
    const session = this.#flow(at);
    const row = session.note('Agent', question, () => { this.choose('agent'); this.#put(question); this.prompt.focus(); });
    land(row);
    this.prompt.value = '';
    drafts.delete(this.#draft());
    this.#fit();
    this.heard.textContent = t('Prompt sent to Agent');
    // On an issue's work the Agent was handed it, and writes; on main it reads and runs only.
    const w = await workOf(at).catch(() => null);
    const issuePath = w?.issue ? (w.issue.startsWith('issue/') ? w.issue : `issue/${w.issue}`) : null;
    const issue = issuePath ? (await store.read(at, issuePath).catch(() => null))?.text ?? '' : null;
    const player = new Player(at, this.#stage(at));
    await atWork(session, row, at, use, await told(at, front, issue), question, agentHands(at, issue !== null), player, (path) => this.#p.went(at, {file: path}));
  }

  /** Where what the box does in `repo` is said: the pane's rows. */
  #flow(repo: string): Flow { return this.#p.flow(repo); }

  /**
   * Where the Agent's work in `at` is played (play.ts): its commands typed in this box under Run, as a person types
   * them, and sent, the Prompt up while they run as for a person's; the box given back after as it was (its mode, what
   * was written in it, the Prompt down); its files brought into view. Neither
   * while another repo is in front: the work goes on there unseen.
   */
  #stage(at: string): Stage {
    return {
      typing: () => {
        if (this.#repo !== at || this.prompt.disabled) return null;
        const was = this.#mode;
        this.choose('run', true, true);
        const before = this.prompt.value;
        return {
          put: (text) => { this.prompt.value = text; this.#fit(); },
          sent: () => { if (this.#repo === at && !this.#up) this.#screen?.raise(); },
          done: () => {
            this.prompt.value = before;
            this.#fit();
            if (this.#repo === at && was !== 'run') this.choose(was, true, true);
          },
        };
      },
      shown: (line, output, status) => sessionFor(at).shown(line, output, status),
      place: (path) => {
        if (this.#repo !== at) return false;
        if (this.#p.place) return this.#p.place(path);
        this.#p.reveal(path, 1);
        return true;
      },
      frame: (keys) => { if (this.#repo === at) this.#p.frame?.(keys); },
    };
  }

  /** The repo's directory `dir` as completing reads it, read once and kept until the repo changes. */
  #list(dir: string): Entry[] | Promise<Entry[]> {
    const key = `${this.#repo}\n${dir}`;
    let got = this.#listed.get(key);
    if (!got) {
      const reading: Promise<Entry[]> = shownTree(this.#repo!, dir).catch(() => [] as Entry[]);
      this.#listed.set(key, got = reading);
      void reading.then((e) => { if (this.#listed.get(key) === reading) this.#listed.set(key, e); });
    }
    return got;
  }
  /** The directory of the path being written, read ahead so → can complete at once. */
  #look() {
    const {prompt} = this, repo = this.#repo;
    const w = repo && prompt.selectionStart === prompt.selectionEnd ? pathWord(prompt.value, prompt.selectionStart, repo) : null;
    if (w) void this.#list(w.dir);
  }
  /**
   * Complete the path before the caret; false when there is none to complete (`text`: what is written).
   */
  #tab(text = this.prompt.value): boolean {
    const {prompt} = this, repo = this.#repo;
    if (!repo || prompt.selectionStart !== prompt.selectionEnd) return false;
    const at = prompt.selectionStart, w = pathWord(text, at, repo);
    if (!w) return false;
    const got = this.#list(w.dir);
    if (!(got instanceof Promise)) return this.#fill(w.name, at, got);
    // Not read yet (rare: it is read while the path is written): completed once it is.
    void got.then((entries) => { if (prompt.value.length >= at && prompt.selectionStart === at) this.#fill(w.name, at, entries); });
    return true;
  }
  /** `name` (the path's last word, before the caret at `at`) completed from its directory's `entries`; false with none. */
  #fill(name: string, at: number, entries: Entry[]): boolean {
    const c = complete(name, entries);
    if (!c) return false;
    if (c.insert) {
      this.prompt.setRangeText(c.insert, at, at, 'end');
      this.#keep();
      this.#walk.reset();
      this.#fit();
      this.#look();
      if (this.#mode === 'edit') this.#edit.show();
    }
    if (c.choices.length) {
      this.#choices = true;
      this.#say(c.choices.slice(0, CHOICES).join('  ') + (c.choices.length > CHOICES ? '  …' : ''));
      this.note.classList.add('paths');
    }
    else this.#unsay();
    return true;
  }

  /**
   * A key in the box: Escape, then the keys that choose what the box does, then the keys of what it does now (Run's,
   * Edit's; writing an issue or a TODO, Enter is a new line and Ctrl+Enter, ⌘+Enter, sends).
   */
  #key(event: KeyboardEvent) {
    // A program in front reading each key as it comes (vi, less, top): every key is its, as at a terminal.
    const raw = this.#raw();
    if (raw) { if (!event.isComposing && raw.key(event)) event.preventDefault(); return; }
    if (event.key !== 'ArrowRight') this.#unsay();
    if (event.key === 'Escape') { this.#escape(event); return; }
    if (this.#modeKey(event)) return;
    if (this.#mode === 'edit') this.#editKey(event);
    else if (this.#mode === 'run') this.#runKey(event);
    else if (sends(event)) { event.preventDefault(); this.#send(); }
  }

  /** Escape: the Prompt put back and the box let go; editing, what is in the box goes first (and then the box). */
  #escape(event: KeyboardEvent) {
    // Editing, Escape gives the keyboard back to the file, where the box was in it.
    if (this.#mode === 'edit' && !event.isComposing) {
      event.preventDefault();
      if (this.#edit.toFile()) return;
    }
    // On a desk the terminal is a piece as a file's sheet is: Escape leaves its line as it leaves a text, the keyboard
    // out on the desk (desk.ts), the terminal still in hand. Nothing is given back to where it came from.
    if (this.#p.desk) { this.#before = null; return; }
    this.#letGo();
  }

  /**
   * The Prompt put back, and the keyboard given back to what had it before the box took it (the file, the page),
   * where it is still to be had; never left on nothing when it came from somewhere.
   */
  #letGo() {
    this.#screen?.lower();
    const back = this.#before;
    this.#before = null;
    if (back?.isConnected && !back.closest('[hidden], [inert]') && back.getClientRects().length) back.focus({preventScroll: true});
    else this.prompt.blur();
  }

  /**
   * Alt+1 to 4 choose what the box does; Alt+↓ brings the four out of the pill, up as the screen too (out of the line's
   * start, where the pill went). True when it was one of them.
   */
  #modeKey(event: KeyboardEvent): boolean {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return false;
    const n = /^Digit([1-9])$/.exec(event.code)?.[1];
    const m = n ? modesNow(this.#p.desk)[Number(n) - 1] : undefined;
    if (m) { event.preventDefault(); this.choose(m); return true; }
    if (event.key !== 'ArrowDown' || this.prompt.disabled) return false;
    event.preventDefault();
    this.#menu.open();
    return true;
  }

  /**
   * A key in the box while it runs: → at the end completes a path (as a shell's suggestion is taken), ↑ and ↓ walk
   * earlier lines, Ctrl-C interrupts, Ctrl+Enter runs.
   */
  #runKey(event: KeyboardEvent) {
    const {prompt} = this, repo = this.#repo, caret = prompt.selectionStart === prompt.selectionEnd;
    if (event.key === 'ArrowRight' && plain(event) && caret && prompt.selectionStart === prompt.value.length) { if (this.#tab()) event.preventDefault(); return; }
    // At a desk's foot the line is a terminal's: Tab completes there and never leaves the line.
    if (this.#p.desk && event.key === 'Tab' && plain(event)) { event.preventDefault(); this.#tab(); return; }
    // ↑ on the first line and ↓ on the last walk earlier lines; elsewhere they move the caret.
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && plain(event) && caret) { this.#walkTo(event, event.key); return; }
    // Ctrl-C with nothing selected (so not a copy) interrupts what runs, as in a terminal; at the prompt line, the line
    // written is let go, said cut, as a terminal's line editor does. (With Caps Lock on, it is still C: Shift held is a
    // terminal's copy, Ctrl+Shift+C, and left to the page.)
    if (event.key.toLowerCase() === 'c' && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && caret && repo) {
      event.preventDefault();
      const s = sessionFor(repo);
      if (s.abandon(prompt.value)) this.#emptied(); else s.interrupt();
      return;
    }
    // Ctrl-Z while a line runs stops it, a job the shell holds (fg brings it back), as in a terminal.
    if (event.key.toLowerCase() === 'z' && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && repo && sessionFor(repo).suspend()) {
      event.preventDefault();
      return;
    }
    if (repo && this.#lineKey(event, repo)) { event.preventDefault(); return; }
    // Enter is a new line; Ctrl+Enter (⌘+Enter) sends. Enter on a line of one, as a terminal's hand presses it, the
    // keys that run it give beside Run, one after the other, as keys pressed together.
    if (sends(event)) { event.preventDefault(); this.#send(); return; }
    if (this.#p.desk && this.#mode === 'run' && event.key === 'Enter' && plain(event) && !event.isComposing) { event.preventDefault(); this.#send(); return; }
    if (event.key === 'Enter' && plain(event) && !prompt.value.includes('\n') && prompt.value.trim() && !still())
      [...this.#sends.children].forEach((k, i) => k.animate([{translate: '0 0'}, {translate: '0 2px', offset: .35}, {translate: '0 0'}],
        {duration: paced(260), delay: paced(i * 90), easing: SPRING}));
  }

  /**
   * A terminal's own keys for its line, as bash's and zsh's line editors have them (and a Mac's text, Ctrl held): Ctrl-A
   * to the line's start and Ctrl-E to its end, Ctrl-U cut back to its start and Ctrl-W the word before the caret,
   * Ctrl-L the screen cleared, Ctrl-D on an empty line the end of what is typed (else the letter after the caret).
   * The editor's own keys (Ctrl+K, Ctrl+P, Ctrl+B) stay the page's. True when the key was taken.
   */
  #lineKey(event: KeyboardEvent, repo: string): boolean {
    if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.isComposing) return false;
    const {prompt} = this, v = prompt.value, at = prompt.selectionStart, end = prompt.selectionEnd;
    const start = v.lastIndexOf('\n', at - 1) + 1, stop = (v.indexOf('\n', at) + 1 || v.length + 1) - 1;
    const cut = (a: number, b: number) => {
      if (a === b) return;
      prompt.setRangeText('', a, b, 'start');
      prompt.dispatchEvent(new Event('input', {bubbles: true}));
    };
    switch (event.key.toLowerCase()) {
      case 'a': prompt.setSelectionRange(start, start); return true;
      case 'e': prompt.setSelectionRange(stop, stop); return true;
      case 'u': cut(start, at); return true;
      case 'w': {
        let a = at;
        while (a > start && /\s/.test(v[a - 1])) a--;
        while (a > start && !/\s/.test(v[a - 1])) a--;
        cut(a, at);
        return true;
      }
      case 'l': return sessionFor(repo).clearScreen();
      case 'd':
        if (!v) { sessionFor(repo).endOfInput(); return true; }
        if (at === end && at < v.length) cut(at, at + 1);
        return true;
      default: return false;
    }
  }

  /** ↑ or ↓ with the caret on the first or last line: the line run before (or after) it in the box. */
  #walkTo(event: KeyboardEvent, key: 'ArrowUp' | 'ArrowDown') {
    const {prompt} = this, repo = this.#repo;
    const runs = repo ? sessionIfAny(repo)?.runs.map((r) => r.line) ?? [] : [];
    const line = this.#walk.arrow(key, prompt.value, prompt.selectionStart, runs);
    if (line === null) return;
    event.preventDefault();
    this.#put(line);
  }

  /** A key in the box while it edits: a text's own keys, as in the file (edit-box.ts key). */
  #editKey(event: KeyboardEvent) {
    // Never the Enter that confirms a Japanese conversion.
    if (event.isComposing || event.keyCode === 229) return;
    this.#edit.key(event);
  }

  #wire(caps: HTMLElement) {
    this.#wireField();
    this.#wireForm(caps);
    this.#wireTerm();
  }

  /** The field: brought to, left, written in, and its keys. */
  #wireField() {
    const {prompt} = this;
    prompt.addEventListener('focus', (event) => {
      // Not a search: it is out while it has the keyboard, so given it back as the Prompt went down, the search left
      // for the box came out again, its shade over the page, at an Escape meant to put things away.
      const from = event.relatedTarget as HTMLElement | null;
      if (!from || !this.dock.contains(from)) this.#before = from?.closest('.search-box') ? null : from;
      if (this.#mode === 'run') this.#screen?.raise();
      this.#pillLine.follow();
      if (this.#mode === 'edit') { this.#pillSays(); this.#edit.show(); }
    });
    // Left while editing, what is lit on the file is put away.
    prompt.addEventListener('blur', () => { if (this.#mode === 'edit') { this.#edit.hide(); this.#say(''); } });
    // A program in front reading each key as it comes has what is typed as it is typed: a conversion confirmed goes to
    // it whole, a paste too (bracketed where it asked), and nothing of either stays in the line.
    prompt.addEventListener('compositionend', (e) => {
      const s = this.#raw();
      if (!s) return;
      s.typeIn(e.data);
      prompt.value = '';
    });
    prompt.addEventListener('paste', (e) => {
      const s = this.#raw();
      if (!s) return;
      e.preventDefault();
      s.typeIn(e.clipboardData?.getData('text/plain') ?? '', true);
    });
    prompt.addEventListener('input', (e) => {
      // Text come without a key for it (a phone's keyboard, a dictation): the program has it, as it came.
      const raw = this.#raw();
      if (raw) { if (!(e as InputEvent).isComposing && prompt.value) { raw.typeIn(prompt.value); prompt.value = ''; } return; }
      this.#fit();
      this.#keep();
      this.#walk.reset();
      this.#unsay();
      // Why it was not done is heard once the box is written in again: it goes as completing's choices go.
      if (this.note.classList.contains('refused')) { this.note.classList.remove('refused'); putAway(this.note, () => { this.note.textContent = ''; }); }
      this.#look();
      if (this.#mode === 'edit') this.#edit.typed();
      // Written to, the Prompt starts: its shell comes up while the line is still being written.
      if (this.#mode === 'run' && this.#repo && this.prompt.value) sessionFor(this.#repo).begin();
    });
    prompt.addEventListener('keydown', (event) => this.#key(event));
  }

  /** The box's line: Run, the pill, and a press anywhere on it. */
  #wireForm(caps: HTMLElement) {
    const {prompt, form, chip, runIt} = this;
    // Run sends as Ctrl+Enter does; pressed with the pointer, the keyboard stays in the box.
    runIt.addEventListener('pointerdown', (event) => { if (document.activeElement === prompt) event.preventDefault(); });
    form.addEventListener('submit', (event) => { event.preventDefault(); this.#send(); prompt.focus(); });
    // The pill pressed at rest brings out what the box can do; up as the screen's prompt line, it is the line's start.
    // On a desk it is a switch between the two things the line does all day, run and note for later (TODO): one press
    // and it is the other, the keyboard in the line; the rest still come out of it at Alt+↓.
    chip.addEventListener('click', () => {
      if (prompt.disabled) return;
      if (!this.#p.desk) { if (!this.#up) this.#menu.open(); return; }
      this.choose(this.#mode === 'run' ? 'todo' : 'run');
      prompt.focus();
    });
    // Pressed anywhere in the box, not on its line alone (its padding, beside Run): the caret goes in.
    form.addEventListener('pointerdown', (event) => {
      const on = event.target as Node;
      if (chip.contains(on) && (!this.#up || this.#p.desk)) return;
      if ((on !== form && !chip.contains(on) && !caps.contains(on)) || prompt.disabled) return;
      event.preventDefault();
      prompt.focus();
    });
  }

  /** The Prompt it brings up: left, switched on again, put back by its ×, pressed. */
  #wireTerm() {
    const {prompt, dock} = this, {term} = this.#p;
    // Leaving the box and the Prompt sends the Prompt home; losing the window's focus does not. On a desk it stays up
    // till it is put away (Escape, its ×, the band's >_): what a run said is read while the file it is about is
    // written in.
    dock.addEventListener('focusout', (event) => {
      const to = event.relatedTarget as Node | null;
      if (to && !dock.contains(to) && !this.#p.desk) this.#screen?.lower();
    });
    // Switched on again from the screen, the keyboard is back in the box (the switch it was on is gone with the old one).
    term.addEventListener('click', (event) => {
      if (this.#up && (event.target as Element).closest('.power')) requestAnimationFrame(() => prompt.focus());
    });
    // Its ×, pressed, keeps the keyboard in the box until the Prompt is down, then gives it back, as Escape does.
    const shut = this.#p.termHead.querySelector<HTMLElement>('.term-shut');
    shut?.addEventListener('pointerdown', (event) => event.preventDefault());
    shut?.addEventListener('click', () => this.#letGo());
    term.addEventListener('pointerdown', (event) => {
      if (this.#up || (event.target as HTMLElement).closest('button')) return;
      event.preventDefault();
      prompt.focus();
    });
  }

  // ---- Stepping back while one reads.

  #rest(on: boolean) {
    // On a desk the line stands on ground of its own under the desk and covers nothing: it has nothing to step back
    // from, and stepped back it left an empty frame there that no press brought back (issue #172).
    if (on && (this.#p.desk || this.#up || this.prompt.value || this.note.textContent || document.activeElement === this.prompt)) return;
    this.dock.classList.toggle('resting', on);
  }

  #stepsBack() {
    const {main, center, back} = this.#p, {dock, prompt} = this;
    const reading = () => this.#rest(true);
    if (back) dock.classList.add('resting');
    main.addEventListener('wheel', reading, {passive: true});
    main.addEventListener('touchmove', reading, {passive: true});
    main.addEventListener('keydown', (event) => {
      if (['PageDown', 'PageUp', ' ', 'Home', 'End', 'ArrowDown', 'ArrowUp'].includes(event.key) && !(event.target as HTMLElement).closest('textarea, input')) reading();
    });
    // Stepped back, it comes back when the pointer rests where it is, not as the pointer crosses its place on the way to
    // something low on the page (it would come up over what was about to be pressed).
    let coming = 0;
    const stay = () => { clearTimeout(coming); coming = 0; };
    center.addEventListener('pointermove', (event) => {
      if (!dock.classList.contains('resting')) return;
      const r = dock.getBoundingClientRect();
      if (event.clientY < r.top - 8 || event.clientX < r.left || event.clientX > r.right) { stay(); return; }
      // On something to press there (a button low on the page, under where the box would be), it stays back: that is
      // what the pointer came for, and the box coming up would take the press.
      if ((event.target as Element).closest('button, a[href], select, summary, label, [role="button"]')) { stay(); return; }
      if (!coming) coming = window.setTimeout(() => { coming = 0; this.#rest(false); }, 220);
    });
    center.addEventListener('pointerleave', stay);
    prompt.addEventListener('focus', () => this.#rest(false));
  }
}

/**
 * What the box's Agent does its work with in `repo`, through the OS's own calls: its files read, and where it was
 * handed the work (`writes`: an issue's) edited and written, by the core's rules (repos/agent-hands.ts); its commands
 * run at once in a Prompt of its own, shown after in the repo's as the screen plays them (play.ts).
 */
function agentHands(repo: string, writes: boolean): Hands {
  return {...fileHands(repo, writes), run: async (command) => {
    const r = await agentSessionFor(repo).run(command);
    return {...r, given: await tail(r.output)};
  }};
}
