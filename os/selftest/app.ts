// The app as a person meets it, in its own words: the rail's places, the
// pages' parts, what one does there. Specs say what a person does
// (`app.rail.go('forge')`, `app.newRepo.make('hello', {template: 'C'})`,
// `app.forge.editFile('README.md', '…')`) and assert what they see.
//
// Everything is found by role and accessible name, the way assistive
// technology finds it, never by CSS class: a page restyled keeps its tests,
// and a word changed is changed here once. Nothing waits a fixed time: each
// step waits for what it needs (Playwright's auto-waiting and web-first
// assertions).

import {expect, type Locator, type Page} from '@playwright/test';
import TEMPLATES from '../shared/templates.json' with {type: 'json'};

/** The rail's places, as the rail names them (in English). */
export const PLACES = {
  home: 'Home', forge: 'Forge', file: 'File', git: 'Git', runtime: 'Runtime',
  remote: 'Remote', server: 'Server', inbox: 'Inbox', plugin: 'Plugin', 'new-repo': 'New repo',
} as const;
export type Place = keyof typeof PLACES;

/** The name a person claims in Inbox for their display name ('Ada 1a2b3c4d' → 'ada-1a2b3c4d'). */
export const handleOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 31);

/** `text` as a regular expression that matches it literally. */
export const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class App {
  readonly page: Page;
  readonly rail: Rail;
  readonly me: MeMenu;
  readonly home: Home;
  readonly newRepo: NewRepo;
  readonly forge: Forge;
  readonly file: FileTree;
  readonly git: Git;
  readonly remote: Remote;
  readonly runtime: Runtime;
  readonly inbox: Inbox;
  readonly server: Server;
  readonly stripe: Stripe;

  constructor(page: Page) {
    this.page = page;
    this.rail = new Rail(this);
    this.me = new MeMenu(this);
    this.home = new Home(this);
    this.newRepo = new NewRepo(this);
    this.forge = new Forge(this);
    this.file = new FileTree(this);
    this.git = new Git(this);
    this.remote = new Remote(this);
    this.runtime = new Runtime(this);
    this.inbox = new Inbox(this);
    this.server = new Server(this);
    this.stripe = new Stripe(this);
  }

  /** The page the rail chose. */
  get main(): Locator { return this.page.getByRole('main'); }

  /**
   * This browser has a platform authenticator that says yes at once (Chromium's virtual one,
   * over CDP): a passkey made or asked for here is made or given without a person at a sensor.
   */
  async withPasskeys() {
    const cdp = await this.page.context().newCDPSession(this.page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    }});
  }

  /** Open the app and wait until it has drawn what it knows. */
  async open() {
    await this.page.goto('/');
    await this.settled();
  }

  /** The first look at the Remote is done and the page drawn from it (main is busy until then). */
  async settled() {
    await expect(this.main).not.toHaveAttribute('aria-busy', 'true');
  }

  /**
   * Answer an ask with `yes`: a deed that comes under the pointer holds still a moment (so a double
   * click cannot answer it), so it is pressed until the ask (`ask`) is gone.
   */
  async answer(yes: Locator, ask: Locator) {
    await expect(async () => {
      if (await yes.isVisible()) await yes.click({timeout: 1000});
      await expect(ask).toBeHidden({timeout: 1000});
    }).toPass({timeout: 15_000});
  }

  /**
   * The person comes back to this window: the app looks at once for what came meanwhile (the
   * Remote's changes, messages, posts), as it does otherwise every little while. Headless, a
   * window never loses its focus, so it is said to it as the browser says it.
   */
  async comeBack() {
    await this.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  }

  /** Who is signed in here (as the development provider was told), and the Inbox name they claim. */
  person = '';
  get handle() { return handleOf(this.person); }

  /** Sign in through the Remote's development provider as `name`; back on Remote, signed in. */
  async signIn(name: string) {
    await this.rail.go('remote');
    await this.main.getByRole('button', {name: 'Continue with Development'}).click();
    await this.atProvider(name);
    await this.settled();
    await expect(this.remote.part('Repos')).toBeVisible();
  }

  /**
   * At the development provider, gone to from a sign-in card: who one is there (`name`), then what length3 asks
   * of it, answered `answer` (Allow signs in; Cancel goes back with nothing shared). (Not reached: the card says
   * why, in its alert.)
   */
  async atProvider(name: string, answer: 'Allow' | 'Cancel' = 'Allow') {
    if (answer === 'Allow') this.person = name;
    await expect(this.page, 'the provider\'s page').toHaveTitle(/Development provider/);
    await this.page.getByRole('textbox', {name: 'Name'}).fill(name);
    await this.page.getByRole('button', {name: 'Continue'}).click();
    await expect(this.page.getByRole('heading', {name: 'length3 wants to access your Development account'})).toBeVisible();
    await this.page.getByRole('button', {name: answer, exact: true}).click();
  }
}

