// A stand-in for Stripe on this machine, for development and the end-to-end
// checks, as devoauth.ts stands in for a sign-in provider. Its pages look and
// behave as Stripe's do in test mode, so a person (or a selftest) goes from
// the Plan to paying and back as they would:
//
//   Checkout       the tier, its price and what it keeps at the left; email,
//                  card, expiry, CVC, cardholder name and country at the
//                  right. Stripe's test cards: 4242 4242 4242 4242 pays,
//                  4000 0000 0000 0002 is declined (said under the card,
//                  nothing sent), 4000 0025 0000 3155 asks for 3-D Secure
//                  first (a page with Complete and Fail, as Stripe's test
//                  page has). Back goes to the app's cancel page.
//   the portal     the tier and the next payment, changing tier, the card
//                  (the same form and test cards), the invoices, cancelling
//                  at the period's end and keeping it after all; and, marked
//                  as not Stripe's, test controls: a payment fails, a payment
//                  goes through, it ends now.
//
// Each step that changes something sends the Remote the events Stripe would,
// signed with the webhook secret, to its own webhook, before the page goes
// on. Stripe's own state (customers, subscriptions, cards, invoices) is kept
// here, in `keep` when given (dev.ts: a file beside the Remote's database).
// Mounted only by dev.ts when it is asked for a plan (LENGTH3_PLAN=1), and by
// the production-like selftest's Worker; never on Workers, and nothing
// reaches Stripe. A card number is never kept or written anywhere: only its
// brand and last four digits, as Stripe shows them.

import {readFileSync} from 'node:fs';
import {Hono} from 'hono';
import {PAID, TIER_NAME, TIERS, isTier, type Tier} from './plan.ts';
import {sign, STRIPE_VERSION, type Change, type Locale, type Price, type StripeApi} from './stripe.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const word = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
const DAY = 86_400;
/** A month, as the stand-in bills one. */
const MONTH = 30 * DAY;
const nowSecs = () => Math.floor(Date.now() / 1000);

/** Each tier's price here: its id, and what it costs a month in US cents (as Stripe says an amount). */
export const DEV_PRICES: Record<Tier, string> = {go: 'price_dev_go', pro: 'price_dev_pro', max: 'price_dev_max'};
const COST: Record<Tier, number> = {go: 700, pro: 1400, max: 1900};
const tierOfPrice = (id: string): Tier | null => TIERS.find((t) => DEV_PRICES[t] === id) ?? null;

/** Money as Stripe's pages say it: $14.00. */
const money = (cents: number) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;

// ---- Stripe's words, in the language its pages were asked in (the OS's: plan.ts) ----

/**
 * Stripe's pages in Japanese, by the English (as the app's own words are: src/i18n.ts), {name} where a value goes.
 * As Stripe says them where it is known how; a Latin word a space apart from kana and kanji (DESIGN.md §1).
 */
const JA: Record<string, string> = {
  'Test mode': 'テストモード', 'Back to length3': 'length3 に戻る', 'Return to length3': 'length3 に戻る', 'Expired': '期限切れ',
  'This {what} has expired': 'この{what}は期限切れです', 'Go back to length3 and start again.': 'length3 に戻って、もう一度始めてください。',
  'Checkout session': 'Checkout セッション', 'portal session': 'ポータルセッション', 'authentication': '認証',
  'A stand-in for Stripe on this machine, in test mode: nothing is charged, and nothing leaves it.': 'このマシン上の Stripe の代役（テストモード）です。請求は一切なく、何も外に出ません。',
  'Subscribe to {tier}': '{tier} に申し込む', 'per month': '月額', 'Billed monthly': '毎月請求', 'Subtotal': '小計', 'Total due today': '本日のお支払い合計',
  'Pay with card': 'カードで支払う', 'Email': 'メールアドレス', 'Card information': 'カード情報', 'Card number': 'カード番号', 'Expiration': '有効期限',
  'Cardholder name': 'カード名義人', 'Full name on card': 'カードに記載の名前', 'Country or region': '国または地域', 'Subscribe': '申し込む',
  'By confirming your subscription, you allow length3 to charge you for future payments in accordance with their terms. You can always cancel your subscription.':
    'サブスクリプションを確定すると、length3 がその規約に従って今後のお支払いを請求することを許可したものとみなされます。サブスクリプションはいつでもキャンセルできます。',
  'Test cards': 'テストカード', 'pays': '支払いが通る', 'is declined': '拒否される', 'asks for 3-D Secure': '3D セキュアを求める', 'Any expiry to come, any CVC': '有効期限は先の日付、CVC は任意',
  '{gb} on the Remote': 'Remote に {gb}', 'Unlimited repos (within storage)': 'リポジトリ無制限（容量の範囲で）', '{n} repos': 'リポジトリ {n} 個',
  'Unlimited usernames on this Remote': 'この Remote のユーザー名は無制限', '{n} names on this Remote': 'この Remote の名前 {n} 個',
  'Servers, and names on your own domain': 'サーバー、自分のドメインの名前',
  'Your card number is incomplete.': 'カード番号が不完全です。', 'Your card number is invalid.': 'カード番号が無効です。',
  'Your card\'s expiration date is incomplete.': 'カードの有効期限が不完全です。', 'Your card\'s expiration date is invalid.': 'カードの有効期限が無効です。',
  'Your card\'s expiration year is in the past.': 'カードの有効期限の年が過ぎています。', 'Your card\'s expiration date is in the past.': 'カードの有効期限が過ぎています。',
  'Your card\'s security code is incomplete.': 'カードのセキュリティコードが不完全です。', 'Your card\'s security code is incorrect.': 'カードのセキュリティコードが正しくありません。',
  'Your card was declined.': 'カードが拒否されました。', 'Your card has insufficient funds.': 'カードの残高が不足しています。', 'Your card has expired.': 'カードの有効期限が切れています。',
  'Your card was declined. This is test mode: use one of Stripe\'s test cards, such as 4242 4242 4242 4242.': 'カードが拒否されました。テストモードです。4242 4242 4242 4242 などの Stripe のテストカードを使ってください。',
  'Your email address is invalid.': 'メールアドレスが無効です。', 'Your email is incomplete.': 'メールアドレスが不完全です。', 'Your name is required.': '名前を入力してください。',
  'This Checkout session has expired.': 'この Checkout セッションは期限切れです。', 'This session has expired.': 'このセッションは期限切れです。',
  'Something went wrong. Try again.': '問題が発生しました。もう一度お試しください。', 'Processing': '処理中',
  'We are unable to authenticate your payment method. Please choose a different payment method and try again.': 'お支払い方法を認証できませんでした。別のお支払い方法を選んで、もう一度お試しください。',
  'length3 partners with Stripe for simplified billing.': 'length3 は Stripe と連携し、請求をシンプルにしています。',
  'Your subscription has been updated.': 'サブスクリプションを更新しました。', 'Your subscription has been canceled. It stays until the end of the period.': 'サブスクリプションをキャンセルしました。期間の終わりまではご利用いただけます。',
  'Your subscription has been renewed.': 'サブスクリプションを再開しました。', 'Your payment method has been updated.': 'お支払い方法を更新しました。',
  'A payment failed (a test control).': '支払いが失敗しました（テスト操作）。', 'A payment went through (a test control).': '支払いが通りました（テスト操作）。',
  'The subscription ended (a test control).': 'サブスクリプションが終了しました（テスト操作）。',
  'You have no subscription.': 'サブスクリプションはありません。', 'Your subscription was canceled on {day}.': 'サブスクリプションは{day}にキャンセルされました。',
  'Your last payment did not go through. Stripe tries again; update your payment method to pay now.': '前回のお支払いが完了しませんでした。Stripe が再度試みます。今すぐ支払うには、お支払い方法を更新してください。',
  'Your subscription will be canceled on {day}.': 'サブスクリプションは{day}にキャンセルされます。', 'Your plan renews on {day}.': 'プランは{day}に更新されます。',
  'Current subscription': '現在のプラン', 'Cancels {day}': '{day}にキャンセル', 'Past due': '支払い期限超過', '{price} per month': '月額 {price}',
  'Update subscription': 'プランを変更', 'Renew plan': 'プランを再開', 'Cancel subscription': 'プランをキャンセル',
  'Payment method': 'お支払い方法', 'Expires {exp}': '有効期限 {exp}', 'No payment method': 'お支払い方法がありません', 'Update payment method': 'お支払い方法を更新', 'Add payment method': 'お支払い方法を追加',
  'Invoice history': '請求履歴', 'Date': '日付', 'Amount': '金額', 'Status': 'ステータス', 'For': '内容', 'Paid': '支払い済み', 'Open': '未払い', 'No invoices yet.': '請求書はまだありません。',
  'Test controls': 'テスト操作', 'Not part of Stripe\'s portal: each sends the Remote the events Stripe would when it happens.': 'Stripe のポータルにはない操作です。どれも、実際に起きたとき Stripe が送るイベントを Remote に送ります。',
  'A payment fails': '支払いが失敗する', 'A payment goes through': '支払いが通る', 'End it now': '今すぐ終了', 'There is no subscription to act on.': '操作できるサブスクリプションがありません。',
  'Billing': '請求', 'Update your plan': 'プランを変更', 'Current plan': '現在のプラン', 'Select': '選択', 'Select {tier}': '{tier} を選択', 'Go back': '戻る',
  'Confirm your updated plan': '変更後のプランを確認', 'Current': '現在', 'New': '変更後', 'Amount due today': '本日のお支払い額', 'Credited to your next invoice': '次回の請求に充当',
  'Prorated for the rest of this period, charged to {card}.': 'この期間の残りを日割りで計算し、{card} に請求します。', 'your payment method': 'お支払い方法',
  'What is left of this period on the plan you have now is credited to your next invoice.': '今のプランのこの期間の残りは、次回の請求に充当されます。',
  'Then {price} per month from {day}.': '{day}からは月額 {price} です。', 'Confirm': '確定する',
  'Cancel your plan': 'プランをキャンセル', 'Your subscription will be canceled, but is still available until the end of your billing period on {day}.':
    'サブスクリプションはキャンセルされますが、請求期間が終わる{day}まではご利用いただけます。',
  'If you change your mind, you can renew your subscription before then.': '気が変わったら、それまでにサブスクリプションを再開できます。', 'Cancel plan': 'プランをキャンセル',
  'Update': '更新', 'Add': '追加', '{from} → {to} · the rest of this period': '{from} → {to} · この期間の残り',
};

