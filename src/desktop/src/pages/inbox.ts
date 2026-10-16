import {ago, h} from '../dom.ts';
import {t} from '../i18n.ts';
import * as inbox from '../inbox.ts';
import {connection} from '../remote.ts';
import {kindOf} from '../text.ts';
import {mark} from '../icons.ts';
import {pageHead} from './common.ts';
import type {Context} from './context.ts';

// Inbox: what comes to you, typed, from people found by address. Not a mail
// screen: each message says what it is (a message, a review request, a
// question, a failed run) and what it is about, with the way there.
//
//   your address   name@domain as a stub (pressing it copies it), its gear for
//                  your own domain (proved by a DNS record); SSH is Runtime's
//   left           conversations: contacts, then requests (accept or block)
//   right          the conversation, the line's state (direct, or through
//                  the Remote), and the box to write in

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const KIND = (k: inbox.Kind) => ({message: t('Message'), review: t('Review request'), question: t('Question'), run: t('Run failed')})[k];

function button(text: string, kind = ''): HTMLButtonElement {
  return h('button', {class: `button ${kind}`.trim(), type: 'button'}, text) as HTMLButtonElement;
}

/** Copy `text` and say so in `el` for a moment. */
function copying(el: HTMLElement, text: string) {
  el.addEventListener('click', () => {
    void navigator.clipboard?.writeText(text);
    el.dataset.copiedWord = t('Copied');
    el.dataset.copied = '';
    window.setTimeout(() => delete el.dataset.copied, 1200);
  });
  el.title = t('Press to copy');
}

/**
 * Your address as a stub: the address (pressing it copies it), or, before
 * there is one, the name to claim on this Remote's domain (Enter claims).
 * At its right end the gear opens your own domain: the TXT record to put in
 * its DNS, looked for every few seconds while open, and the address claimed
 * as soon as the record is there.
 */
function addressStub(me: inbox.Me, again: () => void): HTMLElement {
  const error = h('p', {class: 'error', role: 'alert'});
  const gear = h('button', {type: 'button', class: 'stub-gear', 'aria-label': t('Your own domain'), 'aria-expanded': 'false'}, mark('gear')) as HTMLButtonElement;
  const panel = h('div', {class: 'stub-panel', hidden: ''});
  let stub: HTMLElement;
  if (me.addresses.length) {
    const a = me.addresses[0].address;
    const text = h('button', {type: 'button', class: 'stub-text mono'}, a);
    copying(text, a);
    stub = h('div', {class: 'stub'}, text, gear);
  } else {
    const name = h('input', {class: 'stub-in mono', placeholder: t('name'), 'aria-label': t('Name'), autocapitalize: 'off', spellcheck: 'false', maxlength: '31'}) as HTMLInputElement;
    name.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || e.isComposing || !name.value.trim()) return;
      error.textContent = '';
      try { await inbox.claim(name.value); again(); } catch (err) { error.textContent = message(err); }
    });
    stub = h('div', {class: 'stub'}, name, h('span', {class: 'stub-domain mono'}, `@${me.domain}`), gear);
  }
  // Your own domain: its record, looked for while the panel is open.
  let looking = 0;
  const own = () => {
    const name = h('input', {class: 'line-in mono', placeholder: t('name'), 'aria-label': t('Name'), autocapitalize: 'off', spellcheck: 'false', maxlength: '31'}) as HTMLInputElement;
    const domain = h('input', {class: 'line-in mono', placeholder: 'example.org', 'aria-label': t('Domain'), autocapitalize: 'off', spellcheck: 'false'}) as HTMLInputElement;
    const record = h('div', {class: 'stub-record'});
    const look = async () => {
      if (!panel.isConnected || panel.hidden) { clearInterval(looking); return; }
      if (!domain.value.trim()) { record.replaceChildren(); return; }
      const r = await inbox.domainRecord(domain.value).catch((e) => { record.replaceChildren(h('p', {class: 'error'}, message(e))); return null; });
      if (!r) return;
      const field = (label: string, value: string) => {
        const v = h('button', {type: 'button', class: 'record-value mono'}, value);
        copying(v, value);
        return h('div', {class: 'record-row'}, h('span', {class: 'muted small'}, label), v);
      };
      record.replaceChildren(
        h('p', {class: 'muted small'}, t('Put this record in the domain\'s DNS')),
        field(t('Name'), r.name), field(t('Type'), r.type), field(t('Value'), r.value),
        h('p', {class: `small record-found${r.found ? ' found' : ''}`}, !r.found ? t('Not found yet') : name.value.trim() ? t('Found. Claiming {address}…', {address: `${name.value.trim()}@${domain.value.trim()}`}) : t('Found')));
      if (r.found && name.value.trim()) {
        clearInterval(looking);
        try { await inbox.claim(name.value, domain.value); again(); } catch (e) { record.append(h('p', {class: 'error'}, message(e))); }
      }
    };
    domain.addEventListener('change', () => void look());
    domain.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) void look(); });
    clearInterval(looking);
    looking = window.setInterval(() => void look(), 8000);
    panel.replaceChildren(h('div', {class: 'row stub-own'}, name, h('span', {class: 'muted'}, '@'), domain), record);
    domain.focus();
  };
  gear.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    gear.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) own(); else clearInterval(looking);
  });
  return h('div', {class: 'stub-holder'}, stub, error, panel);
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

