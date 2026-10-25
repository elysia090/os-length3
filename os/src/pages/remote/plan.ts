import {h} from '../../ui/dom.ts';
import {isNative} from '../../app/host.ts';
import {currentLang, t} from '../../i18n.ts';
import {changedWords, leftFor, openPlan, plan as readPlan, planRefusal, planView, priceWords, refusalWords, TERMS, tierName,
  type Meter, type PaidTier, type Plan, type PlanRefusal, type Price, type TierCard} from '../../remote/plan.ts';
import {answers} from '../common.ts';
import type {Context} from '../context.ts';
import {button, message, pressing} from './parts.ts';
import {leaving, stripeReturn} from './stripe.ts';

// Remote's Plan part: the tier this account is on, its use, the tiers to choose from; and the way to it from a
// place the plan refused.

/** Remote's page, at its Plan part: where a place refused for the plan's sake leads. */
export function goToPlan(ctx: Context) {
  try { localStorage.setItem('length3.part.remote', 'plan'); } catch { /* the Repos part, then */ }
  ctx.go('remote');
}

/**
 * Said in place where the Remote refused for the plan's sake: what is paid, what happens to the work, and the
 * way to the Plan (`go`). Anything else, null: the place says it as it says any failure.
 */
export function planRefused(e: unknown, go: () => void): HTMLElement | null {
  const r = planRefusal(e);
  return r ? planSaid(r, go) : null;
}

/** What the plan says of `r` (refused, or known before anything is asked), with See the plan after it: the sentence whole, the button beside it or under it. */
export function planSaid(r: PlanRefusal, go: () => void): HTMLElement {
  const to = h('button', {type: 'button', class: 'button small-button'}, t('See the plan')) as HTMLButtonElement;
  to.addEventListener('click', go);
  return h('span', {class: 'plan-refused'}, h('span', {}, refusalWords(r)), to);
}

/** `el`'s children, those of `nodes` that are there (a part left out is null). */
const put = (el: HTMLElement, ...nodes: (Node | null)[]) => el.replaceChildren(...nodes.filter((n): n is Node => !!n));

/** A meter's track (§3 The meter), filled as far as the use goes: its share set through CSSOM, never a style attribute. */
function meterTrack(m: Meter): HTMLElement {
  const track = h('span', {class: 'meter', role: 'meter', 'aria-label': m.label, 'aria-valuemin': '0', 'aria-valuemax': '100',
    'aria-valuenow': String(Math.round(m.share * 100))}, h('span', {}));
  track.style.setProperty('--share', String(m.share));
  return track;
}

/**
 * One tier as a small card: its name, what it costs, what it keeps (and, when the account keeps more than it does,
 * that what is there stays), its one deed at the right of its foot (`press`), and its own line for what went
 * wrong there. The account's own is current: an ink edge over raised, and nothing to press.
 */
function tierCard(c: TierCard, press: (tier: PaidTier, b: HTMLButtonElement, error: HTMLElement) => void): HTMLElement {
  const error = h('p', {class: 'error small', role: 'alert'});
  const b = c.deed && c.tier !== 'free' ? button(c.deed.label, 'small-button') : null;
  if (b && c.tier !== 'free') { const tier = c.tier; b.addEventListener('click', () => press(tier, b, error)); }
  return h('div', {class: `card small-card tier-card${c.current ? ' current' : ''}`, role: 'group', 'aria-label': c.name, 'data-tier': c.tier,
    ...(c.current ? {'aria-current': 'true'} : {})},
    h('span', {class: 'card-title'}, c.name),
    c.price ? h('span', {class: 'tier-price'}, c.price) : null,
    h('ul', {class: 'tier-keeps muted'}, ...c.keeps.map((k) => h('li', {}, k))),
    c.over ? h('p', {class: 'muted small'}, t('You keep more than this; what is there stays')) : null,
    b ? h('div', {class: 'card-foot'}, h('span', {class: 'grow'}), b) : null, error);
}

/**
 * Before payment, under the tiers: what is bought (the tier, its price as Stripe says it, how it is billed, how it
 * ends, what stays), Not now at the left and the one step on at the right (`go`, with `deed` its word; `lead`, what
 * that step is), and its own line for what went wrong.
 */
