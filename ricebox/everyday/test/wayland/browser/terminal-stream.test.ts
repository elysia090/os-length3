import assert from 'node:assert/strict';
import {test} from 'node:test';
import {guestScreen} from './vt-screen.ts';
import {terminalStream} from './terminal-stream.mts';

const bytes = (text: string) => new TextEncoder().encode(text);

test('a flush drops old output and partial UTF-8/VT input without erasing drawn cells', () => {
  const screen = guestScreen(20, 3);
  const stream = terminalStream(text => screen.write(text), () => screen.discardPartial());
  assert.equal(stream.accept(bytes('keep\x1b[3'), 0), true);
  assert.equal(stream.accept(Uint8Array.of(0xe3), 0), false);
  assert.equal(stream.flush(), 1);
  assert.equal(stream.accept(bytes('1mnever'), 0), false);
  assert.throws(() => stream.accept(bytes('wrong epoch'), 2), /output order/);
  assert.equal(stream.accept(bytes('next'), 1), true);
  assert.equal(screen.text(), 'keepnext');
  assert.deepEqual(screen.lines[0].st.slice(0,8), Array(8).fill(0));
});

test('normal packet splits compose UTF-8 and SGR, and closing is final and idempotent', () => {
  const screen = guestScreen(20, 3);
  const stream = terminalStream(text => screen.write(text), () => screen.discardPartial());
  assert.equal(stream.accept(bytes('\x1b[3'), 0), true);
  const rest = bytes('1m日');
  assert.equal(stream.accept(rest.subarray(0, 3), 0), true);
  assert.equal(stream.accept(rest.subarray(3), 0), true);
  assert.equal(screen.text(), '日');
  assert.equal(screen.styles.of(screen.lines[0].st[0]).fg, 1);
  assert.equal(stream.accept(Uint8Array.of(0xe3), 0), false);
  stream.close();
  stream.close();
  assert.equal(screen.text(), '日�');
  assert.equal(stream.accept(bytes('ignored'), 0), false);
  assert.throws(() => stream.flush(), /closed/);
});

test('FIFO byte acknowledgement includes split and stale bytes and seals exactly once', () => {
  const received: string[] = [];
  const stream = terminalStream(text => received.push(text), () => {});
  assert.equal(stream.accept(Uint8Array.of(0xe3), 0), false);
  stream.flush();
  assert.equal(stream.accept(bytes('old'), 0), false);
  assert.equal(stream.accept(bytes('new'), 1), true);
  assert.throws(() => stream.accept(bytes('late'), 0), /output order/);
  assert.throws(() => stream.seal(3), /does not match/);
  assert.equal(stream.sealed, false);
  stream.seal(7);
  assert.equal(stream.sealed, true);
  assert.throws(() => stream.accept(bytes('after'), 1), /output order/);
  assert.throws(() => stream.seal(7), /does not match/);
  stream.close();
  assert.deepEqual(received, ['new']);
});

test('local cooked echo uses printable cells without completing a guest fragment', () => {
  const screen = guestScreen(20, 3);
  screen.write('\x1b[3');
  screen.echoLine('plain\x1b[0m');
  screen.write('1mred');
  assert.equal(screen.text(), 'plain[0m\nred');
  assert.equal(screen.styles.of(screen.lines[0].st[0]).fg, -1);
  assert.equal(screen.styles.of(screen.lines[1].st[0]).fg, 1);
});
