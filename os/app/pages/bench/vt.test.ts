import assert from 'node:assert/strict';
import {test} from 'node:test';
import {css, F, LineState, Parser, Screen, sgr, PLAIN, width, type Row, type Run} from './vt.ts';

// The terminal's screen (vt.ts), fed what programs write.

const row = (s: Screen, y: number) => s.lines[y].chars.join('').replace(/\s+$/, '');

test('letters go where the cursor is; a line feed starts the next line; past the last row the screen scrolls', () => {
  const gone: Row[] = [];
  const s = new Screen(10, 3, (r) => gone.push(r));
  s.write('one\ntwo\nthree\nfour');
  assert.equal(s.text(), 'two\nthree\nfour');
  assert.equal(gone.map((r) => r.chars.join('').trim()).join(), 'one');
  assert.deepEqual([s.x, s.y], [4, 2]);
});

test('a line longer than the screen wraps onto the next, marked as going on', () => {
  const s = new Screen(5, 3);
  s.write('abcdefg');
  assert.equal(s.text(), 'abcde\nfg');
  assert.equal(s.lines[0].wrapped, true);
  // The last column written leaves the cursor there until the next letter.
  const t = new Screen(5, 2);
  t.write('abcde');
  assert.deepEqual([t.x, t.y], [4, 0]);
  t.write('\r\n');
  assert.equal(t.text(), 'abcde');
});

test('a carriage return goes back to the line\'s start; a backspace a letter back; erasing to the end', () => {
  const s = new Screen(20, 2);
  s.write('progress 10%\rprogress 100%');
  assert.equal(row(s, 0), 'progress 100%');
  s.write('\r\x1b[Kdone');
  assert.equal(row(s, 0), 'done');
  s.write('\bE');
  assert.equal(row(s, 0), 'donE');
});

test('the cursor goes where it is sent; the screen and lines are erased as asked', () => {
  const s = new Screen(10, 4);
  s.write('aaaaaaaaaa\r\nbbbbbbbbbb\r\ncccccccccc\r\ndddddddddd');
  s.write('\x1b[2;3H');
  assert.deepEqual([s.x, s.y], [2, 1]);
  s.write('\x1b[1K');
  assert.equal(row(s, 1), '   bbbbbbb');
  s.write('\x1b[J');
  assert.equal(s.text(), 'aaaaaaaaaa');
  s.write('\x1b[2J\x1b[Hx');
  assert.equal(s.text(), 'x');
  s.write('\x1b[3;4H\x1b[6n');
});

test('it answers where the cursor is and what it is', () => {
  const said: string[] = [];
  const s = new Screen(10, 4, () => {}, (t) => said.push(t));
  s.write('\x1b[3;4H\x1b[6n\x1b[c\x1b[5n');
  assert.deepEqual(said, ['\x1b[3;4R', '\x1b[?1;2c', '\x1b[0n']);
});

test('lines inserted and deleted within the scrolling region move only its rows', () => {
  const s = new Screen(4, 5);
  s.write('1\r\n2\r\n3\r\n4\r\n5');
  s.write('\x1b[2;4r'); // rows 2 to 4
  s.write('\x1b[2;1H\x1b[L');
  assert.equal(s.text(), '1\n\n2\n3\n5');
  s.write('\x1b[M');
  assert.equal(s.text(), '1\n2\n3\n\n5');
  // A line feed at the region's foot scrolls the region alone, nothing kept from it.
  const gone: Row[] = [];
  const t = new Screen(4, 4, (r) => gone.push(r));
  t.write('a\r\nb\r\nc\r\nd\x1b[2;3r\x1b[3;1H\n');
  assert.equal(t.text(), 'a\nc\n\nd');
  assert.equal(gone.length, 0);
});

test('the alternate screen is a whole-screen program\'s, and the main screen comes back as it was', () => {
  const s = new Screen(10, 3);
  s.write('$ vi\r\n');
  s.write('\x1b[?1049h\x1b[H\x1b[2Jediting');
  assert.equal(s.alternate, true);
  assert.equal(s.text(), 'editing');
  s.write('\x1b[?1049l');
  assert.equal(s.alternate, false);
  assert.equal(s.text(), '$ vi');
  assert.deepEqual([s.x, s.y], [0, 1]);
});