class Part {
  protected readonly app: App;
  constructor(app: App) { this.app = app; }
  protected get page() { return this.app.page; }
  protected get main() { return this.app.main; }
}

/** The rail at the left: one place at a time; File and Server open over the page. */
class Rail extends Part {
  button(place: Place): Locator {
    // Its name says more while something is to be seen there ("Inbox has messages not read").
    // The rail is named in the language spoken; its places keep their names in both.
    return this.page.getByRole('navigation', {name: /^(Purposes|目的)$/}).getByRole('button', {name: new RegExp(`^${PLACES[place]}( |$)`)});
  }

  async go(place: Place) {
    await this.button(place).click();
    if (place !== 'file' && place !== 'server' && place !== 'plugin') await expect(this.button(place)).toHaveAttribute('aria-current', 'page');
  }
}

/** The person's own icon at the foot of the rail, and its menu. */
class MeMenu extends Part {
  get button() { return this.page.getByRole('button', {name: 'Me', exact: true}); }
  get menu() { return this.page.getByRole('menu', {name: 'Me'}); }

  async openMenu() {
    await this.button.click();
    await expect(this.menu).toBeVisible();
  }

  /** Language, then the one chosen: the OS speaks it at once. `now` is the language in use, as it names itself. */
  async language(now: string, to: string) {
    await this.openMenu();
    await this.menu.getByRole('menuitem', {name: now}).click();
    await this.menu.getByRole('menuitemradio', {name: to}).click();
  }
}

/** Home: the profile, the TODO, the repos. */
class Home extends Part {
  get todo() { return this.main.getByRole('region', {name: /^TODO/}); }
  /** The TODO's items, one each (the last is always the empty one to write in). */
  get items() { return this.todo.getByRole('listitem'); }
  /** An item's first line, its detail, and its ○. */
  title(item: Locator) { return item.getByRole('textbox', {name: 'What to do'}); }
  detail(item: Locator) { return item.getByRole('textbox', {name: 'Detail'}); }
  mark(item: Locator) { return item.getByRole('button', {name: /^Mark as (not )?done$/}); }
}

/** + : a new repo from the one scaffold (C's files), with what it is for written into its README. */
class NewRepo extends Part {
  get name() { return this.main.getByRole('textbox', {name: 'Name', exact: true}); }
  get summary() { return this.main.getByRole('textbox', {name: 'Summary'}); }
  get create() { return this.main.getByRole('button', {name: 'Create'}); }
  /** What is said under the name when it cannot be used. */
  get problem() { return this.main.getByRole('alert'); }
  get made() { return this.main.getByRole('status'); }
  /** Forge holding `name`'s page: where a repo made is gone into. */
  madeIn(name: string) { return this.page.getByRole('region', {name: `The files of ${name}`, exact: true}); }

  /**
   * Fill the form and press Create (the outcome is the caller's to check). There is no template to
   * choose: every repo starts from the one scaffold (a README, docs/ and issue/).
   */
  async fill(name: string, o: {template?: 'C'; summary?: string} = {}) {
    await this.app.rail.go('new-repo');
    await this.name.fill(name);
    if (o.summary) await this.summary.fill(o.summary);
    await this.create.click();
  }

  /**
   * Make a repo and see it made: Forge opens it. `template: 'C'`: then C's files are written into it from File, as
   * someone would (src/main.c and its Makefile, as `l3 repo new -t c` makes them), and Forge shows it.
   */
  async make(name: string, o: {template?: 'C'; summary?: string} = {}) {
    await this.fill(name, o);
    await expect(this.madeIn(name)).toBeVisible();
    if (o.template !== 'C') return;
    const c = new Map(TEMPLATES.find((t) => t.id === 'c')!.files as [string, string][]);
    await this.app.file.named(name, '', 'New folder', 'src');
    await this.app.file.named(name, 'src', 'New file', 'main.c');
    await this.app.forge.editFile('src/main.c', c.get('src/main.c')!);
    await this.app.file.named(name, '', 'New file', 'Makefile');
    await this.app.forge.editFile('Makefile', c.get('Makefile')!.replaceAll('{name}', name));
  }

  /** Made: Forge has it open, its README there to write in. */
  async openInForge() {
    await expect(this.app.forge.editor('README.md')).toBeVisible();
  }
}