/** Kana and kanji, which a Latin word is set a space apart from (src/i18n.ts, DESIGN.md §1). */
const KANA_KANJI = /[぀-ヺー-ヿ㐀-鿿]/;
/** Stripe's words in `locale`: the English with each {name} filled, or the Japanese for it, a Latin value set apart from kana and kanji. */
type Say = (en: string, vars?: Record<string, string>) => string;
const sayIn = (locale: Locale = 'en'): Say => (en, vars = {}) => {
  if (locale !== 'ja') return en.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
  const ja = JA[en] ?? en;
  return ja.replace(/\{(\w+)\}/g, (m: string, k: string, at: number) => {
    const v = vars[k] ?? '', before = ja[at - 1], after = ja[at + m.length];
    return `${before && KANA_KANJI.test(before) && /^[A-Za-z]/.test(v) ? ' ' : ''}${v}${after && KANA_KANJI.test(after) && /[A-Za-z]$/.test(v) ? ' ' : ''}`;
  });
};
/** A day as Stripe's pages say it: November 22, 2026; 2026年11月22日. */
const longDay = (secs: number, locale: Locale = 'en') => new Date(secs * 1000).toLocaleDateString(locale === 'ja' ? 'ja-JP' : 'en-US', {year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'});
const shortDay = (secs: number, locale: Locale = 'en') => new Date(secs * 1000).toLocaleDateString(locale === 'ja' ? 'ja-JP' : 'en-US',
  locale === 'ja' ? {year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC'} : {year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC'});
const gb = (bytes: number) => `${Math.round(bytes / 1e9)} GB`;
/** What a tier keeps, as its product's description lists it. */
const keeps = (t: Tier, w: Say = sayIn()) => [w('{gb} on the Remote', {gb: gb(PAID[t].bytes)}),
  PAID[t].repos === null ? w('Unlimited repos (within storage)') : w('{n} repos', {n: String(PAID[t].repos)}),
  PAID[t].names === null ? w('Unlimited usernames on this Remote') : w('{n} names on this Remote', {n: String(PAID[t].names)}), w('Servers, and names on your own domain')];

// ---- cards, as Stripe's test mode takes them ----

/** Whether `n` (digits) passes the Luhn check every card number does. */
export function luhn(n: string): boolean {
  let sum = 0, twice = false;
  for (let i = n.length - 1; i >= 0; i--) {
    let d = n.charCodeAt(i) - 48;
    if (twice) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    twice = !twice;
  }
  return n.length > 0 && sum % 10 === 0;
}

/** A card's brand, by its first digits. */
export function brandOf(n: string): 'visa' | 'mastercard' | 'amex' | 'discover' | '' {
  if (/^3[47]/.test(n)) return 'amex';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(n)) return 'mastercard';
  if (/^4/.test(n)) return 'visa';
  if (/^6(011|5)/.test(n)) return 'discover';
  return '';
}
const BRAND: Record<string, string> = {visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', '': 'Card'};

/** What a card's fields say before it is tried, as Stripe's form says it: the field that is wrong and why, or null. */
export function cardTrouble(c: {number: string; exp: string; cvc: string}, now = new Date()): {field: 'number' | 'exp' | 'cvc'; message: string} | null {
  const n = c.number.replace(/\D/g, ''), amex = brandOf(n) === 'amex';
  if (n.length < (amex ? 15 : 16)) return {field: 'number', message: 'Your card number is incomplete.'};
  if (n.length > 19 || !luhn(n)) return {field: 'number', message: 'Your card number is invalid.'};
  const e = /^\s*(\d{1,2})\s*\/?\s*(\d{2})\s*$/.exec(c.exp);
  if (!e) return {field: 'exp', message: 'Your card\'s expiration date is incomplete.'};
  const month = Number(e[1]), year = 2000 + Number(e[2]);
  if (month < 1 || month > 12) return {field: 'exp', message: 'Your card\'s expiration date is invalid.'};
  if (year < now.getUTCFullYear()) return {field: 'exp', message: 'Your card\'s expiration year is in the past.'};
  if (year === now.getUTCFullYear() && month < now.getUTCMonth() + 1) return {field: 'exp', message: 'Your card\'s expiration date is in the past.'};
  if (!new RegExp(`^\\d{${amex ? 4 : 3}}$`).test(c.cvc.trim())) return {field: 'cvc', message: 'Your card\'s security code is incomplete.'};
  return null;
}

/** What trying a card comes to, as Stripe's test cards are made to: paid, declined (and why), or 3-D Secure first. */
export function cardOutcome(number: string): {ok: true} | {secure: true} | {field: 'number' | 'cvc'; message: string} {
  const n = number.replace(/\D/g, '');
  switch (n) {
    case '4242424242424242': case '4000056655665556': case '5555555555554444': case '2223003122003222': case '5200828282828210':
    case '378282246310005': case '371449635398431': case '6011111111111117':
      return {ok: true};
    case '4000002500003155': case '4000002760003184': return {secure: true};
    case '4000000000000002': return {field: 'number', message: 'Your card was declined.'};
    case '4000000000009995': return {field: 'number', message: 'Your card has insufficient funds.'};
    case '4000000000000069': return {field: 'number', message: 'Your card has expired.'};
    case '4000000000000127': return {field: 'cvc', message: 'Your card\'s security code is incorrect.'};
    default: return {field: 'number', message: 'Your card was declined. This is test mode: use one of Stripe\'s test cards, such as 4242 4242 4242 4242.'};
  }
}

// ---- Stripe's own state ----

interface Card { brand: string; last4: string; exp: string }
interface Invoice { id: string; number: string; at: number; amount: number; status: 'paid' | 'open'; what: string }
interface Sub { id: string; item: string; tier: Tier; status: 'active' | 'past_due' | 'canceled'; start: number; end: number; cancelAtEnd: boolean; endedAt: number | null; boughtAs: Tier }
interface Customer { id: string; user: string; email: string; name: string; card: Card | null; sub: Sub | null; invoices: Invoice[]; locale?: Locale }
interface CheckoutSession { id: string; customer: string; user: string; tier: Tier; success: string; cancel: string; done: boolean; locale?: Locale }
interface PortalSession { id: string; customer: string; back: string; change: Tier | null; locale?: Locale }
/** A card tried that asks for 3-D Secure: what it is for, and where to go back to. */
interface Secure { id: string; card: Card; for: {checkout: string; email: string; name: string} | {portal: string} }
interface State { customers: Record<string, Customer>; checkouts: Record<string, CheckoutSession>; portals: Record<string, PortalSession>; secure: Record<string, Secure>; n: number }

/**
 * The stand-in: `base` is the Remote's own address, `secret` the webhook's, `origins` the app's pages,
 * `deliver` hands a signed event to the Remote (its app, in this process), and `keep` holds Stripe's
 * state between runs.
 */
export function devBilling(base: string, secret: string, origins: string[], deliver: (payload: string, signature: string) => Promise<Response>,
  keep?: {load(): string | null; save(text: string): void}) {
  let state: State = {customers: {}, checkouts: {}, portals: {}, secure: {}, n: 0};
  try { const kept = keep?.load(); if (kept) state = {...state, ...JSON.parse(kept) as State}; } catch { /* a fresh Stripe, then */ }
  const save = () => { try { keep?.save(JSON.stringify(state)); } catch { /* kept in memory, then */ } };
  const id = (prefix: string) => `${prefix}_dev${Date.now().toString(36)}${(++state.n).toString(36)}${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  /** Back only to one of the app's pages. */
  const back = (v: string | null | undefined) => { try { const u = new URL(v ?? ''); return origins.includes(u.origin) ? u.toString() : origins[0]; } catch { return origins[0]; } };
  const priceOf = (t: Tier): Price => ({amount: COST[t], currency: 'usd', interval: 'month', every: 1});

  const api: StripeApi = {
    async customer({user, email, name}) {
      const cid = `cus_dev${word(user)}`;
      const c = state.customers[cid];
      state.customers[cid] = {id: cid, user, email, name, card: c?.card ?? null, sub: c?.sub ?? null, invoices: c?.invoices ?? []};
      save();
      return cid;
    },
    // Paying goes back to `success`; Back, without paying, to `cancel`, as Stripe's Checkout does.
    async checkout({customer, user, tier, price, success, cancel, locale}) {
      const t = tierOfPrice(price) ?? (isTier(tier) ? tier : null);
      if (!t) throw new Error('Stripe 400: no such price');
      const s: CheckoutSession = {id: id('cs'), customer, user, tier: t, success, cancel, done: false, ...(locale ? {locale} : {})};
      state.checkouts[s.id] = s;
      save();
      return `${base}/dev-billing/checkout/${s.id}`;
    },
    async portal({customer, back: to, change, locale}: {customer: string; back: string; change?: Change; locale?: Locale}) {
      const s: PortalSession = {id: id('bps'), customer, back: to, change: change ? tierOfPrice(change.price) : null, ...(locale ? {locale} : {})};
      const c = state.customers[customer];
      if (c && locale) c.locale = locale;
      state.portals[s.id] = s;
      save();
      return `${base}/dev-billing/portal/${s.id}${s.change ? `/change/${s.change}` : ''}`;
    },
    async price(price) {
      const t = tierOfPrice(price);
      if (!t) throw new Error('Stripe 404: no such price');
      return priceOf(t);
    },
  };

  // ---- the events Stripe sends ----

  let sent = 0;
  const send = async (type: string, object: Record<string, unknown>, previous?: Record<string, unknown>) => {
    const payload = JSON.stringify({id: `evt_dev${Date.now()}x${++sent}`, object: 'event', api_version: STRIPE_VERSION, created: nowSecs(), livemode: false, type,
      data: {object, ...(previous ? {previous_attributes: previous} : {})}});
    const r = await deliver(payload, await sign(payload, secret));
    if (!r.ok) throw new Error(`webhook ${r.status}: ${await r.text()}`);
  };
  const subject = (c: Customer, s: Sub) => ({id: s.id, object: 'subscription', customer: c.id, status: s.status, livemode: false,
    cancel_at_period_end: s.cancelAtEnd, cancel_at: s.cancelAtEnd ? s.end : null, ended_at: s.endedAt, canceled_at: s.endedAt,
    current_period_start: s.start, current_period_end: s.end, metadata: {user: c.user, tier: s.boughtAs},
    items: {object: 'list', data: [{id: s.item, object: 'subscription_item', quantity: 1, current_period_start: s.start, current_period_end: s.end,
      price: {id: DEV_PRICES[s.tier], object: 'price', currency: 'usd', unit_amount: COST[s.tier], product: `prod_dev_${s.tier}`,
        recurring: {interval: 'month', interval_count: 1}}}]}});
  /** An invoice, kept for the portal's history, and as its event says it. */
  const invoice = (c: Customer, amount: number, what: string, status: Invoice['status'] = 'paid'): Invoice => {
    const i: Invoice = {id: id('in'), number: `DEV-${String(c.invoices.length + 1).padStart(4, '0')}`, at: nowSecs(), amount, status, what};
    c.invoices.unshift(i);
    return i;
  };
  const invoiceObject = (c: Customer, i: Invoice, reason: string) => ({id: i.id, object: 'invoice', customer: c.id, subscription: c.sub?.id ?? null,
    number: i.number, amount_due: i.amount, amount_paid: i.status === 'paid' ? i.amount : 0, currency: 'usd', status: i.status, billing_reason: reason,
    created: i.at, paid: i.status === 'paid'});

  /** Checkout paid: the subscription made, its first invoice paid, and back to the app. */
  async function subscribed(s: CheckoutSession, card: Card, email: string, name: string) {
    const c = state.customers[s.customer] ?? (state.customers[s.customer] = {id: s.customer, user: s.user, email, name, card: null, sub: null, invoices: []});
    c.email = email; c.name = name || c.name; c.card = card; c.locale = s.locale ?? c.locale;
    const start = nowSecs();
    const sub: Sub = {id: `sub_dev${s.customer.slice(7)}${(++state.n).toString(36)}`, item: id('si'), tier: s.tier, status: 'active', start, end: start + MONTH,
      cancelAtEnd: false, endedAt: null, boughtAs: s.tier};
    c.sub = sub;
    s.done = true;
    const first = invoice(c, COST[s.tier], `${TIER_NAME[s.tier]} · ${shortDay(start, c.locale)} – ${shortDay(sub.end, c.locale)}`);
    save();
    await send('checkout.session.completed', {id: s.id, object: 'checkout.session', mode: 'subscription', status: 'complete', payment_status: 'paid',
      customer: c.id, client_reference_id: s.user, subscription: sub.id, customer_details: {email, name}, metadata: {user: s.user, tier: s.tier}});
    await send('customer.subscription.created', subject(c, sub));
    await send('invoice.paid', invoiceObject(c, first, 'subscription_create'));
    await send('customer.subscription.updated', subject(c, sub), {status: 'incomplete'});
  }

  /** A new card on the customer; one owed for (a payment that failed) is paid with it at once, as Stripe tries again. */
  async function carded(c: Customer, card: Card) {
    c.card = card;
    save();
    await send('payment_method.attached', {id: id('pm'), object: 'payment_method', customer: c.id, type: 'card', card: {brand: card.brand, last4: card.last4}});
    const open = c.invoices.find((i) => i.status === 'open');
    if (c.sub && c.sub.status === 'past_due' && open) {
      open.status = 'paid';
      c.sub.status = 'active';
      save();
      await send('invoice.paid', invoiceObject(c, open, 'subscription_cycle'));
      await send('customer.subscription.updated', subject(c, c.sub), {status: 'past_due'});
    }
  }

  /** Changed to `to` at once, the rest of the period prorated: the difference paid now going up, credited going down. */
  async function changed(c: Customer, to: Tier) {
    const s = c.sub!, was = s.tier;
    const left = Math.max(0, Math.min(1, (s.end - nowSecs()) / (s.end - s.start)));
    const owed = Math.round((COST[to] - COST[was]) * left);
    s.tier = to;
    const paid = owed > 0 ? invoice(c, owed, sayIn(c.locale)('{from} → {to} · the rest of this period', {from: TIER_NAME[was], to: TIER_NAME[to]})) : null;
    save();
    await send('customer.subscription.updated', subject(c, s), {items: {data: [{price: {id: DEV_PRICES[was]}}]}});
    if (paid) await send('invoice.paid', invoiceObject(c, paid, 'subscription_update'));
  }

  // ---- the pages ----

  const app = new Hono();
  /**
   * A page of Stripe's, in `locale`, with its own policy: its inline style, and its script by a nonce made for it. A
   * page in Japanese sets the Japanese a little apart (Inter has no kana: the system's Japanese face beside it).
   */
  const html = (locale: Locale | undefined, title: string, body: string, script = '', status = 200) => {
    const nonce = crypto.randomUUID().replace(/-/g, '');
    return new Response(`<!doctype html><html lang="${locale === 'ja' ? 'ja' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${faceOf()}${CSS}</style>${body}${script ? `<script nonce="${nonce}">${script}</script>` : ''}</html>`, {status, headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self' ${origins.join(' ')}; frame-ancestors 'none'; base-uri 'none'`,
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'}});
  };
  /** The two columns, as Stripe's Checkout and portal have them: what it is about at the left, what is done at the right. */
  const page = (left: string, right: string, extra = '') => `<div class="page${extra}"><div class="side"><div class="col">${left}</div></div>
<div class="main"><div class="col">${right}</div></div></div>`;
  const head = (w: Say, to: string, label: string) => `<div class="head"><a class="back" href="${esc(to)}" aria-label="${esc(w(label))}"><span aria-hidden="true">&larr;</span>
${iconOf() ? `<img class="logo" src="${iconOf()}" alt="">` : ''}<span>length3</span></a><span class="badge">${esc(w('Test mode'))}</span></div>`;
  const fine = (w: Say) => `<p class="standin">${esc(w('A stand-in for Stripe on this machine, in test mode: nothing is charged, and nothing leaves it.'))}</p>`;
  /** A session not there (or done): in the language it was asked in when it is known, else the browser's. */
  const gone = (what: string, locale?: Locale, asked?: string) => {
    const l = locale ?? (/^ja\b/i.test(asked ?? '') ? 'ja' : 'en'), w = sayIn(l);
    return html(l, w('Expired'), page(head(w, origins[0], 'Back to length3'),
      `<h1 class="h">${esc(w('This {what} has expired', {what: w(what)}))}</h1><p class="muted">${esc(w('Go back to length3 and start again.'))}</p>
<a class="pay link" href="${esc(origins[0])}">${esc(w('Back to length3'))}</a>`), '', 404);
  };
  const lang = (c: {req: {header(k: string): string | undefined}}) => c.req.header('Accept-Language');

  /** The card's fields, grouped as Stripe's form has them: the number over its expiry and CVC; then the cardholder's name and country. */
  const cardFields = (w: Say, locale: Locale | undefined, email: string | null, error = '') => `
${email === null ? '' : `<div class="row"><label for="email">${esc(w('Email'))}</label><input class="field" id="email" name="email" type="email" autocomplete="off" spellcheck="false" value="${esc(email)}" placeholder="email@example.com">
<p class="err" id="email-err" role="alert"></p></div>`}
<fieldset class="row"><legend>${esc(w('Card information'))}</legend><div class="group" id="card">
<div class="num"><input class="field" id="number" name="number" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="1234 1234 1234 1234" aria-label="${esc(w('Card number'))}" aria-describedby="card-err">
<span class="brands" id="brand" aria-hidden="true"><span class="b visa">VISA</span><span class="b mc">MC</span><span class="b amex">AMEX</span></span></div>
<div class="pair"><input class="field" id="exp" name="exp" inputmode="numeric" autocomplete="off" placeholder="MM / YY" aria-label="${esc(w('Expiration'))}" aria-describedby="card-err">
<input class="field" id="cvc" name="cvc" inputmode="numeric" autocomplete="off" placeholder="CVC" aria-label="CVC" aria-describedby="card-err"></div></div>
<p class="err" id="card-err" role="alert">${esc(error)}</p></fieldset>
<div class="row"><label for="name">${esc(w('Cardholder name'))}</label><input class="field" id="name" name="name" autocomplete="off" spellcheck="false" placeholder="${esc(w('Full name on card'))}">
<p class="err" id="name-err" role="alert"></p></div>
<div class="row"><label for="country">${esc(w('Country or region'))}</label><select class="field" id="country" name="country">${COUNTRIES.map(([code, en, ja]) =>
    `<option value="${code}"${code === (locale === 'ja' ? 'JP' : 'US') ? ' selected' : ''}>${esc(locale === 'ja' ? ja : en)}</option>`).join('')}</select></div>`;
  const testCards = (w: Say) => `<details class="tests"><summary>${esc(w('Test cards'))}</summary><ul>
<li><code>4242 4242 4242 4242</code> ${esc(w('pays'))}</li><li><code>4000 0000 0000 0002</code> ${esc(w('is declined'))}</li>
<li><code>4000 0025 0000 3155</code> ${esc(w('asks for 3-D Secure'))}</li><li>${esc(w('Any expiry to come, any CVC'))}</li></ul></details>`;
  const unauthenticated = 'We are unable to authenticate your payment method. Please choose a different payment method and try again.';

  app.get('/checkout/:id', (c) => {
    const s = state.checkouts[c.req.param('id')];
    if (!s || s.done) return gone('Checkout session', s?.locale, lang(c));
    const cust = state.customers[s.customer], w = sayIn(s.locale);
    const t = s.tier, error = c.req.query('declined') === '3ds' ? w(unauthenticated) : '';
    const left = `${head(w, back(s.cancel), 'Back to length3')}
<p class="what">${esc(w('Subscribe to {tier}', {tier: TIER_NAME[t]}))}</p>
<p class="price" id="total">${money(COST[t])}<small>${s.locale === 'ja' ? esc(w('per month')) : 'per<br>month'}</small></p>
<div class="items"><div class="item"><div><p class="item-name">${esc(TIER_NAME[t])}</p><p class="muted small">${esc(w('Billed monthly'))}</p></div><p>${money(COST[t])}</p></div>
<ul class="keeps">${keeps(t, w).map((k) => `<li>${esc(k)}</li>`).join('')}</ul>
<div class="sum"><span>${esc(w('Subtotal'))}</span><span>${money(COST[t])}</span></div>
<div class="sum total"><span>${esc(w('Total due today'))}</span><span>${money(COST[t])}</span></div></div>`;
    const right = `<h1 class="h">${esc(w('Pay with card'))}</h1><form id="pay-form" novalidate>${cardFields(w, s.locale, cust?.email ?? '', error)}
<button class="pay" id="pay" type="submit"><span class="label">${esc(w('Subscribe'))}</span></button>
<p class="fine">${esc(w('By confirming your subscription, you allow length3 to charge you for future payments in accordance with their terms. You can always cancel your subscription.'))}</p>
</form>${testCards(w)}${fine(w)}`;
    return html(s.locale, `length3 · ${w('Subscribe to {tier}', {tier: TIER_NAME[t]})}`, page(left, right), FORM_JS('pay', w('Subscribe'), s.locale));
  });

  /** A card tried: its fields checked, then what it comes to (declined: said, and nothing sent; 3-D Secure: its page). */
  const tried = async (c: {req: {json(): Promise<unknown>}}) => {
    const f = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const g = (k: string) => (typeof f[k] === 'string' ? (f[k] as string) : '');
    const number = g('number').replace(/\D/g, '');
    const trouble = cardTrouble({number, exp: g('exp'), cvc: g('cvc')});
    const card: Card = {brand: brandOf(number), last4: number.slice(-4), exp: g('exp').replace(/\s/g, '')};
    return {f: {email: g('email').trim(), name: g('name').trim()}, trouble, outcome: trouble ? null : cardOutcome(number), card};
  };
  /** What is wrong with a card tried, said in the page's language. */
  const wrong = (w: Say, field: string, message: string, status: 402 | 410) => ({body: {wrong: {field, message: w(message)}}, status});

  app.post('/checkout/:id/pay', async (c) => {
    const s = state.checkouts[c.req.param('id')], w = sayIn(s?.locale);
    const no = (field: string, message: string, status: 402 | 410 = 402) => { const r = wrong(w, field, message, status); return c.json(r.body, r.status); };
    if (!s || s.done) return no('number', 'This Checkout session has expired.', 410);
    const {f, trouble, outcome, card} = await tried(c);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) return no('email', f.email ? 'Your email address is invalid.' : 'Your email is incomplete.');
    if (trouble) return no(trouble.field, trouble.message);
    if (!f.name) return no('name', 'Your name is required.');
    if (outcome && 'message' in outcome) return no(outcome.field, outcome.message);
    if (outcome && 'secure' in outcome) {
      const a: Secure = {id: id('payatt'), card, for: {checkout: s.id, email: f.email, name: f.name}};
      state.secure[a.id] = a;
      save();
      return c.json({next: `${base}/dev-billing/3ds/${a.id}`});
    }
    await subscribed(s, card, f.email, f.name);
    return c.json({next: back(s.success)});
  });

  // 3-D Secure, as Stripe's test page asks it: the bank's step, Complete or Fail. Stripe's test page is in English
  // whatever the Checkout's language (a bank's own is in the bank's).
  app.get('/3ds/:id', (c) => {
    const a = state.secure[c.req.param('id')];
    if (!a) return gone('authentication', undefined, lang(c));
    const amount = 'checkout' in a.for ? money(COST[state.checkouts[a.for.checkout]?.tier ?? 'go']) : '$0.00';
    const w = sayIn();
    return html('en', '3D Secure 2 Test Page', `<div class="secure"><div class="secure-box" role="dialog" aria-labelledby="secure-title">
<p class="badge">Test mode</p><h1 class="h" id="secure-title">3D Secure 2 Test Page</h1>
<p class="muted">This is a test page for 3-D Secure authentication. In a live payment, your bank would ask you to confirm it is you.</p>
<dl class="facts"><dt>Merchant</dt><dd>length3</dd><dt>Amount</dt><dd>${esc(amount)}</dd><dt>Card</dt><dd>${esc(BRAND[a.card.brand])} •••• ${esc(a.card.last4)}</dd></dl>
<div class="secure-foot"><form method="post" action="${esc(a.id)}/fail"><button class="plain" type="submit">Fail</button></form>
<form method="post" action="${esc(a.id)}/complete"><button class="pay narrow" type="submit">Complete</button></form></div></div>${fine(w)}</div>`);
  });
  app.post('/3ds/:id/:how', async (c) => {
    const a = state.secure[c.req.param('id')], how = c.req.param('how');
    if (!a || (how !== 'complete' && how !== 'fail')) return gone('authentication', undefined, lang(c));
    delete state.secure[a.id];
    save();
    if ('checkout' in a.for) {
      const s = state.checkouts[a.for.checkout];
      if (!s || s.done) return gone('Checkout session', s?.locale, lang(c));
      // Failed: back to Checkout, which says it under the card; nothing is sent.
      if (how === 'fail') return c.redirect(`${base}/dev-billing/checkout/${s.id}?declined=3ds`, 303);
      await subscribed(s, a.card, a.for.email, a.for.name);
      return c.redirect(back(s.success), 303);
    }
    const p = state.portals[a.for.portal];
    if (!p) return gone('portal session', undefined, lang(c));
    if (how === 'fail') return c.redirect(`${base}/dev-billing/portal/${p.id}/card?declined=3ds`, 303);
    const cust = state.customers[p.customer];
    if (cust) await carded(cust, a.card);
    return c.redirect(`${base}/dev-billing/portal/${p.id}?done=card`, 303);
  });

  // ---- the customer portal ----

  const portalOf = (pid: string) => { const p = state.portals[pid]; const cust = p && state.customers[p.customer]; return p && cust ? {p, cust, w: sayIn(p.locale)} : null; };
  const portalHead = (w: Say, p: PortalSession) => `${head(w, back(p.back), 'Return to length3')}
<p class="what">${esc(w('length3 partners with Stripe for simplified billing.'))}</p>${fine(w)}`;
  const done: Record<string, string> = {change: 'Your subscription has been updated.', cancel: 'Your subscription has been canceled. It stays until the end of the period.',
    renew: 'Your subscription has been renewed.', card: 'Your payment method has been updated.', fail: 'A payment failed (a test control).',
    paid: 'A payment went through (a test control).', end: 'The subscription ended (a test control).'};
  const cardSaid = (c: Card) => `${esc(BRAND[c.brand])} •••• ${esc(c.last4)}`;
  const perMonth = (w: Say, cents: number) => esc(w('{price} per month', {price: money(cents)}));

  app.get('/portal/:id', (c) => {
    const at = portalOf(c.req.param('id'));
    if (!at) return gone('portal session', undefined, lang(c));
    const {p, cust, w} = at, s = cust.sub, pid = esc(p.id), day = (secs: number) => longDay(secs, p.locale);
    const live = s && s.status !== 'canceled';
    const line = !s ? w('You have no subscription.')
      : s.status === 'canceled' ? w('Your subscription was canceled on {day}.', {day: day(s.endedAt ?? s.end)})
      : s.status === 'past_due' ? w('Your last payment did not go through. Stripe tries again; update your payment method to pay now.')
      : s.cancelAtEnd ? w('Your subscription will be canceled on {day}.', {day: day(s.end)})
      : w('Your plan renews on {day}.', {day: day(s.end)});
    const banner = done[c.req.query('done') ?? ''];
    const right = `${banner ? `<p class="banner" role="status">${esc(w(banner))}</p>` : ''}
<section aria-labelledby="sub-h"><h2 class="h2" id="sub-h">${esc(w('Current subscription'))}</h2>
${s ? `<div class="plan-row"><div><p class="item-name">${esc(TIER_NAME[s.tier])}${s.cancelAtEnd && live ? ` <span class="tag">${esc(w('Cancels {day}', {day: p.locale === 'ja' ? day(s.end) : shortDay(s.end)}))}</span>` : ''}${s.status === 'past_due' ? ` <span class="tag bad">${esc(w('Past due'))}</span>` : ''}</p>
<p class="price held">${money(COST[s.tier])}<small>${p.locale === 'ja' ? esc(w('per month')) : 'per<br>month'}</small></p></div></div>` : ''}
<p class="muted" id="sub-line">${esc(line)}</p>
${live ? `<div class="acts"><a class="btn" href="${pid}/change">${esc(w('Update subscription'))}</a>
${s.cancelAtEnd ? `<form method="post" action="${pid}/renew"><button class="btn" type="submit">${esc(w('Renew plan'))}</button></form>` : `<a class="btn" href="${pid}/cancel">${esc(w('Cancel subscription'))}</a>`}</div>` : ''}</section>
<section aria-labelledby="pm-h"><h2 class="h2" id="pm-h">${esc(w('Payment method'))}</h2>
<p>${cust.card ? `${cardSaid(cust.card)} <span class="muted">${esc(w('Expires {exp}', {exp: cust.card.exp}))}</span>` : `<span class="muted">${esc(w('No payment method'))}</span>`}</p>
<div class="acts"><a class="btn" href="${pid}/card">${esc(w(cust.card ? 'Update payment method' : 'Add payment method'))}</a></div></section>
<section aria-labelledby="inv-h"><h2 class="h2" id="inv-h">${esc(w('Invoice history'))}</h2>
${cust.invoices.length ? `<table class="invoices"><thead><tr><th>${esc(w('Date'))}</th><th>${esc(w('Amount'))}</th><th>${esc(w('Status'))}</th><th>${esc(w('For'))}</th></tr></thead><tbody>${cust.invoices.map((i) =>
    `<tr><td>${esc(shortDay(i.at, p.locale))}</td><td>${money(i.amount)}</td><td><span class="tag${i.status === 'open' ? ' bad' : ' good'}">${esc(w(i.status === 'paid' ? 'Paid' : 'Open'))}</span></td><td class="muted">${esc(i.what)}</td></tr>`).join('')}</tbody></table>`
    : `<p class="muted">${esc(w('No invoices yet.'))}</p>`}</section>
<section class="controls" aria-labelledby="test-h"><h2 class="h2" id="test-h">${esc(w('Test controls'))}</h2>
<p class="muted small">${esc(w('Not part of Stripe\'s portal: each sends the Remote the events Stripe would when it happens.'))}</p>
<div class="acts">${live ? `<form method="post" action="${pid}/test/fail"><button class="btn" type="submit">${esc(w('A payment fails'))}</button></form>
<form method="post" action="${pid}/test/paid"><button class="btn" type="submit">${esc(w('A payment goes through'))}</button></form>
<form method="post" action="${pid}/test/end"><button class="btn" type="submit">${esc(w('End it now'))}</button></form>` : `<p class="muted small">${esc(w('There is no subscription to act on.'))}</p>`}</div></section>`;
    return html(p.locale, `length3 · ${w('Billing')}`, page(portalHead(w, p), right));
  });

  // Changing tier: each tier, the one now marked; then what it costs now, and Confirm.
  app.get('/portal/:id/change', (c) => {
    const at = portalOf(c.req.param('id'));
    if (!at?.cust.sub || at.cust.sub.status === 'canceled') return gone('portal session', at?.p.locale, lang(c));
    const {p, cust, w} = at, s = cust.sub!;
    const right = `<h1 class="h">${esc(w('Update your plan'))}</h1><div class="tiers">${TIERS.map((t) => `<div class="tier${t === s.tier ? ' now' : ''}">
<p class="item-name">${esc(TIER_NAME[t])}</p><p class="price-line">${perMonth(w, COST[t])}</p><ul class="keeps">${keeps(t, w).slice(0, 2).map((k) => `<li>${esc(k)}</li>`).join('')}</ul>
${t === s.tier ? `<p class="tag">${esc(w('Current plan'))}</p>` : `<a class="btn" href="change/${t}" aria-label="${esc(w('Select {tier}', {tier: TIER_NAME[t]}))}">${esc(w('Select'))}</a>`}</div>`).join('')}</div>
<p><a class="link-back" href="../${esc(p.id)}">${esc(w('Go back'))}</a></p>`;
    return html(p.locale, `length3 · ${w('Update your plan')}`, page(portalHead(w, p), right));
  });
  app.get('/portal/:id/change/:tier', (c) => {
    const at = portalOf(c.req.param('id')), to = c.req.param('tier');
    if (!at?.cust.sub || at.cust.sub.status === 'canceled' || !isTier(to)) return gone('portal session', at?.p.locale, lang(c));
    const {p, cust, w} = at, s = cust.sub!;
    if (to === s.tier) return c.redirect(`${base}/dev-billing/portal/${p.id}`, 303);
    const left = Math.max(0, Math.min(1, (s.end - nowSecs()) / (s.end - s.start)));
    const owed = Math.round((COST[to] - COST[s.tier]) * left);
    // Come from the app for this one change, Go back returns there; from the portal's own list, to it.
    const away = p.change === to ? back(p.back) : `${base}/dev-billing/portal/${p.id}/change`;
    const right = `<h1 class="h">${esc(w('Confirm your updated plan'))}</h1>
<div class="change"><div class="plan-row"><div><p class="muted small">${esc(w('Current'))}</p><p class="item-name">${esc(TIER_NAME[s.tier])}</p><p class="price-line">${perMonth(w, COST[s.tier])}</p></div>
<span class="arrow" aria-hidden="true">&rarr;</span><div><p class="muted small">${esc(w('New'))}</p><p class="item-name">${esc(TIER_NAME[to])}</p><p class="price-line">${perMonth(w, COST[to])}</p></div></div>
<ul class="keeps">${keeps(to, w).map((k) => `<li>${esc(k)}</li>`).join('')}</ul>
<div class="sum total"><span>${esc(w(owed > 0 ? 'Amount due today' : 'Credited to your next invoice'))}</span><span>${money(Math.abs(owed))}</span></div>
<p class="muted small">${esc(owed > 0 ? w('Prorated for the rest of this period, charged to {card}.', {card: cust.card ? `${BRAND[cust.card.brand]} •••• ${cust.card.last4}` : w('your payment method')})
    : w('What is left of this period on the plan you have now is credited to your next invoice.'))}${p.locale === 'ja' ? '' : ' '}${esc(w('Then {price} per month from {day}.', {price: money(COST[to]), day: longDay(s.end, p.locale)}))}</p></div>
<form method="post" action="${esc(to)}"><button class="pay" type="submit">${esc(w('Confirm'))}</button></form>
<p><a class="link-back" href="${esc(away)}">${esc(w('Go back'))}</a></p>`;
    return html(p.locale, `length3 · ${w('Confirm your updated plan')}`, page(portalHead(w, p), right));
  });
  app.post('/portal/:id/change/:tier', async (c) => {
    const at = portalOf(c.req.param('id')), to = c.req.param('tier');
    if (!at?.cust.sub || at.cust.sub.status === 'canceled' || !isTier(to)) return gone('portal session', at?.p.locale, lang(c));
    const {p, cust} = at;
    if (to !== cust.sub!.tier) await changed(cust, to);
    // The change the app asked for goes back to it once done, as the portal's own flow does; one chosen here stays here.
    if (p.change === to) { p.change = null; save(); return c.redirect(back(p.back), 303); }
    return c.redirect(`${base}/dev-billing/portal/${p.id}?done=change`, 303);
  });

  app.get('/portal/:id/cancel', (c) => {
    const at = portalOf(c.req.param('id'));
    if (!at?.cust.sub || at.cust.sub.status === 'canceled') return gone('portal session', at?.p.locale, lang(c));
    const {p, cust, w} = at, s = cust.sub!;
    const until = w('Your subscription will be canceled, but is still available until the end of your billing period on {day}.', {day: '\u0000'}).split('\u0000');
    const right = `<h1 class="h">${esc(w('Cancel your plan'))}</h1>
<p>${esc(until[0])}<strong>${esc(longDay(s.end, p.locale))}</strong>${esc(until[1] ?? '')}</p>
<p class="muted">${esc(w('If you change your mind, you can renew your subscription before then.'))}</p>
<form method="post" action="cancel"><button class="pay danger" type="submit">${esc(w('Cancel plan'))}</button></form>
<p><a class="link-back" href="../${esc(p.id)}">${esc(w('Go back'))}</a></p>`;
    return html(p.locale, `length3 · ${w('Cancel your plan')}`, page(portalHead(w, p), right));
  });
  app.post('/portal/:id/cancel', async (c) => {
    const at = portalOf(c.req.param('id'));
    if (!at?.cust.sub || at.cust.sub.status === 'canceled') return gone('portal session', at?.p.locale, lang(c));
    const s = at.cust.sub!;
    if (!s.cancelAtEnd) { s.cancelAtEnd = true; save(); await send('customer.subscription.updated', subject(at.cust, s), {cancel_at_period_end: false}); }
    return c.redirect(`${base}/dev-billing/portal/${at.p.id}?done=cancel`, 303);
  });
  app.post('/portal/:id/renew', async (c) => {
    const at = portalOf(c.req.param('id'));
    if (!at?.cust.sub || at.cust.sub.status === 'canceled') return gone('portal session', at?.p.locale, lang(c));
    const s = at.cust.sub!;
    if (s.cancelAtEnd) { s.cancelAtEnd = false; save(); await send('customer.subscription.updated', subject(at.cust, s), {cancel_at_period_end: true}); }
    return c.redirect(`${base}/dev-billing/portal/${at.p.id}?done=renew`, 303);
  });

  app.get('/portal/:id/card', (c) => {
    const at = portalOf(c.req.param('id'));
    if (!at) return gone('portal session', undefined, lang(c));
    const {p, cust, w} = at;
    const error = c.req.query('declined') === '3ds' ? w(unauthenticated) : '';
    const label = w(cust.card ? 'Update' : 'Add');
    const right = `<h1 class="h">${esc(w(cust.card ? 'Update payment method' : 'Add payment method'))}</h1><form id="pay-form" novalidate>${cardFields(w, p.locale, null, error)}
<button class="pay" id="pay" type="submit"><span class="label">${esc(label)}</span></button></form>
<p><a class="link-back" href="../${esc(p.id)}">${esc(w('Go back'))}</a></p>${testCards(w)}`;
    return html(p.locale, `length3 · ${w('Payment method')}`, page(portalHead(w, p), right), FORM_JS('here', label, p.locale));
  });
  app.post('/portal/:id/card', async (c) => {
    const at = portalOf(c.req.param('id')), w = at?.w ?? sayIn();
    const no = (field: string, message: string, status: 402 | 410 = 402) => { const r = wrong(w, field, message, status); return c.json(r.body, r.status); };
    if (!at) return no('number', 'This session has expired.', 410);
    const {trouble, outcome, card, f} = await tried(c);
    if (trouble) return no(trouble.field, trouble.message);
    if (!f.name) return no('name', 'Your name is required.');
    if (outcome && 'message' in outcome) return no(outcome.field, outcome.message);
    if (outcome && 'secure' in outcome) {
      const a: Secure = {id: id('payatt'), card, for: {portal: at.p.id}};
      state.secure[a.id] = a;
      save();
      return c.json({next: `${base}/dev-billing/3ds/${a.id}`});
    }
    await carded(at.cust, card);
    return c.json({next: `${base}/dev-billing/portal/${at.p.id}?done=card`});
  });

  // Test controls: what happens to a subscription with time, now.
  app.post('/portal/:id/test/:what', async (c) => {
    const at = portalOf(c.req.param('id')), what = c.req.param('what');
    if (!at?.cust.sub || at.cust.sub.status === 'canceled') return gone('portal session', at?.p.locale, lang(c));
    const {p, cust} = at, s = cust.sub!;
    if (what === 'fail') {
      // The renewal's payment fails: an invoice left open, the subscription past due (Stripe retries meanwhile).
      const open = cust.invoices.find((i) => i.status === 'open') ?? invoice(cust, COST[s.tier], `${TIER_NAME[s.tier]} · ${shortDay(s.end, cust.locale)} – ${shortDay(s.end + MONTH, cust.locale)}`, 'open');
      s.status = 'past_due';
      save();
      await send('invoice.payment_failed', invoiceObject(cust, open, 'subscription_cycle'));
      await send('customer.subscription.updated', subject(cust, s), {status: 'active'});
    } else if (what === 'paid') {
      // A payment goes through: the one owed, if one is; else the next period, renewed.
      const open = cust.invoices.find((i) => i.status === 'open');
      const was = s.status;
      if (open) open.status = 'paid';
      else { s.start = s.end; s.end += MONTH; }
      const paid = open ?? invoice(cust, COST[s.tier], `${TIER_NAME[s.tier]} · ${shortDay(s.start, cust.locale)} – ${shortDay(s.end, cust.locale)}`);
      s.status = 'active';
      save();
      await send('invoice.paid', invoiceObject(cust, paid, 'subscription_cycle'));
      await send('customer.subscription.updated', subject(cust, s), {status: was});
    } else if (what === 'end') {
      s.status = 'canceled';
      s.endedAt = nowSecs();
      save();
      await send('customer.subscription.deleted', subject(cust, s));
    } else return c.text('nothing to do', 400);
    return c.redirect(`${base}/dev-billing/portal/${p.id}?done=${what}`, 303);
  });

  return {api, app, prices: DEV_PRICES};
}