test('modes a program sets are kept: application arrows, the cursor hidden, pasting bracketed', () => {
  const s = new Screen(10, 3);
  s.write('\x1b[?1h\x1b[?25l\x1b[?2004h');
  assert.deepEqual([s.appCursor, s.cursorShown, s.bracketed], [true, false, true]);
  s.write('\x1b[?1l\x1b[?25h\x1b[?2004l');
  assert.deepEqual([s.appCursor, s.cursorShown, s.bracketed], [false, true, false]);
});

test('colours and weight are kept with each letter; a reset goes back to plain', () => {
  const s = new Screen(20, 1);
  s.write('\x1b[1;31mred\x1b[0m plain \x1b[38;5;208mo\x1b[38;2;10;20;30mt');
  const st = (x: number) => s.styles.of(s.lines[0].st[x]);
  assert.deepEqual(st(0), {fg: 1, bg: -1, flags: F.bold});
  assert.deepEqual(st(4), PLAIN);
  assert.equal(st(10).fg, 208);
  assert.equal(st(11).fg, 0x1000000 | (10 << 16) | (20 << 8) | 30);
});

test('SGR as xterm reads it, colons and all', () => {
  assert.deepEqual(sgr(PLAIN, [[38, 2, 0, 1, 2, 3]]), {fg: 0x1000000 | 0x010203, bg: -1, flags: 0});
  assert.deepEqual(sgr(PLAIN, [[48, 5, 17]]), {fg: -1, bg: 17, flags: 0});
  assert.deepEqual(sgr(PLAIN, [[4], [7], [92]]), {fg: 10, bg: -1, flags: F.under | F.inverse});
  assert.deepEqual(sgr({fg: 3, bg: 4, flags: F.bold | F.dim}, [[22], [39]]), {fg: -1, bg: 4, flags: 0});
  assert.equal(css(sgr(PLAIN, [[1], [32]])), 'color: var(--ansi-10); font-weight: 600');
  assert.equal(css(PLAIN), '');
});

test('a wide letter takes two cells, and a sequence cut between writes is read whole', () => {
  assert.equal(width('漢'.codePointAt(0)!), 2);
  assert.equal(width('a'.codePointAt(0)!), 1);
  const s = new Screen(6, 2);
  s.write('漢字a');
  assert.deepEqual([s.x, s.y], [5, 0]);
  assert.equal(row(s, 0), '漢字a');
  s.write('\x1b[3');
  s.write('1mx\x1b[');
  s.write('0m');
  assert.equal(s.styles.of(s.lines[0].st[5]).fg, 1);
});

test('line drawing comes in its own letters', () => {
  const s = new Screen(5, 1);
  s.write('\x1b(0lqk\x1b(Bx');
  assert.equal(row(s, 0), '┌─┐x');
});

test('the parser hands over an OSC whole, and drops a DCS', () => {
  const said: string[] = [];
  const p = new Parser({print: (t) => said.push(`p:${t}`), control: () => {}, esc: () => {}, csi: () => {}, osc: (t) => said.push(`o:${t}`), charset: () => {}});
  p.write('a\x1b]0;title\x07b\x1bPq#0;stuff\x1b\\c');
  assert.deepEqual(said, ['p:a', 'o:0;title', 'p:b', 'p:c']);
});

test('a line at a time: colours kept, the line under way rewritten by a carriage return and an erase', () => {
  const lines: Run[][] = [];
  const l = new LineState((r) => lines.push(r));
  l.write('\x1b[32mok\x1b[0m done\n');
  assert.deepEqual(lines[0].map((r) => r.text), ['ok', ' done']);
  assert.deepEqual(l.styles.of(lines[0][0].st), {fg: 2, bg: -1, flags: 0});
  l.write('10%');
  assert.equal(l.rewritten(), false);
  l.write('\r50%');
  assert.equal(l.text, '50%');
  assert.equal(l.rewritten(), true);
  l.write('\r\x1b[Kfinished\n');
  assert.equal(lines[1].map((r) => r.text).join(''), 'finished');
  l.write('ab\bX');
  assert.equal(l.text, 'aX');
});
