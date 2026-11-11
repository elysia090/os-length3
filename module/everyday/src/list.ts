// What a sheet lets a person change, listed; or a person's changes held to it, and what comes of them.
//
//   node module/everyday/src/list.ts SHEET...                    each thing that may be changed: its name, its kind,
//                                                                its usual value, how far it may go, what is said of it
//   node module/everyday/src/list.ts --changes FILE SHEET...     the rules FILE's changes make, and each line left out
//
// SHEET: a stylesheet (several are read as one). It ends 1 when a line of FILE was left out.
import {readFileSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {change, things} from './everyday.ts';

const {values, positionals} = parseArgs({options: {changes: {type: 'string'}}, allowPositionals: true});
if (!positionals.length) {
  console.error('usage: node module/everyday/src/list.ts [--changes FILE] SHEET...');
  process.exit(2);
}
const all = things(positionals.map((path) => readFileSync(path, 'utf8')).join('\n'));
if (values.changes === undefined) {
  for (const thing of all) {
    const unit = thing.kind === 'length' ? 'px' : thing.kind === 'time' ? 'ms' : '';
    const bounds = thing.most ? `${Math.round(thing.least * 100) / 100}${unit} to ${Math.round(thing.most * 100) / 100}${unit}` : '';
    console.log(`${thing.name.padEnd(18)} ${thing.kind.padEnd(7)} ${thing.usual.slice(0, 44).padEnd(44)} ${bounds.padEnd(18)} ${thing.says.slice(0, 100)}`);
  }
} else {
  const made = change(all, readFileSync(values.changes, 'utf8'));
  if (made.css) console.log(made.css);
  for (const {line, text, why} of made.left) console.error(`${values.changes}:${line}: left out: ${why}${text ? `: ${text}` : ''}`);
  if (made.left.length) process.exit(1);
}