/** Forge: the band of repos and the search on the top line, the files one after another, the right pane at the right. */
class Forge extends Part {
  get band() { return this.main.getByRole('navigation', {name: 'repo'}); }
  get search() { return this.main.getByRole('searchbox', {name: 'Search this repo'}); }
  /**
   * Under the search box while it (or what is under it) has the keyboard, or something is read there: Issue,
   * diff and Output side by side, and the large box with what was searched and read in a line.
   */
  get results() { return this.main.getByRole('region', {name: 'Search results'}); }
  /** What the center refers to: under the search box (issues, the diff, what was run). */
  get reference() { return this.results; }
  /** Issue, diff or Output, side by side under the box. */
  kind(view: 'Issue' | 'diff' | 'Output') { return this.results.getByRole('group', {name: 'What to look in'}).getByRole('button', {name: view, exact: true}); }
  /** The switch at the top line's right end that puts the right pane away and brings it back. */
  get paneSwitch() { return this.main.getByRole('button', {name: 'Right pane', exact: true}); }
  /** A file's text, which is where it is edited. */
  editor(path: string) { return this.main.getByRole('textbox', {name: `Edit ${path}`, exact: true}); }

  /** Open `repo` in Forge (from its card on Home, as a person would). */
  async open(repo: string) {
    await this.app.rail.go('forge');
    const pill = this.band.getByRole('button', {name: repo, exact: true});
    await pill.click();
    await expect(this.editor('README.md')).toBeVisible();
  }

  /** What a file's header says: nothing while it is simply saved ('Unsaved', or why it could not be). */
  fileState(path: string) {
    // The header is the file's place in "/" (/root/<repo>/<path>), then what it says.
    return this.main.getByRole('heading', {name: new RegExp(`^/root/[^/]+/${escape(path)}( |$)`)}).getByRole('status');
  }

  /** Write `text` as the whole of `path` and leave it, which saves it; saved, its header says nothing. */
  async editFile(path: string, text: string) {
    const editor = this.editor(path);
    await editor.fill(text);
    // Not waited for as "Unsaved": a pause of 0.7 s saves it, and a slow machine may take longer than
    // that to look (`writeOn` holds the clock for a step that needs it unsaved). What counts is that it is saved.
    // Leaving the text saves it at once (as do Ctrl+S and a moment's pause).
    await editor.press('Escape');
    await expect(this.fileState(path)).toBeHidden();
    await expect(editor).toHaveValue(text);
  }

  /** Search the open repo: what is found opens under the box. */
  async find(query: string) {
    await this.search.fill(query);
    await expect(this.results).toBeVisible();
    await expect(this.results.getByText('Searching…')).toBeHidden();
  }

  /** A line found by the search, by its text. */
  hit(text: string | RegExp) { return this.results.getByRole('button', {name: text}); }

