import {errorText} from '../../../api/errors.ts';
import {every} from '../../../api/runs.ts';
import {connection} from '../../../shipto/connection.ts';
import * as inbox from '../../../shipto/inbox.ts';
import {look, onNews} from '../../../shipto/news.ts';
import {shortDay} from '../../../text/format.ts';
import {t} from '../../../text/i18n.ts';
import {arrowKeys, h} from '../../ui/dom.ts';
import {nudge, paced, still} from '../../ui/glide.ts';
import {whole} from '../../ui/whole.ts';
import {pageHead} from '../kit/common.ts';
import type {Context} from '../kit/context.ts';
import {takeNext} from '../kit/next.ts';
import {deskSearch, placesMenu} from '../kit/places.ts';
import {goToPlan} from '../kit/plan-gate.ts';
import {signInBox, signInLead, signInPlace} from '../kit/sign-in.ts';
import {unreachedError, unreachedPlace} from '../kit/unreached.ts';
import {letter, letterClock, type LetterView} from './letter.ts';
import {InboxPapers, paperSwitch, recipientPaper} from './papers.ts';
import {addressStub} from './usernames.ts';

const PLACES = ['Server', 'Inbox'] as const;
const inboxPlaces = (holder: HTMLElement, ctx: Context, showNames?: () => void) =>
  placesMenu(holder, PLACES, 'Inbox', (place) => { if (place === 'Server') void ctx.go('server'); },
    () => [
      ...(showNames ? [{label: 'Your usernames', run: showNames}] : []),
      ...(ctx.placeCommands?.(['server']) ?? []),
    ], {find: deskSearch(ctx)});
type OpenedLetter = Awaited<ReturnType<typeof inbox.thread>>;

/** Don't carry the other account's drafts or opened names into a new Remote or sign-in. */
let kept: {scope: string; papers: InboxPapers} | null = null;

export function inboxPage(ctx: Context): Node[] {
  const holder = h('div', {class: 'inbox-holder'});
  const beforeDesk = (...nodes: Node[]) => {
    holder.classList.remove('inbox-shell');
    holder.replaceChildren(...nodes);
    inboxPlaces(holder, ctx);
  };
  let stopDesk: (() => void) | null = null;
  let reading = 0;
  const paint = async () => {
    const asked = ++reading;
    stopDesk?.();
    stopDesk = null;
    const from = connection();
    if (!from) {
      kept = null;
      beforeDesk(signInPlace(t('Sign in'), ...signInLead(t('Signing in lets you claim a username to receive reviews and questions.')), signInBox(() => void paint())));
      return;
    }
    const me = await inbox.me().catch((e: unknown) => e instanceof Error ? e : new Error(errorText(e)));
    if (asked !== reading || !holder.isConnected) return;
    if (me instanceof Error) {
      beforeDesk(unreachedError(me) ? unreachedPlace(t('Conversations will reappear once Remote responds'), () => void paint()) : h('p', {class: 'error'}, errorText(me)));
      return;
    }
    if (!me.addresses.length) {
      beforeDesk(signInPlace(t('Claim username'), addressStub(me, () => void paint(), () => goToPlan(ctx)).holder));
      return;
    }
    const scope = JSON.stringify([from.url, me.account]);
    if (kept?.scope !== scope) kept = {scope, papers: new InboxPapers()};
    holder.classList.add('inbox-shell');
    const desk = showDesk(holder, ctx, me, kept.papers, () => void paint());
    stopDesk = desk.stop;
    await desk.ready;
  };
  void whole(paint());
  return [pageHead('inbox'), holder];
}