/** The countries the form offers, each as English and Japanese name it; the first is the one chosen to begin with. */
const COUNTRIES: [string, string, string][] = [['US', 'United States', 'アメリカ合衆国'], ['JP', 'Japan', '日本'], ['GB', 'United Kingdom', 'イギリス'],
  ['CA', 'Canada', 'カナダ'], ['AU', 'Australia', 'オーストラリア'], ['DE', 'Germany', 'ドイツ'], ['FR', 'France', 'フランス'], ['NL', 'Netherlands', 'オランダ'],
  ['SE', 'Sweden', 'スウェーデン'], ['SG', 'Singapore', 'シンガポール'], ['KR', 'South Korea', '韓国'], ['BR', 'Brazil', 'ブラジル'], ['IN', 'India', 'インド']];

/**
 * Stripe's Checkout and portal as this Remote's Stripe is branded (README.md, Billing: the Dashboard's branding),
 * so what is seen here is what a person paying sees: the OS's paper behind what is bought, its ink on the button and
 * every ring and link, corners rounded, Inter. Chosen in mock rounds among what Stripe's branding lets be set.
 */
const LOOK = {background: '#f9f8f5', button: '#2c2a27', hover: '#45423e', font: 'Inter'};
/**
 * The business's icon, as Stripe shows the one uploaded to its branding beside the name: the app's own, read the first
 * time a page shows it. A Worker has no files to read it from (the production-like stack's, selftest/prod/worker.ts):
 * there, the name alone.
 */