function payingFor(tier: PaidTier, price: Price | undefined, o: {deed: string; lead: string; no(): void; go(yes: HTMLButtonElement, error: HTMLElement): void}): HTMLElement {
  const error = h('p', {class: 'error', role: 'alert'});
  const no = button(t('Not now')), yes = button(o.deed, 'primary');
  no.addEventListener('click', o.no);
  yes.addEventListener('click', () => o.go(yes, error));
  setTimeout(() => yes.focus());
  return h('section', {class: 'sub-part plan-confirm', role: 'group', 'aria-labelledby': 'plan-confirm'},
    h('h3', {id: 'plan-confirm'}, h('span', {}, t('Subscribe to {tier}', {tier: tierName(tier)}))),
    h('p', {class: 'plan-price'}, price ? priceWords(price, currentLang()) : t('Price shown before you pay')),
    h('ul', {class: 'plan-terms'}, ...TERMS(tier).map((x) => h('li', {}, x))),
    h('p', {class: 'muted small'}, o.lead),
    answers(no, yes), error);
}

/**
 * Plan: the tier this account is on in a figure's size (Free plan, Pro plan) and the one date that matters; its
 * use of what the Remote keeps against what that tier keeps, as meters; then free and the three tiers side by
 * side, its own marked, each with what it costs and keeps and its one deed (Subscribe when free; Upgrade or
 * Downgrade when paying); what any tier adds; and, paid, Manage the plan at the right of the part's foot (the
 * portal: the card, the invoices, cancelling). Subscribe is never a step into payment at once: it opens, under
 * the tiers, what is bought, with Not now and Continue to payment. Upgrade and Downgrade go to Stripe's portal at
 * the step that changes the tier, where Stripe says what it costs now and asks. Back from Stripe, how it went is
 * said once, above the plan (paid, and to what, once the Remote has heard it; cancelled, nothing charged; what
 * changed in the portal). What went wrong is said where it was pressed. The Remote decides all of it
 * (service/plan.ts); this shows it. `offered` says whether this Remote has a plan at all.
 */
