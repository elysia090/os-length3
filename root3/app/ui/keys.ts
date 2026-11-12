// The keys heard on a control's activation and as the Agent's typing is played on screen (pages/bench/play.ts): each key pressed and, a beat after,
// let go, from kbsim's recordings (MIT, Thomas Lai: public/sounds/keys/LICENSE.md): NovelKeys Cream's Space for a key,
// Cream's Backspace for Enter, Alpaca's Space for Space. No two strokes alike: each a little higher or lower, softer
// or harder, duller or brighter, as a hand's are. Quiet beside what the person does, and silent while the page is
// out of sight. The sounds are fetched on the first activation or Agent stroke; the context is made and resumed
// before that fetch. A failed fetch can be tried again, and unavailable audio never blocks an action.

export type Key = 'key' | 'enter' | 'space';

/** How loud a stroke is, by key, before its own few percent either way. */
const LOUD: Record<Key, number> = {key: 0.62, enter: 0.72, space: 0.66};
/** All of them, under what the page's other sounds would be. */
const MASTER = 0.32;

let ctx: AudioContext | null = null;
let out: GainNode | null = null;
let samples: Promise<Record<Key, [AudioBuffer, AudioBuffer]> | null> | null = null;

/** The six recordings, decoded; null where the page cannot sound. */
function load(): Promise<Record<Key, [AudioBuffer, AudioBuffer]> | null> {
  return samples ??= (async () => {
    if (!ctx) return null;
    const one = async (name: string) => {
      const response = await fetch(`/sounds/keys/${name}.mp3`);
      if (!response.ok) throw new Error(`key sound: ${response.status}`);
      return edged(await ctx!.decodeAudioData(await response.arrayBuffer()));
    };
    const kinds: Key[] = ['key', 'enter', 'space'];
    const got = await Promise.all(kinds.map((k) => Promise.all([one(`${k}-press`), one(`${k}-release`)])));
    return Object.fromEntries(kinds.map((k, i) => [k, got[i]])) as Record<Key, [AudioBuffer, AudioBuffer]>;
  })().catch(() => { samples = null; return null; });
}

/** How long a recording's ends are faded (s): kbsim's are cut off still sounding, and a sound stopped there clicks,
 * a crackle under every stroke as they come one on another. */
const FADE_IN = 0.0015, FADE_OUT = 0.012;

/** `b` faded in and out at its ends, in place (once, as it is decoded). */
export function edged(b: AudioBuffer): AudioBuffer {
  const lead = Math.min(b.length, Math.round(FADE_IN * b.sampleRate)), tail = Math.min(b.length, Math.round(FADE_OUT * b.sampleRate));
  for (let c = 0; c < b.numberOfChannels; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < lead; i++) d[i] *= i / lead;
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
  src.start(at);
}

/** A key struck now: pressed, and let go 50–110 ms after. Said on the window too ('root3-key', the key): a film made of
 * the page hears each stroke as the person does, and lays its sound under the picture at its time. */
export function strike(key: Key): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('root3-key', {detail: key}));
  if (typeof document !== 'undefined' && document.hidden) return;
  // Make and resume the context during the activation, before fetching or decoding yields its user gesture.
  try {
    if (!ctx) {
      if (typeof AudioContext === 'undefined') return;
      ctx = new AudioContext();
      out = ctx.createGain();
      out.gain.value = MASTER;
      out.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  } catch { return; } // Sound unavailable must never prevent the control's action.
  void load().then((s) => {
    // Do not queue stale strokes in a suspended context, or play a fetch that finished after the page hid.
    if (!s || !ctx || ctx.state !== 'running' || (typeof document !== 'undefined' && document.hidden)) return;
    const [press, release] = s[key];
    const gain = LOUD[key] * (1 + near(0.13, 0.3));
    const rate = 1 + near(0.022, 0.05);
    const bright = 7000 + 9000 * Math.random();
    const now = ctx.currentTime;
    play(press, now, gain, rate, bright);
    play(release, now + 0.05 + 0.06 * Math.random(), gain * (0.55 + 0.25 * Math.random()), rate, bright);
  }).catch(() => {}); // Device/context failure is silent, like unavailable audio at the activation itself.
}