  /** The text selected in a file's editor (where the search or a diff opened it). */
  selected(path: string) {
    return this.editor(path).evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd));
  }

  /** 'Issue', 'diff' or 'Output' pressed under the search box (pressed with nothing typed: what there is of it). */
  async show(view: 'Issue' | 'diff' | 'Output') {
    await this.search.click();
    const b = this.kind(view);
    if (await b.getAttribute('aria-pressed') !== 'true') await b.click();
    await expect(b).toHaveAttribute('aria-pressed', 'true');
  }

  /** A changed file's diff, read in the box under the search (from diff's list). */
  async openDiff(path: string) {
    await this.show('diff');
    await this.results.getByRole('button', {name: new RegExp(`^${escape(path)}( |$)`)}).click();
  }

  /** A run read in the box under the search (from Output's list), by its line. */
  async readRun(line: string) {
    await this.show('Output');
    await this.results.getByRole('button', {name: new RegExp(`^${escape(line)} `)}).first().click();
  }

  /** The prompt box at the center's foot, and the Prompt (the repo's sh) it writes to. */
  get promptBox() { return this.main.getByRole('textbox', {name: 'Prompt box', exact: true}); }
  get prompt() { return this.main.getByRole('region', {name: 'Prompt', exact: true}); }

  /** What is said under the prompt box (the choices Tab found, Still starting…). */
  promptSays(text: string | RegExp) { return this.main.getByRole('status').filter({hasText: text}); }

  /** Start the open repo's Prompt by writing to it, and wait for its prompt line (`hello $ `). */
  async startPrompt(repo: string) {
    await this.promptBox.focus();
    await expect(this.prompt).toContainText(new RegExp(`${escape(repo)} \\$|Could not start`), {timeout: 240_000});
    await expect(this.prompt).not.toContainText('Could not start');
  }

  /** Write `line` in the prompt box and send it (Ctrl+Enter; Enter is a new line). */
  async run(line: string) {
    await this.promptBox.fill(line);
    await this.promptBox.press('Control+Enter');
    await expect(this.promptBox).toHaveValue('');
  }

  /** A run read under the search box (`readRun`), its line: pressed, it is put back in the prompt box. */
  ran(line: string) { return this.reference.getByRole('button', {name: line, exact: true}); }

  /**
   * Write `text` as the whole of `path` and go on writing: it stays unsaved for as long as the
   * steps after it take. (A pause in writing saves it, 0.7 s on the page's clock, so that clock is
   * held still from here: only `lookUntil` moves it, a little at a time, and `writingDone` lets it run.)
   */
  async writeOn(path: string, text: string) {
    // Its time starts as this machine's now, and is held a little ahead of it (never behind, however slow the step).
    await this.page.clock.install();
    await this.page.clock.pauseAt(Date.now() + 2000);
    await this.editor(path).fill(text);
    await expect(this.fileState(path)).toHaveText('Unsaved');
  }

  /** The page's clock runs again (after `writeOn`). */
  async writingDone() { await this.page.clock.resume(); }

  /**
   * Look for what the Remote has (as on coming back to the window) until `what` shows, the held
   * clock stepped on a little each time so what the look schedules runs, never as far as a save.
   */
  async lookUntil(what: Locator) {
    await expect(async () => {
      await this.app.comeBack();
      await this.page.clock.runFor(20);
      await expect(what).toBeVisible({timeout: 500});
    }).toPass({timeout: 15_000});
  }

  /** What Forge asks when a file open here with unsaved words was saved elsewhere. */
  get changedElsewhere() { return this.main.getByRole('group', {name: 'Changed elsewhere'}); }

  /**
   * Put `path` back as it was at the last commit, from its head in the diff: it asks in the head
   * (what will happen, Not now, Put back), which is answered. `says` is what it should say it does.
   */
  async putBack(path: string, says: string) {
    await this.openDiff(path);
    await this.reference.getByRole('button', {name: `Put back ${path}`, exact: true}).click();
    await expect(this.reference.getByText(says)).toBeVisible();
    await this.app.answer(this.reference.getByRole('button', {name: 'Put back', exact: true}), this.reference.getByRole('button', {name: 'Not now'}));
  }

  /** A line of the diff, by what it says: pressed, it is marked as with a highlighter. */
  diffLine(text: string) { return this.reference.getByRole('button', {name: text, exact: true}); }
}

/** File: the tree of "/" over the page. */
class FileTree extends Part {
  get tree() { return this.page.getByRole('tree', {name: '/'}); }
  /** The tree's row for a repo or a file (its name, which is pressed to choose it), wherever it is. */
  name(text: string) { return this.tree.getByRole('button', {name: text, exact: true}); }

  async openTree() {
    // Out is what File's button says, not whether the tree is still seen: put away a moment ago, it fades for a
    // moment while no longer out.
    const file = this.app.rail.button('file');
    if (await file.getAttribute('aria-expanded') !== 'true') await file.click();
    await expect(file).toHaveAttribute('aria-expanded', 'true');
    await expect(this.tree).toBeVisible();
  }

  /**
   * The item for `path` in `repo` ('' for the repo itself), with the tree out and every folder
   * down to it opened (the repo's own too, when `open`).
   */
  async item(repo: string, path = '', o: {open?: boolean} = {}): Promise<Locator> {
    await this.openTree();
    let at = this.tree.getByRole('treeitem', {name: 'root', exact: true}).getByRole('treeitem', {name: repo, exact: true});
    let name = repo;
    for (const part of path ? path.split('/') : []) {
      await this.expand(at, name);
      at = at.getByRole('treeitem', {name: part, exact: true});
      name = part;
    }
    if (o.open) await this.expand(at, name);
    await expect(at).toBeVisible();
    return at;
  }

  /** Choose `path` of `repo` in the tree: each folder down to it opened, then the file pressed. */
  async open(repo: string, path: string) {
    const item = await this.item(repo, path);
    await item.getByRole('button', {name: path.split('/').at(-1)!, exact: true}).first().click();
  }

  /** Bring a repo that is only on the Remote here, from its row (it says Remote): Forge then shows it. */
  async bring(repo: string) {
    const item = await this.item(repo);
    await expect(item).toContainText('Remote');
    await item.getByRole('button', {name: repo, exact: true}).click();
    await expect(this.app.forge.editor('README.md')).toBeVisible();
  }