/**
 * The price set as Home sets a person's name, in the app's display face (Inter Display Black, its Latin letters: the
 * app's own file, public/fonts), read the first time a page shows it; without the file (a Worker), the page's own
 * face at the same weight.
 */
let face: string | undefined;
const faceOf = () => {
  if (face === undefined) {
    try {
      const woff2 = readFileSync(new URL('../public/fonts/inter-display-black.woff2', import.meta.url)).toString('base64');
      face = `@font-face{font-family:"Inter Display";font-weight:900;font-style:normal;font-display:block;src:url(data:font/woff2;base64,${woff2}) format("woff2")}`;
    } catch { face = ''; }
  }
  return face;
};
let icon: string | null | undefined;
const iconOf = () => {
  if (icon === undefined) {
    try { icon = `data:image/png;base64,${readFileSync(new URL('../src-tauri/icons/128x128.png', import.meta.url)).toString('base64')}`; } catch { icon = null; }
  }
  return icon;
};

// Stripe's look, branded: a page in two columns (the paper behind what is bought), fields with a light edge, the ring and the button the brand's.
const CSS = `*{box-sizing:border-box}
html,body{margin:0;background:#fff}
body{font:14px/1.45 ${LOOK.font},-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,"Hiragino Sans","Noto Sans JP","Yu Gothic UI",Meiryo,sans-serif;color:#1a1a1a;-webkit-font-smoothing:antialiased}
html[lang=ja] body{line-height:1.6;word-break:auto-phrase}
html[lang=ja] .price small{line-height:1.2}
p{margin:0}
.page{display:grid;grid-template-columns:1fr 1fr;min-height:100vh}
.side{display:flex;justify-content:flex-end;padding:56px 64px 32px;background:${LOOK.background}}
.main{display:flex;justify-content:flex-start;padding:56px 64px 32px;box-shadow:-16px 0 32px -18px rgba(0,0,0,.18)}
.col{width:100%;max-width:400px}
.head{display:flex;align-items:center;gap:12px;margin-bottom:36px}
.back{display:inline-flex;align-items:center;gap:8px;color:#1a1a1a;text-decoration:none;font-weight:500;border-radius:6px;padding:2px 4px;margin-left:-4px}
.back:hover{background:#f2f2f2}
.logo{display:block;width:28px;height:28px;border-radius:50%;object-fit:cover}
.badge{display:inline-block;background:#ffde92;color:#bb5504;font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;padding:2px 6px;border-radius:4px}
.what{color:#6d6e78;font-size:16px;font-weight:500;margin-bottom:4px}
.price{display:flex;align-items:flex-end;gap:12px;font:900 72px/.88 "Inter Display",${LOOK.font},sans-serif;letter-spacing:-.045em;margin:6px 0 36px}
.price small{font:500 14px/1.15 ${LOOK.font},sans-serif;color:#6d6e78;letter-spacing:0;padding-bottom:7px}
.price.held{font-size:48px;margin:4px 0 12px}
.price.held small{padding-bottom:4px}
.items .item{display:flex;justify-content:space-between;gap:16px;padding-bottom:12px;font-weight:500}
.item-name{font-weight:600;font-size:15px}
.muted{color:#6d6e78}.small{font-size:12px}
.keeps{margin:4px 0 20px;padding:0 0 0 18px;color:#6d6e78}
.keeps li+li{margin-top:2px}
.sum{display:flex;justify-content:space-between;padding:12px 0;border-top:1px solid #e6e6e6;font-weight:500}
.sum.total{font-weight:600}
.h{font-size:20px;font-weight:600;margin:0 0 20px}
.h2{font-size:16px;font-weight:600;margin:0 0 10px}
.row{margin:0 0 16px;border:0;padding:0;min-width:0}
legend,label{display:block;font-size:13px;font-weight:500;color:#30313d;margin:0 0 6px;padding:0}
.field{display:block;width:100%;height:44px;padding:10px 12px;border:1px solid #e0e0e0;border-radius:6px;background:#fff;font:inherit;font-size:16px;color:#30313d;
  box-shadow:0 1px 1px rgba(0,0,0,.03),0 3px 6px rgba(0,0,0,.02);outline:none;transition:box-shadow .15s,border-color .15s}
.field::placeholder{color:#a3a3a8}
.field:focus{position:relative;z-index:1;border-color:${LOOK.button}80;box-shadow:0 1px 1px rgba(0,0,0,.03),0 3px 6px rgba(0,0,0,.02),0 0 0 3px ${LOOK.button}33}
.field.bad{border-color:#df1b41;color:#df1b41}
select.field{appearance:auto}
.group .field{border-radius:0;box-shadow:none}
.group .num .field{border-radius:6px 6px 0 0}
.group .pair{display:grid;grid-template-columns:1fr 1fr}
.group .pair .field{margin-top:-1px}
.group .pair .field:first-child{border-radius:0 0 0 6px}
.group .pair .field:last-child{border-radius:0 0 6px 0;margin-left:-1px}
.num{position:relative}
.num .field{padding-right:120px}
.brands{position:absolute;right:10px;top:50%;transform:translateY(-50%);display:flex;gap:4px;z-index:2;pointer-events:none}
.b{font-size:9px;font-weight:800;letter-spacing:.02em;padding:3px 4px;border-radius:3px;border:1px solid #e0e0e0;color:#6d6e78;background:#fff}
.brands[data-brand] .b{opacity:.25}
.brands[data-brand="visa"] .visa,.brands[data-brand="mastercard"] .mc,.brands[data-brand="amex"] .amex{opacity:1;color:#1a1a1a;border-color:#1a1a1a}
.err{color:#df1b41;font-size:13px;margin-top:6px}
.err:empty{display:none}
.pay{display:flex;align-items:center;justify-content:center;width:100%;height:44px;margin-top:20px;border:0;border-radius:6px;background:${LOOK.button};color:#fff;
  font:inherit;font-size:16px;font-weight:600;cursor:pointer;text-decoration:none;box-shadow:inset 0 0 0 1px rgba(50,50,93,.1),0 2px 5px rgba(50,50,93,.1),0 1px 1px rgba(0,0,0,.07)}
.pay:hover{background:${LOOK.hover}}
.pay:focus-visible{outline:none;box-shadow:0 0 0 3px ${LOOK.button}59}
.pay:disabled{cursor:default;opacity:.75}
.pay.narrow{width:auto;padding:0 28px;margin:0}
.pay.danger{background:#df1b41}
.pay.danger:hover{background:#c0123a}
.pay .spin{width:18px;height:18px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.pay .spin{animation:none}}
.fine{margin-top:14px;color:#6d6e78;font-size:12px;text-align:center}
.standin{margin-top:28px;color:#8a8a91;font-size:12px}
.tests{margin-top:20px;color:#6d6e78;font-size:13px}
.tests summary{cursor:pointer}
.tests ul{margin:8px 0 0;padding-left:18px}
code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#30313d}
section{padding:0 0 24px;margin:0 0 24px;border-bottom:1px solid #e6e6e6}
section:last-child{border-bottom:0}
.plan-row{display:flex;align-items:center;gap:20px;margin-bottom:8px}
.price-line{color:#30313d}
.acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.acts form{margin:0}
.btn{display:inline-flex;align-items:center;height:34px;padding:0 14px;border:1px solid #e0e0e0;border-radius:6px;background:#fff;color:#1a1a1a;font:inherit;font-weight:500;
  text-decoration:none;cursor:pointer;box-shadow:0 1px 1px rgba(0,0,0,.03)}
.btn:hover{background:#f7f7f7}
.btn:focus-visible,.link-back:focus-visible,.back:focus-visible,.plain:focus-visible{outline:2px solid ${LOOK.button};outline-offset:2px}
.tag{display:inline-block;font-size:12px;font-weight:600;padding:1px 6px;border-radius:4px;background:#ebeef1;color:#414552;white-space:nowrap}
.tag.good{background:#d7f7c2;color:#05690d}.tag.bad{background:#ffe7f2;color:#b3093c}
.banner{margin:0 0 20px;padding:10px 12px;border-radius:6px;background:#ebf5ff;color:#0055bc}
.invoices{width:100%;border-collapse:collapse}
.invoices th{text-align:left;font-size:12px;font-weight:500;color:#6d6e78;padding:0 8px 6px 0}
.invoices td{padding:8px 8px 8px 0;border-top:1px solid #f0f0f0;vertical-align:top}
.invoices th,.invoices td:not(.muted){white-space:nowrap}
.main p+p.muted{margin-top:8px}
.controls{border:1px dashed #c4a000;border-radius:8px;padding:16px;background:#fffbea}
.tiers{display:grid;gap:12px;margin-bottom:20px}
.tier{border:1px solid #e0e0e0;border-radius:8px;padding:14px 16px;display:grid;gap:2px}
.tier.now{border-color:${LOOK.button};box-shadow:0 0 0 1px ${LOOK.button}}
.tier .keeps{margin:6px 0 10px}
.tier .btn,.tier .tag{justify-self:start}
.change{border:1px solid #e0e0e0;border-radius:8px;padding:16px;margin-bottom:8px}
.arrow{font-size:20px;color:#6d6e78}
.link-back{display:inline-block;margin-top:16px;color:${LOOK.button};text-decoration:none;font-weight:500}
.link{text-align:center}
.plain{height:44px;padding:0 20px;border:1px solid #e0e0e0;border-radius:6px;background:#fff;font:inherit;font-size:15px;font-weight:600;cursor:pointer}
.secure{display:grid;place-items:center;min-height:100vh;padding:24px;background:#f6f8fa}
.secure-box{width:min(420px,100%);background:#fff;border:1px solid #e3e8ee;border-radius:10px;padding:24px;box-shadow:0 15px 35px rgba(50,50,93,.1),0 5px 15px rgba(0,0,0,.07)}
.secure-box .badge{margin-bottom:12px}
.facts{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:16px 0 24px}
.facts dt{color:#6d6e78}.facts dd{margin:0;font-weight:500}
.secure-foot{display:flex;justify-content:space-between;gap:12px}
.secure-foot form{margin:0}
@media (max-width:880px){
  .page{grid-template-columns:1fr}
  .side,.main{justify-content:center;padding:24px 16px}
  .main{box-shadow:none;border-top:1px solid #e6e6e6}
  .price{margin-bottom:16px}
}`;