export function inboxPage(ctx: Context): Node[] {
  const holder = h('div', {});
  let open: string | null = null;
  let live: inbox.Live | null = null;
  let mine = '';
  let poll = 0;

  const paint = async () => {
    if (!connection()) {
      const go = button(t('Go to Remote'), 'primary');
      go.addEventListener('click', () => ctx.go('remote'));
      holder.replaceChildren(h('section', {class: 'section'}, h('p', {class: 'muted'}, t('The Inbox is on the Remote. Sign in to it to have an address and messages.')), h('div', {class: 'row'}, go)));
      return;
    }
    let me: inbox.Me;
    try { me = await inbox.me(); } catch (e) { holder.replaceChildren(h('p', {class: 'error'}, message(e))); return; }
    if (!me.addresses.length) { holder.replaceChildren(addressStub(me, () => void paint())); return; }
    mine = me.addresses[0].address;
    const list = h('nav', {class: 'inbox-list', 'aria-label': t('Conversations')});
    const pane = h('section', {class: 'inbox-thread', 'aria-live': 'polite'});
    holder.replaceChildren(
      addressStub(me, () => void paint()),
      h('div', {class: 'inbox-box'}, list, pane));
    await paintList(list, pane);
  };

  const paintList = async (list: HTMLElement, pane: HTMLElement) => {
    const all = await inbox.threads().catch(() => [] as inbox.Thread[]);
    const to = h('input', {class: 'line-in', placeholder: t('Write to name@domain'), 'aria-label': t('Write to an address'), autocapitalize: 'off', spellcheck: 'false'}) as HTMLInputElement;
    const start = button(t('Write'), 'small-button');
    const error = h('p', {class: 'error', role: 'alert'});
    to.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) start.click(); });
    start.addEventListener('click', async () => {
      if (!to.value.trim()) { to.focus(); return; }
      const found: {address?: string; reachable: boolean; why?: string} = await inbox.lookup(to.value).catch(() => ({reachable: false, why: ''}));
      if (!found.reachable) { error.textContent = t('Cannot reach {address} ({why})', {address: to.value, why: found.why ?? ''}); return; }
      void show(found.address!, list, pane);
    });
    const row = (th: inbox.Thread) => {
      const b = h('button', {type: 'button', class: 'inbox-row', 'data-state': th.state},
        h('span', {class: 'inbox-who'}, h('b', {}, th.name || th.address), th.unread ? h('span', {class: 'unread'}, `${th.unread}`) : null),
        h('span', {class: 'muted small mono'}, th.address),
        h('span', {class: 'muted small inbox-last'}, `${th.last.mine ? t('You: ') : ''}${th.last.type === 'message' ? '' : `${KIND(th.last.type)} · `}${th.last.body}`));
      if (th.address === open) b.setAttribute('aria-current', 'true');
      b.addEventListener('click', () => void show(th.address, list, pane));
      return b;
    };
    const contacts = all.filter((x) => x.state === 'contact'), requests = all.filter((x) => x.state === 'request');
    list.replaceChildren(
      h('div', {class: 'row inbox-new'}, to, start), error,
      ...contacts.map(row),
      ...(requests.length ? [h('h3', {class: 'inbox-head'}, t('Requests')), ...requests.map(row)] : []),
      ...(!all.length ? [h('p', {class: 'muted small'}, t('No messages yet. Write to someone by their address.'))] : []));
    if (!open) pane.replaceChildren(h('p', {class: 'quiet'}, t('Choose a conversation, or write to an address.')));
  };

  const show = async (address: string, list: HTMLElement, pane: HTMLElement) => {
    open = address;
    live?.stop();
    live = null;
    const th = await inbox.thread(address).catch((e) => { pane.replaceChildren(h('p', {class: 'error'}, message(e))); return null; });
    if (!th) return;
    void inbox.markRead(address).catch(() => {});
    const lineWord = h('span', {class: 'muted small'}, t('Through the Remote'));
    const messages = h('div', {class: 'inbox-messages'});
    const seen = new Set<string>();
    const add = (m: inbox.Message) => {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      const about = [m.target.repo, m.target.issue, m.target.change ? t('change {id}', {id: String(m.target.change).slice(0, 8)}) : ''].filter(Boolean).join(' · ');
      const go = m.target.repo ? (() => {
        const b = h('button', {type: 'button', class: 'link'}, about);
        b.addEventListener('click', () => { if (m.target.issue) ctx.openRepo(m.target.repo!, `issue/${m.target.issue}`); else { ctx.remember(m.target.repo!); ctx.go('git'); } });
        return b;
      })() : null;
      messages.append(h('div', {class: 'bubble', 'data-mine': String(m.mine)},
        m.type !== 'message' ? h('span', {class: 'state-chip'}, KIND(m.type)) : null,
        go, h('p', {class: 'bubble-text'}, m.body),
        h('span', {class: 'muted small'}, `${ago(m.time)}${m.live ? ` · ${t('direct')}` : ''}`)));
      messages.scrollTop = messages.scrollHeight;
    };
    th.messages.forEach(add);
    // Accept or block someone who wrote first.
    const decide: Node[] = [];
    if (th.state === 'request') {
      const yes = button(t('Accept'), 'small-button primary'), no = button(t('Block'), 'small-button');
      yes.addEventListener('click', async () => { await inbox.setContact(address, 'accepted'); void show(address, list, pane); void paintList(list, pane); });
      no.addEventListener('click', async () => { await inbox.setContact(address, 'blocked'); open = null; void paintList(list, pane); });
      decide.push(yes, no);
    }
    // Writing is one line that grows as it is written. What it is reads off the text the way
    // an issue is named ("Review：…", "Question：…"), and a /root/… path in it says what it
    // is about; nothing else to choose. Enter sends; Shift+Enter starts a new line.
    const text = h('textarea', {class: 'line-in bubble-in', rows: '1', placeholder: t('Write to {address}…', {address}), 'aria-label': t('Message'), maxlength: '4000'}) as HTMLTextAreaElement;
    const grow = () => { text.style.height = 'auto'; text.style.height = `${Math.min(text.scrollHeight + 2, 200)}px`; };
    text.addEventListener('input', grow);
    const sendB = button(t('Send'), 'primary');
    const error = h('p', {class: 'error', role: 'alert'});
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
        grow();
        if (r.request) error.textContent = t('Sent as a request: they see it once they accept you.');
      } catch (e) { error.textContent = message(e); }
      sendB.disabled = false;
    };
    sendB.addEventListener('click', () => void go());
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void go(); } });
    pane.replaceChildren(
      h('header', {class: 'inbox-top'}, h('b', {class: 'mono'}, address), lineWord, h('span', {class: 'grow'}), ...decide),
      messages,
      h('div', {class: 'inbox-write'},
        h('div', {class: 'row write-line'}, text, sendB),
        h('p', {class: 'muted small write-hint'}, t('Review： or Question： first to ask · a /root/… path says what it is about · Enter sends · Shift+Enter for a new line')), error));
    text.focus();
    // Accepted both ways: a direct line between the two devices, when both are here.
    if (th.mutual) {
      live = new inbox.Live(mine, address, add, (on) => { lineWord.textContent = on ? t('Direct') : t('Through the Remote'); });
      live.start();
    }
    for (const b of list.querySelectorAll('.inbox-row')) b.toggleAttribute('aria-current', b.querySelector('.mono')?.textContent === address);
  };

  void paint();
  // New messages through the Remote are looked for while the page is shown.
  poll = window.setInterval(() => {
    if (!holder.isConnected) { clearInterval(poll); live?.stop(); return; }
    const list = holder.querySelector<HTMLElement>('.inbox-list'), pane = holder.querySelector<HTMLElement>('.inbox-thread');
    if (list && pane && document.visibilityState === 'visible') void paintList(list, pane);
  }, 10_000);
  return [pageHead('inbox'), holder];
}
