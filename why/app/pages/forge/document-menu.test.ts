import assert from 'node:assert/strict';
import {test} from 'node:test';
import {clipboardEdit, menuPosition, sameSelection, selectionOf} from './document-menu.ts';

const file = {value: 'from this file', selectionStart: 5, selectionEnd: 9, selectionDirection: 'backward'} as const;

test('context menu prefers pointer, flips at lower-right and accounts for visual viewport offsets', () => {
  assert.deepEqual(menuPosition({x: 30, y: 40}, 100, 100, {width: 390, height: 400}), {x: 35, y: 45});
  assert.deepEqual(menuPosition({x: 385, y: 392}, 100, 100, {width: 390, height: 400}), {x: 280, y: 287});
  assert.deepEqual(menuPosition({x: 5, y: 7}, 100, 100, {x: 4, y: 6, width: 390, height: 400}), {x: 10, y: 12});
});

test('clipboard edits only propose changes, preserving exact direction and selected text', async () => {
  const taken = selectionOf(file);
  assert.equal(sameSelection(file, taken), true);
  assert.equal(sameSelection({...file, selectionDirection: 'forward'}, taken), false);
  let written = '';
  const clipboard = {readText: async () => 'the other', writeText: async (text: string) => { written = text; }};
  assert.deepEqual(await clipboardEdit('Copy', taken, clipboard, () => true), {kind: 'done'});
  assert.equal(written, 'this');
  assert.deepEqual(await clipboardEdit('Cut', taken, clipboard, () => true), {kind: 'replace', text: ''});
  assert.deepEqual(await clipboardEdit('Paste', taken, clipboard, () => true), {kind: 'replace', text: 'the other'});
  assert.equal(file.value, 'from this file');
});

test('denied clipboard, empty paste, and stale asynchronous cut or paste cannot change either file', async () => {
  const not = async () => { throw new Error('denied'); };
  assert.deepEqual(await clipboardEdit('Cut', file, {readText: not, writeText: not}, () => true), {kind: 'denied'});
  assert.deepEqual(await clipboardEdit('Paste', file, undefined, () => true), {kind: 'denied'});
  assert.deepEqual(await clipboardEdit('Paste', file, {readText: async () => '', writeText: not}, () => true), {kind: 'done'});
  for (const action of ['Cut', 'Paste'] as const) {
    let current = true;
    let read = false;
    const pending = clipboardEdit(action, file, {
      readText: async () => { read = true; return 'other'; },
      writeText: async () => { read = true; },
    }, () => current);
    assert.equal(read, true);
    current = false;
    assert.deepEqual(await pending, {kind: 'stale'});
  }
});
