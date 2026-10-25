import {h} from '../../ui/dom.ts';
import {isNative} from '../../app/host.ts';
import {currentLang, t} from '../../i18n.ts';
import {plan as readPlan, planRefusal, planView, priceWords, refusalWords, TERMS, tierName,
  type Meter, type PaidTier, type Plan, type PlanRefusal, type PlanView, type Price, type TierCard} from '../../remote/plan.ts';
import {answers, choosePart} from '../common.ts';
import type {Context} from '../context.ts';
import {errorText} from '../../app/errors.ts';
import {button, pressing} from './parts.ts';
import {stripeTrip} from './stripe.ts';

// Remote's Plan part: the tier this account is on, its use, the tiers to choose from; and the way to it from a
// place the plan refused.

/** Remote's page, at its Plan part: where a place refused for the plan's sake leads. */
export function goToPlan(ctx: Context) {
  choosePart('remote', 'plan');
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

/** The tier the account is on in a figure's size, and the one date that matters. */
const planNow = (v: PlanView) => h('section', {class: 'sub-part plan-now', 'aria-labelledby': 'plan-title'},
  h('h2', {id: 'plan-title', class: 'plan-title'}, v.title), h('p', {class: 'muted'}, v.line));

/** Its use of what the Remote keeps, against what its tier keeps: a meter each. */
const planUse = (v: PlanView) => h('section', {class: 'sub-part', 'aria-labelledby': 'plan-use'}, h('h3', {id: 'plan-use'}, h('span', {}, t('On the Remote'))),
  h('div', {class: 'rows'}, ...v.meters.map((m) => h('div', {class: `row-item plan-meter${m.over ? ' over' : ''}`},
    h('span', {class: 'row-name'}, m.label),
    m.of === null ? null : meterTrack(m),
    h('span', {class: 'row-meta'}, m.of === null ? m.used : t('{used} of {of}', {used: m.used, of: m.of}))))),
  v.note ? h('p', {class: 'muted small plan-note'}, v.note) : null);

/** Free and the tiers side by side, each with its deed (`press`); none when there is nothing to choose among. */
const planTiers = (v: PlanView, press: (tier: PaidTier, b: HTMLButtonElement, error: HTMLElement) => void) => (v.tiers.length
  ? h('section', {class: 'sub-part plan-tiers', 'aria-labelledby': 'plan-tiers'}, h('h3', {id: 'plan-tiers'}, h('span', {}, t('Plans'))),
    h('div', {class: 'grid small-grid tier-cards'}, ...v.tiers.map((c) => tierCard(c, press))))
  : null);

/** What any paid tier adds (gives, once paid). */
const planAdds = (p: Plan, v: PlanView) => h('section', {class: 'sub-part', 'aria-labelledby': 'plan-adds'},
  h('h3', {id: 'plan-adds'}, h('span', {}, p.plan === 'paid' ? t('Paid gives') : t('Paid adds'))),
  h('div', {class: 'rows plan-adds'}, ...v.adds.map((a) => h('div', {class: 'row-item'}, h('span', {class: 'row-name'}, a)))));

/**
 * Plan: the tier this account is on in a figure's size (Free plan, Pro plan) and the one date that matters; its
 * use of what the Remote keeps against what that tier keeps, as meters; then free and the three tiers side by
 * side, its own marked, each with what it costs and keeps and its one deed (Subscribe when free; Upgrade or
 * Downgrade when paying); what any tier adds; and, paid, Manage the plan at the right of the part's foot (the
 * portal: the card, the invoices, cancelling). Subscribe is never a step into payment at once: it opens, under
 * the tiers, what is bought, with Not now and Continue to payment. Upgrade and Downgrade go to Stripe's portal at
 * the step that changes the tier, where Stripe says what it costs now and asks. Back from Stripe, how it went is
 * said once, above the plan (stripe.ts). What went wrong is said where it was pressed. The Remote decides all of
 * it (service/plan.ts); this shows it. `offered` says whether this Remote has a plan at all.
 */
export function planSection(offered: (on: boolean) => void): {el: HTMLElement; paint(): Promise<void>} {
  const el = h('div', {class: 'plan-part'});
  const error = h('p', {class: 'error', role: 'alert'});
  const trip = stripeTrip(() => { if (el.isConnected) void paint(); });
  /** The tier whose payment is being asked about, under the tiers; null while none is. */
  let confirming: PaidTier | null = null;
  const paint = async () => {
    let p: Plan;
    try { p = await readPlan(); } catch (e) { error.textContent = errorText(e); return; }
    offered(p.plan !== 'none');
    if (p.plan === 'none') { el.replaceChildren(); return; }
    trip.heard(p);
    // While a payment is asked about, what is asked stays as it is.
    if (confirming && p.plan === 'free') return;
    confirming = null;
    show(p);
  };
  /** The plan as read, drawn; drawn again as a tier's payment is asked about, or put off. */
  const show = (p: Plan) => {
    const v = planView(p, Date.now(), currentLang());
    error.textContent = '';
    const pay = (tier: PaidTier) => payingFor(tier, p.tiers?.find((x) => x.tier === tier)?.price, {
      deed: t('Continue to payment'),
      lead: isNative ? t('Stripe\'s page opens in your browser. Come back here when you are done.')
        : t('You pay on Stripe\'s page, then come back here. Your work is saved first.'),
      no: () => { confirming = null; draw(); el.querySelector<HTMLElement>(`.tier-card[data-tier="${tier}"] button`)?.focus(); },
      go: (yes, err) => void pressing(yes, err, async () => { await trip.go(p, 'checkout', tier); confirming = null; }),
    });
    const press = (tier: PaidTier, b: HTMLButtonElement, err: HTMLElement) => {
      // Free: what is bought, asked under the tiers. Paying: Stripe's portal, at the step that changes the tier.
      if ((p.tier ?? 'free') === 'free') { confirming = tier; draw(); return; }
      void pressing(b, err, () => trip.go(p, 'portal', tier));
    };
    const manage = v.action ? button(v.action.label, 'primary') : null;
    manage?.addEventListener('click', () => void pressing(manage, error, () => trip.go(p, 'portal')));
    const draw = () => put(el, trip.told, planNow(v), planUse(v), planTiers(v, press), confirming ? pay(confirming) : null,
      planAdds(p, v), manage ? answers(null, manage) : null, error);
    draw();
  };
  return {el, paint};
}