  /** Open a folder of the tree (its triangle), unless it is open. */
  private async expand(item: Locator, name: string) {
    const toggle = item.getByRole('button', {name: new RegExp(`^(Open|Close) ${escape(name)}$`)}).first();
    // The tree may open it by itself meanwhile (a file just made there): read, press, and see again, as a person does.
    await expect(async () => {
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true', {timeout: 1000});
    }).toPass({timeout: 15_000});
  }

  async close() {
    await this.page.keyboard.press('Escape');
    await expect(this.tree).toBeHidden();
  }

  /** A row's menu (its deeds at its right end: New file, New folder, Rename, Delete), by where the row is. */
  async deeds(repo: string, path = '') {
    const name = path ? path.split('/').at(-1)! : repo;
    const item = await this.item(repo, path);
    await item.getByRole('button', {name: `What to do with ${name}`, exact: true}).first().click();
    const menu = this.page.getByRole('menu', {name, exact: true});
    await expect(menu).toBeVisible();
    return menu;
  }

  /** In a row's menu: a deed that asks for a name (New file, New folder, Rename), the name written, Enter. */
  async named(repo: string, path: string, deed: 'New file' | 'New folder' | 'Rename', name: string) {
    const menu = await this.deeds(repo, path);
    await menu.getByRole('menuitem', {name: deed}).click();
    const field = menu.getByRole('textbox');
    await field.fill(name);
    await field.press('Enter');
  }

  /** Delete a row from its menu, answering its ask (what it says is the caller's to check first, if wanted). */
  async remove(repo: string, path: string) {
    const menu = await this.deeds(repo, path);
    await menu.getByRole('menuitem', {name: 'Delete'}).click();
    await this.app.answer(menu.getByRole('button', {name: 'Delete', exact: true}), menu);
  }
}

/** Git: the issues, each a box with Start, Commit, Push; under it Review and Merge. */
class Git extends Part {
  /** The issue's box, by its name as it is shown (#1 Fix：title); its neighbours show only their heads. */
  issue(name: string) { return this.main.getByRole('heading', {name, exact: true, level: 2}); }
  get review() { return this.main.getByRole('region', {name: 'Review'}); }

  /** Write an issue in `repo`, its first line named like a TODO ("Fix: title"). */
  async write(repo: string, first: string, detail = '') {
    await this.app.rail.go('git');
    await this.main.getByRole('button', {name: 'Write an issue'}).click();
    // Where it goes is chosen in the one row of repos above the box, as the issues shown are.
    await this.repos.getByRole('radio', {name: repo, exact: true}).click();
    await expect(this.firstLine).toHaveAccessibleDescription(repo);
    await this.main.getByRole('textbox', {name: 'First line as Kind: title'}).fill(first);
    if (detail) await this.main.getByRole('textbox', {name: 'Summary'}).fill(detail);
    await this.main.getByRole('button', {name: 'Create'}).click();
  }

  /** The one row of repos above the issues: which are shown, and, while one is written, where it goes. */
  get repos() { return this.main.getByRole('radiogroup', {name: 'repo'}); }
  /** A new issue's first line, which says the repo it goes in (its description). */
  get firstLine() { return this.main.getByRole('textbox', {name: 'First line as Kind: title'}); }

  /** A step's button in the issue on screen (Start, Commit, Push, Merge…): only the issue on screen has them. */
  step(name: string) { return this.main.getByRole('button', {name, exact: true}); }

  /** The issues not done with yet (each a box, one on screen), or what is said in their place. */
  get issues() { return this.main.getByRole('region', {name: /^Issues/}); }

  /** One of the sections under the issues, by its heading: main (what main has not committed), Merged, Closed. */
  section(name: 'main' | 'Committed' | 'Merged' | 'Closed') { return this.main.getByRole('region', {name: new RegExp(`^${name}( \\d+)?$`)}); }
  /** main's card for `repo`, while something there is not committed. */
  mainCard(repo: string) { return this.section('main').getByRole('group', {name: `Not committed on main in ${repo}`}); }
  /** A commit made on main from here: its line, under the issues in Committed. */
  committed(title: string) { return this.section('Committed').getByText(title); }

  /** Commit what main has not committed in `repo`, its line written as Kind: title (Enter commits it). */
  async commitOnMain(repo: string, line: string) {
    await this.app.rail.go('git');
    const card = this.mainCard(repo);
    await card.getByRole('button', {name: 'Commit', exact: true}).click();
    const field = card.getByRole('textbox', {name: 'The commit\'s line as Kind: title'});
    await expect(field).toBeFocused();
    await field.fill(line);
    await this.commitLine(repo);
  }