export function planSection(offered: (on: boolean) => void): {el: HTMLElement; paint(): Promise<void>} {
  const el = h('div', {class: 'plan-part'});
  const error = h('p', {class: 'error', role: 'alert'});
  /** How the last trip to Stripe went, said above the plan until the plan says it itself. */
  const told = h('p', {class: 'plan-told', role: 'status', hidden: ''});
  const tell = (text: string, kind: '' | 'done' = '') => { told.textContent = text; told.hidden = !text; told.classList.toggle('done', kind === 'done'); };
  let came = stripeReturn();
  /** When the person came back from Stripe's page: the web, as this page loads again; the app, as its window comes back (null till then). */
  let since: number | null = Date.now();
  if (came?.how === 'cancelled') tell(t('Payment was cancelled: nothing was charged, and the plan is as it was.'));
  if (came?.how === 'paid') {
    tell(came.tier ? t('Payment went through. {tier} shows here as soon as Stripe tells the Remote, a moment from now.', {tier: tierName(came.tier)})
      : t('Payment went through. The plan shows Paid as soon as Stripe tells the Remote, a moment from now.'));
  }
  /** The tier whose payment is being asked about, under the tiers; null while none is. */
  let confirming: PaidTier | null = null;
  const paint = async () => {
    let p: Plan;
    try { p = await readPlan(); } catch (e) { error.textContent = message(e); return; }
    offered(p.plan !== 'none');
    if (p.plan === 'none') { el.replaceChildren(); return; }
    const tierNow = p.tier ?? 'free';
    if (came?.how === 'paid') {
      // Paid now, after a Checkout: said once, and nothing more is waited for.
      if (p.plan === 'paid') { tell(t('Payment went through: you are on {tier} now.', {tier: tierName(tierNow)}), 'done'); came = null; }
      // Not heard yet: asked again in a moment, for a minute; then said where to look (the payment itself went through).
      else if (Date.now() - (since ?? Date.now()) < 60_000) setTimeout(() => { if (el.isConnected) void paint(); }, 3000);
      else { came = null; tell(t('Stripe has not told the Remote yet. The plan shows Paid once it does; nothing is charged twice.')); }
    } else if (came?.how === 'managed') {
      // Back from the portal: what changed there, said against the plan as it was when this tab left; nothing, if nothing did.
      const said = came.left ? changedWords(came.left, p) : null;
      // The app's window back (the browser had the person meanwhile): from now on, as the web's page loaded again.
      if (since === null && document.hasFocus()) since = Date.now();
      if (said) { tell(said, 'done'); came = null; }
      // Not heard yet: asked again a few times once back, then left to the next time the plan is read.
      else if (since !== null && Date.now() - since > 20_000) came = null;
      else if (since !== null) setTimeout(() => { if (el.isConnected) void paint(); }, 3000);
    }
    // While a payment is asked about, what is asked stays as it is.
    if (confirming && p.plan === 'free') return;
    confirming = null;
    const v = planView(p, Date.now(), currentLang());
    error.textContent = '';
    /** A trip to Stripe: what is written here is sent first (the web leaves this page for it); the plan as it is, kept to say what changed. */
    const toStripe = async (kind: 'checkout' | 'portal', tier?: PaidTier) => {
      await leaving();
      leftFor(p);
      await openPlan(kind, tier ? {tier} : {});
      opened();
    };
    const pay = (tier: PaidTier) => payingFor(tier, p.tiers?.find((x) => x.tier === tier)?.price, {
      deed: t('Continue to payment'),
      lead: isNative ? t('Stripe\'s page opens in your browser. Come back here when you are done.')
        : t('You pay on Stripe\'s page, then come back here. Your work is saved first.'),
      no: () => { confirming = null; draw(); el.querySelector<HTMLElement>(`.tier-card[data-tier="${tier}"] button`)?.focus(); },
      go: (yes, err) => void pressing(yes, err, async () => { await toStripe('checkout', tier); confirming = null; }),
    });
    const press = (tier: PaidTier, b: HTMLButtonElement, err: HTMLElement) => {
      // Free: what is bought, asked under the tiers. Paying: Stripe's portal, at the step that changes the tier.
      if (tierNow === 'free') { confirming = tier; draw(); return; }
      void pressing(b, err, () => toStripe('portal', tier));
    };
    const manage = v.action ? button(v.action.label, 'primary') : null;
    manage?.addEventListener('click', () => void pressing(manage, error, () => toStripe('portal')));
    const draw = () => put(el, told,
      h('section', {class: 'sub-part plan-now', 'aria-labelledby': 'plan-title'},
        h('h2', {id: 'plan-title', class: 'plan-title'}, v.title), h('p', {class: 'muted'}, v.line)),
      h('section', {class: 'sub-part', 'aria-labelledby': 'plan-use'}, h('h3', {id: 'plan-use'}, h('span', {}, t('On the Remote'))),
        h('div', {class: 'rows'}, ...v.meters.map((m) => h('div', {class: `row-item plan-meter${m.over ? ' over' : ''}`},
          h('span', {class: 'row-name'}, m.label),
          m.of === null ? null : meterTrack(m),
          h('span', {class: 'row-meta'}, m.of === null ? m.used : t('{used} of {of}', {used: m.used, of: m.of}))))),
        v.note ? h('p', {class: 'muted small plan-note'}, v.note) : null),
      v.tiers.length ? h('section', {class: 'sub-part plan-tiers', 'aria-labelledby': 'plan-tiers'}, h('h3', {id: 'plan-tiers'}, h('span', {}, t('Plans'))),
        h('div', {class: 'grid small-grid tier-cards'}, ...v.tiers.map((c) => tierCard(c, press)))) : null,
      confirming ? pay(confirming) : null,
      h('section', {class: 'sub-part', 'aria-labelledby': 'plan-adds'}, h('h3', {id: 'plan-adds'}, h('span', {}, p.plan === 'paid' ? t('Paid gives') : t('Paid adds'))),
        h('div', {class: 'rows plan-adds'}, ...v.adds.map((a) => h('div', {class: 'row-item'}, h('span', {class: 'row-name'}, a))))),
      manage ? answers(null, manage) : null, error);
    /**
     * The app opened the browser: said, and the plan read again when the window comes back (below), where what
     * changed meanwhile is said against the plan as it was (the browser comes back to no page of the app's to say it).
     */
    const opened = () => {
      if (!isNative) return;
      tell(t('The payment page is open in your browser. When you are done there, come back: the plan is read again.'));
      came = {how: 'managed', tier: null, left: {tier: tierNow, ends: p.ends ?? null, paid: p.plan === 'paid'}};
      since = null;
    };
    draw();
  };
  return {el, paint};
}
