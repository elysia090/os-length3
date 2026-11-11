import {change, type Changed, type Pair} from '../../../module/everyday/src/everyday.ts';
import {THINGS} from './look-things.ts';

// The OS's look as the person at it has changed it: the lines of their `.everyday` (a dotfile, kept with the
// others: Runtime shows and edits it, the Remote keeps it in step, and one changed elsewhere is not worn here
// until it is taken here), held by everyday to what the sheets let be changed and to the words that must stay
// read, and put over the sheets as one rule. With no such file, or none of its lines taken, the page has no
// rule of this and is as the sheets have it: the way back to the look as it came is the file with a line less,
// or no file.

/** The dotfile a person's changes are written in. */
export const NAME = '.everyday';

/** The words that must stay read on their grounds, whatever is changed (each holds as the sheets have them: look.test.ts). */
export const PAIRS: readonly Pair[] = [
  {on: 'ink', under: 'ground', least: 4.5}, {on: 'ink', under: 'paper', least: 4.5}, {on: 'ink', under: 'raised', least: 4.5},
  {on: 'sub', under: 'ground', least: 4.5}, {on: 'sub', under: 'paper', least: 4.5}, {on: 'sub', under: 'raised', least: 4.5},
  {on: 'edge', under: 'ground', least: 3}, {on: 'ground', under: 'off', least: 4.5}, {on: 'ground', under: 'done', least: 3},
  {on: 'add', under: 'add-tint', least: 4.5}, {on: 'del', under: 'del-tint', least: 4.5},
  {on: 'ink', under: 'marker', least: 4.5}, {on: 'ink', under: 'marker-soft', least: 4.5}, {on: 'agent', under: 'paper', least: 4.5},
];

/** A person's changes held to the look: the rule that makes them so, and each line left out with why. */
export const worn = (text: string): Changed => change(THINGS, text, PAIRS);

/** Put a person's changes over the sheets (none: take them off). What was left out is given back. */
export function wear(text: string | undefined): Changed['left'] {
  const made = worn(text ?? '');
  let rule = document.getElementById('everyday');
  if (!made.css) { rule?.remove(); return made.left; }
  if (!rule) {
    rule = document.createElement('style');
    rule.id = 'everyday';
    document.head.append(rule);
  }
  if (rule.textContent !== made.css) rule.textContent = made.css;
  return made.left;
}
