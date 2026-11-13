// The keys heard on a control's activation and as the Agent's typing is played on screen (pages/bench/play.ts): each key pressed and, a beat after,
// let go, from kbsim's recordings (MIT, Thomas Lai: public/sounds/keys/LICENSE.md): NovelKeys Cream's Space for a key,
// Cream's Backspace for Enter, Alpaca's Space for Space. No two strokes alike: each a little higher or lower, softer
// or harder, duller or brighter, as a hand's are. Quiet beside what the person does, and silent while the page is
// out of sight.
//
// A stroke sounds as it is struck, not after: the recordings are fetched and decoded before the first of them is asked
// for (`prime`, as the page comes to rest), the context is made and started at the person's first act (`wake`: an
// output not yet open takes its time), a recording's own silence before it sounds is not played, and a pointer's
// press on a control sounds as it goes down, its release as it is let go (`press`, `lift`), not both at the click
// that ends it. A stroke that could not sound in time is not played late. A failed fetch can be tried again, and
// unavailable audio never blocks an action.

export type Key = 'key' | 'enter' | 'space';

/** How loud a stroke is, by key, before its own few percent either way. */
const LOUD: Record<Key, number> = {key: 0.62, enter: 0.72, space: 0.66};
/** All of them, under what the page's other sounds would be. */
const MASTER = 0.32;

let ctx: AudioContext | null = null;
let out: GainNode | null = null;
let samples: Promise<Record<Key, [AudioBuffer, AudioBuffer]> | null> | null = null;
/** What decodes before there is a context that sounds (one may not be started before the person acts). */
let apart: OfflineAudioContext | null = null;
const decoder = (): BaseAudioContext | null => (typeof OfflineAudioContext === 'undefined' ? ctx : apart ??= new OfflineAudioContext(1, 1, 44100));

/** The six recordings, decoded; null where the page cannot sound. */
function load(): Promise<Record<Key, [AudioBuffer, AudioBuffer]> | null> {
  if (samples) return samples;
  const by = decoder();
  if (!by) return Promise.resolve(null);
  return samples = (async () => {
    const one = async (name: string) => {
      const response = await fetch(`/sounds/keys/${name}.mp3`);
      if (!response.ok) throw new Error(`key sound: ${response.status}`);
      return edged(await by.decodeAudioData(await response.arrayBuffer()));
    };
    const kinds: Key[] = ['key', 'enter', 'space'];
    const got = await Promise.all(kinds.map((k) => Promise.all([one(`${k}-press`), one(`${k}-release`)])));
    return Object.fromEntries(kinds.map((k, i) => [k, got[i]])) as Record<Key, [AudioBuffer, AudioBuffer]>;
  })().catch(() => { samples = null; return null; });
}

/** The recordings fetched and decoded ahead of the first stroke (where they can be decoded with nothing sounding). */
export function prime(): void {
  if (typeof OfflineAudioContext !== 'undefined') void load();
}

/** How long a recording's ends are faded (s): kbsim's are cut off still sounding, and a sound stopped there clicks,
 * a crackle under every stroke as they come one on another. */
const FADE_IN = 0.0015, FADE_OUT = 0.012;

/** Where each recording begins to sound (s into it). What is before is the recorder's silence (30 ms of it before
 * Enter's press), and is not played: a stroke is heard as it is struck. */
const begins = new WeakMap<AudioBuffer, number>();

/** How far into `b` it begins to sound (s): where it is played from. */
export const begun = (b: AudioBuffer): number => begins.get(b) ?? 0;

/** `b` faded in where it begins to sound and out at its end, in place (once, as it is decoded). */
export function edged(b: AudioBuffer): AudioBuffer {
  // It begins a millisecond before its first sample over a thirtieth of its loudest.
  let peak = 0, first = b.length;
  for (let c = 0; c < b.numberOfChannels; c++) for (const x of b.getChannelData(c)) peak = Math.max(peak, Math.abs(x));
  for (let c = 0; peak > 0 && c < b.numberOfChannels; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < first; i++) if (Math.abs(d[i]) > peak / 30) { first = i; break; }
  }
  const from = peak > 0 ? Math.max(0, first - Math.round(0.001 * b.sampleRate)) : 0;
  begins.set(b, from / b.sampleRate);
  const lead = Math.min(b.length - from, Math.round(FADE_IN * b.sampleRate)), tail = Math.min(b.length, Math.round(FADE_OUT * b.sampleRate));
  for (let c = 0; c < b.numberOfChannels; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < lead; i++) d[from + i] *= i / lead;
    for (let i = 0; i < tail; i++) d[b.length - 1 - i] *= i / tail;
  }
  return b;
}

