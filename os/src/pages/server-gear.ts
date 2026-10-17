import {day, h} from '../dom.ts';
import {t} from '../i18n.ts';
import {shown as named, shownAs} from '../inbox.ts';
import * as servers from '../servers.ts';
import {parts} from './common.ts';
import {askIn, boardName, button, foot, footLeft, line, message, MOVE, smallCard} from './server-parts.ts';

// Behind the gear: what changes the server for everyone. In parts, as
// Remote's page is (its people, the repos shown, its boards, the server
// itself): a small card for each thing, what can be done with it at its
// foot, and what reaches past its people asked in the card.

type Part = 'people' | 'repos' | 'boards' | 'server';

/** What the gear needs of the layer it is in. */
export interface GearWays {
  /** The boards' place, where the gear's sheet goes. */
  sheet: HTMLElement;
  /** Still behind the gear of this server: a reading that comes after it is put away is dropped. */
  still(): boolean;
  /** Done: back to the boards. */
  done(): void;
  /** Something changed: the gear and the side are drawn again. */
  again(): void;
  /** A board was removed or brought back: the boards are built again on the way back to them. */
  boardsChanged(): void;
  /** One left the server, or removed it: the next one, or making one. */
  gone(id: string): void;
  isMe(address: string): Promise<boolean>;
}

