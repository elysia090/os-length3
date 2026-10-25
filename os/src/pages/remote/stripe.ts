import {h} from '../../ui/dom.ts';
import {isNative} from '../../app/host.ts';
import {t} from '../../i18n.ts';
import {flush} from '../../remote/lifecycle.ts';
import {takeLeft, takeStripeReturn, tierName, type Back, type Left, type PaidTier} from '../../remote/plan.ts';
import {answers} from '../common.ts';
import {button} from './parts.ts';

// Trips to Stripe's pages and back: what goes to the Remote before one, and how it went, said once back.

/**
 * Back from Stripe in a browser that is not signed in here (the app opened Stripe's page in the browser): how it
 * went, and where to go on, rather than a sign-in card nobody came for. Signed in, Remote's Plan says it instead.
 */
export function checkoutBackPage(how: 'paid' | 'cancelled' | 'managed', tier: PaidTier | null, goOn: () => void): HTMLElement {
  const on = button(t('Open the web app'));
  on.addEventListener('click', goOn);
  const [title, line] = how === 'paid'
    ? [t('Payment went through'), tier ? t('{tier} shows in the app as soon as Stripe tells the Remote, a moment from now.', {tier: tierName(tier)})
      : t('The plan shows Paid in the app as soon as Stripe tells the Remote, a moment from now.')]
    : how === 'cancelled' ? [t('Payment was cancelled'), t('Nothing was charged; the plan is as it was.')]
    : [t('Back from Stripe'), t('What changed shows in the app as soon as Stripe tells the Remote.')];
  return h('main', {class: 'device-page sign-in-place'},
    h('section', {class: 'sign-in-card', 'aria-labelledby': 'checkout-back'},
      h('h1', {id: 'checkout-back'}, title), h('p', {}, line),
      h('p', {class: 'muted'}, t('Go back to the app; you can close this tab.')),
      answers(null, on)));
}

/**
 * How the trip to Stripe went, read once from where the page that came back kept it (with the plan as it was when
 * this tab left, to say what changed), and held a few minutes for every Plan drawn meanwhile (the page is drawn
 * again as what the Remote says comes in, and the Plan with it).
 */
let stripeBack: {how: Back['how']; tier: PaidTier | null; left: Left | null; at: number} | null = null;
export function stripeReturn(): {how: Back['how']; tier: PaidTier | null; left: Left | null} | null {
  const back = takeStripeReturn();
  if (back) stripeBack = {...back, left: takeLeft(), at: Date.now()};
  if (stripeBack && Date.now() - stripeBack.at > 3 * 60_000) stripeBack = null;
  return stripeBack;
}

/** Before a page of Stripe's is opened in this tab: every change made here goes to the Remote first. */
export async function leaving() {
  if (!isNative) await flush().catch(() => {});
}