  /**
   * Enter in main's card commits its line, or says under it why not. Within a moment of the ask
   * coming it is not taken (a double press is not an answer), so it is pressed until one happens.
   */
  async commitLine(repo: string) {
    const card = this.mainCard(repo);
    const field = card.getByRole('textbox');
    const said = card.getByRole('alert');
    await expect(async () => {
      if (await field.isVisible()) await field.press('Enter', {timeout: 1000});
      expect(!(await card.isVisible()) || !!(await said.textContent({timeout: 1000}))?.trim()).toBe(true);
    }).toPass();
  }

  /** Start the issue on screen, make the change in Forge, then Commit and Push it: handed in for review. */
  async handIn(edit: {path: string; text: string}) {
    await this.step('Start').click();
    await expect(this.step('Back to main')).toBeVisible();
    // The work is done where files are written: in Forge, on the issue's own copy.
    await this.app.rail.go('forge');
    await this.app.forge.editFile(edit.path, edit.text);
    await this.app.rail.go('git');
    await this.step('Commit').click();
    await expect(this.step('Push')).toBeEnabled();
    await this.step('Push').click();
    await expect(this.review).toBeVisible();
  }
}

/** Remote: the canonical copy; signed in, its parts (Repos, Sign-in, Devices, Plan). */
class Remote extends Part {
  /** One of its parts, by the heading that switches to it (a count may follow the word). */
  part(name: 'Repos' | 'Sign-in' | 'Devices' | 'Plan') { return this.main.getByRole('tab', {name: new RegExp(`^${name}`)}); }
  /** The Plan part's panel. */
  get plan() { return this.main.getByRole('tabpanel', {name: /^Plan/}); }
  /** A tier's card, by its name (Free plan, Go plan, Pro plan, Max plan): under the Plan signed in, under the way in signed out. */
  tier(name: string) { return this.main.getByRole('region', {name: 'Plans'}).getByRole('group', {name, exact: true}); }
  /** What the Plan says of the last trip to Stripe, above it. */
  get told() { return this.plan.getByRole('status').first(); }
  /** What is bought, asked before payment: Subscribe to Pro. */
  asking(tier: string) { return this.main.getByRole('group', {name: `Subscribe to ${tier}`}); }

  /** Subscribe to a tier (Go, Pro, Max) from its card on the Plan, then on to Stripe's Checkout. */
  async subscribe(tier: string) {
    await this.part('Plan').click();
    await this.tier(`${tier} plan`).getByRole('button', {name: 'Subscribe'}).click();
    await this.asking(tier).getByRole('button', {name: 'Continue to payment'}).click();
    await expect(this.page.getByText(`Subscribe to ${tier}`, {exact: true})).toBeVisible();
  }
  /** A repo's card, by its name. */
  card(repo: string) { return this.main.getByRole('tabpanel', {name: /^Repos/}).getByRole('group', {name: repo, exact: true}).first(); }
  /** What a card asks before its repo is turned off (a group of its own, named by the repo, inside the card). */
  ask(repo: string) { return this.card(repo).getByRole('group', {name: repo, exact: true}); }
  /** Its power switch: on while the Remote keeps it on. */
  power(repo: string) { return this.card(repo).getByRole('switch'); }
  /**
   * Turn `repo` off from its card, as its switch asks: with no code yet the code is set first
   * (a passkey made and confirmed with it), then the names and the code are asked once.
   */
  async turnOff(repo: string, code: string) {
    await this.power(repo).click();
    const ask = this.ask(repo);
    const fresh = ask.getByRole('textbox', {name: 'New code'});
    const name = ask.getByRole('textbox', {name: 'Your name'});
    await expect(fresh.or(name)).toBeFocused();
    if (await fresh.isVisible()) {
      await fresh.fill(code);
      await this.app.answer(ask.getByRole('button', {name: 'Set the code'}), fresh);
    }
    await expect(name).toBeFocused();
    await name.fill(this.app.person);
    await ask.getByRole('textbox', {name: 'The repo\'s name'}).fill(repo);
    await ask.getByRole('textbox', {name: 'Code', exact: true}).fill(code);
    await this.app.answer(ask.getByRole('button', {name: 'Turn off'}), ask);
  }

  /** Who sees it: Share opens the list of one's servers, the ones it is shown in checked. */
  async share(repo: string) {
    await this.card(repo).getByRole('button', {name: 'Share'}).click();
    const list = this.card(repo).getByRole('menu', {name: 'Share'});
    await expect(list).toBeVisible();
    return list;
  }
}

