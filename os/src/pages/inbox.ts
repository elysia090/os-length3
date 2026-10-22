import {ago, day, h} from '../dom.ts';
import {t} from '../i18n.ts';
import * as inbox from '../inbox.ts';
import {connection} from '../remote.ts';
import {look} from '../news.ts';
import {Drafts} from '../drafts.ts';
import {kindOf} from '../text.ts';
import {mark} from '../icons.ts';
import {copying, deed, pageHead} from './common.ts';
import {every} from '../runs.ts';
import {goToPlan, planRefused, planSaid, signInBox, signInPlace} from './remote.ts';
import {plan as readPlan} from '../plan.ts';
import type {Context} from './context.ts';
import {errorText} from '../errors.ts';

// Inbox: what comes to you, typed, from people found by address. Not a mail
// screen: each message says what it is (a message, a review request, a
// question, a failed run) and what it is about, with the way there.
//
//   your name      as a stub: your name on this Remote and your code (each
//                  copied by a press); its gear for your names' terms and a
//                  name on your own domain beside it (proved by a DNS
//                  record); SSH is Runtime's, per device
//   left           conversations: contacts, then requests (accept or block)
//   right          the conversation, the line's state (direct, or through
//                  the Remote), and the box to write in

const KIND = (k: inbox.Kind) => ({message: t('Message'), review: t('Review request'), question: t('Question'), run: t('Run failed')})[k];

function button(text: string, kind = ''): HTMLButtonElement {
  return h('button', {class: `button ${kind}`.trim(), type: 'button'}, text) as HTMLButtonElement;
}

/**
 * Your name as a stub: your name on this Remote, shown alone (it is a name,
 * not a domain anyone holds), and your code, six digits to be found by; a
 * press copies either. Before there is a name, the name to claim (Enter
 * claims): first come, yours for five years at a time. At its right end the
 * gear opens your names, each with its term and Renew near its end, and a
 * name of your choosing on a domain you own, shown beside it: the TXT
 * record to put in its DNS, looked for every few seconds while open, and the
 * name claimed as soon as the record is there.
 */
function addressStub(me: inbox.Me, again: () => void, toPlan: () => void): HTMLElement {
  const error = h('p', {class: 'error', role: 'alert'});
  const gear = h('button', {type: 'button', class: 'stub-gear', 'aria-label': t('Your names'), 'aria-expanded': 'false'}, mark('gear')) as HTMLButtonElement;
  const note = h('p', {class: 'muted small'});
  const panel = h('div', {class: 'stub-panel pop', hidden: ''});
  let stub: HTMLElement;
  if (me.addresses.length) {
    const a = inbox.shown(me.addresses[0].address);
    const text = h('button', {type: 'button', class: 'stub-text'}, a);
    copying(text, a);
    const code = h('button', {type: 'button', class: 'stub-code mono', 'aria-label': t('Your code {code}', {code: me.code})}, me.code);
    copying(code, me.code);
    stub = h('div', {class: 'stub'}, text, code, gear);
  } else {
    const name = h('input', {class: 'stub-in', placeholder: t('name'), 'aria-label': t('Name'), autocapitalize: 'off', spellcheck: 'false', maxlength: '31'}) as HTMLInputElement;
    name.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || e.isComposing || !name.value.trim() || name.readOnly) return;
      error.textContent = '';
      // Asked once: Enter again while it is asked claims nothing more.
      name.readOnly = true;
      try { await inbox.claim(name.value); again(); } catch (err) { const plan = planRefused(err, toPlan); if (plan) error.replaceChildren(plan); else error.textContent = errorText(err); } finally { name.readOnly = false; }
    });
    stub = h('div', {class: 'stub'}, name, gear);
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
    looking = every(8000, look, {alive: () => panel.isConnected && !panel.hidden});
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
  // With no name yet there is nothing else in it: the field at once.
  // Letting a name go is not offered here; the Remote's way to do it stays (l3 people release uses it).
  const fill = () => panel.replaceChildren(...(me.addresses.length ? [yours(), adding()] : [own()]));
  // The panel lies over the Inbox under it; Escape or a press outside closes it.
  const holder = h('div', {class: 'stub-holder'}, stub, note, error, panel);
  // Put away by Escape from inside it, the keyboard goes back to the gear rather than to the page.
  const away = (e: Event) => {
    if (!(e instanceof KeyboardEvent ? e.key === 'Escape' : !holder.contains(e.target as Node))) return;
    const inside = panel.contains(document.activeElement);
    toggle(false);
    if (e instanceof KeyboardEvent && inside) gear.focus();
  };
  const toggle = (open: boolean) => {
    panel.hidden = !open;
    gear.setAttribute('aria-expanded', String(open));
    for (const k of ['pointerdown', 'keydown'] as const) (open ? document.addEventListener : document.removeEventListener).call(document, k, away);
    if (open) fill(); else looking?.stop();
  };
  gear.addEventListener('click', () => toggle(panel.hidden !== false));
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

