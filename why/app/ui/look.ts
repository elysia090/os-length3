import {change, type Changed, type Pair} from '../../../ricebox/everyday/src/everyday.ts';
import {THINGS} from './look-things.ts';

// The OS's look as the person at it has changed it: the lines of their `.everyday` (a dotfile, kept with the
// others: Runtime shows and edits it, the Remote keeps it in step, and one changed elsewhere is not worn here
// until it is taken here), held by everyday to what the sheets let be changed and to the words that must stay
// read, and put over the sheets as validated root properties. With no such file, or none of its lines taken,
// those overrides are removed: the way back to the look as it came is the file with a line less,
// or no file.

/** The dotfile a person's changes are written in. */
export const NAME = '.everyday';

/** The words that must stay read on their grounds, whatever is changed (each holds as the sheets have them: look.test.ts). */
export const PAIRS: readonly Pair[] = [
  // Active/leaving Prompt screens and held/leaving desk terminals use ordinary
  // text (green) and quiet text (slot) on ink. Both need normal-text contrast.
  {on: 'green', under: 'ink', least: 4.5}, {on: 'slot', under: 'ink', least: 4.5},
  {on: 'ink', under: 'ground', least: 4.5}, {on: 'ink', under: 'paper', least: 4.5}, {on: 'ink', under: 'raised', least: 4.5},
  {on: 'sub', under: 'ground', least: 4.5}, {on: 'sub', under: 'paper', least: 4.5}, {on: 'sub', under: 'raised', least: 4.5},
  {on: 'edge', under: 'ground', least: 3}, {on: 'ground', under: 'off', least: 4.5}, {on: 'ground', under: 'done', least: 3},
  {on: 'add', under: 'add-tint', least: 4.5}, {on: 'del', under: 'del-tint', least: 4.5},
  {on: 'ink', under: 'marker', least: 4.5}, {on: 'ink', under: 'marker-soft', least: 4.5}, {on: 'agent', under: 'paper', least: 4.5},
];

/** A person's changes held to the look: the rule that makes them so, and each line left out with why. */
export const worn = (text: string): Changed => change(THINGS, text, PAIRS);

// Only properties written by this owner are removed when its next file changes.
// Other root CSSOM state (for example optical.ts's --box-drop) stays untouched.
let managed = new Set<string>();

/** Put validated changes over the sheets without an inline stylesheet (desktop CSP forbids those). */
export function wear(text: string | undefined): Changed['left'] {
  const made = worn(text ?? ''), style = document.documentElement.style;
  const next = new Set(Object.keys(made.values).map(name => `--${name}`));
  for (const property of managed) if (!next.has(property)) style.removeProperty(property);
  for (const [name, value] of Object.entries(made.values)) {
    const property = `--${name}`;
    if (style.getPropertyValue(property) !== value) style.setProperty(property, value);
  }
  managed = next;
  return made.left;
}
