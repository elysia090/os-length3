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
  remote: 'Remote', server: 'Server', inbox: 'Inbox', 'new-repo': 'New repo',
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
    this.person = name;
    await this.rail.go('remote');
    await this.main.getByRole('button', {name: 'Continue with Development'}).click();
    // The provider's own page: a name, and you are in. (Not reached: the card says why, in its alert.)
    await expect(this.page.getByRole('heading', {name: 'Development provider'}), 'the provider\'s page').toBeVisible();
    await this.page.getByRole('textbox', {name: 'Name'}).fill(name);
    await this.page.getByRole('button', {name: 'Continue'}).click();
    await this.settled();
    await expect(this.remote.part('Repos')).toBeVisible();
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
    if (place !== 'file' && place !== 'server') await expect(this.button(place)).toHaveAttribute('aria-current', 'page');
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
  /** The name a file of the scaffold will have (its field in the box, by the scaffold's path). */
  fileName(path: string) { return this.main.getByRole('textbox', {name: `Name of ${path}`, exact: true}); }

  /**
   * Fill the form and press Create (the outcome is the caller's to check). There is no template to
   * choose: every repo starts from the one scaffold (a README, docs/ and issue/); `files` names its
   * files in the box first, by the scaffold's path.
   */
  async fill(name: string, o: {template?: 'C'; summary?: string; files?: Record<string, string>} = {}) {
    await this.app.rail.go('new-repo');
    await this.name.fill(name);
    for (const [path, as] of Object.entries(o.files ?? {})) await this.fileName(path).fill(as);
    if (o.summary) await this.summary.fill(o.summary);
    await this.create.click();
  }

  /**
   * Make a repo and see it made. `template: 'C'`: then C's files are written into it from File, as
   * someone would (src/main.c and its Makefile, as `l3 repo new -t c` makes them), and Forge shows it.
   */
  async make(name: string, o: {template?: 'C'; summary?: string; files?: Record<string, string>} = {}) {
    await this.fill(name, o);
    await expect(this.made).toHaveText(`Made ${name}`);
    if (o.template !== 'C') return;
    const c = new Map(TEMPLATES.find((t) => t.id === 'c')!.files as [string, string][]);
    await this.app.file.named(name, '', 'New folder', 'src');
    await this.app.file.named(name, 'src', 'New file', 'main.c');
    await this.app.forge.editFile('src/main.c', c.get('src/main.c')!);
    await this.app.file.named(name, '', 'New file', 'Makefile');
    await this.app.forge.editFile('Makefile', c.get('Makefile')!.replaceAll('{name}', name));
  }

  /** Made: open it in Forge, as the page offers (made with C's files, Forge has it open already). */
  async openInForge() {
    const open = this.main.getByRole('button', {name: 'Open in Forge'});
    if (await open.isVisible()) await open.click();
    await expect(this.app.forge.editor('README.md')).toBeVisible();
  }
}

/** Forge: the band of repos, the files one after another, the search and the reference at the right. */
class Forge extends Part {
  get band() { return this.main.getByRole('navigation', {name: 'repo'}); }
  get reference() { return this.main.getByRole('region', {name: 'Reference'}); }
  get search() { return this.main.getByRole('searchbox', {name: 'Search this repo'}); }
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

  /** Search the open repo: the results take the reference's place. */
  async find(query: string) {
    await this.search.fill(query);
    await expect(this.reference.getByText('Searching…')).toBeHidden();
  }

  /** A line found by the search, by its text. */
  hit(text: string | RegExp) { return this.reference.getByRole('button', {name: text}); }

  /** The text selected in a file's editor (where the search or a diff opened it). */
  selected(path: string) {
    return this.editor(path).evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd));
  }

  /** One of the reference's views: 'Issue', 'diff', 'Output'. */
  async show(view: 'Issue' | 'diff' | 'Output') {
    const chip = this.reference.getByRole('button', {name: view, exact: true});
    await chip.click();
    await expect(chip).toHaveAttribute('aria-current', 'true');
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

  /** A run in Output (the reference's record of what was run), by its line: pressed, it is put back in the box. */
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
    await this.show('diff');
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
    if (await this.tree.isVisible()) return;
    await this.app.rail.button('file').click();
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
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
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
    if (detail) await this.main.getByRole('textbox', {name: 'Detail'}).fill(detail);
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
  section(name: 'main' | 'Merged' | 'Closed') { return this.main.getByRole('region', {name: new RegExp(`^${name}( \\d+)?$`)}); }
  /** main's card for `repo`, while something there is not committed. */
  mainCard(repo: string) { return this.section('main').getByRole('group', {name: `Not committed on main in ${repo}`}); }

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

/** Remote: the canonical copy; signed in, its parts (Repos, Sign-in, Devices). */
class Remote extends Part {
  /** One of its parts, by the heading that switches to it (a count may follow the word). */
  part(name: 'Repos' | 'Sign-in' | 'Devices') { return this.main.getByRole('tab', {name: new RegExp(`^${name}`)}); }
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
