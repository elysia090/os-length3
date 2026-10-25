import {fieldMoved} from '../caret.ts';
import {h} from '../dom.ts';
import {errorText} from '../errors.ts';
import {keepOut, LAND, paced, putAway, still} from '../glide.ts';
import {t} from '../i18n.ts';
import {complete, pathWord, Recall} from '../recall.ts';
import {onChange, store, type Entry} from '../repos.ts';
import {boxMode, modeHint, modeMenu, MODES, nextIssue, onBoxMode, pillWords, sendAs, sendInto, sendTitle, sendWord, setBoxMode, turn, type Mode} from './box-modes.ts';
import type {Screen, ScreenState} from './screen.ts';
import {sessionFor, sessionIfAny, terminalFor, type Session} from './terminal.ts';
import {issueLook, lookFrom, todoLook} from './look.ts';
import {EditLine} from './edit-box.ts';
import type {Writing} from './reader.ts';

// The box at the foot of a work page's center (DESIGN.md § Forge, The box at the foot): one field, and at its left a
// pill that says what it does: Run in the repo's Prompt (the pill the prompt line the shell waits at), Write an issue,
// Add to TODO (box-modes.ts), Edit the file in front (edit-box.ts). Enter is a new line and Ctrl+Enter sends, as in
// every box one writes in; Edit's lines are one line each, done with Enter.
//
// What is written in it belongs to the repo and to what the box does: each keeps its own while the app runs, so going
// to another page and back keeps it, and switching repos swaps it for that repo's (or an empty box). Running, ↑ on the
// first line and ↓ on the last walk the repo's earlier lines, a run pressed in Output is put back in the box, and Tab
// completes the path before the caret from the repo's tree (several matches said in one quiet line under the box).
//
// While one reads (the center turned by the wheel, a touch or the keys) and the box is empty and not written in, it
// steps back and lets what is under it be pressed; the keyboard reaching it, a press on the Prompt, or the pointer
// resting at the center's foot brings it back where it was. A page read rather than written in (Git) has it stepped
// back from the start.

/** Choices said under the box after Tab, at most. */
const CHOICES = 24;

/** What was written in a box and not sent: by repo for Run, by what the box does and repo otherwise. */
const drafts = new Map<string, string>();

export interface BoxParts {
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
  /** A line of the box's own in the Prompt's flow pressed: the issue it wrote (its file, in `repo`), or Home's TODO. */
  went(repo: string, to: {issue: string} | 'todo'): void;
  /** A file of the repo shown in the center (Edit's @path). */
  reveal(path: string, line?: number, write?: Writing): void;
}

export class Box {
  readonly prompt = h('textarea', {class: 'prompt-in', rows: '1', 'aria-label': t('Prompt box'), spellcheck: 'false', autocapitalize: 'off'}) as HTMLTextAreaElement;
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

  #screen: Screen | null = null;
  #repo: string | null = null;
  #mode: Mode = boxMode();
  /** What Tab last said under the box, which goes as soon as anything else is done there. */
  #choices = false;
  /** The repo's earlier lines, walked with ↑ and ↓. */
  readonly #walk = new Recall();
  /** The repo's directories as Tab reads them: read ahead as a path is written, again once anything changes. */
  readonly #listed = new Map<string, Entry[] | Promise<Entry[]>>();
  readonly #modeWords = h('span', {class: 'prompt-mode', 'aria-hidden': 'true'});
  /** The key that brings the box up doing what it does now: ` for Run, G for Edit (Go to line, as editors have it). */
  readonly #summonKey = h('kbd', {}, '`');
  readonly #keys: string;
  readonly #menu: ReturnType<typeof modeMenu>;
  /** The Prompt followed (its prompt line, its lamp): the repo's own, a new one once it is started again. */
  #followed: Session | null = null;
  #unwatch: (() => void) | null = null;
  /** The prompt line each repo's shell last waited at: the pill's at rest, while a line runs or before it starts. */
  readonly #lastLine = new Map<string, string>();
  #saying = 0;
  #speaking = 0;
  /** Edit: the file in front, what a line would do shown on it. */
  readonly #edit: EditLine;

  readonly #p: BoxParts;

