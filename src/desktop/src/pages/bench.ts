import {h} from '../dom.ts';
import {t} from '../i18n.ts';
import {icon} from '../icons.ts';
import type {PurposeId} from '../purposes.ts';
import {connection, RemoteError} from '../remote.ts';
import {LIMIT} from '../topic.ts';
import {pageHead} from './common.ts';
import {Reference} from './reference.ts';
import {sessionFor, sessionIfAny, terminalFor} from './terminal.ts';
import {postNow, timeline} from './topic.ts';

// The workbench Forge and Git share, and Topic brings when it is laid over
// another page: the page's own content in the large center (3/4) with the
// field at its foot, and a narrow right pane (1/4) with the search box and
// a reference switched freely on top and the Prompt (the repo's sh) below.
//
// The field at the foot is two boxes side by side, as the issues are (#1,
// #2): one in full, the other's edge showing beside it, and the edge is the
// way to it (a press, or Alt+←/→, slides the track there). Which box is out
// says where Enter goes: Post (purple, #) sends to Topic, Shell (yellow,
// >_) runs in the repo's sh; Shift+Enter is a new line in either. What is
// above the field follows the box: in Post, Topic is laid over the center
// (unless the center is Topic already); in Shell, using the field sends the
// Prompt flying up over the center, just above it, and the reference grows
// down into the room it leaves. Above the field's right end, the same
// switch as a repo's turns the repo's Prompt on and off.

const MOVE = 280;

