import {ago, arrowKeys, day, h} from '../ui/dom.ts';
import {t} from '../i18n.ts';
import * as inbox from '../remote/inbox.ts';
import {connection} from '../remote/connection.ts';
import {look, onNews} from '../remote/news.ts';
import {Drafts} from '../home/drafts.ts';
import {kindOf} from '../repos/text.ts';
import {mark} from '../ui/icons.ts';
import {copying, deed, pageHead} from './common.ts';
import {personBadge} from './pane.ts';
import {every} from '../app/runs.ts';
import {goToPlan, planRefused, planSaid, signInBox, signInPlace, unreachedError, unreachedPlace} from './remote.ts';
import {plan as readPlan} from '../remote/plan.ts';
import type {Context} from './context.ts';
import {errorText} from '../app/errors.ts';
import {arrive, closeUp, keepOut, LAND, nudge, paced, putAway, still, where} from '../ui/glide.ts';

// Inbox: what comes to you, typed, from people found by address. Not a mail
// screen: each message says what it is (a message, a review request, a
// question, a failed run) and what it is about, with the way there.
//
// On the page's three columns (as Home's repos and New repo stand):
//   the first      your name as a stub: your name on this Remote and your
//                  code (each copied by a press); its gear for your names'
//                  terms and a name on your own domain beside it (proved by
//                  a DNS record); SSH is Runtime's, per device. Under it, of
//                  its width and height, the field to write to someone new;
//                  under that the conversations: contacts, then requests
//                  (accept or block), or that none came yet
//   the other two  the conversation as a sheet, the line's state (direct, or
//                  through the Remote), and the box to write in; none open
//                  and none to open, nothing

const KIND = (k: inbox.Kind) => ({message: t('Message'), review: t('Review request'), question: t('Question'), run: t('Run failed')})[k];

function button(text: string, kind = ''): HTMLButtonElement {
  return h('button', {class: `button ${kind}`.trim(), type: 'button'}, text) as HTMLButtonElement;
}

/**
 * A name just taken: the field it was written in, its name in it, goes up and becomes the stub (no empty box flown in
 * its place), and from a field it turns into a name; as it lands its code and gear come in beside it, and what the
 * Inbox holds comes in under it.
 */
function took(stub: HTMLElement, from: DOMRect) {
  if (still()) return;
  const at = stub.getBoundingClientRect();
  if (!at.width || !at.height) return;
  stub.style.transformOrigin = '0 0';
  const back = () => { stub.style.transformOrigin = ''; };
  stub.animate([
    {transform: `translate(${from.left - at.left}px, ${from.top - at.top}px) scale(${from.width / at.width}, ${from.height / at.height})`, backgroundColor: 'var(--raised)', borderColor: 'var(--edge)'},
    {transform: 'none'},
  ], {duration: paced(380), easing: LAND}).finished.then(back, back);
  for (const el of stub.querySelectorAll<HTMLElement>('.stub-code, .stub-gear')) {
    el.animate([{opacity: 0, transform: 'translateX(-8px)'}, {opacity: 1, transform: 'none'}], {duration: paced(260), delay: paced(300), easing: LAND, fill: 'backwards'});
  }
  const under = stub.closest('.inbox-page')?.querySelector<HTMLElement>('.inbox-list');
  under?.animate([{opacity: 0, transform: 'translateY(10px)'}, {opacity: 1, transform: 'none'}], {duration: paced(300), delay: paced(160), easing: LAND, fill: 'backwards'});
}

/**
 * Your name as a stub: your name on this Remote, shown alone (it is a name,
 * not a domain anyone holds), and your code, six digits to be found by; a
 * press copies either. Before there is a name, the name to claim, alone, as
 * it will be shown (Enter claims): first come, yours for five years at a
 * time; nothing after an @ is the person's to think of. Once there is one, at
 * its right end the gear opens your names, each with its term and Renew near
 * its end, and a name of your choosing on a domain you own, shown beside it:
 * the TXT record to put in its DNS, looked for every few seconds while open,
 * and the name claimed as soon as the record is there.
 */