  constructor(p: BoxParts) {
    this.#p = p;
    // Run: Ctrl+Enter (⌘+Enter) is how it is done from the box, said in its title, not beside the word. Never Enter
    // alone: Enter is what confirms a Japanese conversion, and a line must not run because a word was chosen.
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    this.#keys = mac ? '⌘+Enter' : 'Ctrl+Enter';
    this.runIt = h('button', {type: 'submit', class: 'button small-button prompt-run', 'aria-keyshortcuts': mac ? 'Meta+Enter' : 'Control+Enter'}) as HTMLButtonElement;
    const lamp = h('span', {class: 'lamp'});
    this.chip = h('button', {type: 'button', class: 'prompt-chip', tabindex: '-1', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-mode': 'run'},
      lamp, this.waits, this.#modeWords) as HTMLButtonElement;
    // The keys that bring it up from anywhere, said at rest as keys are (Run says Ctrl+Enter in its title).
    const summon = h('span', {class: 'prompt-keys', 'aria-hidden': 'true'}, h('kbd', {}, mac ? '⌘' : 'Ctrl'), this.#summonKey);
    this.form = h('form', {class: 'prompt'}, this.chip, this.prompt, summon, this.runIt) as HTMLFormElement;
    this.line = [lamp, this.waits, this.prompt, this.runIt];
    this.dock = h('div', {class: 'dock'}, this.note, this.heard);
    // Put away with Escape, the keyboard goes back to the box if it was there (the Prompt not brought up for it), else
    // nowhere.
    this.#edit = new EditLine({box: this.prompt, main: p.main, dock: this.dock, repo: () => this.#repo, reveal: p.reveal,
      say: (text) => { if (this.#mode === 'edit') this.#say(text); }, moved: () => { if (this.#mode === 'edit') this.#pillSays(); },
      active: () => this.#mode === 'edit' && document.activeElement === this.prompt});
    this.#menu = modeMenu(this.chip, {repo: () => this.#repo, at: () => this.#edit.where(), chosen: (m) => { this.choose(m); this.prompt.focus(); },
      closed: (before) => { if (before === this.prompt) this.prompt.focus(); else (document.activeElement as HTMLElement | null)?.blur(); }});
    this.dock.append(this.#menu.element);
    this.#wire(summon);
    this.#stepsBack();
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
  set screen(s: Screen) { this.#screen = s; }
  get #up(): boolean { return this.#screen?.up ?? false; }

  /** As the screen goes up, starts down, or is the box's line again: what the line says, and how tall it is. */
  screenChanged(state: ScreenState) {
    this.#said();
    this.#fit();
    if (state === 'leaving' && this.#p.back) requestAnimationFrame(() => this.#rest(true));
  }

  /** The repo the box works on; null for none (the box can do nothing then). */
  setRepo(name: string | null) {
    if (name === this.#repo && name) { this.attach(); return; }
    this.#repo = name;
    this.attach();
    this.prompt.disabled = this.runIt.disabled = !name;
    this.#edit.cancel();
    this.#edit.hide();
    this.prompt.placeholder = modeHint(this.#mode, name);
    this.prompt.value = name ? drafts.get(this.#draft()) ?? '' : '';
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

  /** Ctrl+`: the box runs, and has the keyboard; false when it can do nothing (no repo). */
  summon(): boolean {
    if (this.prompt.disabled) return false;
    this.choose('run');
    this.prompt.focus();
    return true;
  }

  /** Ctrl+G: the box edits the file in front, and has the keyboard; false when it can do nothing (no repo). */
  edit(): boolean {
    if (this.prompt.disabled) return false;
    this.choose('edit');
    this.prompt.focus();
    return true;
  }

  /** The box made to do `m`: its pill turns to it, and what was half written for it comes back. */
  choose(m: Mode, seen = true) {
    // Told to the other pages' boxes once this one has turned (it hears its own telling, and is there already).
    if (m === this.#mode) { setBoxMode(m); return; }
    if (this.#up && m !== 'run') this.#screen?.lower();
    const change = () => {
      // A line taken into the box for Edit is let go as it was, not kept as a draft.
      if (this.#mode === 'edit') this.#edit.cancel();
      this.#keep();
      this.#mode = m;
      this.#pillSays();
      this.prompt.placeholder = modeHint(m, this.#repo, m === 'edit' ? this.#edit.where()?.file : null);
      this.prompt.value = this.#repo ? drafts.get(this.#draft()) ?? '' : '';
      this.#fit();
      this.#unsay();
      this.#say('');
      this.heard.textContent = '';
      // Edit shows what it would do on the file while the box has the keyboard; the others show nothing there.
      if (m === 'edit' && document.activeElement === this.prompt) this.#edit.show(); else this.#edit.hide();
    };
    if (seen && this.#p.work.isConnected && !this.#up) turn(this.chip, this.runIt, change); else change();
    setBoxMode(m);
  }

  /**
   * The repo's Prompt in this box. A Prompt is one element wherever it is shown, so another page's box (Git's) takes it
   * while it is there: coming back, it is put back here.
   */
  attach() {
    const {term, termHead} = this.#p;
    const el = this.#repo ? terminalFor(this.#repo) : null;
    if (el ? el.parentElement !== term : term.childElementCount > 1) term.replaceChildren(termHead, ...(el ? [el] : []));
    this.#following();
  }

  /** Whether the repo's Prompt has run anything yet, which is what gives it room. */
  room() { this.#p.work.classList.toggle('unrun', !!this.#repo && !sessionIfAny(this.#repo)?.runs.length); }

  // ---- What it says.

  #fit() { this.prompt.style.height = 'auto'; this.prompt.style.height = `${this.prompt.scrollHeight}px`; }
  /** What is half written is kept for the repo and for what the box does: an issue's words are not a line to run. */
  #draft() { return this.#mode === 'run' ? this.#repo! : `${this.#mode}\n${this.#repo}`; }
  #keep() { if (this.#repo) { if (this.prompt.value) drafts.set(this.#draft(), this.prompt.value); else drafts.delete(this.#draft()); } }
  /** Tab's choices go as the next key is pressed, not at once: put away as they came. */
  #unsay() {
    if (!this.#choices) return;
    this.#choices = false;
    putAway(this.note, () => { this.note.textContent = ''; this.note.classList.remove('paths'); });
  }
  /** Said under the box, at once (what was going out from there stays, saying this). */
  #say(text: string | Node[]) {
    keepOut(this.note);
    this.note.classList.remove('paths');
    const was = this.note.textContent;
    if (typeof text === 'string') this.note.textContent = text; else this.note.replaceChildren(...text);
    // Something else said in its place comes up out of a light fade, not swapped in one frame (from nothing it is at once).
    if (was && was !== this.note.textContent && !still()) this.note.animate([{opacity: .35}, {opacity: 1}], {duration: paced(140), easing: 'ease-out'});
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
    this.chip.dataset.mode = mode;
    this.form.dataset.mode = mode;
    this.#summonKey.textContent = mode === 'edit' ? 'G' : '`';
    this.#summonKey.classList.toggle('tick', mode !== 'edit');
    this.chip.setAttribute('aria-label', t('What the box does: {what}', {what: sendWord(mode)}));
    this.runIt.textContent = sendWord(mode);
    this.runIt.title = sendTitle(mode, this.#keys);
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
    // An issue written, the next number comes up into the pill as a counter's figure turns.
    const b = words.querySelector('b');
    if (mode === 'issue' && b && was && was !== '#' && b.textContent !== was && !still())
      b.animate([{translate: '0 11px', opacity: 0}, {translate: '0 0', opacity: 1}], {duration: paced(260), easing: LAND});
  }

  /**
   * The prompt line: up, the one the shell waits at now (none while a line runs); at rest, the last it waited at.
   * Come back after a run, it comes once what the run printed has come in (terminal.ts), as a terminal's does.
   */
  #said() {
    const repo = this.#repo, s = repo ? sessionIfAny(repo) : undefined;
    // Started again: the new one is followed from now on.
    if (this.#followed && (s ?? null) !== this.#followed) { this.#following(); return; }
    const line = s?.promptLine.trimEnd() ?? '';
    if (repo && line) this.#lastLine.set(repo, line);
    this.chip.dataset.state = !s ? 'none' : s.ended ? 'ended' : s.running ? 'on' : 'starting';
    const now = !repo ? '' : this.#up ? line : this.#lastLine.get(repo) ?? `${repo} $`;
    cancelAnimationFrame(this.#saying);
    clearTimeout(this.#speaking);
    if (!(this.#up && now && !this.waits.textContent) || still()) { this.waits.textContent = now; return; }
    // After the frame that draws what came, so the time its lines take to come in is known; then the prompt line and
    // the caret after it come together, as the last line comes.
    this.#saying = requestAnimationFrame(() => {
      this.#speaking = window.setTimeout(() => {
        this.waits.textContent = now;
        fieldMoved();
        this.waits.animate([{opacity: 0}, {opacity: 1}], {duration: 140, easing: 'ease-out'});
      }, s?.settlesIn() ?? 0);
    });
  }

  #following() {
    const s = this.#repo ? sessionIfAny(this.#repo) ?? null : null;
    if (s !== this.#followed) {
      this.#followed = s;
      this.#unwatch?.();
      this.#unwatch = s ? s.watch(() => this.#said()) : null;
      this.onFollow?.();
    }
    this.#said();
  }
  /** Told when another Prompt is followed (the reference reads its runs again). */
  onFollow: (() => void) | null = null;

  // ---- What is done in it.

  /** What is in the box goes to the repo's Prompt (an ended one is started again first), or is made as an issue or a TODO. */
  #send() {
    const repo = this.#repo;
    if (!repo) return;
    if (this.#mode === 'edit') { this.#edit.enter(); return; }
    if (this.#mode !== 'run') { void this.#write(this.#mode, repo); return; }
    const s = sessionIfAny(repo);
    // Ended: started again, and what was written waits in the box to be sent once it is up.
    if (s?.ended) { s.restart(); this.#following(); this.#say(t('Still starting')); return; }
    if (!sessionFor(repo).send(this.prompt.value)) { this.#say(t('Still starting')); return; }
    this.#unsay();
    this.#say('');
    this.prompt.value = '';
    drafts.delete(this.#draft());
    this.#walk.reset();
    this.room();
    this.#fit();
  }

  /**
   * An issue or a TODO written in the box: made, the box emptied, and what was written goes on into the right pane, a
   * line of its own in the repo's Prompt, among what was run there as it came (pressed, it goes to the issue or TODO).
   */
  async #write(as: 'issue' | 'todo', at: string) {
    const text = this.prompt.value;
    const land = sendInto(this.prompt);
    try {
      const sent = await sendAs(as, at, text);
      if (!sent) { this.#say(t('Its first line is its title')); return; }
      // Pressed, it opens where it stands (look.ts): the issue's summary, the TODO's mark; their page is a deed further.
      const to = sent.to, went = () => this.#p.went(at, 'issue' in to ? {issue: to.issue} : 'todo');
      const row = sessionFor(at).note(sent.head, sent.words,
        (pressed) => lookFrom(pressed, 'issue' in to ? issueLook(at, to.issue, went) : todoLook(to.todo, went)));
      if (this.prompt.value === text) { land(row); this.prompt.value = ''; drafts.delete(this.#draft()); this.#fit(); }
      this.heard.textContent = sent.said;
      this.#pillSays();
    } catch (e) { this.#say(errorText(e)); }
  }

  /** The repo's directory `dir` as Tab reads it, read once and kept until the repo changes. */
  #list(dir: string): Entry[] | Promise<Entry[]> {
    const key = `${this.#repo}\n${dir}`;
    let got = this.#listed.get(key);
    if (!got) {
      const reading: Promise<Entry[]> = store.tree(this.#repo!, dir).catch(() => [] as Entry[]);
      this.#listed.set(key, got = reading);
      void reading.then((e) => { if (this.#listed.get(key) === reading) this.#listed.set(key, e); });
    }
    return got;
  }
  /** The directory of the path being written, read ahead so Tab can answer at once. */
  #look() {
    const {prompt} = this, repo = this.#repo;
    const w = repo && prompt.selectionStart === prompt.selectionEnd ? pathWord(prompt.value, prompt.selectionStart, repo) : null;
    if (w) void this.#list(w.dir);
  }
  /**
   * Complete the path before the caret; false when there is none to complete. Edit's @path is read as a word of its
   * own (`text`: what is written, the @ a space).
   */
  #tab(text = this.prompt.value): boolean {
    const {prompt, note} = this, repo = this.#repo;
    if (!repo || prompt.selectionStart !== prompt.selectionEnd) return false;
    const at = prompt.selectionStart, w = pathWord(text, at, repo);
    if (!w) return false;
    const fill = (entries: Entry[]) => {
      const c = complete(w.name, entries);
      if (!c) return false;
      if (c.insert) {
        prompt.setRangeText(c.insert, at, at, 'end');
        this.#keep();
        this.#walk.reset();
        this.#fit();
        this.#look();
        if (this.#mode === 'edit') this.#edit.show();
      }
      if (c.choices.length) {
        this.#choices = true;
        this.#say(c.choices.slice(0, CHOICES).join('  ') + (c.choices.length > CHOICES ? '  …' : ''));
        note.classList.add('paths');
      }
      else this.#unsay();
      return true;
    };
    const got = this.#list(w.dir);
    if (!(got instanceof Promise)) return fill(got);
    // Not read yet (rare: it is read while the path is written): completed once it is.
    void got.then((entries) => { if (prompt.value.length >= at && prompt.selectionStart === at) fill(entries); });
    return true;
  }

  /** A key in the box. */
  #key(event: KeyboardEvent) {
    const {prompt} = this, repo = this.#repo;
    if (event.key !== 'Tab') this.#unsay();
    if (event.key === 'Escape') {
      // Editing, Escape lets a line taken go as it was, or takes back what was written, then gives the keyboard back to
      // the file at its caret.
      if (this.#mode === 'edit' && !event.isComposing) {
        event.preventDefault();
        if (this.#edit.cancel()) return;
        if (prompt.value) { this.#put(''); this.#edit.show(); return; }
        if (this.#edit.toFile()) return;
      }
      this.#screen?.lower();
      prompt.blur();
      return;
    }
    // Alt+1 to 4 choose what the box does; Alt+↓ brings the four out of the pill.
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing) {
      const n = /^Digit([1-9])$/.exec(event.code)?.[1];
      const m = n ? MODES[Number(n) - 1] : undefined;
      if (m) { event.preventDefault(); this.choose(m); return; }
      if (event.key === 'ArrowDown' && !this.#up && !prompt.disabled) { event.preventDefault(); this.#menu.open(); return; }
    }
    if (this.#mode === 'edit') { this.#editKey(event); return; }
    const sends = event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing;
    if (this.#mode !== 'run') { if (sends) { event.preventDefault(); this.#send(); } return; }
    const plain = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && !event.isComposing;
    if (event.key === 'Tab' && plain) { if (this.#tab()) event.preventDefault(); return; }
    // ↑ on the first line and ↓ on the last walk earlier lines; elsewhere they move the caret.
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && plain && prompt.selectionStart === prompt.selectionEnd) {
      const runs = repo ? sessionIfAny(repo)?.runs.map((r) => r.line) ?? [] : [];
      const line = this.#walk.arrow(event.key, prompt.value, prompt.selectionStart, runs);
      if (line === null) return;
      event.preventDefault();
      this.#put(line);
      return;
    }
    // Ctrl-C with nothing selected (so not a copy) interrupts what runs, as in a terminal.
    if (event.key === 'c' && event.ctrlKey && !event.altKey && !event.metaKey && prompt.selectionStart === prompt.selectionEnd && repo) {
      event.preventDefault();
      sessionFor(repo).interrupt();
      return;
    }
    // Enter is a new line; Ctrl+Enter (⌘+Enter) sends.
    if (sends) { event.preventDefault(); this.#send(); }
  }

  /**
   * A key in the box while it edits: Enter does what is written (Shift+Enter: a word found, the one before); in the
   * empty box ↑ and ↓ move the caret's line and Ctrl+Z takes back what the box did (Ctrl+Shift+Z, Ctrl+Y: puts it
   * back); Tab completes @path.
   */
  #editKey(event: KeyboardEvent) {
    const {prompt} = this, edit = this.#edit;
    // Never the Enter that confirms a Japanese conversion.
    if (event.isComposing || event.keyCode === 229) return;
    const mod = event.ctrlKey || event.metaKey, empty = !prompt.value;
    if (event.key === 'Enter' && !event.altKey) { event.preventDefault(); edit.enter(event.shiftKey); return; }
    // A line taken: ↑ and ↓ (nothing written in it yet) take the one above or below; Tab is a tab in it, as in the file.
    if (edit.taken && !mod && !event.altKey && !event.shiftKey) {
      if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && edit.stepTaken(event.key === 'ArrowUp' ? -1 : 1)) event.preventDefault();
      if (event.key === 'Tab') { event.preventDefault(); document.execCommand('insertText', false, '\t'); }
      return;
    }
    if (event.key === 'Tab' && !mod && !event.altKey && !event.shiftKey && prompt.value.startsWith('@')) {
      if (this.#tab(` ${prompt.value.slice(1)}`)) event.preventDefault();
      return;
    }
    if (!empty) return;
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !mod && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      edit.step(event.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    const k = event.key.toLowerCase();
    if (mod && !event.altKey && (k === 'z' || k === 'y')) { event.preventDefault(); edit.undo(k === 'y' || event.shiftKey); }
  }

  #wire(summon: HTMLElement) {
    const {prompt, form, chip, runIt, dock} = this, {term} = this.#p;
    prompt.addEventListener('focus', () => {
      if (this.#mode === 'run') this.#screen?.raise();
      this.#following();
      if (this.#mode === 'edit' && !this.#edit.busy) { this.#pillSays(); this.#edit.show(); }
    });
    // Left while editing (not for the file a moment, to write in it), what it would do is put away.
    prompt.addEventListener('blur', () => { if (this.#mode === 'edit' && !this.#edit.busy) { this.#edit.hide(); this.#say(''); } });
    prompt.addEventListener('input', () => {
      this.#fit();
      this.#keep();
      this.#walk.reset();
      this.#unsay();
      this.#look();
      if (this.#mode === 'edit' && !this.#edit.busy) this.#edit.show();
    });
    prompt.addEventListener('keydown', (event) => this.#key(event));
    // Run sends as Ctrl+Enter does; pressed with the pointer, the keyboard stays in the box.
    runIt.addEventListener('pointerdown', (event) => { if (document.activeElement === prompt) event.preventDefault(); });
    form.addEventListener('submit', (event) => { event.preventDefault(); this.#send(); prompt.focus(); });
    // The pill pressed at rest brings out what the box can do; up as the screen's prompt line, it is the line's start.
    chip.addEventListener('click', () => { if (!this.#up && !prompt.disabled) this.#menu.open(); });
    // Pressed anywhere in the box, not on its line alone (its padding, beside Run): the caret goes in.
    form.addEventListener('pointerdown', (event) => {
      const on = event.target as Node;
      if (chip.contains(on) && !this.#up) return;
      if ((on !== form && !chip.contains(on) && on !== summon) || prompt.disabled) return;
      event.preventDefault();
      prompt.focus();
    });
    // Leaving the box and the Prompt sends the Prompt home; losing the window's focus does not.
    dock.addEventListener('focusout', (event) => {
      const to = event.relatedTarget as Node | null;
      if (to && !dock.contains(to)) this.#screen?.lower();
    });
    // Switched on again from the screen, the keyboard is back in the box (the switch it was on is gone with the old one).
    term.addEventListener('click', (event) => {
      if (this.#up && (event.target as Element).closest('.power')) requestAnimationFrame(() => prompt.focus());
    });
    // Its ×, pressed, keeps the keyboard in the box until the Prompt is down, then lets it go, as Escape does.
    const shut = this.#p.termHead.querySelector<HTMLElement>('.term-shut');
    shut?.addEventListener('pointerdown', (event) => event.preventDefault());
    shut?.addEventListener('click', () => { this.#screen?.lower(); prompt.blur(); });
    term.addEventListener('pointerdown', (event) => {
      if (this.#up || (event.target as HTMLElement).closest('button')) return;
      event.preventDefault();
      prompt.focus();
    });
  }

  // ---- Stepping back while one reads.

  #rest(on: boolean) {
    if (on && (this.#up || this.prompt.value || this.note.textContent || document.activeElement === this.prompt)) return;
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