export async function gear(s: servers.Server, w: GearWays): Promise<void> {
  const done = button(t('Done'), 'small-button');
  done.addEventListener('click', () => w.done());
  const tabs = parts<Part>('server-gear', [{id: 'people', label: t('People')}, {id: 'repos', label: t('Repos')}, {id: 'boards', label: t('Boards')}, {id: 'server', label: t('This server')}]);
  const ids: Part[] = ['people', 'repos', 'boards', 'server'];
  w.sheet.replaceChildren(
    h('div', {class: 'sheet-head'}, h('div', {class: 'sheet-title'}, h('h2', {}, s.name), h('p', {}, `${named(s.address)} · ${s.code}`)), h('span', {class: 'grow'}), done),
    h('div', {class: 'sheet-body'}, tabs.switch, ...ids.map((k) => tabs.panel(k))));
  // Narrow, the parts slide: the one chosen is kept in view.
  const inView = () => tabs.switch.querySelector('[aria-selected="true"]')?.scrollIntoView({block: 'nearest', inline: 'nearest'});
  tabs.onShow(inView);
  requestAnimationFrame(inView);
  const grid = (k: Part, ...cards: (Node | null)[]) => tabs.panel(k).replaceChildren(h('div', {class: 'grid small-grid'}, ...cards));
  /** A setting in a card: its word and a switch. Widening asks in the card first; narrowing is at once. */
  const setting = (card: HTMLElement, label: string, on: boolean, ask: {what: string | string[]; verb: string}, change: (v: boolean) => Promise<unknown>) => {
    const sw = h('button', {type: 'button', class: 'power plain', role: 'switch', 'aria-checked': String(on), 'aria-label': label}, h('span', {class: 'knob'})) as HTMLButtonElement;
    // It moves on the press, green when on; widening then asks in the card (no puts it back), narrowing is at once.
    const to = (v: boolean) => sw.setAttribute('aria-checked', String(v));
    const said = h('span', {class: 'error small', role: 'alert'});
    sw.addEventListener('click', async () => {
      to(!on);
      if (!on) {
        window.setTimeout(() => askIn(card, sw, card.querySelector('.card-title')?.textContent ?? '', ask.what, ask.verb, async () => { await change(true); w.again(); }, () => to(false)), MOVE);
        return;
      }
      sw.disabled = true;
      // Not narrowed: the switch goes back on, and says why.
      try { await change(false); w.again(); } catch (e) { to(true); sw.disabled = false; said.textContent = message(e); }
    });
    return h('div', {class: 'card-row'}, h('span', {class: 'grow'}, label), sw, said);
  };
  try {
    const [people, repos, mineAll] = await Promise.all([servers.people(s.id), servers.shownIn(s.id), servers.seenAll()]);
    if (!w.still()) return;
    tabs.count('people', people.length);
    tabs.count('repos', repos.length);
    tabs.count('boards', s.boards.filter((b) => !b.gone).length);
    const mine = (await Promise.all(people.map(async (p) => ((await w.isMe(p.address)) ? p.address : null)))).find(Boolean) ?? null;

    // Its people: anyone in it adds someone they know; only its owner takes someone out. Pressed, the
    // dashed card is the card that adds: one's contacts not in it yet, each a press away, and a name or
    // a code for anyone else, asked in the Inbox and in once they accept.
    const add = h('button', {type: 'button', class: 'card small-card new'}, t('Add someone you know')) as HTMLButtonElement;
    add.addEventListener('click', async () => {
      const inbox = await import('../inbox.ts');
      let known: {address: string}[] = [], why = '';
      try { known = (await inbox.threads()).filter((x) => x.state === 'contact' && !people.some((p) => p.address === x.address)); } catch (e) { why = message(e); }
      const typed = h('input', {class: 'line-in', placeholder: t('A name or a code'), 'aria-label': t('Name or code of someone to add'),
        autocapitalize: 'off', spellcheck: 'false'}) as HTMLInputElement;
      const go = button(t('Add'), 'small-button primary');
      const said = h('p', {class: 'muted small', role: 'status'});
      const ways: servers.AddWays = {
        lookup: (x) => inbox.lookup(x),
        add: (id, address) => servers.addPerson(id, address),
        ask: (address, body, server) => inbox.send(address, body, 'message', {server}),
      };
      const adding = async () => {
        if (!typed.value.trim() || go.disabled) { typed.focus(); return; }
        go.disabled = true;
        said.className = 'muted small';
        try {
          const r = await servers.addByName(s, typed.value, people.map((p) => p.address), ways);
          if (r.is === 'in') { w.again(); return; }
          said.textContent = r.is === 'already' ? t('{who} is in it already', {who: named(r.address)})
            : t('Asked {who} in the Inbox. They come in once they accept you.', {who: named(r.address)});
          typed.value = '';
        } catch (e) { said.className = 'error small'; said.textContent = message(e); typed.focus(); }
        go.disabled = false;
      };
      go.addEventListener('click', () => void adding());
      typed.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void adding(); } });
      const pick = h('div', {class: 'card small-card add-card'}, h('span', {class: 'card-title'}, t('Add someone you know')),
        ...(why ? [h('p', {class: 'error small'}, why)] : known.map((x) => {
          const b = button(named(x.address), 'small-button');
          b.addEventListener('click', async () => { b.disabled = true; try { await servers.addPerson(s.id, x.address); w.again(); } catch (e) { b.textContent = message(e); } });
          return b;
        })),
        h('div', {class: 'row add-by-name'}, typed, go), said);
      add.replaceWith(pick);
      typed.focus();
    });
    grid('people', ...people.map((p) => {
      const c = smallCard(named(p.address), line(p.owner ? t('owner') : p.address === mine ? t('you') : ''));
      if (s.owner && p.address !== mine) {
        const out = button(t('Remove'), 'small-button');
        out.addEventListener('click', () => askIn(c, out, named(p.address), t('{who} leaves {server}.', {who: named(p.address), server: s.name}),
          t('Remove'), async () => { await servers.removePerson(s.id, p.address); w.again(); }));
        c.append(footLeft(out));
      }
      return c;
    }), add);

    // The repos, as the boards: each of one's own with the two a board has, to its people and to everyone
    // (seen by everyone as the server's, never as oneself); others' shown here, as whose, its owner may take off.
    const shares = (name: string) => mineAll.find((x) => x.name === name)?.servers.map((x) => x.id) ?? [];
    const own = mineAll.map((x) => {
      const r = repos.find((y) => y.mine && y.name === x.name);
      const c = smallCard(x.name, r?.as && r.asServer !== s.id ? line(t('Everyone sees it as {name}', {name: shownAs(r.as)})) : null);
      c.append(setting(c, t('Show to its people'), !!r, {what: t('The people of {server} see it as last pushed.', {server: s.name}), verb: t('Show')},
        (v) => (v ? servers.showIn(s.id, x.name) : servers.takeOff(s.id, mine!, x.name))));
      if (s.address) {
        c.append(setting(c, t('Show to everyone'), r?.asServer === s.id, {what: [t('Anyone sees it as {name}.', {name: shownAs(`${s.address}:${x.name}`)}), t('Your name is not shown.')], verb: t('Show')},
          (v) => (v ? servers.setSeen(x.name, 'everyone', {as: s.id}) : servers.setSeen(x.name, 'servers', {servers: [...new Set([...shares(x.name), s.id])]}))));
      }
      return c;
    });
    const others = repos.filter((r) => !r.mine).map((r) => {
      const c = smallCard(r.name, line(named(r.owner)), r.as ? line(t('Everyone sees it as {name}', {name: shownAs(r.as)})) : null);
      if (s.owner) {
        const off = button(t('Remove'), 'small-button');
        off.addEventListener('click', async () => { off.disabled = true; try { await servers.takeOff(s.id, r.owner, r.name); w.again(); } catch (e) { off.textContent = message(e); } });
        c.append(footLeft(off));
      }
      return c;
    });
    grid('repos', ...own, ...others, own.length || others.length ? null : h('div', {class: 'empty'}, t('No repo on the Remote yet')));

    // Its boards: how far each is open and removing one, its owner's to say; taking one home, anyone's.
    grid('boards', ...s.boards.map((b) => {
      // Removed: quiet, held until then, its 外す red; pressed again, it is back at once.
      if (b.gone) {
        const back = s.owner ? h('button', {type: 'button', class: 'button small-button off', 'aria-pressed': 'true', title: t('Bring it back')}, t('Remove')) as HTMLButtonElement : null;
        back?.addEventListener('click', async () => {
          back.disabled = true;
          try { await servers.bringBackBoard(b.id); delete b.gone; w.boardsChanged(); w.again(); } catch (e) { back.textContent = message(e); back.disabled = false; }
        });
        return h('div', {class: 'card small-card off'}, h('span', {class: 'card-title'}, boardName(b.name)), line(t('Removed · back until {date}', {date: day(b.gone)})),
          back ? h('div', {class: 'card-foot'}, back, h('span', {class: 'grow'})) : null);
      }
      const how = b.open ? (b.guests ? `${t('Seen by everyone')} · ${t('Guests can write')}` : t('Seen by everyone')) : t('Its people only');
      const c = smallCard(boardName(b.name), s.owner ? null : line(how));
      if (s.owner) {
        const set = (change: {open?: boolean; guests?: boolean}) => servers.setBoard(b.id, change).then((n) => { b.open = n.open; b.guests = n.guests; });
        c.append(
          setting(c, t('Show to everyone'), b.open, {what: t('Anyone reads #{board}, signed in or not.', {board: b.name}), verb: t('Show')}, (v) => set({open: v})),
          setting(c, t('Guests can write'), b.guests, {what: t('Others write in #{board} after an email check.', {board: b.name}), verb: t('Take guests')}, (v) => set({guests: v})));
      }
      const take = button(t('Take home'), 'small-button');
      take.title = t('Everything stays on the Remote. Take a copy as text when you want one here.');
      take.addEventListener('click', async () => {
        take.disabled = true;
        try {
          const text = await servers.archive(b.id, true);
          const a = h('a', {href: URL.createObjectURL(new Blob([text], {type: 'text/markdown'})), download: `${s.name}-${b.name}.md`.replace(/[^\w.-]+/g, '-')}) as HTMLAnchorElement;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        } catch (e) { take.textContent = message(e); } finally { take.disabled = false; }
      });
      const out = s.owner ? button(t('Remove'), 'small-button') : null;
      out?.addEventListener('click', () => askIn(c, out, boardName(b.name), [t('#{board} goes with its talk and TODO.', {board: b.name}), t('You can bring it back within 30 days.')], t('Remove'), async () => {
        const r = await servers.removeBoard(b.id);
        b.gone = r.until;
        w.boardsChanged();
        w.again();
      }));
      c.append(h('div', {class: 'card-foot'}, out, h('span', {class: 'grow'}), take));
      return c;
    }));

    // The server itself: its name's term (renewed by its owner near its end), leaving it, and, its owner, removing it.
    const YEAR = 365 * 86_400_000;
    const name = smallCard(named(s.address), line(`${t('Its code')} ${s.code}`),
      s.until ? line(s.until <= Date.now() ? t('Its term ended; held for it until {date}', {date: day(s.until + 30 * 86_400_000)}) : t('Until {date}', {date: day(s.until)})) : null);
    if (s.owner && s.until && s.until - Date.now() < YEAR) {
      const renew = button(t('Renew'), 'small-button primary');
      renew.addEventListener('click', async () => { renew.disabled = true; try { const r = await servers.renewServer(s.id); s.until = r.until; w.again(); } catch (e) { renew.textContent = message(e); } });
      name.append(foot(renew));
    }
    const leaving = mine ? smallCard(t('Leave this server'), line(s.owner ? t('It goes to whoever came next.') : '')) : null;
    if (leaving && mine) {
      const go = button(t('Leave'), 'small-button');
      go.addEventListener('click', () => askIn(leaving, go, t('Leave this server'), t('You leave {server}.', {server: s.name}), t('Leave'),
        async () => { await servers.removePerson(s.id, mine); w.gone(s.id); }));
      leaving.append(foot(go));
    }
    const removing = s.owner ? smallCard(t('Remove this server'), line(t('You can bring it back within 30 days.'))) : null;
    if (removing) {
      const go = button(t('Delete'), 'small-button');
      go.addEventListener('click', () => askIn(removing, go, t('Remove this server'), [t('{server} goes, with its boards.', {server: s.name}), t('You can bring it back within 30 days.')], t('Delete'),
        async () => { await servers.removeServer(s.id); w.gone(s.id); }));
      removing.append(foot(go));
    }
    grid('server', name, leaving, removing);
  } catch (e) { tabs.panel(tabs.current()).replaceChildren(h('p', {class: 'error'}, message(e))); }
}
