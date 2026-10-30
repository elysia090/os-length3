import {addToBand, moveTo, offBand, parseBand} from '../../home/band.ts';
import {getState, setState} from '../../home/state.ts';
import {t} from '../../i18n.ts';
import {arrowKeys, h} from '../../ui/dom.ts';
import {mark} from '../../ui/icons.ts';
import {glide, LAND, paced, still, where} from '../../ui/glide.ts';
import {bring, remoteOnly} from '../../remote/lifecycle.ts';
import {work as workOn} from '../../repos/history.ts';
import {repoOf, type Row} from './columns.ts';
import type {Drag} from './drag.ts';

// The band: ⊕ first, then the repos out to work on, each a pill that comes
// off with its ×. One press of ⊕ brings every repo not on the band out at
// once; this is not adding tabs one by one, and what comes and goes is to
// its right, so ⊕ stays where it was pressed however many come out (the
// pills scroll after it). With no pill left the center says how to bring one out.

/** What the band asks of the page it heads. */
interface BandWays {
  /** A pill pressed: its repo is worked on in the box worked on. */
  show(name: string): void;
  /** Pressed with Ctrl (⌘): it opens beside (as a link opens in a new tab). */
  beside(name: string): void;
  /** Its × (or the middle button): off the band. */
  takeOff(name: string): void;
  /** The first button (`at`): the deeds for the file read now (or the repo itself), out under it. */
  act(at: HTMLElement): void;
}

/** The band on Forge's top line, over the `row` it says the repos of. */
export class Band {
  /** The repos on the band, left to right. */
  names: string[] = [];
  /** Every repo here. */
  all: string[] = [];
  private pills = h('div', {class: 'pills'});
  private add = h('button', {type: 'button', class: 'band-add', 'aria-label': t('Bring every repo out to the band')}, mark('plus')) as HTMLButtonElement;
  // First on the band, what can be done to the file read now (or the repo itself): File's menu for it, out of the
  // tree at its row (New file, New folder, Rename, Delete, as each allows); ⊕ after the pills (issue #49).
  private acts = h('button', {type: 'button', class: 'band-add band-acts', 'aria-label': t('Files: new, rename, delete'),
    title: t('Files: new, rename, delete')}, mark('files')) as HTMLButtonElement;
  private caret = h('span', {class: 'band-caret', 'aria-hidden': 'true'});
  /**
   * The issue each repo on the band is worked on for (#n), while its copy is an issue's rather than main: Start in Git
   * turns the repo's files into the issue's, and its pill says so, so what is written here is seen to be for it.
   */
  private onIssue = new Map<string, string>();
  /** The band as last drawn: which pills, and which is worked on or open beside. */
  private painted = '';
  /** Not read from what is kept yet: the band is, the first time the repos here are known. */
  private first = true;
  private row: Row;
  private drag: Drag;
  private ways: BandWays;

  /** The band is drawn in `strip`; a pill is dragged with `drag`. */
  constructor(strip: HTMLElement, row: Row, drag: Drag, ways: BandWays) {
    this.row = row; this.drag = drag; this.ways = ways;
    arrowKeys(this.pills, '.pill-name');
    this.acts.addEventListener('click', () => ways.act(this.acts));
    strip.append(this.acts, this.pills, this.add);
    this.add.addEventListener('click', () => void this.bringOut());
    this.along();
  }

  /**
   * The repos here are `all` now: the band as it was kept (the first time; never kept, `chosen` starts it) or as it
   * stands, of those still here.
   */
  known(all: string[], chosen: string | null) {
    this.all = all;
    this.names = parseBand(this.first ? getState('band') : JSON.stringify(this.names), all, chosen);
    this.first = false;
    this.readIssues();
  }

  /** `name` on the band (at its end, unless it is there already), and the band kept. */
  put(name: string) {
    this.names = addToBand(this.names, name);
    this.save();
  }

  save() { void setState('band', JSON.stringify(this.names)).catch(() => { /* the band is a convenience */ }); }

