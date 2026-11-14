import {h} from '../../ui/dom.ts';
import {t} from '../../i18n/i18n.ts';
import {shown as named, shownAs} from '../../remote/inbox.ts';
import * as servers from '../../remote/servers.ts';
import {boardNew} from '../../remote/news.ts';
import {personBadge} from '../kit/pane.ts';
import {errorText} from '../../host/errors.ts';
import {every} from '../../host/runs.ts';
import {paced, still} from '../../ui/glide.ts';
import {SPRING} from '../../ui/law.ts';

// The room's own sheet, the first piece of Server's row: who is in the server, then the repos they show in it
// (pressing one shows it as it was last pushed; a repo shown is only seen there, never written).

/** What the side needs of the view it is in. */
interface SideWays {
  isMe(address: string): Promise<boolean>;
  /** A repo pressed: seen in the boards' place (repo.ts). */
  seeRepo(r: servers.ShownRepo): void;
  /** Someone else pressed: a conversation with them. */
  write(address: string): void;
}

/** How often who is in the server is looked at again, while it is on screen. */
const EVERY = 15_000;

const part = (title: string, ...body: (Node | null)[]) => h('section', {class: 'side-part'}, h('h3', {}, title), ...body);
const faceOf = (address: string) => personBadge(named(address));

export class Side {
  readonly element = h('aside', {class: 'server-side', 'aria-label': t('Members and shared repos')});
  /** Its boards, by name: the room's index, before who is in it (`boards`). */
  private readonly index = h('section', {class: 'side-part side-index'});
  /** The reading asked for last: one answered after a later one was asked is dropped. */
  private token = 0;
  private readonly ways: SideWays;

  constructor(ways: SideWays) {
    this.ways = ways;
  }

  /** Who is in server `id`, then the repos they show in it. */
  paint(id: string | null) {
    const mine = ++this.token;
    // Outside a server (an open board, or none chosen), whose it is is not told: the row has no such sheet.
    this.element.hidden = !id;
    if (!id) { this.element.replaceChildren(); return; }
    // Before who is in it is read, its boards are there already.
    if (!this.element.contains(this.index)) this.element.replaceChildren(this.index);
    const read = () => Promise.all([servers.people(id), servers.shownIn(id)]);
    let drawn = '';
    const draw = ([people, repos]: [servers.Person[], servers.ShownRepo[]]) => {
      drawn = JSON.stringify([people, repos]);
      // Another server's people in place of those drawn: they come in over a moment, as its boards do, not swapped in
      // one frame beside them; the same server's drawn again (someone came in), they simply stand.
      const another = !!this.counted && this.counted.id !== id && this.element.childElementCount > 0;
      this.counted = {id, people: people.length, repos: repos.length};
      this.element.replaceChildren(this.index,
        part(t('Members'), h('ul', {class: 'people'}, ...people.map((p) => this.person(p)))),
        // The repos shown, when there are any: nothing is said of none here.
        repos.length ? part(t('Repos'), h('ul', {class: 'side-repos'}, ...repos.map((r) => this.repo(r)))) : '');
      if (another && !still()) this.element.animate([{opacity: 0}, {opacity: 1}], {duration: paced(220), easing: SPRING});
    };
    void read().then((got) => { if (mine === this.token) draw(got); })
      .catch((e) => { if (mine === this.token) this.element.replaceChildren(h('p', {class: 'error'}, errorText(e))); });
    // While it is on screen, who is in it is looked at again every little while: someone asked in, who accepts on
    // their own device, comes in here then (and a repo shown or taken off with them), not when Server is next opened.
    every(EVERY, async () => {
      const got = await read();
      if (mine === this.token && JSON.stringify(got) !== drawn) draw(got);
    }, {alive: () => mine === this.token && this.element.isConnected, paced: true});
  }