/** What the card form's script says, each in the page's language. */
const FORM_WORDS = ['Your card number is incomplete.', 'Your card number is invalid.', 'Your card\'s expiration date is incomplete.', 'Your card\'s expiration date is invalid.',
  'Your card\'s expiration year is in the past.', 'Your card\'s expiration date is in the past.', 'Your card\'s security code is incomplete.',
  'Your email address is invalid.', 'Your email is incomplete.', 'Your name is required.', 'Something went wrong. Try again.', 'Processing'];

/**
 * The card form's own script, the same in Checkout and the portal: the number in groups as it is typed (4-6-5 for
 * American Express), the expiry as MM / YY, each field checked as Stripe's are (Luhn, an expiry to come, a CVC),
 * what is wrong said under it, and the card tried by a POST to `at` (the page's own path, or that and /pay), whose
 * answer says what is wrong or where to go on. `label` is the button's word, back once the answer is said; what it
 * says is in `locale`.
 */
const FORM_JS = (at: 'pay' | 'here', label: string, locale?: Locale) => `(() => {
const W = ${JSON.stringify(Object.fromEntries(FORM_WORDS.map((en) => [en, sayIn(locale)(en)])))};
const $ = (id) => document.getElementById(id);
const form = $('pay-form'), number = $('number'), exp = $('exp'), cvc = $('cvc'), email = $('email'), name = $('name'), pay = $('pay'), brand = $('brand');
const cardErr = $('card-err'), group = [number, exp, cvc];
const digits = (s) => s.replace(/\\D/g, '');
const brandOf = (n) => /^3[47]/.test(n) ? 'amex' : /^(5[1-5]|2(2[2-9]|[3-6]\\d|7[01]|720))/.test(n) ? 'mastercard' : /^4/.test(n) ? 'visa' : /^6(011|5)/.test(n) ? 'discover' : '';
const amex = () => brandOf(digits(number.value)) === 'amex';
const luhn = (n) => { let s = 0, t = false; for (let i = n.length - 1; i >= 0; i--) { let d = +n[i]; if (t) { d *= 2; if (d > 9) d -= 9; } s += d; t = !t; } return n.length > 0 && s % 10 === 0; };
const groups = (n) => { const out = []; let i = 0; for (const g of brandOf(n) === 'amex' ? [4, 6, 5] : [4, 4, 4, 4]) { if (i >= n.length) break; out.push(n.slice(i, i + g)); i += g; } return out.join(' '); };
const errOf = (el) => (el === email ? $('email-err') : el === name ? $('name-err') : cardErr);
const say = (el, message) => { el.classList.add('bad'); el.setAttribute('aria-invalid', 'true'); errOf(el).textContent = message; };
const clear = (el) => {
  el.classList.remove('bad'); el.removeAttribute('aria-invalid');
  if (!group.includes(el)) errOf(el).textContent = '';
  else if (!group.some((f) => f.classList.contains('bad'))) cardErr.textContent = '';
};
// Shaped as it is typed, the caret kept after the same digit it was after.
const shaping = (el, shape) => el.addEventListener('input', () => {
  const before = digits(el.value.slice(0, el.selectionStart ?? el.value.length)).length;
  el.value = shape(digits(el.value));
  let seen = 0, i = 0;
  while (i < el.value.length && seen < before) { if (/\\d/.test(el.value[i])) seen++; i++; }
  el.setSelectionRange(i, i);
  clear(el);
});
shaping(number, (n) => { const b = brandOf(n); if (b) brand.dataset.brand = b; else delete brand.dataset.brand; return groups(n.slice(0, b === 'amex' ? 15 : 16)); });
shaping(exp, (n) => { if (n.length === 1 && n > '1') n = '0' + n; n = n.slice(0, 4); return n.length > 2 ? n.slice(0, 2) + ' / ' + n.slice(2) : n; });
shaping(cvc, (n) => n.slice(0, amex() ? 4 : 3));
const card = () => {
  const n = digits(number.value);
  if (n.length < (amex() ? 15 : 16)) return [number, W['Your card number is incomplete.']];
  if (!luhn(n)) return [number, W['Your card number is invalid.']];
  const e = /^(\\d{2}) \\/ (\\d{2})$/.exec(exp.value), now = new Date();
  if (!e) return [exp, W["Your card's expiration date is incomplete."]];
  const m = +e[1], y = 2000 + +e[2];
  if (m < 1 || m > 12) return [exp, W["Your card's expiration date is invalid."]];
  if (y < now.getFullYear()) return [exp, W["Your card's expiration year is in the past."]];
  if (y === now.getFullYear() && m < now.getMonth() + 1) return [exp, W["Your card's expiration date is in the past."]];
  if (digits(cvc.value).length < (amex() ? 4 : 3)) return [cvc, W["Your card's security code is incomplete."]];
  return null;
};
const wrong = () => {
  const out = [];
  if (email && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email.value.trim())) out.push([email, email.value.trim() ? W['Your email address is invalid.'] : W['Your email is incomplete.']]);
  const c = card();
  if (c) out.push(c);
  if (!name.value.trim()) out.push([name, W['Your name is required.']]);
  return out;
};
// Left with something in it, a field of the card is checked as Stripe's are; a field left empty is said on paying.
for (const el of group) el.addEventListener('blur', () => { if (!digits(el.value)) return; const c = card(); if (c && c[0] === el) say(el, c[1]); });
// Come back from 3-D Secure that failed: said under the card already.
if (cardErr.textContent) number.classList.add('bad');
const busy = (on) => {
  pay.disabled = on;
  const s = document.createElement('span');
  if (on) { s.className = 'spin'; s.setAttribute('role', 'status'); s.setAttribute('aria-label', W['Processing']); } else { s.className = 'label'; s.textContent = ${JSON.stringify(label)}; }
  pay.replaceChildren(s);
};
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  for (const el of [email, name, ...group]) if (el) clear(el);
  const w = wrong();
  if (w.length) { for (const [el, m] of w) say(el, m); w[0][0].focus(); return; }
  busy(true);
  try {
    const r = await fetch(location.pathname${at === 'pay' ? ` + '/pay'` : ''}, {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({email: email ? email.value : '', number: number.value, exp: exp.value, cvc: cvc.value, name: name.value, country: $('country').value})});
    const a = await r.json();
    if (a.next) { location.assign(a.next); return; }
    const field = ({email, number, exp, cvc, name})[a.wrong && a.wrong.field] || number;
    say(field, (a.wrong && a.wrong.message) || W['Something went wrong. Try again.']);
    field.focus();
  } catch { say(number, W['Something went wrong. Try again.']); }
  busy(false);
});
})();`;
