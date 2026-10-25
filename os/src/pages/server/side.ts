import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {shown as named, shownAs} from '../../remote/inbox.ts';
import * as servers from '../../remote/servers.ts';
import {personBadge} from '../pane.ts';
import {errorText} from '../../app/errors.ts';

// Server's right pane, where a repo's reference would be: who is in the server, then the repos they show in it
// (pressing one shows it as it was last pushed; a repo shown is only seen there, never written).

/** What the side needs of the view it is in. */
interface SideWays {
  isMe(address: string): Promise<boolean>;
  /** A repo pressed: seen in the boards' place (repo.ts). */
  seeRepo(r: servers.ShownRepo): void;
  /** Someone else pressed: a conversation with them. */
  write(address: string): void;
}

const part = (title: string, ...body: (Node | null)[]) => h('section', {class: 'side-part'}, h('h3', {}, title), ...body);
const faceOf = (address: string) => personBadge(named(address));

export class Side {
  readonly element = h('aside', {class: 'side server-side', 'aria-label': t('Who is in it, and the repos they show')});
  /** The reading asked for last: one answered after a later one was asked is dropped. */
  private token = 0;
  private readonly ways: SideWays;

  constructor(ways: SideWays) {
    this.ways = ways;
  }

  /** Who is in server `id`, then the repos they show in it. */
  paint(id: string | null) {
    const mine = ++this.token;
    // Outside a server (an open board, or none chosen), whose it is is not told: the side stays, empty, so the
    // center keeps its width and nothing on the band moves when a server is chosen or made.
    if (!id) { this.element.replaceChildren(); return; }
    void Promise.all([servers.people(id), servers.shownIn(id)]).then(([people, repos]) => {
      if (mine !== this.token) return;
      this.element.replaceChildren(
        part(t('People'), h('ul', {class: 'people'}, ...people.map((p) => this.person(p)))),
        // The repos shown, when there are any: nothing is said of none here.
        repos.length ? part(t('Repos'), h('ul', {class: 'side-repos'}, ...repos.map((r) => this.repo(r)))) : '');
    }).catch((e) => { if (mine === this.token) this.element.replaceChildren(h('p', {class: 'error'}, errorText(e))); });
  }

  /** Emptied while a server is made, until its first person stands there (`ghost`). */
  clear() {
    this.element.replaceChildren();
  }

  /** The server being made: its first person, oneself (`address`), as its owner, faint. */
  ghost(address: string) {
    this.element.replaceChildren(h('div', {class: 'side-ghost', 'aria-hidden': 'true'}, part(t('People'), h('ul', {class: 'people'},
      h('li', {}, faceOf(address), h('span', {}, named(address)), h('span', {class: 'muted small'}, t('owner')))))));
  }

  /** One of its people, its owner said so. */
  private person(p: servers.Person): HTMLElement {
    const li = h('li', {}, faceOf(p.address), h('span', {}, named(p.address)), p.owner ? h('span', {class: 'muted small'}, t('owner')) : null);
    // Someone else pressed is a conversation with them, in the Inbox: who they are is who one writes to.
    void this.ways.isMe(p.address).then((me) => {
      if (me || !li.isConnected) return;
      const b = h('button', {type: 'button', class: 'person-go', title: t('Write to {name}', {name: named(p.address)})}, ...li.childNodes);
      b.addEventListener('click', () => this.ways.write(p.address));
      li.replaceChildren(b);
    });
    return li;
  }

  /** A repo shown in it: whose, and said when everyone sees it. */
  private repo(r: servers.ShownRepo): HTMLElement {
    const b = h('button', {type: 'button', class: 'side-repo', title: r.as ? t('Everyone sees it as {name}', {name: shownAs(r.as)}) : `${named(r.owner)}:${r.name}`},
      h('span', {}, r.name), h('span', {class: 'muted small'}, named(r.owner)), r.as ? h('span', {class: 'seen-mark muted small'}, t('everyone')) : null);
    b.addEventListener('click', () => this.ways.seeRepo(r));
    return h('li', {}, b);
  }
}
