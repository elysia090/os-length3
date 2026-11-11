// The way to Remote's Plan from a place the plan refused or limits (New repo, Inbox, Server): what is paid, what
// happens to the work, and a button to the Plan (pages/remote/plan.ts is the Plan itself).

import {h} from '../../ui/dom.ts';
import {t} from '../../i18n/i18n.ts';
import {planRefusal, refusalWords, type PlanRefusal} from '../../remote/plan.ts';
import {choosePart} from './common.ts';
import type {Context} from './context.ts';

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
  const to = h('button', {type: 'button', class: 'button small-button'}, t('View plan')) as HTMLButtonElement;
  to.addEventListener('click', go);
  return h('span', {class: 'plan-refused'}, h('span', {}, refusalWords(r)), to);
}
