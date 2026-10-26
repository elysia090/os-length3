import {day, h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {RemoteError} from '../../remote/connection.ts';
import * as servers from '../../remote/servers.ts';
import {nudge} from '../../ui/glide.ts';
import {mark as todoMark} from '../todo-list.ts';
import {deed} from '../common.ts';
import {planRefused} from '../remote/plan.ts';
import {errorText} from '../../app/errors.ts';
import {button, type Here, type Writer} from './parts.ts';

// No server chosen (or none yet): it is named where it will stand. Its chip is the field, in the band after the
// others, and under it the server it will be stands faint: its first board (#general, its TODO and its talk) and,
// at the right, its first person, oneself. Made (Enter, or Make), the same shapes stand there whole. Its name on
// this Remote follows the name, quiet, in the chip; what that name is, and what the plan allows, is said only when
// the Remote says no.

/**
 * What is half written in the name of the server being made: its name, and its own address if written. Kept while the
 * app runs as the box's words are; put away with Escape or by going elsewhere, Server opens with it as it was; made,
 * it is gone.
 */
let draft: [string, string] = ['', ''];

/** What making a server needs of the view it is in. */
interface MakingWays {
  writer: Writer;
  /** The chip being named, put in the band where the server will stand. */
  naming(chip: HTMLElement): void;
  /** Made: it is shown. */
  made(s: servers.Server): void;
  /** One removed or left before, brought back: the servers read again, and it shown. */
  broughtBack(id: string): Promise<void>;
  /** Asked for more than the plan allows: away to the plan. */
  plan(): void;
  /** Asked for one's own name first: away to the Inbox, where it is claimed. */
  inbox(): void;
}

/** A name as a name on this Remote can be: Trip is trip. */
const slug = (v: string) => v.toLowerCase().normalize('NFKD').replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 31);

/**
 * The server being made: its chip, put in the band (`naming`), and the faint server under it, for the view to stand
 * in their places: its board's two slides and the box at the foot. Its name's field is returned to take the keyboard.
 */
export function nameServer(here: Here, ways: MakingWays): {name: HTMLInputElement; slides: HTMLElement[]; dock: HTMLElement} {
  const {name, handle, label, fit, reveal} = fields();
  const make = button(t('Make'), 'small-button primary');
  // What the Remote said no to, at the chip's end: the plan, a name taken, a name of one's own to claim first.
  const ask = h('span', {class: 'server-ask', role: 'alert'});
  const chip = h('span', {class: 'server-making'}, label, make, ask);
  // Its people, as the box at the foot will say them: by the name being written.
  const people = h('span', {}, name.value.trim() || t('Trip'));
  // Named, its chip is drawn whole (solid, in ink) rather than dashed as a place for one.
  name.addEventListener('input', () => {
    label.classList.toggle('named', !!name.value.trim());
    people.textContent = name.value.trim() || t('Trip');
  });
  ways.naming(chip);
  fit();
  label.classList.toggle('named', !!name.value.trim());
  ways.writer(name, () => document.activeElement === name || document.activeElement === handle || !!name.value.trim());
  const done = async () => {
    // Enter pressed again while it is made makes no second server.
    if (!name.value.trim() || make.disabled) { name.focus(); return; }
    make.disabled = true;
    ask.replaceChildren();
    try {
      const s = await servers.makeServer(name.value, handle.value);
      draft = ['', ''];
      ways.made(s);
    } catch (e) {
      make.disabled = false;
      refused(e, ask, here, reveal, ways);
    }
  };
  make.addEventListener('click', () => void done());
  for (const f of [name, handle]) f.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void done(); } });
  return {name, slides: ghostBoard(heldServers(ways)), dock: ghostDock(people)};
}

/**
 * The chip's fields, as they were left (`draft`): its name, and its name on this Remote, which follows the name until
 * it is written itself. `reveal` shows that address, to be written otherwise.
 */
function fields() {
  const name = h('input', {class: 'server-name-in', maxlength: '64', placeholder: t('Trip'), 'aria-label': t('Name')}) as HTMLInputElement;
  const handle = h('input', {class: 'server-handle-in mono', maxlength: '31', placeholder: 'trip', autocapitalize: 'off', spellcheck: 'false',
    'aria-label': t('Name on this Remote'),
    title: t('First come, as a person\'s: nobody else\'s while the server has it, renewed by its owner every five years.')}) as HTMLInputElement;
  // Its address follows its name until it is written itself.
  let own = false;
  const fit = fitting(name, handle);
  // Its name on this Remote follows its name unseen (Trip is trip): the chip says one name, not two. The quiet @
  // after it shows the address to write it otherwise, and it shows itself when the one it would be is taken.
  const at = h('button', {type: 'button', class: 'server-at', 'aria-label': t('Name on this Remote'), title: t('Name on this Remote')}, '@') as HTMLButtonElement;
  const address = h('span', {class: 'server-address', hidden: ''}, h('span', {class: 'muted', 'aria-hidden': 'true'}, '@'), handle);
  const reveal = () => { at.hidden = true; address.hidden = false; fit(); handle.focus(); handle.select(); };
  at.addEventListener('click', reveal);
  const keep = () => { draft = name.value || own ? [name.value, own ? handle.value : ''] : ['', '']; };
  name.addEventListener('input', () => { if (!own) handle.value = slug(name.value); fit(); keep(); });
  handle.addEventListener('input', () => { own = handle.value !== ''; fit(); keep(); });
  // Half written before, it is as it was left.
  const [was, wasAt] = draft;
  if (was || wasAt) {
    name.value = was;
    handle.value = wasAt || slug(was);
    own = !!wasAt;
    if (own) { at.hidden = true; address.hidden = false; }
  }
  return {name, handle, label: h('label', {class: 'chip server-naming'}, name, at, address), fit, reveal};
}

