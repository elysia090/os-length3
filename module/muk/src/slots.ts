// A table of names in muk.c found by one look: a multiplier that sends each name's first eight bytes, as one
// word, to a slot of its own among 128 (the word times it, its top seven bits), and the slots (the name's row
// and one; nothing where no name goes). muk.c has what this prints (TABLE_MUL, TABLE_AT); that every name of a
// table is found is muk.sh's to check, so a name added without this run again fails there.
//
//   node module/muk/src/slots.ts TABLE[+SKIP]...      e.g. CAPS OPTIONS FLOOR_PROC+6 (its names told apart by
//                                                     what follows their first six bytes)
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('muk.c', import.meta.url), 'utf8');
const WORD = (1n << 64n) - 1n;

/** A name's first eight bytes as the machine reads them, those past its end zero. */
const head = (name: string) => {
  const bytes = Buffer.alloc(8);
  Buffer.from(name).copy(bytes, 0, 0, 8);
  return bytes.readBigUInt64LE();
};

for (const asked of process.argv.slice(2)) {
  const [table, skipped] = asked.split('+');
  const skip = Number(skipped ?? 0);
  const body = new RegExp(`static const char ${table}\\[\\]\\[\\d+\\] = \\{(.*?)\\};`, 's').exec(source);
  if (!body) throw new Error(`muk.c has no table ${table}`);
  const heads = [...body[1].matchAll(/"([^"]*)"/g)].map((m) => head(m[1].slice(skip)));
  if (new Set(heads).size !== heads.length) throw new Error(`${table}: two names begin with the same eight bytes`);
  // The same every run: a generator that starts from the table's name.
  let state = head(table) | 1n;
  const next = () => {
    state ^= state << 13n & WORD; state ^= state >> 7n; state ^= state << 17n & WORD;
    return state;
  };
  for (let tries = 1; ; tries++) {
    const mul = next() | 1n;
    const slots = heads.map((h) => Number((h * mul & WORD) >> 57n));
    if (new Set(slots).size !== slots.length) continue;
    const at = new Array<number>(128).fill(0);
    slots.forEach((slot, row) => { at[slot] = row + 1; });
    console.log(`#define ${table}_MUL 0x${mul.toString(16).padStart(16, '0')}ull /* (${heads.length} names; slots.ts, ${tries} tries) */`);
    console.log(`static const u8 ${table}_AT[128] = {${at.join(', ')}};`);
    break;
  }
}