export function inboxPage(ctx: Context): Node[] {
  const holder = h('div', {});
  let open: string | null = null;
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
    try { me = await inbox.me(); } catch (e) { holder.replaceChildren(h('p', {class: 'error'}, errorText(e))); return; }
    if (!me.addresses.length) { holder.replaceChildren(addressStub(me, () => void paint(), () => goToPlan(ctx))); return; }
    mine = me.addresses[0].address;
    // The field to write to someone new is made once: what comes every little while changes only the rows under it.
    const to = h('input', {class: 'line-in', placeholder: t('Write to a name or a code'), 'aria-label': t('Write to a name or a code'), autocapitalize: 'off', spellcheck: 'false'}) as HTMLInputElement;
    to.value = drafts.get(TO);
    to.addEventListener('input', () => drafts.set(TO, to.value));
    const start = button(t('Write'), 'small-button');
    const error = h('p', {class: 'error', role: 'alert'});
    const rows = h('div', {class: 'inbox-rows'});
    const list = h('nav', {class: 'inbox-list', 'aria-label': t('Conversations')}, h('div', {class: 'row inbox-new'}, to, start), error, rows);
    const pane = h('section', {class: 'inbox-thread', 'aria-live': 'polite'});
    to.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) start.click(); });
    start.addEventListener('click', async () => {
      if (!to.value.trim()) { to.focus(); return; }
      error.textContent = '';
      const found: {address?: string; reachable: boolean; why?: string} = await inbox.lookup(to.value).catch((e) => ({reachable: false, why: errorText(e)}));
      if (!found.reachable) { error.textContent = t('Cannot reach {address} ({why})', {address: to.value, why: t(found.why ?? '')}); return; }
      // Gone to: the field has done its work.
      to.value = '';
      drafts.sent(TO);
      void show(found.address!, rows, pane);
    });
    holder.replaceChildren(
      addressStub(me, () => void paint(), () => goToPlan(ctx)),
      h('div', {class: 'inbox-box'}, list, pane));
    await paintList(rows, pane);
  };

  const paintList = async (rows: HTMLElement, pane: HTMLElement) => {
    const asked = ++listed;
    let all: inbox.Thread[] = [], unread = '';
    try { all = await inbox.threads(); } catch (e) { unread = errorText(e); }
    if (asked !== listed) return;
    const row = (th: inbox.Thread) => {
      // The open one is being read: what came to it is not counted as waiting.
      const waiting = th.address === open ? 0 : th.unread;
      const b = h('button', {type: 'button', class: 'inbox-row', 'data-state': th.state, 'data-address': th.address},
        h('span', {class: 'inbox-who'}, h('b', {}, th.name || inbox.shown(th.address)), waiting ? h('span', {class: 'unread'}, `${waiting}`) : null),
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
      ...contacts.map(row),
      ...(requests.length ? [h('h3', {class: 'inbox-head'}, t('Requests')), ...requests.map(row)] : []));
    if (had) rows.querySelector<HTMLElement>(`.inbox-row[data-address="${CSS.escape(had)}"]`)?.focus();
    // One quiet line in the open pane says what to do; none yet, it says so instead.
    if (!open && !unread) pane.removeAttribute('aria-label');
    if (!open && !unread) pane.replaceChildren(h('p', {class: 'quiet'}, all.length ? t('Choose a conversation, or write to a name or a code.') : t('No messages yet. Write to someone by their name or code.')));
    // What came to the open conversation since it was drawn is put at its foot.
    const open_ = shownThread;
    const now = open_ && all.find((x) => x.address === open_.address);
    if (open_ && now && open_.on.behind(now)) await open_.more();
  };

  const show = async (address: string, rows: HTMLElement, pane: HTMLElement) => {
    // Opened again before the last opening was drawn (a row pressed twice): only the latest is drawn,
    // so one conversation never gets two panes, nor two direct lines.
    const asked = ++opened;
    open = address;
    live?.stop();
    live = null;
    shownThread = null;
    const th = await inbox.thread(address).catch((e) => { if (asked === opened) pane.replaceChildren(h('p', {class: 'error'}, errorText(e))); return null; });
    if (!th || asked !== opened) return;
    // Heard as the conversation it is, named by the other.
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
      messages.append(h('div', {class: 'bubble', 'data-mine': String(m.mine)},
        m.type !== 'message' ? h('span', {class: 'state-chip'}, KIND(m.type)) : null,
        go, h('p', {class: 'bubble-text'}, m.body),
        h('span', {class: 'muted small'}, `${ago(m.time)}${m.live ? ` · ${t('direct')}` : ''}`)));
      messages.scrollTop = messages.scrollHeight;
    };
    // What the Remote gives is taken in once (its newest noted by its clock); what is added here,
    // sent or come over the direct line, is drawn once too, and not again when the Remote gives it.
    on.took(th.messages).forEach(bubble);
    const add = (m: inbox.Message) => { if (on.have(m)) bubble(m); };
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
      if (came.some((m) => !m.mine)) read();
      // Accepted both ways meanwhile: the direct line can open now.
      if (now.mutual && !live) startLive();
    };
    shownThread = {address, on, more};
    const error = h('p', {class: 'error', role: 'alert'});
    // Accept or block someone who wrote first: one answer, asked once (both held while it is), and said if it did not go.
    const decide: HTMLButtonElement[] = [];
    if (th.state === 'request') {
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
      no.addEventListener('click', answer('blocked', () => { open = null; shownThread = null; void paintList(rows, pane); }));
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
      if (!text.value.trim() || sendB.disabled) return;
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
      } catch (e) { error.textContent = errorText(e); }
      sendB.disabled = false;
    };
    sendB.addEventListener('click', () => void go());
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); void go(); } });
    pane.replaceChildren(
      h('header', {class: 'inbox-top'}, h('b', {}, inbox.shown(address)), lineWord, h('span', {class: 'grow'}), ...decide),
      messages,
      h('div', {class: 'inbox-write'},
        h('div', {class: 'row write-line'}, text, sendB),
        h('p', {class: 'muted small write-hint'}, t('Review： or Question： first to ask · a /root/… path says what it is about · Ctrl+Enter sends')), error));
    if (text.value) grow();
    text.focus();
    text.setSelectionRange(text.value.length, text.value.length);
    if (th.mutual) startLive();
    for (const b of rows.querySelectorAll<HTMLElement>('.inbox-row')) {
      b.toggleAttribute('aria-current', b.dataset.address === address);
      // Opened, its count is read.
      if (b.dataset.address === address) b.querySelector('.unread')?.remove();
    }
  };

  void paint();
  // New messages through the Remote are looked for while the page is shown: the rows, and the open conversation.
  every(10_000, async () => {
    const rows = holder.querySelector<HTMLElement>('.inbox-rows'), pane = holder.querySelector<HTMLElement>('.inbox-thread');
    // Not while a row has the keyboard: drawn again, it would be lost.
    if (rows && pane && !rows.contains(document.activeElement)) await paintList(rows, pane);
  }, {alive: () => holder.isConnected, ended: () => live?.stop()});
  return [pageHead('inbox'), holder];
}
