import assert from 'node:assert/strict';
import {test} from 'node:test';
import {acceptsControlC, controlC, rawEditor, rawPaste} from './terminal-input.mts';

test('queued composition cannot send after mode or focus changes', async () => {
  let focused = true, draft = 'before', sent: string[] = [];
  const editor = rawEditor(() => focused, () => { if (draft) sent.push(draft); draft = ''; });
  editor.begin();
  editor.input(true);
  editor.finish();
  editor.fence(); // A new TTY mode invalidates the queued draft.
  await Promise.resolve();
  assert.deepEqual(sent, []);
  editor.begin();
  editor.finish();
  focused = false; // The browser moved focus before the microtask.
  await Promise.resolve();
  assert.deepEqual(sent, []);
  focused = true;
  draft = 'once';
  editor.begin();
  editor.input(false); // A final input can precede compositionend.
  editor.finish();
  editor.input(false); // Or it can follow. Only one can take this value.
  await Promise.resolve();
  assert.deepEqual(sent, ['once']);
});

test('raw paste preserves admitted text and rejects unbracketed multiline or oversized text', () => {
  assert.deepEqual(rawPaste('abc', 3, false), {text: 'abc'});
  assert.deepEqual(rawPaste('a\r\nb', 4, true), {text: '\x1b[200~a\r\nb\x1b[201~'});
  assert.deepEqual(rawPaste('a\nb', 3, false), {message: 'Multiline raw paste requires bracketed mode.'});
  assert.deepEqual(rawPaste('abcd', 3, true), {message: 'Raw paste exceeds the command field limit.'});
});

test('Control+C respects ISIG and NOFLSH for both UI entry points', () => {
  let epoch = 0;
  const flush = () => ++epoch;
  assert.equal(acceptsControlC(2), false);
  assert.equal(controlC(2, flush), null);
  assert.equal(acceptsControlC(0), true);
  assert.deepEqual(controlC(0, flush), {type: 'input', bytes: Uint8Array.of(3)});
  assert.deepEqual(controlC(1 | 2 | 0x80, flush), {type: 'interrupt', sig: 2});
  assert.deepEqual(controlC(1 | 2, flush), {type: 'interrupt', sig: 2, flush: 1});
  assert.equal(epoch, 1);
});