function addressStub(me: inbox.Me, again: () => void, toPlan: () => void): HTMLElement {
  const error = h('p', {class: 'error', role: 'alert'});
  const gear = h('button', {type: 'button', class: 'stub-gear', 'aria-label': t('Your names'), 'aria-expanded': 'false'}, mark('gear')) as HTMLButtonElement;
  const note = h('p', {class: 'muted small'});
  const panel = h('div', {class: 'stub-panel pop', hidden: ''});
  let stub: HTMLElement;
  let take: HTMLButtonElement | null = null;
  if (me.addresses.length) {
    const a = inbox.shown(me.addresses[0].address);
    const text = h('button', {type: 'button', class: 'stub-text'}, a);
    copying(text, a);
    const code = h('button', {type: 'button', class: 'stub-code mono', 'aria-label': t('Your code {code}', {code: me.code})}, me.code);
    copying(code, me.code);
    stub = h('div', {class: 'stub'}, text, code, gear);
  } else {
    const name = h('input', {class: 'stub-in', placeholder: t('name'), 'aria-label': t('Name'), autocapitalize: 'off', spellcheck: 'false', maxlength: '31'}) as HTMLInputElement;
    // Taken with Enter or with Take it, asked once: pressed again while it is asked, nothing more is claimed.
    const claim = async () => {
      if (!name.value.trim() || name.readOnly) { name.focus(); return; }
      error.textContent = '';
      name.readOnly = true;
      take!.disabled = true;
      try { await inbox.claim(name.value); again(); } catch (err) { const plan = planRefused(err, toPlan); if (plan) error.replaceChildren(plan); else { error.textContent = errorText(err); nudge(stub); } } finally { name.readOnly = false; take!.disabled = false; }
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) void claim(); });
    take = button(t('Take it'), 'primary');
    take.addEventListener('click', () => void claim());
    // The name alone, as it will be shown everywhere: what comes after an @ is not the person's to think of (a name on
    // a domain of one's own is behind the gear once a name is taken).
    stub = h('div', {class: 'stub'}, name);
    note.textContent = t('A name on this Remote: first come, yours for five years at a time, renewed by you.');
  }
  // The gear's panel, as the person's menu: your names with their terms, then Add a domain, then letting one go.
  let looking: {stop(): void} | null = null;
  const item = (label: string, at: Node | null = null) => h('button', {type: 'button', class: 'pop-item'}, label, at) as HTMLButtonElement;
  /** Your own domain, written whole in one field (name@domain, the @ too); its record looked for while the panel is open. */
  const own = (): HTMLElement => {
    const field = h('input', {class: 'line-in', placeholder: t('name@example.org'), 'aria-label': t('Name on your domain'),
      autocapitalize: 'off', spellcheck: 'false', maxlength: '285'}) as HTMLInputElement;
    const record = h('div', {class: 'stub-record'});
    const parts = () => {
      const v = field.value.trim(), at = v.lastIndexOf('@');
      return at < 0 ? {name: '', domain: v} : {name: v.slice(0, at), domain: v.slice(at + 1)};
    };
    const look = async () => {
      if (!panel.isConnected || panel.hidden) return;
      const asked = field.value.trim();
      const {name, domain} = parts();
      if (!domain) { record.replaceChildren(); return; }
      const r = await inbox.domainRecord(domain).catch((e: unknown) => e instanceof Error ? e : new Error(String(e)));
      // Written over meanwhile: this answer is for a domain no longer asked about, and is not shown (nor claimed).
      if (field.value.trim() !== asked) return;
      if (r instanceof Error) { record.replaceChildren(h('p', {class: 'error'}, r.message)); return; }
      const row = (label: string, value: string) => {
        const v = h('button', {type: 'button', class: 'record-value mono'}, value);
        copying(v, value);
        return h('div', {class: 'record-row'}, h('span', {class: 'muted small'}, label), v);
      };
      record.replaceChildren(
        h('p', {class: 'muted small'}, t('Put this record in the domain\'s DNS')),
        row(t('Name'), r.name), row(t('Type'), r.type), row(t('Value'), r.value),
        h('p', {class: `small record-found${r.found ? ' found' : ''}`}, !r.found ? t('Not found yet') : name ? t('Found. Claiming {address}…', {address: `${name}@${domain}`}) : t('Found')));
      if (r.found && name) {
        looking?.stop();
        try { await inbox.claim(name, domain); again(); } catch (e) {
          const plan = planRefused(e, toPlan);
          if (plan) paid.replaceChildren();
          record.append(h('p', {class: 'error'}, plan ?? errorText(e)));
        }
      }
    };
    field.addEventListener('change', () => void look());
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) void look(); });
    looking?.stop();
    looking = every(8000, look, {alive: () => panel.isConnected && !panel.hidden, paced: true});
    // A name on one's own domain is paid: a free account is told before it goes to its DNS, with the way to the Plan.
    const paid = h('p', {class: 'muted small'});
    void readPlan().then((p) => {
      if (p.plan !== 'free') return;
      paid.replaceChildren(planSaid({rule: 'domain', buy: !!p.buy}, toPlan));
    }, () => {});
    queueMicrotask(() => field.focus());
    return h('div', {class: 'stub-own'}, field, paid, record);
  };
  /** Add a domain: pressed, the row is the field, where it was. */
  const adding = (): HTMLElement => {
    const b = item(t('Add a domain'), mark('plus'));
    b.querySelector('svg')?.classList.add('pop-mark');
    b.addEventListener('click', () => b.replaceWith(own()));
    return b;
  };
  /** Your names, each with its state: its term (Renew near its end), or that its domain no longer names this Remote. */
  const yours = (): HTMLElement => {
    const YEAR = 365 * 86_400_000;
    return h('div', {class: 'pop-group', role: 'group', 'aria-label': t('Your names')}, h('div', {class: 'pop-head muted small'}, t('Your names')), ...me.addresses.map((a) => {
      const state = a.lapsed ? h('span', {class: 'small error'}, t('its domain no longer names this Remote'))
        : a.ended ? h('span', {class: 'small error'}, t('Its term ended; held for you until {date}', {date: day(a.until! + 30 * 86_400_000)}))
        : a.until ? h('span', {class: 'muted small'}, t('Until {date}', {date: day(a.until)})) : null;
      const renew = a.until && (a.ended || a.until - Date.now() < YEAR) ? h('button', {type: 'button', class: 'button small-button primary'}, t('Renew')) as HTMLButtonElement : null;
      if (renew) deed(renew, async () => { await inbox.renew(a.address); again(); });
      return h('div', {class: 'your-row'}, h('span', {}, inbox.shown(a.address)), state, renew);
    }));
  };
  // Letting a name go is not offered here; the Remote's way to do it stays (l3 people release uses it).
  const fill = () => panel.replaceChildren(yours(), adding());
  // The panel lies over the Inbox under it; Escape or a press outside closes it.
  const holder = h('div', {class: 'stub-holder'}, stub, note, error, take ? h('div', {class: 'card-foot'}, h('span', {class: 'grow'}), take) : null, panel);
  // Put away by Escape from inside it, the keyboard goes back to the gear rather than to the page.
  const away = (e: Event) => {
    if (!(e instanceof KeyboardEvent ? e.key === 'Escape' : !holder.contains(e.target as Node))) return;
    const inside = panel.contains(document.activeElement);
    toggle(false);
    if (e instanceof KeyboardEvent && inside) gear.focus();
  };
  const toggle = (open: boolean) => {
    if (open) { keepOut(panel); panel.hidden = false; } else putAway(panel, () => { panel.hidden = true; });
    gear.setAttribute('aria-expanded', String(open));
    for (const k of ['pointerdown', 'keydown'] as const) (open ? document.addEventListener : document.removeEventListener).call(document, k, away);
    if (open) fill(); else looking?.stop();
  };
  gear.addEventListener('click', () => toggle(gear.getAttribute('aria-expanded') !== 'true'));
  return holder;
}