/** Move `el` into `to`, animating from where it was (FLIP). */
function fly(el: HTMLElement, to: HTMLElement) {
  const from = el.getBoundingClientRect();
  to.append(el);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const at = el.getBoundingClientRect();
  if (!at.width || !from.width) return;
  el.animate([
    {transformOrigin: 'top left', transform: `translate(${from.left - at.left}px, ${from.top - at.top}px) scale(${from.width / at.width}, ${from.height / at.height})`},
    {transformOrigin: 'top left', transform: 'none'},
  ], {duration: MOVE, easing: 'cubic-bezier(.2, .9, .25, 1.06)'});
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Which way the field at the foot sends. */
export type Lane = 'post' | 'shell';

export interface Bench {
  element: HTMLElement;
  reference: Reference;
  /** The repo the prompt and the reference work on; null for none, with what to say instead. */
  setRepo(name: string | null, none?: string): void;
  /** Bring out a lane of the field (and what goes above it). */
  lane(which: Lane, focus?: boolean): void;
  readonly current: Lane;
  /** The center is Topic itself (Post lays nothing over it). */
  readonly topicIsMain: boolean;
}

/** The bench on screen, if any: Topic is laid over its center rather than over the page. */
let shown: Bench | null = null;
export const benchOnScreen = (): Bench | null => (shown?.element.isConnected ? shown : null);

export interface BenchParts {
  strip?: HTMLElement;
  main: HTMLElement;
  reveal(path: string, line?: number): void;
  /** Where the field's lanes lead when they need a page (signing in, claiming an address). */
  go(id: PurposeId): void;
  /** Whether the center is Topic already, so Post lays nothing over it. */
  topicIsMain?(): boolean;
  /** Start a repo's Prompt only when asked (its switch, or a line to run), not on sight. */
  lazy?: boolean;
}

export function bench(parts: BenchParts): Bench {
  let repo: string | null = null;
  let current: Lane = 'shell';
  // Named for what one does there: type at the prompt of the repo's sh.
  const termTitle = h('h2', {}, 'Prompt');
  const termBox = h('section', {class: 'term-box', 'aria-label': 'Prompt'}, termTitle);
  const termHome = h('div', {class: 'term-home'}, termBox);
  const termSlot = h('div', {class: 'term-slot'});

  // ---- the two lanes ----
  const field = (label: string) => h('textarea', {class: 'say-in', rows: '1', 'aria-label': label, spellcheck: 'false', autocapitalize: 'off'}) as HTMLTextAreaElement;
  const post = field(t('Post to Topic'));
  post.maxLength = LIMIT;
  post.spellcheck = true;
  const prompt = field(t('Prompt box'));
  prompt.classList.add('prompt-in');
  const signIn = h('button', {type: 'button', class: 'button small-button say-sign-in'}, t('Sign in')) as HTMLButtonElement;
  signIn.addEventListener('click', () => parts.go('remote'));
  const laneOf = (which: Lane, input: HTMLTextAreaElement, extra: Node[] = []) => {
    const box = h('form', {class: `say-lane say-${which}`, 'data-lane': which},
      h('span', {class: 'say-mark', 'aria-hidden': 'true'}, icon(which === 'post' ? 'topic' : 'forge')), input, ...extra);
    box.addEventListener('submit', (event) => event.preventDefault());
    return box;
  };
  const postLane = laneOf('post', post, [signIn]);
  const shellLane = laneOf('shell', prompt);
  // As the issues are: one box in full, the other's edge showing beside it; the edge is the way to it.
  const edge = (which: Lane) => {
    const b = h('button', {type: 'button', class: `stage-hit ${which === 'post' ? 'prev' : 'next'}`,
      'aria-label': which === 'post' ? t('Post to Topic') : t('Shell')}, icon(which === 'post' ? 'topic' : 'forge')) as HTMLButtonElement;
    b.addEventListener('click', () => setLane(which, true));
    return b;
  };
  const toPost = edge('post'), toShell = edge('shell');
  const lanes = h('div', {class: 'say-stage'}, h('div', {class: 'say-track'}, postLane, shellLane), toPost, toShell);
  const hint = h('p', {class: 'say-hint small', 'aria-live': 'polite'});
  // The repo's Prompt, on or off: the same switch as a repo's or SSH's.
  const power = h('button', {type: 'button', class: 'power plain', role: 'switch', 'aria-checked': 'false'}, h('span', {class: 'knob'})) as HTMLButtonElement;
  const say = h('div', {class: 'say', 'data-lane': current}, h('div', {class: 'say-head'}, hint, power), lanes);
  const note = h('p', {class: 'prompt-note muted small', role: 'status'});
  const dock = h('div', {class: 'dock'}, termSlot, say, note);

  // Topic, laid over the center while Post is out (read afresh each time: it opens at the newest).
  const cover = h('section', {class: 'cover', 'aria-label': 'Topic'});
  const center = h('div', {class: 'center'}, parts.main, cover, dock);
  const reference = new Reference({reveal: parts.reveal});
  const side = h('aside', {class: 'side', 'aria-label': t('Reference and Prompt')}, reference.element, termHome);
  const work = h('div', {class: parts.strip ? 'work' : 'work no-strip'}, ...(parts.strip ? [parts.strip] : []), center, side);

  const signedIn = () => connection() !== null;
  const paint = () => {
    say.dataset.lane = current;
    for (const [which, box, input] of [['post', postLane, post], ['shell', shellLane, prompt]] as const) {
      const out = which === current;
      box.setAttribute('aria-current', String(out));
      input.tabIndex = out ? 0 : -1;
    }
    toPost.hidden = current === 'post';
    toShell.hidden = current === 'shell';
    post.disabled = !signedIn();
    signIn.hidden = signedIn();
    post.placeholder = signedIn() ? t('Something short to share') : t('Sign in to post.');
    prompt.disabled = !repo;
    prompt.placeholder = repo ? t('Run in {name}', {name: repo}) : t('Runs once a repo is open');
    // What Enter does, said where it is pressed; what is left of a post only once it runs short.
    const left = LIMIT - post.value.length;
    hint.textContent = current === 'post'
      ? (signedIn() ? [t('Enter: post'), t('Shift+Enter: new line'), ...(left < 100 ? [String(left)] : [])].join(' · ') : '')
      : (repo ? `${t('Enter: run in {name}', {name: repo})} · ${t('Shift+Enter: new line')}` : '');
    paintPower();
  };

  // ---- the switch: the repo's Prompt, on or off ----
  let unwatch: (() => void) | null = null;
  const follow = () => {
    unwatch?.();
    unwatch = repo ? sessionIfAny(repo)?.watch(paintPower) ?? null : null;
  };
  function paintPower() {
    // Starting counts as on: the switch then stops it.
    const s = repo ? sessionIfAny(repo) : undefined;
    const on = Boolean(s && !s.ended);
    power.disabled = !repo;
    power.setAttribute('aria-checked', String(on));
    const label = !repo ? t('No Prompt: no repo is open') : on ? t('Turn the Prompt off') : t('Turn the Prompt on');
    power.setAttribute('aria-label', label);
    power.title = label;
  }
  const turnOn = () => {
    if (!repo) return;
    const s = sessionIfAny(repo);
    if (s?.ended) s.restart();
    // Here, whether it was here before or not.
    const el = terminalFor(repo);
    if (!termBox.contains(el)) termBox.replaceChildren(termTitle, el);
    follow();
  };
  power.addEventListener('click', () => {
    if (!repo) return;
    const s = sessionIfAny(repo);
    if (s && !s.ended) s.stop(); else turnOn();
    paintPower();
  });

  // ---- what goes above the field ----
  let prompting = false;
  const setPrompting = (on: boolean) => {
    if (on === prompting) return;
    prompting = on;
    work.classList.toggle('prompting', on);
    fly(termBox, on ? termSlot : termHome);
  };
  const covering = () => current === 'post' && !parts.topicIsMain?.();
  const paintCover = () => {
    const on = covering();
    if (on === work.classList.contains('covered')) return;
    work.classList.toggle('covered', on);
    if (on) cover.replaceChildren(h('div', {class: 'topic'}, pageHead('topic'), timeline(cover)));
    else cover.replaceChildren();
  };
  function setLane(which: Lane, focus = false) {
    current = which;
    if (which === 'post') setPrompting(false);
    paint();
    paintCover();
    if (focus) (which === 'post' ? post : prompt).focus();
    work.dispatchEvent(new CustomEvent('lane', {detail: which}));
  }

  const fit = (input: HTMLTextAreaElement) => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; };
  for (const input of [post, prompt]) {
    input.addEventListener('input', () => { fit(input); if (input === post) paint(); });
    input.addEventListener('keydown', (event) => {
      if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        setLane(event.key === 'ArrowLeft' ? 'post' : 'shell', true);
      }
    });
  }
  prompt.addEventListener('focus', () => setPrompting(true));
  prompt.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { setPrompting(false); prompt.blur(); return; }
    // Ctrl-C with nothing selected (so not a copy) interrupts what runs, as in a terminal.
    if (event.key === 'c' && event.ctrlKey && !event.altKey && !event.metaKey && prompt.selectionStart === prompt.selectionEnd && repo) {
      event.preventDefault();
      sessionIfAny(repo)?.interrupt();
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (!repo) return;
    // A line to run turns the Prompt on, if it was off.
    const s = sessionIfAny(repo);
    if (!s || s.ended) turnOn();
    if (!sessionFor(repo).send(prompt.value)) { note.textContent = t('Still starting'); return; }
    note.textContent = '';
    prompt.value = '';
    fit(prompt);
  });

  let posting = false;
  const send = async () => {
    if (posting || !post.value.trim()) return;
    posting = true;
    note.replaceChildren();
    try {
      await postNow(post.value);
      post.value = '';
      fit(post);
    } catch (e) {
      if (e instanceof RemoteError && e.status === 409) {
        const inbox = h('button', {type: 'button', class: 'button small-button'}, t('Go to Inbox'));
        inbox.addEventListener('click', () => parts.go('inbox'));
        note.replaceChildren(t('Posting needs an address. Claim one in Inbox.'), ' ', inbox);
      } else note.textContent = message(e);
    } finally { posting = false; paint(); }
  };
  post.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { if (!parts.topicIsMain?.()) setLane('shell'); post.blur(); return; }
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void send();
  });

  // Leaving the field and the Prompt sends it home; losing the window's focus does not.
  dock.addEventListener('focusout', (event) => {
    const to = event.relatedTarget as Node | null;
    if (to && !dock.contains(to)) setPrompting(false);
  });
  termBox.addEventListener('pointerdown', (event) => {
    if (prompting || (event.target as HTMLElement).closest('button')) return;
    event.preventDefault();
    setLane('shell');
    prompt.focus();
  });

  const setRepo = (name: string | null, none = t('Runs once a repo is open')) => {
    if (name === repo && name) return;
    repo = name;
    reference.setRepo(name);
    const running = name ? sessionIfAny(name) : undefined;
    termBox.replaceChildren(termTitle, !name ? h('div', {class: 'empty'}, none)
      : parts.lazy && !running ? h('div', {class: 'empty'}, t('The Prompt is off: its switch above the field turns it on'))
      : terminalFor(name));
    follow();
    paint();
  };
  setRepo(null);
  const b: Bench = {element: work, reference, setRepo, lane: setLane, get current() { return current; }, get topicIsMain() { return Boolean(parts.topicIsMain?.()); }};
  shown = b;
  return b;
}