/** Runtime: this device, the environments, the dotfiles. */
class Runtime extends Part {
  /** One of its parts, by the heading that switches to it (a count may follow the word). */
  part(name: 'This browser' | 'Prompts running' | 'Environments' | 'Dotfiles') { return this.main.getByRole('tab', {name: new RegExp(`^${name}`)}); }
  /** Runtime, at part `name`. */
  async open(name: 'This browser' | 'Prompts running' | 'Environments' | 'Dotfiles') {
    await this.app.rail.go('runtime');
    await this.part(name).click();
    await expect(this.part(name)).toHaveAttribute('aria-selected', 'true');
  }
  get dotfiles() { return this.main.getByRole('tabpanel', {name: /^Dotfiles/}); }
  /** Stop every Prompt running (Runtime's Prompts running, each card's Stop): what one had open can then be freed. */
  async stopPrompts() {
    await this.open('Prompts running');
    const panel = this.main.getByRole('tabpanel', {name: /^Prompts running/});
    const stop = panel.getByRole('button', {name: 'Stop', exact: true});
    await expect(stop.first()).toBeVisible();
    while (await stop.count()) await stop.first().click();
  }
  /** A dotfile's card (its name, then its size). */
  dotfile(name: string) { return this.dotfiles.getByRole('button', {name: new RegExp(`^${escape(name)} `)}); }
  /** The text of the dotfile open under the cards (its field is named by the file). */
  text(name: string) { return this.dotfiles.getByRole('textbox', {name, exact: true}); }

  /** Remove, under the open dotfile's text: it asks in the box first, and that ask is returned. */
  async askRemove(name: string) {
    await this.dotfiles.getByRole('button', {name: 'Remove', exact: true}).click();
    const ask = this.dotfiles.getByRole('group', {name: `Remove ${name}`, exact: true});
    await expect(ask).toBeVisible();
    return ask;
  }

  /** Make a dotfile and save it. */
  async makeDotfile(name: string, text: string) {
    await this.open('Dotfiles');
    await this.dotfiles.getByRole('button', {name: /New dotfile/}).click();
    const field = this.dotfiles.getByRole('textbox', {name: 'Name', exact: true});
    await field.fill(name);
    // The text's field is named by the name it was offered with (.profile first).
    await this.dotfiles.getByRole('textbox').nth(1).fill(text);
    await this.dotfiles.getByRole('button', {name: 'Save', exact: true}).click();
  }
}

/** Inbox: your name, the conversations, the one open. */
class Inbox extends Part {
  get conversations() { return this.main.getByRole('navigation', {name: 'Conversations'}); }
  /** A conversation in the list, by the other's name or address (it shows both, then the last message). */
  conversation(who: string) { return this.conversations.getByRole('button', {name: who}); }
  get message() { return this.main.getByRole('textbox', {name: 'Message', exact: true}); }
  /** The conversation open at the right, named by the other (their name on this Remote). */
  thread(who: string) { return this.main.getByRole('region', {name: `Conversation with ${who}`, exact: true}); }

  /** Claim `name` on this Remote (the stub before there is one); claimed, the stub is the name. */
  async claim(name = this.app.handle) {
    await this.app.rail.go('inbox');
    const field = this.main.getByRole('textbox', {name: 'Name', exact: true});
    await field.fill(name);
    await field.press('Enter');
    await expect(this.main.getByRole('button', {name, exact: true})).toBeVisible();
  }

  /** Write `text` to `to` (a name or a code) and send it. */
  async writeTo(to: string, text: string) {
    await this.app.rail.go('inbox');
    await this.conversations.getByRole('textbox', {name: 'Write to a name or a code'}).fill(to);
    await this.conversations.getByRole('button', {name: 'Write', exact: true}).click();
    await this.message.fill(text);
    await this.main.getByRole('button', {name: 'Send', exact: true}).click();
    await expect(this.message).toHaveValue('');
  }
}

/** Server: laid over the page; servers on its top line, boards side by side. */
class Server extends Part {
  get layer() { return this.page.getByRole('dialog', {name: 'Server'}); }
  /** The right: who is in it, then the repos they show in it. */
  get side() { return this.layer.getByRole('complementary', {name: 'Who is in it, and the repos they show'}); }

  async openLayer() {
    await this.app.rail.button('server').click();
    await expect(this.layer).toBeVisible();
  }

  /** Put it away with Escape: from behind the gear (or a repo shown) the first goes back to the boards. */
  async close() {
    await expect(async () => {
      await this.page.keyboard.press('Escape');
      await expect(this.layer).toBeHidden({timeout: 1000});
    }).toPass({timeout: 15_000});
  }

