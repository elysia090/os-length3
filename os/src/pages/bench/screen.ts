import {fieldMoved} from '../../ui/caret.ts';
import {LAND, msOf, paced, still} from '../../ui/glide.ts';

// The Prompt up as a screen over the center (DESIGN.md § Forge): the box at the foot, lit. Brought up, the glass of
// the box's pill runs along the box's line and rises into the screen that holds the Prompt; put back, it sinks to the
// line and runs back into the pill, which gives under it as it lands, and the Prompt comes into the pane where it
// lives. Its state is one of three, and only this file changes it:
//
//   rest     the box's line, the Prompt in the pane;
//   up       the screen over the center, the Prompt in it (.prompting);
//   leaving  going back down: still the screen until it is the box's line again (.prompt-leaving).
//
// The line's words and Run take the glass's light while it is under them (.line-lit). What it says and how tall its
// line is are the box's (box.ts), told as the state changes (`changed`).

export type ScreenState = 'rest' | 'up' | 'leaving';

/** The box at rest, measured in the screen: where its pill stands (from its left and its foot, its size), the box's
 * height and its corner. */
interface Rest { l: number; b: number; w: number; h: number; box: number; round: number }
/** A shape in the screen, as insets from its edges and a corner: [top, right, bottom, left, round]. */
type Shape = [number, number, number, number, number];

/** Moved from the pane to the screen or back, the output would read from its top (a move loses where it was scrolled):
 * it reads from its foot, where a terminal is read, what was printed last over the line it waits at. */
function atFoot(term: HTMLElement) {
  for (const out of term.querySelectorAll<HTMLElement>('.term-out')) out.scrollTop = out.scrollHeight;
}

/**
 * The shapes the glass goes through: the pill, the box's line (the box at rest), the whole screen. For the Prompt above
 * the line (`above`), the line's shape holds none of it: what it printed comes only as the glass rises.
 */
function shapes(screen: HTMLElement, r: Rest, above: HTMLElement | null = null): {pill: Shape; line: Shape; whole: Shape} {
  const s = screen.getBoundingClientRect(), {width: W, height: H} = s;
  const top = above ? above.getBoundingClientRect().bottom - s.top : H - r.box;
  return {pill: [H - r.b - r.h, W - r.l - r.w, r.b, r.l, r.h / 2], line: [Math.max(top, H - r.box), 0, 0, 0, r.round],
    whole: [0, 0, 0, 0, parseFloat(getComputedStyle(screen).borderTopLeftRadius) || 0]};
}

/** A shape of the screen as `t`'s clip (t a part of it: the glass, or the Prompt above the line). */
function clipOf(t: HTMLElement, screen: HTMLElement, [top, right, bottom, left, round]: Shape): string {
  const s = screen.getBoundingClientRect(), r = t.getBoundingClientRect();
  return `inset(${top - (r.top - s.top)}px ${right - (s.right - r.right)}px ${bottom - (s.bottom - r.bottom)}px ${left - (r.left - s.left)}px round ${round}px)`;
}

/** How a way of the screen goes, as styles.css sets it, so the box's light and the words' colours keep with it: how long
 * it takes (--prompt-up), the part of it spent on the line (--prompt-up-line), and how each part moves (`first` and
 * `then`: --prompt-along and --prompt-rise up, --prompt-sink and --prompt-back down). */
function timing(way: 'up' | 'down'): {duration: number; line: number; first: string; then: string} {
  const cs = getComputedStyle(document.documentElement), v = (n: string) => cs.getPropertyValue(`--prompt-${n}`).trim();
  const [first, then] = way === 'up' ? [v('along'), v('rise')] : [v('sink'), v('back')];
  return {duration: msOf(v(way)) || (way === 'up' ? 460 : 320), line: parseFloat(v(`${way}-line`)) || (way === 'up' ? .38 : .5),
    first: first || 'ease-out', then: then || 'ease-out'};
}

/** Each of `els` from where it stood (`was`, its box then) to where it stands now, or (`back`) from here to there. */
function glide(els: HTMLElement[], was: DOMRect[], o: KeyframeAnimationOptions, back = false) {
  els.forEach((e, i) => {
    const r = e.getBoundingClientRect(), dx = was[i].left - r.left, dy = was[i].top - r.top;
    if (Math.abs(dx) < .5 && Math.abs(dy) < .5) return;
    const at = {transform: `translate(${dx}px, ${dy}px)`}, here = {transform: 'none'};
    e.animate(back ? [here, at] : [at, here], {...o, fill: back ? 'both' : 'backwards'});
  });
}

