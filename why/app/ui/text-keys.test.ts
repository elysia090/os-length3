import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nativeOptionArrow} from './text-keys.ts';

test('Apple Option arrows remain native; other platforms and application chords do not change', () => {
  for (const platform of ['MacIntel', 'Macintosh', 'iPad', 'iPhone']) {
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      const e = {key, altKey: true, ctrlKey: false, metaKey: false};
      assert.equal(nativeOptionArrow(e, platform), true);
      assert.equal(nativeOptionArrow({...e, ctrlKey: true}, platform), false);
      assert.equal(nativeOptionArrow({...e, metaKey: true}, platform), false);
      assert.equal(nativeOptionArrow({...e, altKey: false}, platform), false);
      assert.equal(nativeOptionArrow(e, 'Linux x86_64'), false);
      assert.equal(nativeOptionArrow(e, 'Win32'), false);
    }
  }
  assert.equal(nativeOptionArrow({key: 'a', altKey: true, ctrlKey: false, metaKey: false}, 'MacIntel'), false);
});