  /** Every repo: here, and only on the Remote (fetched when it comes out, as opening one from Home does). */
  private every() { return [...this.all, ...remoteOnly().map((r) => r.name).filter((n) => !this.all.includes(n))]; }

  /** ⊕ pressed: every repo not on the band comes out to it at once, those only on the Remote fetched first. */
  private async bringOut() {
    const {add} = this;
    const rest = offBand(this.names, this.every());
    if (!rest.length) return;
    // Held down while repos come from the Remote, ⊕ loses the keyboard; it is given back below.
    const pressed = document.activeElement === add;
    add.disabled = true;
    try {
      for (const name of rest.filter((n) => !this.all.includes(n))) { await bring(name); this.all = [...this.all, name]; }
    } catch (e) { add.disabled = false; add.title = e instanceof Error ? e.message : String(e); if (pressed) add.focus(); return; }
    for (const name of rest) this.names = addToBand(this.names, name);
    this.save();
    if (this.row.repo) this.paint(); else this.ways.show(rest[0]);
    // Nothing left to bring out, ⊕ steps back; the keyboard that pressed it goes to the first repo it brought.
    if (pressed) (add.disabled ? this.pills.querySelector<HTMLElement>(`.pill[data-repo="${CSS.escape(rest[0])}"] .pill-name`) : add)?.focus();
  }

  /** Which issue each repo on the band is worked on for, read again; a pill whose issue changed is drawn so. */
  private readIssues() {
    for (const name of this.names) {
      void workOn(name).then((w) => {
        const n = w.issue?.match(/(\d+)/)?.[1];
        const was = this.onIssue.get(name);
        if (n) this.onIssue.set(name, `#${Number(n)}`); else this.onIssue.delete(name);
        if (was !== this.onIssue.get(name)) this.paint();
      }, () => {});
    }
  }

  /** `name` in the row: in the box worked on ('on'), open beside ('beside'), or not out (''). */
  private stand(name: string) {
    const {repo, shown} = this.row;
    return repo && name === repoOf(repo) ? 'on' : shown.some((k) => repoOf(k) === name) ? 'beside' : '';
  }

  /** The band drawn as the row stands: which pills, and which is worked on or open beside. */
  paint() {
    const {pills} = this;
    this.acts.disabled = this.row.repo === null;
    // Asked again as it already is (one deed can ask twice: the box chosen, then the box shown), it is left as it
    // is: drawn anew, its pills would be new ones, and the ink on its way between two would stop where it was.
    const state = this.names.map((name) => `${name}${this.onIssue.get(name) ?? ''}:${this.stand(name)}`).join('|');
    if (state === this.painted && pills.querySelectorAll('.pill').length === this.names.length) { this.paintAdd(); return; }
    this.painted = state;
    const was = new Map([...pills.querySelectorAll<HTMLElement>('.pill')].map((p) => [p.dataset.repo!, p.getBoundingClientRect()]));
    const inkWas = where(pills.querySelector('.pill[aria-current]'));
    pills.replaceChildren(...this.names.map((name) => this.pill(name)));
    if (!still()) this.moved(was);
    glide(inkWas, pills.querySelector<HTMLElement>('.pill[aria-current]'), pills, 'var(--r-round)');
    this.paintAdd();
  }