interface ScreenParts {
  /** What carries the state's classes (the bench). */
  work: HTMLElement;
  screen: HTMLElement;
  /** The glass, a layer of its own under the screen's words: what runs out of the pill and rises. */
  glass: HTMLElement;
  /** Where the Prompt stands while it is up, and its own box, and where it lives at rest (the pane). */
  slot: HTMLElement;
  term: HTMLElement;
  home: HTMLElement;
  /** The box's line and its pill, measured at rest: where the glass runs out of and back into. */
  form: HTMLElement;
  chip: HTMLElement;
  /** The line's parts that stay where they are while the glass comes under them: the pill's lamp first. */
  line: HTMLElement[];
  /** Told as it goes up, as it starts back down, and once it is the box's line again, before anything moves. */
  changed(state: ScreenState): void;
}

/** The Prompt up as a screen over the center and back into the box: its state, and the ways between them. */
export class Screen {
  #state: ScreenState = 'rest';
  /** The box at rest (its pill, in the screen), and the line's parts where they stood: where it goes back to. */
  #rest: Rest | null = null;
  #rested: DOMRect[] | null = null;
  /** The line's light going as the glass runs back from under it. */
  #unlit: Animation | null = null;

  readonly #p: ScreenParts;

  constructor(p: ScreenParts) {
    this.#p = p;
    // Up, it grows with what the Prompt holds: the room a line takes comes over a moment, its top rising, not at
    // once. Grown again while it is still growing (a line run makes room for its line, then for what it prints, a
    // frame apart), it rises on from where its top is seen, never jumping the rest of the way. Rising out of the pill
    // or sinking into it, it grows with that. Cleared, it is smaller at once, as a terminal's is.
    let held = 0;
    let grows: Animation[] = [];
    new ResizeObserver(() => {
      const now = p.term.getBoundingClientRect().height, by = now - held;
      held = now;
      if (this.#state !== 'up' || by < 1 || still() || p.term.parentElement !== p.slot) return;
      if (p.glass.getAnimations().some((a) => a.playState === 'running' && !grows.includes(a))) return;
      const seen = parseFloat(/inset\(([-\d.]+)px/.exec(getComputedStyle(p.slot).clipPath)?.[1] ?? '') || 0;
      for (const a of grows) a.cancel();
      const r = parseFloat(getComputedStyle(p.screen).borderTopLeftRadius) || 0, from = seen + by;
      grows = [p.glass, p.slot].map((t) => t.animate([{clipPath: `inset(${from}px 0 0 0 round ${r}px)`}, {clipPath: `inset(0 0 0 0 round ${r}px)`}],
        {duration: Math.min(320, 160 + from / 2), easing: LAND}));
    }).observe(p.term);
  }

  get state(): ScreenState { return this.#state; }
  /** Whether the Prompt is up over the center (going back down, it is not any more). */
  get up(): boolean { return this.#state === 'up'; }

  /** Brought up out of the box's pill. */
  raise() {
    if (this.#state === 'up') return;
    const {chip, screen, form, line, work} = this.#p;
    // Measured at rest, before it goes up: the pill it spreads out of and where the line's parts stand.
    const c = chip.getBoundingClientRect(), r = screen.getBoundingClientRect(), f = form.getBoundingClientRect();
    this.#rest = c.width ? {l: c.left - r.left, b: r.bottom - c.bottom, w: c.width, h: c.height, box: f.height,
      round: parseFloat(getComputedStyle(form).borderTopLeftRadius) || 0} : null;
    this.#rested = line.map((m) => m.getBoundingClientRect());
    this.#state = 'up';
    work.classList.add('prompting', 'line-lit');
    work.classList.remove('prompt-leaving');
    this.#unlit?.cancel();
    this.#p.changed('up');
    this.#rise();
    if (this.#rested && !still()) {
      const up = timing('up');
      glide(line, this.#rested, {duration: up.duration * up.line, easing: up.first});
    }
    // The line goes, and the caret in it with it from the first frame.
    fieldMoved();
  }

  /** Put back into the box's pill. */
  lower() {
    if (this.#state !== 'up') return;
    const {work, glass} = this.#p;
    this.#state = 'leaving';
    work.classList.remove('prompting');
    work.classList.add('prompt-leaving');
    // The line's words and Run lose the glass's light as it runs back from under them: timed on the clock it moves
    // by, so they keep together.
    this.#unlit?.cancel();
    if (still()) work.classList.remove('line-lit');
    else {
      const down = timing('down');
      const unlit = this.#unlit = glass.animate([], {duration: down.duration * down.line});
      unlit.finished.then(() => { if (this.#state !== 'up') work.classList.remove('line-lit'); }, () => {});
    }
    this.#p.changed('leaving');
    this.#sink();
    fieldMoved();
  }

  /** Taken off the screen with its page while up: at rest at once, the Prompt home. */
  drop() {
    if (this.#state === 'rest') return;
    const {work, screen, glass, slot, home, term, line} = this.#p;
    this.#state = 'rest';
    this.#unlit?.cancel();
    work.classList.remove('prompting', 'prompt-leaving', 'line-lit');
    for (const a of [screen, glass, slot, ...line].flatMap((e) => e.getAnimations())) a.cancel();
    home.append(term);
    atFoot(term);
    this.#p.changed('rest');
  }

  /** The glass out of the pill, along the line and up; the Prompt above the line comes with it, never stretched. */
  #rise() {
    const {term, slot, screen, glass} = this.#p, from = this.#rest;
    for (const a of [term, screen, glass, slot].flatMap((e) => e.getAnimations())) a.cancel();
    slot.append(term);
    atFoot(term);
    if (still() || !from) return;
    const UP = timing('up');
    for (const t of [glass, slot]) {
      const sh = shapes(screen, from, t === slot ? slot : null);
      t.animate([{clipPath: clipOf(t, screen, sh.pill), easing: UP.first}, {clipPath: clipOf(t, screen, sh.line), offset: UP.line, easing: UP.then},
        {clipPath: clipOf(t, screen, sh.whole)}], {duration: UP.duration});
    }
  }

  /**
   * The glass sinks to the line and runs back into the pill, the line's parts going back to where they stood at rest;
   * then the Prompt comes into the pane where it lives. Brought up again meanwhile, it stays up.
   */
  #sink() {
    const {term, slot, home, screen, glass, line} = this.#p, to = this.#rest;
    const done: Animation[] = [];
    const there = (landed: boolean) => {
      if (this.#state !== 'leaving') return;
      this.#state = 'rest';
      this.#p.work.classList.remove('prompt-leaving', 'line-lit');
      this.#p.changed('rest');
      for (const a of term.getAnimations()) a.cancel();
      home.append(term);
      atFoot(term);
      for (const a of [...done, ...line.flatMap((p) => p.getAnimations())]) a.cancel();
      if (still()) return;
      // Into the pane from the center's side, where it came from.
      term.animate([{opacity: 0, transform: 'translateX(-12px)'}, {opacity: 1, transform: 'none'}], {duration: paced(220), easing: LAND});
      if (landed) this.#caught();
    };
    if (still() || term.parentElement !== slot || !to) { there(false); return; }
    const DOWN = timing('down');
    for (const t of [glass, slot]) {
      const sh = shapes(screen, to, t === slot ? slot : null);
      done.push(t.animate([{clipPath: clipOf(t, screen, sh.whole), easing: DOWN.first}, {clipPath: clipOf(t, screen, sh.line), offset: DOWN.line, easing: DOWN.then},
        {clipPath: clipOf(t, screen, sh.pill)}], {duration: DOWN.duration, fill: 'forwards'}));
    }
    if (this.#rested) glide(line, this.#rested, {duration: DOWN.duration * (1 - DOWN.line), delay: DOWN.duration * DOWN.line, easing: DOWN.then}, true);
    done[0].finished.then(() => there(true), () => there(false));
  }

  /** The glass caught in the pill: the pill gives under it, flattened and wider, back past round and settled, as a
   * thing that lands; its lamp lights as it does, while its shell runs. */
  #caught() {
    const [lamp] = this.#p.line, pill = this.#p.chip;
    pill.animate([{scale: '1 1'}, {scale: '1.07 .8', offset: .22}, {scale: '.97 1.06', offset: .58}, {scale: '1 1'}],
      {duration: paced(210), easing: 'ease-out'});
    if (pill.dataset.state === 'on') lamp.animate([{boxShadow: '0 0 0 3px color-mix(in srgb, var(--done) 30%, transparent), 0 0 12px var(--done)'}, {}],
      {duration: paced(320), easing: 'ease-out'});
  }
}
