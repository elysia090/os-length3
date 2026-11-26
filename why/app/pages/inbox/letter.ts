import {errorText} from '../../../api/errors.ts';
import {kindOf} from '../../../repo/text.ts';
import {json} from '../../../shipto/connection.ts';
import * as inbox from '../../../shipto/inbox.ts';
import type {Server} from '../../../shipto/servers.ts';
import {dateFormat} from '../../../text/format.ts';
import {t} from '../../../text/i18n.ts';
import {h} from '../../ui/dom.ts';
import type {Context} from '../kit/context.ts';
import {remember as serverAt} from '../server/parts.ts';
import type {InboxPapers} from './papers.ts';

const CLOCK: Intl.DateTimeFormatOptions = {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'};
const DAY: Intl.DateTimeFormatOptions = {weekday: 'long', month: 'long', day: 'numeric'};
export const letterClock = (ms: number) => dateFormat(CLOCK).format(ms);
const kindName = (k: inbox.Kind) => ({
  message: t('Message'), review: t('Review request'), question: t('Question'), run: t('Execution failed'),
})[k];

export function written(text: string): {kind: inbox.Kind; body: string; target: inbox.Target} {
  const {kind, title} = kindOf(text);
  const k = (kind ?? '').toLowerCase();
  const type: inbox.Kind = k === 'review' ? 'review' : k === 'question' ? 'question' : 'message';
  const body = type === 'message' ? text.trim() : title;
  const at = /\/root\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:\/issue\/([A-Za-z0-9._-]+\.md))?/.exec(text);
  return {kind: type, body, target: at ? {repo: at[1], ...(at[2] ? {issue: at[2]} : {})} : {}};
}

interface LetterOptions {
  ctx: Context;
  pane: HTMLElement;
  indexKey: HTMLElement;
  key: string;
  title: string;
  mine: string;
  th: Awaited<ReturnType<typeof inbox.thread>>;
  papers: InboxPapers;
  active(): boolean;
  alive(): boolean;
  refreshed(): void;
  read(time: number): void;
  answer(state: 'accepted' | 'blocked'): void;
  changed(): void;
}

export interface LetterView {
  input: HTMLTextAreaElement | null;
  refresh(th: inbox.Thread): Promise<void>;
  stop(): void;
}