/** What a written message is: its kind named first like an issue, and what a /root/… path in it is about. */
export function written(text: string): {kind: inbox.Kind; body: string; target: inbox.Target} {
  const {kind, title} = kindOf(text);
  const k = (kind ?? '').toLowerCase();
  const type: inbox.Kind = k === 'review' ? 'review' : k === 'question' ? 'question' : 'message';
  const body = type === 'message' ? text.trim() : title;
  const at = /\/root\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:\/issue\/([A-Za-z0-9._-]+\.md))?/.exec(text);
  return {kind: type, body, target: at ? {repo: at[1], ...(at[2] ? {issue: at[2]} : {})} : {}};
}

/**
 * What is half written stays with what it was written for: each conversation's message by its
 * address, and the name or code being written to, kept while the app runs (as Forge keeps a
 * prompt by its repo), swapped with the conversation and gone only when it is sent.
 */
const drafts = new Drafts();
/** The name or code being written to, under its own key. */
const TO = '\0to';

/** The conversation the page is next come to for (Home's Lately), opened as it is drawn. */
let wanted: string | null = null;
export function openNext(address: string) { wanted = address; }
/** The conversation open as Inbox was left: open again, as it was, when Inbox is come back to. */
let left: string | null = null;

export function inboxPage(ctx: Context): Node[] {
  const holder = h('div', {});
  let open: string | null = left;
  /** Nobody written to or from, as the list was last read (none read yet: as for a name just taken); and the field a name was just taken in. */
  let bare = true;
  let landing: DOMRect | null = null;
  let live: inbox.Live | null = null;
  let mine = '';
  /** Which reading of the list, and which opening of a conversation, is the latest: an older answer that comes after it is not drawn. */
  let listed = 0, opened = 0;
  /** The open conversation: the time of the newest it has, and how to take in what came since. */
  let shownThread: {address: string; on: inbox.Conversation; more(): Promise<void>} | null = null;

  const paint = async () => {
    if (!connection()) {
      // Signed out, the same card as Remote's, in the same place.
      holder.replaceChildren(signInPlace(t('Sign in'), signInBox(() => void paint())));
      return;
    }
    let me: inbox.Me;
    try { me = await inbox.me(); } catch (e) {
      holder.replaceChildren(unreachedError(e) ? unreachedPlace(t('Your conversations are here again once it answers'), () => void paint()) : h('p', {class: 'error'}, errorText(e)));
      return;
    }
    // No name yet: the one thing to do here, in the middle, as signing in was (the same card, in the same place).
    if (!me.addresses.length) {
      // Taken: the field it was written in goes up to where the name now lives, the row at the Inbox's top.
      const place = signInPlace(t('Take a name'), addressStub(me, () => {
        landing = where(place.querySelector('.stub'));
        void paint();
      }, () => goToPlan(ctx)));
      holder.replaceChildren(place);
      return;
    }
    mine = me.addresses[0].address;
    // The field to write to someone new is made once: what comes every little while changes only the rows under it.
    const to = h('input', {class: 'line-in', placeholder: t('Write to a name or a code'), 'aria-label': t('Write to a name or a code'), autocapitalize: 'off', spellcheck: 'false'}) as HTMLInputElement;
    to.value = drafts.get(TO);
    to.addEventListener('input', () => { drafts.set(TO, to.value); error.textContent = ''; });
    const start = button(t('Write'), 'small-button');
    const error = h('p', {class: 'error', role: 'alert'});
    const rows = h('div', {class: 'inbox-rows'});
    arrowKeys(rows, '.inbox-row');
    const list = h('nav', {class: 'inbox-list', 'aria-label': t('Conversations')}, h('div', {class: 'row inbox-new'}, to, start), error, rows);
    const pane = h('section', {class: 'inbox-thread', 'aria-live': 'polite'});
    to.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) start.click(); });
    start.addEventListener('click', async () => {
      if (!to.value.trim()) { to.focus(); nudge(to); return; }
      error.textContent = '';
      const found: {address?: string; reachable: boolean; why?: string} = await inbox.lookup(to.value).catch((e) => ({reachable: false, why: errorText(e)}));
      if (!found.reachable) { error.textContent = t('Cannot reach {address} ({why})', {address: to.value, why: t(found.why ?? '')}); nudge(to); return; }
      // One's own name finds oneself: a conversation with no one else in it is not one.
      if (me.addresses.some((a) => a.address === found.address)) { error.textContent = t('That is you: write to someone else'); to.focus(); nudge(to); return; }
      // Gone to: the field has done its work.
      to.value = '';
      drafts.sent(TO);
      void show(found.address!, rows, pane);
    });
    // No sheet until the list says there is one to show (as it did last time it was read): not a sheet drawn and taken away.
    holder.replaceChildren(h('div', {class: 'inbox-page'},
      addressStub(me, () => void paint(), () => goToPlan(ctx)),
      h('div', {class: bare && !open ? 'inbox-box none' : 'inbox-box'}, list, pane)));
    // A name just taken goes up into its place as it is drawn there, before the frame after shows it standing.
    const stub = holder.querySelector<HTMLElement>('.stub');
    if (landing && stub) took(stub, landing);
    landing = null;
    await paintList(rows, pane);
    if (wanted) { const at = wanted; wanted = null; void show(at, rows, pane); }
    else if (open && rows.querySelector(`.inbox-row[data-address="${CSS.escape(open)}"]`)) void show(open, rows, pane);
    else if (open) { open = left = null; pane.parentElement?.classList.toggle('none', bare); }
  };

  /** Who each conversation is with, by the name the list gives them: the conversation's head says it as its row does. */
  const names = new Map<string, string>();
  const named = (address: string) => names.get(address) || inbox.shown(address);
  const paintList = async (rows: HTMLElement, pane: HTMLElement) => {
    const asked = ++listed;
    let all: inbox.Thread[] = [], unread = '';
    try { all = await inbox.threads(); } catch (e) { unread = errorText(e); }
    if (asked !== listed) return;
    for (const th of all) if (th.name) names.set(th.address, th.name);
    const row = (th: inbox.Thread) => {
      // The open one is being read: what came to it is not counted as waiting.
      const waiting = th.address === open ? 0 : th.unread;
      const b = h('button', {type: 'button', class: 'inbox-row', 'data-state': th.state, 'data-address': th.address},
        h('span', {class: 'inbox-who'}, personBadge(th.name || inbox.shown(th.address)), h('b', {}, th.name || inbox.shown(th.address)),
          waiting ? h('span', {class: 'unread'}, `${waiting}`) : null),
        h('span', {class: 'muted small'}, inbox.shown(th.address)),
        h('span', {class: 'muted small inbox-last'}, `${th.last.mine ? t('You: ') : ''}${th.last.type === 'message' ? '' : `${KIND(th.last.type)} · `}${th.last.body}`));
      if (th.address === open) b.setAttribute('aria-current', 'true');
      b.addEventListener('click', () => void show(th.address, rows, pane));
      return b;
    };
    const contacts = all.filter((x) => x.state === 'contact'), requests = all.filter((x) => x.state === 'request');
    // The keyboard on a row stays on that row as the rows are drawn again.
    const had = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.inbox-row')?.dataset.address;
    rows.replaceChildren(
      // Not read: said where the conversations would be, not shown as none.
      ...(unread ? [h('p', {class: 'error'}, unread)] : []),
      // None: said where they will be, under the field that starts one.
      ...(!unread && !all.length ? [h('p', {class: 'quiet inbox-none'}, t('No messages yet'))] : []),
      ...contacts.map(row),
      ...(requests.length ? [h('h3', {class: 'inbox-head'}, t('Requests')), ...requests.map(row)] : []));
    if (had) rows.querySelector<HTMLElement>(`.inbox-row[data-address="${CSS.escape(had)}"]`)?.focus();
    // One quiet line in the open pane says what to do; none yet, it says so instead.
    if (!open && !unread) pane.removeAttribute('aria-label');
    // No conversation open (none written yet, or none chosen), there is no sheet: not a sheet of nothing. The one
    // chosen brings it in.
    bare = !open && !unread;
    pane.parentElement?.classList.toggle('none', bare);
    if (!open && !unread) pane.replaceChildren();
    // What came to the open conversation since it was drawn is put at its foot.
    const open_ = shownThread;
    const now = open_ && all.find((x) => x.address === open_.address);
    // Something there the Remote counts unread is taken in too (and so read), though it may be here already.
    if (open_ && now && (open_.on.behind(now) || now.unread > 0)) await open_.more();
  };

  const show = async (address: string, rows: HTMLElement, pane: HTMLElement) => {
    // Opened again before the last opening was drawn (a row pressed twice): only the latest is drawn,
    // so one conversation never gets two panes, nor two direct lines.
    const asked = ++opened;
    open = left = address;
    // The first conversation brings its sheet in, from the field that started it; another one, chosen while one is
    // open, comes into the sheet as it is (what was there fading out of it as the new comes in), never at once.
    const switching = !!pane.parentElement && !pane.parentElement.classList.contains('none') && pane.childElementCount > 0;
    if (pane.parentElement?.classList.contains('none')) {
      pane.parentElement.classList.remove('none');
      arrive(pane, -1, 'x', 24, 320);
    }
    rows.querySelector('.inbox-none')?.remove();
    live?.stop();
    live = null;
    shownThread = null;
    const th = await inbox.thread(address).catch((e) => { if (asked === opened) pane.replaceChildren(h('p', {class: 'error'}, errorText(e))); return null; });
    if (!th || asked !== opened) return;
    // Heard as the conversation it is, by the other's address (one only theirs: two may share a name).
    pane.setAttribute('aria-label', t('Conversation with {who}', {who: inbox.shown(address)}));
    // Read is said again the next time the conversation opens; nothing waits on it. The rail's mark follows.
    const read = () => void inbox.markRead(address).then(() => look(), () => {});
    read();
    const lineWord = h('span', {class: 'muted small'}, t('Through the Remote'));
    const messages = h('div', {class: 'inbox-messages'});
    const on = new inbox.Conversation();
    /** A message as a bubble at the foot. */
    const bubble = (m: inbox.Message) => {
      const about = [m.target.repo, m.target.issue, m.target.change ? t('change {id}', {id: String(m.target.change).slice(0, 8)}) : ''].filter(Boolean).join(' · ');
      // A way there only where it names a place a repo here could be; a repo named otherwise is said, as words.
      const place = inbox.placeOf(m.target);
      let go: HTMLElement | null = null;
      if (place) {
        go = h('button', {type: 'button', class: 'link'}, about);
        go.addEventListener('click', () => { if (place.issue) ctx.openRepo(place.repo, `issue/${place.issue}`); else { ctx.remember(place.repo); ctx.go('git'); } });
      } else if (m.target.repo) go = h('span', {class: 'muted small'}, about);
      const b = h('div', {class: 'bubble', 'data-mine': String(m.mine)},
        m.type !== 'message' ? h('span', {class: 'state-chip'}, KIND(m.type)) : null,
        go, h('p', {class: 'bubble-text'}, m.body),
        h('span', {class: 'muted small'}, `${ago(m.time)}${m.live ? ` · ${t('direct')}` : ''}`));
      // What was said before goes up to make room for it on the same curve, not a line higher in one frame.
      messages.querySelector('.inbox-empty')?.remove();
      const before = drawn ? [...messages.children].slice(-12) as HTMLElement[] : [];
      const was = before.at(-1)?.getBoundingClientRect().bottom;
      messages.append(b);
      messages.scrollTop = messages.scrollHeight;
      // Come since the conversation was drawn: one's own up from the box it was written in, theirs in from their side.
      if (drawn) { if (m.mine) arrive(b, 1, 'y', 18, 300); else arrive(b, -1, 'x', 18, 300); }
      if (was !== undefined) { const by = was - before.at(-1)!.getBoundingClientRect().bottom; if (by > .5) closeUp(before, by, 300); }
    };
    // What the Remote gives is taken in once (its newest noted by its clock); what is added here,
    // sent or come over the direct line, is drawn once too, and not again when the Remote gives it.
    let drawn = false;
    on.took(th.messages).forEach(bubble);
    // None yet: said once where the words will come, gone with the first of them.
    if (!messages.childElementCount) messages.append(h('div', {class: 'empty inbox-empty'}, t('No messages yet')));
    drawn = true;
    // Come by the direct line, it is read where it lands, as one taken in through the Remote is: the rail's mark
    // is not left on a conversation open on the screen.
    const add = (m: inbox.Message) => {
      if (!on.have(m)) return;
      bubble(m);
      // Theirs, by the direct line: read, and its row in the list says it once the Remote has it too.
      if (!m.mine) { read(); setTimeout(() => { if (open === address) void paintList(rows, pane); }, 800); }
    };
    // Accepted both ways: a direct line between the two devices, when both are here.
    const startLive = () => {
      live?.stop();
      live = new inbox.Live(mine, address, add, (direct) => { lineWord.textContent = direct ? t('Direct') : t('Through the Remote'); });
      // Ends with the page, not at the page's next look.
      live.start(() => holder.isConnected);
    };
    // Taken in every little while through the Remote: what is not here yet goes at the foot, and is read.
    const more = async () => {
      const now = await inbox.thread(address).catch(() => null);
      if (!now || asked !== opened || !pane.contains(messages)) return;
      const came = on.took(now.messages);
      came.forEach(bubble);
      // Any of theirs the Remote still counts unread (one come first by the direct line, marked before the Remote had
      // it) is read: it is on the screen.
      if (came.some((m) => !m.mine) || now.messages.some((m) => !m.mine && !m.read)) read();
      // Accepted both ways meanwhile: the direct line can open now.
      if (now.mutual && !live) startLive();
    };
    shownThread = {address, on, more};
    const error = h('p', {class: 'error', role: 'alert'});
    // Accept or block someone who wrote first: one answer, asked once (both held while it is), and said if it did not go.
    const decide: HTMLButtonElement[] = [];
    // A request is theirs to be answered: one written to first, by someone who has not written, has nothing to accept.
    if (th.state === 'request' && th.messages.some((m) => !m.mine)) {
      const answer = (state: 'accepted' | 'blocked', then: () => void) => async () => {
        if (decide.some((b) => b.disabled)) return;
        for (const b of decide) b.disabled = true;
        error.textContent = '';
        try { await inbox.setContact(address, state); } catch (e) {
          for (const b of decide) b.disabled = false;
          error.textContent = errorText(e);
          return;
        }
        then();
      };
      const yes = button(t('Accept'), 'small-button primary'), no = button(t('Block'), 'small-button');
      yes.addEventListener('click', answer('accepted', () => { void show(address, rows, pane); void paintList(rows, pane); }));
      no.addEventListener('click', answer('blocked', () => { open = left = null; shownThread = null; void paintList(rows, pane); }));
      decide.push(yes, no);
    }
    // Writing is one line that grows as it is written. What it is reads off the text the way
    // an issue is named ("Review：…", "Question：…"), and a /root/… path in it says what it
    // is about; nothing else to choose. Enter is a new line; Ctrl+Enter sends. What is half
    // written stays with this conversation, here when it is opened again.
    const text = h('textarea', {class: 'line-in bubble-in', rows: '1', placeholder: t('Write to {address}…', {address: inbox.shown(address)}), 'aria-label': t('Message'), maxlength: '4000'}) as HTMLTextAreaElement;
    text.value = drafts.get(address);
    const grow = () => { text.style.height = 'auto'; text.style.height = `${Math.min(text.scrollHeight + 2, 200)}px`; };
    text.addEventListener('input', () => { drafts.set(address, text.value); grow(); });
    const sendB = button(t('Send'), 'primary');
    const go = async () => {
      if (sendB.disabled) return;
      if (!text.value.trim()) { text.focus(); nudge(text); return; }
      sendB.disabled = true;
      error.textContent = '';
      try {
        const {kind, body, target} = written(text.value);
        const r = await inbox.send(address, body, kind, target);
        const m: inbox.Message = {id: r.id, mine: true, type: kind, target, body: body.trim(), time: Date.now(), read: false};
        live?.say(m);
        add({...m, live: live?.open});
        text.value = '';
        drafts.sent(address);
        grow();
        if (r.request) error.textContent = t('Sent as a request: they see it once they accept you.');
        // Its row says so now (the first to someone new comes into the list), not at the next look.
        void paintList(rows, pane);
      } catch (e) { error.textContent = errorText(e); }
      sendB.disabled = false;
      // The keyboard stays where one writes, for the next (Send pressed and held while it sent, it would be nowhere).
      if (text.isConnected) text.focus({preventScroll: true});
    };
    sendB.addEventListener('click', () => void go());
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); void go(); } });
    pane.replaceChildren(
      h('header', {class: 'inbox-top'}, h('b', {}, named(address)), lineWord, h('span', {class: 'grow'}), ...decide),
      messages,
      h('div', {class: 'inbox-write'},
        h('div', {class: 'row write-line'}, text, sendB),
        h('p', {class: 'muted small write-hint'}, t('Review: or Question: first to ask · a /root/… path says what it is about · Ctrl+Enter sends')), error));
    if (text.value) grow();
    if (switching && !still()) for (const c of pane.children) c.animate([{opacity: 0}, {opacity: 1}], {duration: paced(180), easing: 'ease-out'});
    text.focus();
    text.setSelectionRange(text.value.length, text.value.length);
    if (th.mutual) startLive();
    for (const b of rows.querySelectorAll<HTMLElement>('.inbox-row')) {
      if (b.dataset.address === address) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
      // Opened, its count is read.
      if (b.dataset.address === address) b.querySelector('.unread')?.remove();
    }
  };

  void paint();
  // New messages through the Remote: the rows, and the open conversation, drawn again when what is unread changes
  // (news.ts looks for that anyway), and now and then besides (slower while nobody is at it: runs.ts paced).
  const again = async () => {
    const rows = holder.querySelector<HTMLElement>('.inbox-rows'), pane = holder.querySelector<HTMLElement>('.inbox-thread');
    // Not while a row has the keyboard: drawn again, it would be lost.
    if (rows && pane && !rows.contains(document.activeElement)) await paintList(rows, pane);
  };
  const unheard = onNews(() => { if (holder.isConnected) void again(); });
  every(60_000, again, {alive: () => holder.isConnected, ended: () => { live?.stop(); unheard(); }, paced: true});
  return [pageHead('inbox'), holder];
}