/** Each field as wide as what is written in it (or its placeholder), as a chip is. */
function fitting(...fields: HTMLInputElement[]): () => void {
  const pen = document.createElement('canvas').getContext('2d');
  const wide = (f: HTMLInputElement) => {
    if (!pen || !f.isConnected) return;
    pen.font = getComputedStyle(f).font;
    f.style.width = `${Math.ceil(pen.measureText(f.value || f.placeholder).width) + 2}px`;
  };
  return () => { for (const f of fields) wide(f); };
}

/** What the Remote said no to, said at the chip's end (`ask`): the plan, a name taken, a name of one's own to claim first. */
function refused(e: unknown, ask: HTMLElement, here: Here, reveal: () => void, ways: MakingWays) {
  const plan = planRefused(e, () => ways.plan());
  if (plan) ask.replaceChildren(plan);
  // Told apart by what the Remote said in its own words (service/servers.ts), not by the words shown here.
  else if (e instanceof RemoteError && (e.status === 409 ? e.detail.error !== 'Claim a name first'
    : e.status === 400 && /^(Its name|Only on a domain)/.test(String(e.detail.error)))) {
    // The name on this Remote is someone else's (or held for them), or one it cannot be (a name in other
    // letters follows to nothing): the address shows, to be written otherwise.
    reveal();
    ask.textContent = errorText(e);
    nudge(here.naming?.querySelector('.server-naming') ?? null);
  } else if (e instanceof RemoteError && e.status === 409) {
    const inbox = button(t('Go to Inbox'), 'small-button');
    inbox.addEventListener('click', () => ways.inbox());
    ask.replaceChildren(t('A server needs your name. Claim one in Inbox.'), ' ', inbox);
  } else ask.textContent = errorText(e);
}

/** What one removed or left last, still held: brought back with its name and boards, from under the board. */
function heldServers(ways: MakingWays): HTMLElement {
  const back = h('div', {class: 'server-back'});
  void servers.goneServers().then((held) => back.replaceChildren(...held.map((g) => {
    const b = button(t('Bring back {name}', {name: g.name}), 'small-button');
    b.title = t('Held until {date}', {date: day(g.until)});
    deed(b, async () => { await servers.bringBack(g.id); await ways.broughtBack(g.id); });
    return b;
  })), (e) => back.replaceChildren(h('p', {class: 'error small'}, errorText(e))));
  return back;
}

/**
 * The server it will be, faint: its first board as it will open, of the same parts a made one is (its TODO's first
 * line and its talk's foot in their own words, each where it will stand), with what is held under it (`back`).
 */
function ghostBoard(back: HTMLElement): HTMLElement[] {
  return [h('div', {class: 'slide', 'aria-current': 'true'}, h('div', {class: 'board-card board-ghost', 'aria-hidden': 'true'},
    h('div', {class: 'board-head'}, h('span', {class: 'muted board-mark'}, '#'), h('h2', {}, 'general')),
    h('section', {class: 'board-todo'}, h('div', {class: 'board-todo-head'}, h('span', {}, 'TODO')),
      h('div', {class: 'todo-box'}, h('div', {class: 'todo-items'}, h('div', {class: 'todo-item'}, h('div', {class: 'todo-head'},
        h('span', {class: 'todo-mark'}, todoMark(false)), h('span', {class: 'todo-kind', hidden: ''}),
        h('span', {class: 'todo-title'}, t('Something to do together'))))))),
    h('div', {class: 'board-talk'}, h('div', {class: 'timeline tl-empty'}, h('div', {class: 'tl-start muted small'}, t('No posts yet'))))), back),
  // Beside it, the edge of the box that will make its next board, where it will be.
  h('div', {class: 'slide', 'aria-current': 'false'}, h('div', {class: 'board-card board-ghost ghost-next', 'aria-hidden': 'true'}, h('span', {class: 'board-head'}, '+')))];
}

/** Under it, the box that will write to its people, saying them by the name being written (`people`). */
function ghostDock(people: HTMLElement): HTMLElement {
  // The box's own words, with the name being written where they put it (before it in Japanese, after in English).
  const [before, after] = t('To the people of {server}', {server: '\u0000'}).split('\u0000');
  return h('div', {class: 'prompt ghost-dock', 'aria-hidden': 'true'}, h('span', {}, before, people, after));
}