  /**
   * The room's boards, by name, the one in the hand in ink: any of them is one press away from here. It is the only
   * way among them that is seen: the row shows the board in the hand alone, beside this sheet, as Inbox shows one
   * conversation beside who wrote. A board with something not seen yet has its dot.
   */
  boards(list: readonly {id: string; name: string}[], now: number, go: (j: number) => void, more = false) {
    const lines = list.map((b, j) => {
      const line = h('button', {type: 'button', class: `side-board${boardNew(b.id) ? ' news' : ''}`, 'aria-current': String(j === now)},
        h('span', {class: 'board-mark', 'aria-hidden': 'true'}, '#'), h('span', {}, b.name));
      line.addEventListener('click', () => go(j));
      return h('li', {}, line);
    });
    // (After them, the way to a new one, as Home's is after its repos: the board not made yet is the row's last.)
    if (more) {
      const line = h('button', {type: 'button', class: 'side-board side-new', 'aria-current': String(now === list.length)},
        h('span', {class: 'board-mark', 'aria-hidden': 'true'}, '+'), h('span', {}, t('New board')));
      line.addEventListener('click', () => go(list.length));
      lines.push(h('li', {}, line));
    }
    this.index.replaceChildren(h('h3', {}, t('Boards')), h('ul', {class: 'side-boards'}, ...lines));
  }

  /** How many people and repos it drew last, and for which server. */
  private counted: {id: string; people: number; repos: number} | null = null;
  /** How many people and repos it drew for server `id`, if it did (the gear's counts, at once). */
  known(id: string) {
    return this.counted?.id === id ? {people: this.counted.people, repos: this.counted.repos} : null;
  }

  /** Emptied while a server is made, until its first person stands there (`ghost`). */
  clear() {
    this.element.hidden = false;
    this.element.replaceChildren();
  }

  /** The server being made: its first person, oneself (`address`), as its owner, faint. */
  ghost(address: string) {
    this.element.replaceChildren(h('div', {class: 'side-ghost', 'aria-hidden': 'true'}, part(t('Members'), h('ul', {class: 'people'},
      h('li', {}, faceOf(address), h('span', {}, named(address)), h('span', {class: 'muted small'}, t('Owner')))))));
  }

  /** One of its people, its owner said so. */
  private person(p: servers.Person): HTMLElement {
    const li = h('li', {}, faceOf(p.address), h('span', {}, named(p.address)), p.owner ? h('span', {class: 'muted small'}, t('Owner')) : null);
    // Someone else pressed is a conversation with them, in the Inbox: who they are is who one writes to.
    void this.ways.isMe(p.address).then((me) => {
      if (me || !li.isConnected) return;
      const b = h('button', {type: 'button', class: 'person-go', title: t('Message {name}', {name: named(p.address)})}, ...li.childNodes);
      b.addEventListener('click', () => this.ways.write(p.address));
      li.replaceChildren(b);
    });
    return li;
  }

  /** A repo shown in it: whose, and said when everyone sees it; lit while it is the one in the boards' place. */
  private repo(r: servers.ShownRepo): HTMLElement {
    const b = h('button', {type: 'button', class: 'side-repo', 'data-repo': `${r.owner}:${r.name}`,
      title: r.as ? t('Publicly visible as "{name}"', {name: shownAs(r.as)}) : `${named(r.owner)}:${r.name}`},
    h('span', {}, r.name), h('span', {class: 'muted small'}, named(r.owner)), r.as ? h('span', {class: 'seen-mark muted small'}, t('Public')) : null);
    if (b.dataset.repo === this.seeing) b.setAttribute('aria-current', 'true');
    b.addEventListener('click', () => this.ways.seeRepo(r));
    return h('li', {}, b);
  }

  /** The repo in the boards' place (owner:name), or none: its row is lit, as a file chosen is in its list. */
  private seeing: string | null = null;
  seen(r: servers.ShownRepo | null) {
    this.seeing = r ? `${r.owner}:${r.name}` : null;
    for (const b of this.element.querySelectorAll<HTMLElement>('.side-repo')) {
      if (b.dataset.repo === this.seeing) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    }
  }
}
