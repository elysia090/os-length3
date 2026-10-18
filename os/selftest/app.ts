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

  /** Open the app and wait until it has drawn what it knows. */
  async open() {
    await this.page.goto('/');
    await this.settled();
  }

  /** The first look at the Remote is done and the page drawn from it (main is busy until then). */
  async settled() {
    await expect(this.main).not.toHaveAttribute('aria-busy', 'true');
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
    return this.page.getByRole('navigation', {name: 'Purposes'}).getByRole('button', {name: PLACES[place], exact: true});
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

/** + : a new repo from a template, with what it is for written into its README. */
class NewRepo extends Part {
  get name() { return this.main.getByRole('textbox', {name: 'Name'}); }
  get summary() { return this.main.getByRole('textbox', {name: 'Summary'}); }
  get create() { return this.main.getByRole('button', {name: 'Create'}); }
  /** What is said under the name when it cannot be used. */
  get problem() { return this.main.getByRole('alert'); }
  get made() { return this.main.getByRole('status'); }
  template(label: string) { return this.main.getByRole('radiogroup', {name: 'Template'}).getByRole('radio', {name: label, exact: true}); }

  /** Fill the form and press Create (the outcome is the caller's to check). */
  async fill(name: string, o: {template?: string; summary?: string} = {}) {
    await this.app.rail.go('new-repo');
    await this.name.fill(name);
    if (o.template) {
      await this.template(o.template).click();
      await expect(this.template(o.template)).toBeChecked();
    }
    if (o.summary) await this.summary.fill(o.summary);
    await this.create.click();
  }

  /** Make a repo and see it made. */
  async make(name: string, o: {template?: string; summary?: string} = {}) {
    await this.fill(name, o);
    await expect(this.made).toHaveText(`Made ${name}`);
  }

  /** Made: open it in Forge, as the page offers. */
  async openInForge() {
    await this.main.getByRole('button', {name: 'Open in Forge'}).click();
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
    await expect(this.fileState(path)).toHaveText('Unsaved');
    // Leaving the text saves it at once (as do Ctrl+S and a moment's pause).
    await editor.press('Escape');
    await expect(this.fileState(path)).toBeHidden();
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

  /** Write `line` in the prompt box and send it (Ctrl+Enter; Enter is a new line). */
  async run(line: string) {
    await this.promptBox.fill(line);
    await this.promptBox.press('Control+Enter');
    await expect(this.promptBox).toHaveValue('');
  }

  /** A line of the diff, by what it says: pressed, it is marked as with a highlighter. */
  diffLine(text: string) { return this.reference.getByRole('button', {name: text, exact: true}); }
}

/** File: the tree of "/" over the page. */
class FileTree extends Part {
  get tree() { return this.page.getByRole('tree', {name: '/'}); }
  /** The tree's row for a repo or a file, by its name. */
  name(text: string) { return this.tree.getByRole('button', {name: text, exact: true}); }

  async openTree() {
    await this.app.rail.button('file').click();
    await expect(this.tree).toBeVisible();
  }

  /** Open `path` of `repo` from the tree: the repo's folder first, then each folder down to it, then the file. */
  async open(repo: string, path: string) {
    await this.openTree();
    let at = this.tree.getByRole('treeitem').filter({has: this.page.getByRole('button', {name: repo, exact: true})}).first();
    const parts = path.split('/');
    await this.expand(at, repo);
    for (const dir of parts.slice(0, -1)) {
      at = at.getByRole('treeitem').filter({has: this.page.getByRole('button', {name: dir, exact: true})}).first();
      await this.expand(at, dir);
    }
    await at.getByRole('button', {name: parts.at(-1)!, exact: true}).click();
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
    await this.main.getByRole('radiogroup', {name: 'Repo to write in'}).getByRole('radio', {name: repo, exact: true}).click();
    await this.main.getByRole('textbox', {name: 'First line as Kind: title'}).fill(first);
    if (detail) await this.main.getByRole('textbox', {name: 'Detail'}).fill(detail);
    await this.main.getByRole('button', {name: 'Create'}).click();
  }

  /** A step's button in the issue on screen (Start, Commit, Push, Merge…): only the issue on screen has them. */
  step(name: string) { return this.main.getByRole('button', {name, exact: true}); }
}

/** Remote: the canonical copy; signed in, its parts (Repos, Sign-in, Devices). */
class Remote extends Part {
  /** One of its parts, by the heading that switches to it (a count may follow the word). */
  part(name: 'Repos' | 'Sign-in' | 'Devices') { return this.main.getByRole('tab', {name: new RegExp(`^${name}`)}); }
  /** A repo's card, by its name. */
  card(repo: string) { return this.main.getByRole('tabpanel', {name: /^Repos/}).getByRole('group', {name: repo, exact: true}); }
  /** Its power switch: on while the Remote keeps it on. */
  power(repo: string) { return this.card(repo).getByRole('switch'); }
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
  get dotfiles() { return this.main.getByRole('region', {name: /^Dotfiles/}); }
  /** A dotfile's card (its name, then its size). */
  dotfile(name: string) { return this.dotfiles.getByRole('button', {name: new RegExp(`^${escape(name)} `)}); }
  /** The text of the dotfile open under the cards (its field is named by the file). */
  text(name: string) { return this.dotfiles.getByRole('textbox', {name, exact: true}); }

  /** Make a dotfile and save it. */
  async makeDotfile(name: string, text: string) {
    await this.app.rail.go('runtime');
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
    await this.conversations.getByRole('textbox', {name: 'Write to an address'}).fill(to);
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

  async close() {
    await this.page.keyboard.press('Escape');
    await expect(this.layer).toBeHidden();
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

  /** Post `text` in `board` from the box at the foot (Ctrl+Enter sends). */
  async post(board: string, text: string) {
    const box = this.layer.getByRole('textbox', {name: `Write in ${board}`, exact: true});
    await box.fill(text);
    await box.press('Control+Enter');
    await expect(box).toHaveValue('');
  }
}
