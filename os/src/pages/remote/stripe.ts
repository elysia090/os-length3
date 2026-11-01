import {h} from '../../ui/dom.ts';
import {isNative} from '../../app/host.ts';
import {t} from '../../i18n.ts';
import {flush} from '../../remote/lifecycle.ts';
import {changedWords, leftFor, openPlan, takeLeft, takeStripeReturn, tierName, type Back, type Left, type PaidTier, type Plan} from '../../remote/plan.ts';
import {answers} from '../common.ts';
import {button} from './parts.ts';

// Trips to Stripe's pages and back: what goes to the Remote before one, and how it went, said once back.

/**
 * Back from Stripe in a browser that is not signed in here (the app opened Stripe's page in the browser): how it
 * went, and where to go on, rather than a sign-in card nobody came for. Signed in, Remote's Plan says it instead.
 */
export function checkoutBackPage(how: 'paid' | 'cancelled' | 'managed', tier: PaidTier | null, goOn: () => void): HTMLElement {
  const on = button(t('Open web app'));
  on.addEventListener('click', goOn);
  const [title, line] = how === 'paid'
    ? [t('Payment successful'), tier ? t('App status will reflect {tier} as soon as Stripe confirms.', {tier: tierName(tier)})
      : t('Plan status will update to Paid as soon as Stripe confirms payment.')]
    : how === 'cancelled' ? [t('Payment cancelled'), t('No charge was made; plan remains unchanged.')]
    : [t('Returned from Stripe'), t('Changes will reflect in app once confirmed by Stripe.')];
  return h('main', {class: 'device-page sign-in-place'},
    h('section', {class: 'sign-in-card', 'aria-labelledby': 'checkout-back'},
      h('h1', {id: 'checkout-back'}, title), h('p', {}, line),
      h('p', {class: 'muted'}, t('Return to the app; you may close this tab.')),
      answers(null, on)));
}

/** A trip to Stripe as Remote's Plan makes it and hears of it (stripeTrip). */
interface StripeTrip {
  /** How the last trip to Stripe went, said above the plan until the plan says it itself. */
  told: HTMLElement;
  /** The plan read again (`p`): what it says of the trip, once the Remote has heard it. */
  heard(p: Plan): void;
  /** To Stripe's Checkout for `tier`, or to its portal, from the plan as it is (`p`). */
  go(p: Plan, kind: 'checkout' | 'portal', tier?: PaidTier): Promise<void>;
}

/**
 * The trips to Stripe of one Plan drawn. Back from one, how it went is said once, above the plan: paid, and to
 * what, once the Remote has heard it; cancelled, nothing charged; what changed in the portal. While the Remote has
 * not heard yet, `again` reads the plan again in a moment.
 */
export function stripeTrip(again: () => void): StripeTrip {
  const told = h('p', {class: 'plan-told', role: 'status', hidden: ''});
  const tell = (text: string, kind: '' | 'done' = '') => { told.textContent = text; told.hidden = !text; told.classList.toggle('done', kind === 'done'); };
  let came = stripeReturn();
  /** When the person came back from Stripe's page: the web, as this page loads again; the app, as its window comes back (null till then). */
  let since: number | null = Date.now();
  if (came?.how === 'cancelled') tell(t('Payment cancelled: no charge applied and plan remains unchanged.'));
  if (came?.how === 'paid') {
    tell(came.tier ? t('Payment successful. Tier updates to {tier} once Stripe confirms.', {tier: tierName(came.tier)})
      : t('Payment successful. Plan updates to Paid shortly after Stripe confirms.'));
  }
  /** Back from Checkout: paid now, said once, and nothing more is waited for. */
  const paid = (p: Plan) => {
    if (p.plan === 'paid') { tell(t('Payment successful: you are now on {tier}.', {tier: tierName(p.tier ?? 'free')}), 'done'); came = null; }
    // Not heard yet: asked again in a moment, for a minute; then said where to look (the payment itself went through).
    else if (Date.now() - (since ?? Date.now()) < 60_000) setTimeout(again, 3000);
    else { came = null; tell(t('Awaiting confirmation from Stripe. Paid status applies once verified (no duplicate charge).')); }
  };
  /** Back from the portal: what changed there, said against the plan as it was when this tab left; nothing, if nothing did. */
  const managed = (p: Plan, left: Left | null) => {
    const said = left ? changedWords(left, p) : null;
    // The app's window back (the browser had the person meanwhile): from now on, as the web's page loaded again.
    if (since === null && document.hasFocus()) since = Date.now();
    if (said) { tell(said, 'done'); came = null; }
    // Not heard yet: asked again a few times once back, then left to the next time the plan is read.
    else if (since !== null && Date.now() - since > 20_000) came = null;
    else if (since !== null) setTimeout(again, 3000);
  };
  /**
   * The app opened the browser: said, and the plan read again when the window comes back, where what
   * changed meanwhile is said against the plan as it was (the browser comes back to no page of the app's to say it).
   */
  const opened = (p: Plan) => {
    if (!isNative) return;
    tell(t('Payment page opened in browser. Return here after completion to refresh plan status.'));
    came = {how: 'managed', tier: null, left: {tier: p.tier ?? 'free', ends: p.ends ?? null, paid: p.plan === 'paid'}};
    since = null;
  };
  return {
    told,
    heard: (p) => {
      if (came?.how === 'paid') paid(p);
      else if (came?.how === 'managed') managed(p, came.left);
    },
    // What is written here is sent first (the web leaves this page for it); the plan as it is, kept to say what changed.
    go: async (p, kind, tier) => {
      await leaving();
      leftFor(p);
      await openPlan(kind, tier ? {tier} : {});
      opened(p);
    },
  };
}

/**
 * How the trip to Stripe went, read once from where the page that came back kept it (with the plan as it was when
 * this tab left, to say what changed), and held a few minutes for every Plan drawn meanwhile (the page is drawn
 * again as what the Remote says comes in, and the Plan with it).
 */
let stripeBack: {how: Back['how']; tier: PaidTier | null; left: Left | null; at: number} | null = null;
function stripeReturn(): {how: Back['how']; tier: PaidTier | null; left: Left | null} | null {
  const back = takeStripeReturn();
  if (back) stripeBack = {...back, left: takeLeft(), at: Date.now()};
  if (stripeBack && Date.now() - stripeBack.at > 3 * 60_000) stripeBack = null;
  return stripeBack;
}

/** Before a page of Stripe's is opened in this tab: every change made here goes to the Remote first. */
async function leaving() {
  if (!isNative) await flush().catch(() => {});
}