/** A normal deviate, `sd` wide, held within `most` either side. */
function near(sd: number, most: number): number {
  const n = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  return Math.max(-most, Math.min(most, n * sd));
}

/** `buffer` played at `at` (the context's time), `gain` loud, its pitch and brightness this stroke's own. */
function play(buffer: AudioBuffer, at: number, gain: number, rate: number, bright: number) {
  const src = ctx!.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  const tone = ctx!.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = bright;
  const g = ctx!.createGain();
  g.gain.value = gain;
  src.connect(tone).connect(g).connect(out!);
  src.start(at, begun(buffer));
}

/** A resume may complete on a later task, or stay pending when the browser will not allow sound. Wait briefly
 * for it without saving a stroke to play long after the control was activated. */
function waking(resume: Promise<void>): Promise<boolean> {
  return new Promise((resolve) => {
    const late = setTimeout(() => resolve(false), 250);
    void resume.then(() => { clearTimeout(late); resolve(true); }, () => { clearTimeout(late); resolve(false); });
  });
}

/** The context made, and started if it is not: null where the page cannot sound, else whether it came to run in time.
 * Called at the person's first act too (touch.ts), so that the output is open before a stroke is asked for. */
export function wake(): Promise<boolean> | null {
  try {
    if (!ctx) {
      if (typeof AudioContext === 'undefined') return null;
      ctx = new AudioContext();
      out = ctx.createGain();
      out.gain.value = MASTER;
      out.connect(ctx.destination);
    }
    return ctx.state === 'suspended' ? waking(ctx.resume()) : Promise.resolve(true);
  } catch { return null; } // Sound unavailable must never prevent the control's action.
}

/** How long after it was struck a stroke may still sound (ms): past it, it is not played (never late). */
const LATE = 200;
/** The least a release follows its press by (s). */
const APART = 0.035;
/** A stroke's own loudness, pitch and brightness; when it was struck. */
interface Voice { key: Key; gain: number; rate: number; bright: number; at: number }
/** The press sounded and not yet let go (`press`). */
let down: Voice | null = null;

const hidden = () => typeof document !== 'undefined' && document.hidden;
const clock = () => (typeof performance === 'undefined' ? Date.now() : performance.now());

/** Said on the window ('why-key', the key): a film made of the page hears each stroke as the person does, and lays
 * its sound under the picture at its time. */
function said(key: Key) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('why-key', {detail: key}));
}

/** `key` sounded now: its press, and with `whole` its release 50–110 ms after. */
function stroke(key: Key, whole: boolean): Voice | null {
  if (hidden()) return null;
  // Make and resume the context during the activation, before fetching or decoding yields its user gesture.
  const ready = wake();
  if (!ready) return null;
  const voice: Voice = {key, gain: LOUD[key] * (1 + near(0.13, 0.3)), rate: 1 + near(0.022, 0.05), bright: 7000 + 9000 * Math.random(), at: clock()};
  void Promise.all([load(), ready]).then(([s, awake]) => {
    // Do not queue stale strokes in a suspended context, play a fetch that finished after the page hid, or sound
    // one long after it was struck.
    if (!awake || !s || !ctx || ctx.state !== 'running' || hidden() || clock() - voice.at > LATE) return;
    const [press, release] = s[key];
    const now = ctx.currentTime;
    play(press, now, voice.gain, voice.rate, voice.bright);
    if (whole) play(release, now + 0.05 + 0.06 * Math.random(), voice.gain * (0.55 + 0.25 * Math.random()), voice.rate, voice.bright);
  }).catch(() => {}); // Device/context failure is silent, like unavailable audio at the activation itself.
  return voice;
}

/** A key struck now: pressed, and let go 50–110 ms after. */
export function strike(key: Key): void {
  said(key);
  stroke(key, true);
}

/** A key pressed now and held (a pointer gone down on a control): its press sounds; `lift` sounds its release. */
export function press(key: Key): void {
  said(key);
  down = stroke(key, false);
}

/** What `press` pressed, let go: its release sounds (a moment after its press at the soonest). */
export function lift(): void {
  const voice = down;
  down = null;
  if (!voice || !ctx || ctx.state !== 'running' || hidden()) return;
  void load().then((s) => {
    if (!s || !ctx || ctx.state !== 'running') return;
    const wait = Math.max(0, APART - (clock() - voice.at) / 1000);
    play(s[voice.key][1], ctx.currentTime + wait, voice.gain * (0.55 + 0.25 * Math.random()), voice.rate, voice.bright);
  }).catch(() => {});
}
