import {h} from '../../ui/dom.ts';
import {mark} from '../../ui/icons.ts';
import {keepOut, putAway} from '../../ui/glide.ts';
import {copying} from '../kit/common.ts';
import {planRefused, planSaid} from '../kit/plan-gate.ts';
import {errorText} from '../../../api/errors.ts';
import {every} from '../../../api/runs.ts';
import * as inbox from '../../../shipto/inbox.ts';
import {plan as readPlan} from '../../../shipto/plan.ts';
import {t} from '../../../text/i18n.ts';

/**
 * Your name as a stub: your username, shown alone (it is a name, not a domain
 * anyone holds; given at the first sign-in, changed on Home's profile); a
 * press copies it. (No number beside it: one is found by one's name.) At its right
 * end the gear opens your names, and a name of your choosing on a domain you
 * own, shown beside it: the TXT record to put in its DNS, looked for every few
 * seconds while open, and the name claimed as soon as the record is there.
 */
export function addressStub(me: inbox.Me, again: () => void, toPlan: () => void, closed: () => void = () => {}) {
  const gear = h('button', {type: 'button', class: 'stub-gear', 'aria-label': t('Your usernames'), 'aria-expanded': 'false'}, mark('down')) as HTMLButtonElement;
  const panel = h('div', {class: 'stub-panel pop', hidden: ''});
  const a = inbox.shown(inbox.username(me));
  const text = h('button', {type: 'button', class: 'stub-text'}, a);
  copying(text, a);
  const stub = h('div', {class: 'stub'}, text, gear);
  // The gear's panel, as the person's menu: your names, then Add a domain.
  let looking: {stop(): void} | null = null;
  const item = (label: string, at: Node | null = null) => h('button', {type: 'button', class: 'pop-item'}, label, at) as HTMLButtonElement;
  /** Your own domain, written whole in one field (name@domain, the @ too); its record looked for while the panel is open. */
  const own = (): HTMLElement => {
    const field = h('input', {class: 'line-in', placeholder: t('name@example.org'), 'aria-label': t('Custom domain name'),
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
      if (!panel.isConnected || panel.hidden || field.value.trim() !== asked) return;
      if (r instanceof Error) { record.replaceChildren(h('p', {class: 'error'}, r.message)); return; }
      const row = (label: string, value: string) => {
        const v = h('button', {type: 'button', class: 'record-value mono'}, value);
        copying(v, value);
        return h('div', {class: 'record-row'}, h('span', {class: 'muted small'}, label), v);
      };
      record.replaceChildren(
        h('p', {class: 'muted small'}, t('Add this DNS record to your domain')),
        row(t('Name'), r.name), row(t('Type'), r.type), row(t('Value'), r.value),
        h('p', {class: `small record-found${r.found ? ' found' : ''}`}, !r.found ? t('Not detected yet') : name ? t('Record detected. Claiming {address}…', {address: `${name}@${domain}`}) : t('Detected')));
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
    const b = item(t('Add domain'), mark('plus'));
    b.querySelector('svg')?.classList.add('pop-mark');
    b.addEventListener('click', () => b.replaceWith(own()));
    return b;
  };
  /** Your names, each with what holds it back, if anything: its domain no longer naming this Remote. */
  const yours = (): HTMLElement =>
    h('div', {class: 'pop-group', role: 'group', 'aria-label': t('Your usernames')}, h('div', {class: 'pop-head muted small'}, t('Your usernames')), ...me.addresses.map((a) =>
      h('div', {class: 'your-row'}, h('span', {}, inbox.shown(a.address)),
        a.lapsed ? h('span', {class: 'small error'}, t('Domain no longer points to this Remote')) : null)));
  // Letting a name go is not offered here; the Remote's way to do it stays (why people release uses it).
  const fill = () => panel.replaceChildren(yours(), adding());
  // The panel lies over the Inbox under it; Escape or a press outside closes it.
  const holder = h('div', {class: 'stub-holder'}, stub, panel);
  // Put away by Escape from inside it, the keyboard goes back to the gear rather than to the page.
  const away = (e: Event) => {
    if (!(e instanceof KeyboardEvent ? e.key === 'Escape' : !holder.contains(e.target as Node))) return;
    const inside = panel.contains(document.activeElement);
    toggle(false);
    if (e instanceof KeyboardEvent && inside && !holder.closest('[hidden]')) gear.focus();
  };
  const toggle = (open: boolean) => {
    if (open) { keepOut(panel); panel.hidden = false; } else putAway(panel, () => { panel.hidden = true; });
    gear.setAttribute('aria-expanded', String(open));
    for (const k of ['pointerdown', 'keydown'] as const) (open ? document.addEventListener : document.removeEventListener).call(document, k, away);
    if (open) fill(); else { looking?.stop(); closed(); }
  };
  gear.addEventListener('click', () => toggle(gear.getAttribute('aria-expanded') !== 'true'));
  return {holder, open: () => { toggle(true); gear.focus({preventScroll: true}); }, close: () => toggle(false)};
}