function showDesk(holder: HTMLElement, ctx: Context, me: inbox.Me, papers: InboxPapers, again: () => void) {
  let ended = false;
  let letterView: LetterView | null = null;
  let opened = 0, listed = 0;
  let threads = new Map<string, inbox.Thread>();
  let listError = '';
  /** An unread server snapshot may arrive before the receipt of a read or out of order. */
  const readThrough = new Map<string, number>();
  let lookupError = '';
  let finding = false;
  let entered = 0;

  const name = (address: string) => threads.get(address)?.name || inbox.shown(address);
  const rows = h('nav', {class: 'inbox-index', 'aria-label': t('Conversations')});
  arrowKeys(rows, '.inbox-row');
  const title = h('h1', {class: 'inbox-title'}, t('Inbox'));
  const newMessage = h('button', {type: 'button', class: 'inbox-deed', 'aria-label': t('New message')}, t('New message'), ' →');
  const back = h('button', {type: 'button', class: 'inbox-deed', hidden: ''}, '← ', t('Back'));
  const over = h('div', {class: 'inbox-over'}, newMessage, back);
  const pane = h('section', {class: 'inbox-thread', tabindex: '-1', hidden: ''});
  const desk = h('div', {class: 'inbox-page'}, rows, over, pane);
  const names = h('div', {class: 'inbox-names', hidden: ''});
  const stub = addressStub(me, again, () => goToPlan(ctx), () => { names.hidden = true; });
  names.append(stub.holder);
  const showNames = () => { names.hidden = false; stub.open(); };
  const maps = paperSwitch(papers, (key) => key === recipientPaper ? t('New message') : t('Conversation with {who}', {who: name(key)}), (key) => void take(key));

  holder.replaceChildren(title, desk, maps.element, names);
  const menus = inboxPlaces(holder, ctx, showNames);

  const unread = (th: inbox.Thread) => th.unread > 0 && th.last.time > (readThrough.get(th.address) ?? -1);
  const updateIndex = () => {
    const had = document.activeElement instanceof HTMLElement && rows.contains(document.activeElement) ? document.activeElement.dataset.address : undefined;
    const makeRow = (th: inbox.Thread) => {
      const who = name(th.address);
      const tail = th.last;
      const waiting = unread(th);
      const shown = inbox.shown(th.address);
      const named = who === shown ? who : `${who} · ${shown}`;
      const b = h('button', {type: 'button', class: 'inbox-row', 'data-address': th.address,
        'aria-current': String(papers.active === th.address),
        'aria-label': waiting ? t('{who} · unread', {who: named}) : named},
      h('span', {class: 'inbox-who'}, h('span', {class: 'inbox-dot', 'aria-hidden': 'true', ...(waiting ? {} : {hidden: ''})}),
        h('span', {class: 'inbox-first-line'}, h('span', {class: 'inbox-person'}, who),
          h('time', {datetime: new Date(tail.time).toISOString()}, new Date().toDateString() === new Date(tail.time).toDateString()
            ? letterClock(tail.time) : shortDay(tail.time)))),
      h('span', {class: 'inbox-last'}, (inbox.noticeWords(tail.target, tail.mine, who) ?? tail.body).split('\n')[0]));
      b.addEventListener('click', () => void take(th.address, 'paper'));
      return b;
    };
    const contacts = [...threads.values()].filter((x) => x.state === 'contact');
    const requests = [...threads.values()].filter((x) => x.state === 'request');
    const group = (label: string, all: inbox.Thread[]) =>
      h('section', {class: 'inbox-group'}, h('h2', {}, label), ...all.map(makeRow));
    rows.replaceChildren(...[
      listError ? h('p', {class: 'inbox-index-error', role: 'alert'}, listError) : null,
      contacts.length ? group(t('Messages'), contacts) : null,
      requests.length ? group(t('Requests'), requests) : null,
      !listError && !contacts.length && !requests.length ? h('p', {class: 'inbox-none'}, t('No messages yet')) : null,
    ].filter((el) => el !== null));
    if (had) rows.querySelector<HTMLElement>(`.inbox-row[data-address="${CSS.escape(had)}"]`)?.focus({preventScroll: true});
    maps.paint();
  };
  const selectInIndex = (key: string | null) => {
    for (const b of rows.querySelectorAll('.inbox-row')) b.setAttribute('aria-current', String(b.getAttribute('data-address') === key));
    maps.paint();
  };
  const mark = (address: string, time: number) => {
    readThrough.set(address, Math.max(time, readThrough.get(address) ?? -1));
    updateIndex();
    void inbox.markRead(address).then(() => look(), () => {});
  };

  const alive = () => !ended && holder.isConnected;
  const refresh = async () => {
    if (!alive()) return;
    const asked = ++listed;
    try {
      const latest = await inbox.threads();
      if (!alive() || asked !== listed) return;
      threads = new Map(latest.map((th) => [th.address, th]));
      listError = '';
    } catch (e) {
      if (!alive() || asked !== listed) return;
      listError = errorText(e);
    }
    // A conversation is not returned only because it was opened by username before the first message.
    updateIndex();
    const at = papers.active, th = at ? threads.get(at) : undefined;
    if (th && letterView) await letterView.refresh(th);
  };

  const showIndex = () => {
    desk.dataset.narrow = 'index';
    rows.querySelector<HTMLElement>('.inbox-row[aria-current=true], .inbox-row')?.focus({preventScroll: true});
  };
  const indexKey = h('button', {type: 'button', class: 'inbox-deed inbox-index-key'}, t('Inbox'));
  indexKey.addEventListener('click', showIndex);

  const chrome = (key: string | null) => {
    desk.dataset.narrow = key ? 'paper' : 'index';
    newMessage.hidden = key === recipientPaper;
    back.hidden = key !== recipientPaper;
  };
  const closeRecipient = (restore = true) => {
    papers.closeRecipient();
    void take(papers.active);
    if (restore) newMessage.focus({preventScroll: true});
  };
  back.addEventListener('click', () => closeRecipient());
  const keys = new AbortController();
  holder.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.isComposing || papers.active !== recipientPaper ||
        !(pane.contains(e.target as Node) || e.target === back)) return;
    e.preventDefault();
    e.stopPropagation();
    closeRecipient();
  }, {signal: keys.signal});
  newMessage.addEventListener('click', () => void take(recipientPaper, 'field'));

  function recipient(focus: boolean) {
    const heading = h('header', {class: 'inbox-top'}, h('h2', {}, t('New message')));
    const input = h('input', {name: 'recipient', maxlength: '285', 'aria-label': t('Recipient address'),
      'aria-describedby': 'inbox-address-kinds', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false'}) as HTMLInputElement;
    const open = h('button', {type: 'submit', class: 'inbox-deed inbox-strong'}, t('Open')) as HTMLButtonElement;
    const note = h('p', {class: 'inbox-address-note', id: 'inbox-address-kinds'}, t('Username, address, or 6-digit code'));
    const error = h('p', {class: 'inbox-address-error', role: 'alert'}, lookupError);
    const form = h('form', {class: 'inbox-recipient'}, h('label', {}, h('span', {}, t('To')), input), open, note, error);
    const line = () => {
      open.disabled = finding || !input.value.trim();
      open.textContent = finding ? t('Opening') : t('Open');
    };
    input.value = papers.to;
    line();
    input.addEventListener('input', () => {
      papers.to = input.value;
      entered++;
      finding = false;
      lookupError = error.textContent = '';
      line();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const typed = input.value.trim();
      if (!typed || finding) return;
      const asked = ++entered;
      const onThisPaper = opened;
      const current = () => alive() && asked === entered && opened === onThisPaper && papers.active === recipientPaper;
      const refused = (why: string) => {
        if (!current()) return;
        finding = false;
        lookupError = error.textContent = why;
        line();
        input.focus({preventScroll: true});
        nudge(input);
      };
      finding = true;
      lookupError = error.textContent = '';
      line();
      const found = await inbox.lookup(typed).catch((e: unknown) => ({reachable: false, why: errorText(e), address: undefined}));
      if (!current()) return;
      if (!found.reachable || !found.address) {
        refused(t('Cannot deliver to {address} ({why})', {address: typed, why: t(found.why ?? '')}));
        return;
      }
      if (me.addresses.some((a) => a.address === found.address)) {
        refused(t('Cannot message yourself; choose another recipient'));
        return;
      }
      try {
        // Keep the addressed paper in the hand until the actual letter is ready.
        const ready = await inbox.thread(found.address);
        if (!current()) return;
        papers.to = lookupError = '';
        papers.closeRecipient();
        void take(found.address, 'field', ready);
      } catch (e) {
        refused(t('Could not open the conversation ({why})', {why: errorText(e)}));
      }
    });
    pane.setAttribute('aria-label', t('New message'));
    pane.replaceChildren(heading, form);
    pane.hidden = false;
    if (focus) {
      // The recipient is another paper to the right, not a layer over the letter.
      if (!still()) pane.animate([{transform: 'translateX(48px)'}, {transform: 'none'}], {duration: paced(150), easing: 'ease-out'});
      input.focus({preventScroll: true});
    }
  }

  const stopLetter = () => {
    opened++;
    entered++;
    finding = false;
    letterView?.stop();
    letterView = null;
  };

  async function take(key: string | null, focus?: 'field' | 'paper', ready?: OpenedLetter) {
    if (!alive()) return;
    stopLetter();
    const now = opened;
    if (key) papers.take(key);
    pane.hidden = true;
    pane.replaceChildren();
    pane.removeAttribute('aria-label');
    pane.dataset.kind = key === recipientPaper ? 'recipient' : 'letter';
    chrome(key);
    selectInIndex(key);
    if (!key) return;
    if (key === recipientPaper) { recipient(focus === 'field'); return; }
    const current = () => alive() && now === opened && papers.active === key;
    const th = ready ?? await inbox.thread(key).catch((e: unknown) => e instanceof Error ? e : new Error(errorText(e)));
    if (!current()) return;
    pane.setAttribute('aria-label', t('Conversation with {who}', {who: inbox.shown(key)}));
    pane.hidden = false;
    if (th instanceof Error) {
      const retry = h('button', {type: 'button', class: 'inbox-deed'}, t('Try again'));
      retry.addEventListener('click', () => void take(key, 'paper'));
      pane.replaceChildren(indexKey, h('div', {class: 'inbox-letter-error'}, h('p', {role: 'alert'}, th.message), retry));
      if (focus) pane.focus({preventScroll: true});
      return;
    }
    letterView = letter({ctx, pane, indexKey, key, title: name(key), mine: inbox.username(me), th, papers, active: current, alive,
      refreshed: () => void refresh(),
      read: (time) => mark(key, time),
      answer: (state) => {
        // Accepting or blocking is deliberate; an answer which finishes after switching can't take the new paper away.
        if (state === 'blocked') papers.block(key);
        if (current() || (state === 'blocked' && alive() && now === opened)) void take(papers.active, state === 'accepted' ? 'field' : undefined);
        void refresh();
      },
      changed: () => void take(key),
    });
    if (focus === 'field' && letterView.input) letterView.input.focus({preventScroll: true});
    else if (focus) pane.focus({preventScroll: true});
  }

  const leaving = new MutationObserver(() => { if (!holder.isConnected) stop(); });
  if (holder.parentNode) leaving.observe(holder.parentNode, {childList: true});
  const unheard = onNews(() => { if (alive()) void refresh(); });
  const timer = every(60_000, refresh, {alive, ended: () => stop(), paced: true});
  const stop = () => {
    if (ended) return;
    ended = true;
    stopLetter();
    timer.stop();
    keys.abort();
    leaving.disconnect();
    unheard();
    menus.drop();
    stub.close();
  };
  const ready = (async () => {
    await refresh();
    if (alive()) await take(takeNext() ?? papers.active);
  })();
  return {ready, stop};
}