  /** One repo's pill: pressed, it is worked on in the box worked on; with Ctrl (⌘), it opens beside. */
  private pill(name: string): HTMLElement {
    const issue = this.onIssue.get(name);
    const open = h('button', {type: 'button', class: 'pill-name', title: issue ? t('On {issue}: what is written here is for it', {issue}) : t('Ctrl+click: open beside')},
      name, issue ? h('span', {class: 'pill-issue', 'aria-hidden': 'true'}, issue) : null);
    const go = (event: MouseEvent) => { if (event.ctrlKey || event.metaKey) this.ways.beside(name); else this.ways.show(name); };
    open.addEventListener('click', go);
    const close = h('button', {type: 'button', class: 'pill-close', 'aria-label': t('Take {name} off the band', {name})}, mark('close'));
    // Taken off, the keyboard is not left on nothing: it goes to the pill now worked on (or the next), on the band.
    close.addEventListener('click', () => {
      this.ways.takeOff(name);
      (this.pills.querySelector<HTMLElement>('.pill[aria-current] .pill-name') ?? this.pills.querySelector<HTMLElement>('.pill-name'))?.focus({preventScroll: true});
    });
    const pill = h('span', {class: 'pill', 'data-repo': name, draggable: 'true'}, open, close);
    // It is one thing to press: on its edge, round the name, it goes as on the name (the × aside).
    pill.addEventListener('click', (event) => { if (event.target === pill) go(event); });
    // The middle button takes it off, as it closes a tab.
    pill.addEventListener('auxclick', (event) => { if (event.button === 1) { event.preventDefault(); this.ways.takeOff(name); } });
    this.drag.from(pill, name, true);
    // The pill shows it (ink); its button says it, which is what is heard. Beside it, its outline in ink.
    const stands = this.stand(name);
    if (stands === 'on') { pill.setAttribute('aria-current', 'page'); open.setAttribute('aria-current', 'page'); }
    else if (stands === 'beside') pill.classList.add('beside');
    return pill;
  }

  /**
   * What moved along the band glides to where it is now (from `was`, where each pill stood); the ink goes from the pill
   * it was on to the one it is on. What is new on a band that was there (brought out with ⊕, made, opened) comes out
   * of the ⊕ at its end, one after another, as from where it was kept.
   */
  private moved(was: Map<string, DOMRect>) {
    let came = 0;
    for (const p of this.pills.querySelectorAll<HTMLElement>('.pill')) {
      const from = was.get(p.dataset.repo!), to = p.getBoundingClientRect();
      if (from && Math.abs(from.left - to.left) > 1) p.animate([{transform: `translateX(${from.left - to.left}px)`}, {transform: 'none'}], {duration: paced(240), easing: LAND});
      else if (!from && was.size) p.animate([{transform: 'translateX(24px)', opacity: 0}, {transform: 'none', opacity: 1}],
        {duration: paced(300), delay: paced(came++ * 60), easing: LAND, fill: 'backwards'});
    }
  }

  /** ⊕, by how many repos are not on the band yet. */
  paintAdd() {
    const rest = offBand(this.names, this.every()).length;
    this.add.disabled = rest === 0;
    this.add.title = rest ? t('Bring every repo out to the band ({n} more)', {n: rest}) : t('Every repo is on the band');
  }

  /** Where along the band a pill let go at x lands: the index of the pill it goes before. */
  private slot(x: number) {
    const ps = [...this.pills.querySelectorAll<HTMLElement>('.pill')];
    const i = ps.findIndex((p) => { const r = p.getBoundingClientRect(); return x < r.left + r.width / 2; });
    return i < 0 ? ps.length : i;
  }

  /** Along the band, a pill dragged lands where it is let go, the others making room. */
  private along() {
    const {pills, caret} = this;
    pills.addEventListener('dragover', (event) => {
      if (!this.drag.name || !this.names.includes(this.drag.name)) return;
      event.preventDefault();
      const i = this.slot(event.clientX), ps = [...pills.querySelectorAll<HTMLElement>('.pill')];
      const box = pills.getBoundingClientRect();
      const edge = ps[i] ? ps[i].getBoundingClientRect().left - 5 : ps.at(-1)!.getBoundingClientRect().right + 3;
      caret.style.left = `${edge - box.left + pills.scrollLeft}px`;
      if (!caret.isConnected) pills.append(caret);
    });
    pills.addEventListener('dragleave', (event) => { if (!pills.contains(event.relatedTarget as Node)) caret.remove(); });
    pills.addEventListener('drop', (event) => {
      const name = this.drag.carried(event);
      caret.remove();
      if (!name || !this.names.includes(name)) return;
      event.preventDefault();
      this.names = moveTo(this.names, name, this.slot(event.clientX));
      this.save();
      this.paint();
    });
  }
}
