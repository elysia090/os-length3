import assert from 'node:assert/strict';
import {test} from 'node:test';
import {clips, heldBack, OSC} from './osc.ts';

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');

test('an OSC split between two pieces of output is held until it ends, and nothing of it is shown', () => {
  const a = heldBack('', `made\n\x1b]52;c;${b64('hello')}`.slice(0, 12));
  assert.equal(a.now, 'made\n');
  const b = heldBack(a.held, `\x1b]52;c;${b64('hello')}\x07$ `.slice(7));
  assert.equal(b.held, '');
  assert.deepEqual(clips(b.now), ['hello']);
  assert.equal(b.now.replace(OSC, ''), '$ ');
});

test('output with no OSC, or with each one ended, is read at once', () => {
  assert.deepEqual(heldBack('', 'plain\n'), {now: 'plain\n', held: ''});
  assert.deepEqual(heldBack('', '\x1b]133;D;0\x07$ '), {now: '\x1b]133;D;0\x07$ ', held: ''});
  assert.deepEqual(heldBack('', '\x1b]0;title\x1b\\x'), {now: '\x1b]0;title\x1b\\x', held: ''});
});

test("what is put on the clipboard is the text as written, Japanese and lines and all; a query is never answered", () => {
  assert.deepEqual(clips(`\x1b]52;c;${b64('日本語\nline two\n')}\x07`), ['日本語\nline two\n']);
  assert.deepEqual(clips('\x1b]52;c;?\x07'), []);
  // Bytes that are no UTF-8 text put nothing there.
  assert.deepEqual(clips(`\x1b]52;c;${Buffer.from([0xff, 0xfe]).toString('base64')}\x07`), []);
});