  /** Make a server named `name`, `handle` its name on this Remote (one's own Inbox name is needed first). */
  async make(name: string, handle: string) {
    await this.openLayer();
    await this.layer.getByRole('textbox', {name: 'Name', exact: true}).fill(name);
    // Its name on this Remote follows the name unseen; the quiet @ after it shows the field to write it otherwise.
    await this.layer.getByRole('button', {name: 'Name on this Remote', exact: true}).click();
    await this.layer.getByRole('textbox', {name: /^Name on this Remote/}).fill(handle);
    await this.layer.getByRole('button', {name: 'Make', exact: true}).click();
    await expect(this.layer.getByRole('radiogroup', {name: 'Server'}).getByRole('radio', {name, exact: true})).toBeChecked();
  }

  /** Make a board in the server on screen: its last box makes one (a server starts with #general). */
  async makeBoard(name: string) {
    const field = this.layer.getByRole('textbox', {name: 'New board', exact: true});
    const next = this.layer.getByRole('button', {name: 'Next board'});
    await expect(next.or(field).first()).toBeVisible();
    // Along the boxes, one at a time, to the last.
    for (let i = 0; i < 20 && !(await field.isVisible()); i++) await next.click();
    await field.fill(name);
    await field.press('Enter');
    await expect(this.board(name)).toBeVisible();
  }

  /** A board's box, by its heading. */
  board(name: string) { return this.layer.getByRole('heading', {name, exact: true, level: 2}); }
  /** Its talk, read as a conversation. */
  talk(board: string) { return this.layer.getByRole('region', {name: board, exact: true}); }
  /** Its TODO, pinned at the top of its box. */
  get todo() { return this.layer.getByRole('region', {name: 'TODO', exact: true}); }

  /** A server's chip on the top line (its name says so while a board in it has posts not seen). */
  chip(name: string) { return this.layer.getByRole('radiogroup', {name: 'Server'}).getByRole('radio', {name: new RegExp(`^${escape(name)}(, |$)`)}); }

  /** The box at the board's foot that writes in it. */
  box(board: string) { return this.layer.getByRole('textbox', {name: `Write in ${board}`, exact: true}); }

  /**
   * Add someone to the server on screen by their name or code, from behind its gear (People,
   * Add someone you know). What the card then says is returned, to be checked by the caller.
   */
  async addSomeone(who: string) {
    await this.layer.getByRole('button', {name: 'Its people, boards and repos'}).click();
    await this.layer.getByRole('tab', {name: /^People/}).click();
    await this.layer.getByRole('button', {name: 'Add someone you know'}).click();
    const typed = this.layer.getByRole('textbox', {name: 'Name or code of someone to add'});
    await expect(typed).toBeFocused();
    await typed.fill(who);
    await this.layer.getByRole('button', {name: 'Add', exact: true}).click();
    return this.layer.getByRole('tabpanel', {name: /^People/}).getByRole('status');
  }

  /** Post `text` in `board` from the box at the foot (Ctrl+Enter sends). */
  async post(board: string, text: string) {
    const box = this.layer.getByRole('textbox', {name: `Write in ${board}`, exact: true});
    await box.fill(text);
    await box.press('Control+Enter');
    await expect(box).toHaveValue('');
  }
}

/**
 * Stripe, as the Remote with the plan has it (service/devbilling.ts, its stand-in in test mode): Checkout's card
 * form, the 3-D Secure step, and the customer portal, found as a person finds them there.
 */
class Stripe extends Part {
  /** The card's number, and what is said under the card's fields. */
  get number() { return this.page.getByRole('textbox', {name: 'Card number'}); }
  get cardSays() { return this.page.getByRole('group', {name: 'Card information'}).getByRole('alert'); }

  /** Pay with `card` (one of Stripe's test cards): the card, its expiry and CVC, the cardholder, the country, then `deed` (Subscribe in Checkout). */
  async pay(card: string, deed = 'Subscribe') {
    await this.number.fill(card);
    await this.page.getByRole('textbox', {name: 'Expiration'}).fill('12 / 34');
    await this.page.getByRole('textbox', {name: 'CVC'}).fill('123');
    await this.page.getByRole('textbox', {name: 'Cardholder name'}).fill(this.app.person || 'Ada');
    await this.page.getByRole('combobox', {name: 'Country or region'}).selectOption('JP');
    await this.page.getByRole('button', {name: deed, exact: true}).click();
  }

  /** The 3-D Secure step a card asks for, answered Complete or Fail. */
  async secure(answer: 'Complete' | 'Fail') {
    await expect(this.page.getByRole('dialog', {name: '3D Secure 2 Test Page'})).toBeVisible();
    await this.page.getByRole('button', {name: answer, exact: true}).click();
  }

  /** The portal's subscription, as its page says it. */
  get subscription() { return this.page.getByRole('region', {name: 'Current subscription'}); }
}