/** The one held letter: only it reads, receives a direct connection, or shows a deed. */
export function letter(o: LetterOptions): LetterView {
  const {ctx, pane, key, th, papers, active} = o;
  const myName = inbox.shown(o.mine);
  const on = new inbox.Conversation();
  const messages = h('div', {class: 'inbox-messages'});
  const heading = h('h2', {}, o.title);
  let who = o.title;
  const direct = h('span', {class: 'inbox-direct', role: 'status', hidden: ''}, t('Direct'));
  const address = inbox.shown(key);
  const addressLine = h('p', {class: 'inbox-address'}, address, direct);
  const error = h('p', {class: 'inbox-letter-error', role: 'alert'});
  const days = new Map<number, HTMLElement>();
  let state = th.state;
  let first = !th.messages.length && state !== 'blocked';
  let input: HTMLTextAreaElement | null = null;
  let live: inbox.Live | null = null;
  let myServers: Promise<Server[]> | null = null;
  let more = 0;
  let unwatch: (() => void) | undefined;

  const writeTo = () => t(first ? 'Write to {who}' : 'Reply to {who}', {who});
  const addressTag = () => {
    pane.toggleAttribute('data-first-letter', first);
    addressLine.hidden = first && who === address && !th.mutual;
    if (input) input.placeholder = writeTo();
  };

  const serverLink = (id: string, knownWords?: HTMLElement) => {
    const go = h('button', {type: 'button', class: 'inbox-deed', hidden: ''});
    // A notice can be the first thing to say membership changed. Share only the request already in flight,
    // not the short Server-page cache, so an earlier look can't hide the new route.
    void (myServers ??= json<Server[]>('/v1/servers').finally(() => { myServers = null; })).then((list) => {
      if (!active()) return;
      const found = list.find((x) => x.id === id);
      if (!found) return;
      go.textContent = knownWords?.textContent || found.name;
      go.hidden = false;
      go.addEventListener('click', () => { serverAt({server: id}); void ctx.go('server'); });
      knownWords?.replaceWith(go);
    }, () => {});
    return go;
  };

  function entry(m: inbox.Message) {
    const remoteSaid = m.live ? null : inbox.noticeWords(m.target, m.mine, who);
    const time = h('time', {datetime: new Date(m.time).toISOString()}, letterClock(m.time));
    const place = inbox.placeOf(m.target);
    let about: HTMLElement | null = null;
    if (place) {
      const what = [place.repo, place.issue, m.target.change ? t('Change {id}', {id: String(m.target.change).slice(0, 8)}) : ''].filter(Boolean).join(' · ');
      about = h('button', {type: 'button', class: 'inbox-deed'}, `${t('Git')} · ${what}`);
      about.addEventListener('click', () => {
        if (place.issue) ctx.openRepo(place.repo, `issue/${place.issue}`);
        else { ctx.remember(place.repo); void ctx.go('git'); }
      });
    } else if (m.target.repo) about = h('span', {class: 'inbox-address'}, m.target.repo);
    else if (typeof m.target.server === 'string') {
      if (remoteSaid) {
        const line = h('p', {class: 'inbox-words'}, remoteSaid);
        serverLink(m.target.server, line);
        return h('article', {class: 'inbox-entry', 'data-time': String(m.time)}, h('header', {class: 'inbox-entry-by'}, time), line);
      }
      about = serverLink(m.target.server);
    }
    return h('article', {class: 'inbox-entry', 'data-time': String(m.time)},
      h('header', {class: 'inbox-entry-by'}, h('b', m.mine ? {} : {'data-peer': ''}, m.mine ? myName : who), time),
      m.type !== 'message' ? h('span', {class: 'inbox-kind'}, kindName(m.type)) : null,
      h('p', {class: 'inbox-words'}, m.body), about);
  }

  function append(list: readonly inbox.Message[], stay = false) {
    if (!list.length) return;
    if (first) { first = false; addressTag(); }
    const atFoot = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 3;
    messages.querySelector('.inbox-empty')?.remove();
    for (const m of list) {
      const day = new Date(m.time).setHours(0, 0, 0, 0);
      let group = days.get(day);
      if (!group) {
        group = h('section', {class: 'inbox-day', 'data-day': String(day)}, h('h3', {}, dateFormat(DAY).format(day)));
        days.set(day, group);
        const later = [...messages.children].find((el) => Number(el.getAttribute('data-day')) > day);
        messages.insertBefore(group, later ?? null);
      }
      let after = group.lastElementChild;
      // Normal posts append. A direct delivery and its Remote copy need not arrive in order.
      while (after?.matches('.inbox-entry') && Number(after.getAttribute('data-time')) > m.time) after = after.previousElementSibling;
      group.insertBefore(entry(m), after?.nextSibling ?? null);
    }
    if (stay || atFoot) messages.scrollTop = messages.scrollHeight;
  }
  const initial = on.took(th.messages);
  addressTag();
  append(initial);
  if (!initial.length && !first) messages.append(h('p', {class: 'inbox-empty'}, t('No messages yet')));

  const unread = (all: readonly inbox.Message[]) => {
    if (all.some((m) => !m.mine && !m.read)) o.read(all.reduce((last, m) => Math.max(last, m.time), 0));
  };
  // Seeing the request clears unread, not the separate Accept gate.
  unread(th.messages);

  function startLive() {
    if (live || typeof RTCPeerConnection === 'undefined') return;
    live = new inbox.Live(o.mine, key, (m) => {
      if (!active() || !on.have(m)) return;
      append([m]);
      if (!m.mine) o.read(m.time);
    }, (connected) => { direct.hidden = !connected; });
    live.start(active);
  }

  const request = state === 'request' && th.messages.some((m) => !m.mine);
  const action = (label: string, strong = false) => h('button', {type: 'button', class: `inbox-deed${strong ? ' inbox-strong' : ''}`}, t(label)) as HTMLButtonElement;
  let footer: HTMLElement;
  if (state === 'blocked') {
    footer = h('div', {class: 'inbox-footer'}, h('p', {}, t('{who} is blocked.', {who: o.title})));
  } else if (request) {
    // The existing API makes this a decision about the sender, not just one of their message subjects. Do not
    // guess private server names or whether a user-authored reference is eligible from the transcript.
    const yes = action('Accept', true), no = action('Block');
    const answer = (state: 'accepted' | 'blocked') => async () => {
      if (!active() || papers.busy(key)) return;
      papers.wait(key, true);
      yes.disabled = no.disabled = true;
      error.textContent = '';
      try {
        await inbox.setContact(key, state);
        o.answer(state);
      } catch (e) {
        if (active()) error.textContent = errorText(e);
      } finally {
        papers.wait(key, false);
        yes.disabled = no.disabled = false;
        if (o.alive() && !active()) o.refreshed();
      }
    };
    const update = () => { yes.disabled = no.disabled = papers.busy(key); };
    update();
    unwatch = papers.watching(key, update);
    yes.addEventListener('click', answer('accepted'));
    no.addEventListener('click', answer('blocked'));
    footer = h('div', {class: 'inbox-footer inbox-ask', role: 'group', 'aria-label': t('{who} initiated a conversation', {who: o.title})},
      h('p', {}, t('Accept to start a conversation. This also joins any eligible server invitations from this sender.')),
      h('div', {class: 'inbox-ask-acts'}, yes, no), error);
  } else {
    const status = h('p', {class: 'inbox-send-status', role: 'status'});
    const text = input = h('textarea', {class: 'inbox-reply', rows: '1', placeholder: writeTo(),
      'aria-label': t('Message'), maxlength: '4000'}) as HTMLTextAreaElement;
    const send = action('Send', true);
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    send.setAttribute('aria-keyshortcuts', mac ? 'Meta+Enter' : 'Control+Enter');
    text.value = papers.drafts.get(key);
    const update = () => {
      send.disabled = !text.value.trim() || papers.busy(key);
      send.hidden = !text.value.trim();
    };
    text.addEventListener('input', () => { papers.drafts.set(key, text.value); update(); });
    const write = async () => {
      if (!active() || send.disabled || papers.busy(key)) return;
      const words = text.value;
      if (!words.trim()) return;
      papers.wait(key, true);
      update();
      status.textContent = error.textContent = '';
      try {
        const {kind, body, target} = written(words);
        const r = await inbox.send(key, body, kind, target);
        if (papers.drafts.get(key) === words) papers.drafts.sent(key);
        if (!active()) return;
        const m: inbox.Message = {id: r.id, mine: true, type: kind, target, body, time: Date.now(), read: false};
        live?.say(m);
        if (on.have(m)) append([m], true);
        if (text.value === words) text.value = '';
        state = 'contact';
        pane.dataset.state = state;
        status.textContent = r.request ? t('Sent as a message request.') : '';
        text.focus({preventScroll: true});
      } catch (e) {
        if (active()) error.textContent = errorText(e);
      } finally {
        papers.wait(key, false);
        update();
        o.refreshed();
      }
    };
    send.addEventListener('click', () => void write());
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); void write(); } });
    update();
    unwatch = papers.watching(key, () => {
      const current = papers.drafts.get(key);
      if (text.value !== current) text.value = current;
      update();
    });
    footer = h('div', {class: 'inbox-footer inbox-write'}, h('div', {class: 'inbox-write-line'}, text, send), status, error);
  }
  pane.dataset.state = state;
  pane.replaceChildren(h('header', {class: 'inbox-top'}, o.indexKey, heading, addressLine), messages, footer);
  messages.scrollTop = papers.scroll.get(key) ?? 0;
  if (th.mutual) startLive();
  return {
    input,
    async refresh(row) {
      const named = row.name || inbox.shown(key);
      if (named !== who) {
        who = named;
        heading.textContent = named;
        for (const by of messages.querySelectorAll('b[data-peer]')) by.textContent = named;
        addressTag();
      }
      if (row.state !== state) { o.changed(); return; }
      // A stale unread list may describe messages just marked read, so pull only new text or changed state.
      if (!on.behind(row)) return;
      const at = ++more;
      const next = await inbox.thread(key).catch(() => null);
      if (!next || !active() || at !== more) return;
      if (next.state !== state) { o.changed(); return; }
      append(on.took(next.messages));
      unread(next.messages);
      if (next.mutual) startLive();
    },
    stop() {
      papers.scroll.set(key, messages.scrollTop);
      unwatch?.();
      live?.stop();
      live = null;
    },
  };
}
