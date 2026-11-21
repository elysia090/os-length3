import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';

test('workspace checks run directly, outside the Why application test harness', () => {
  assert.ok(process.argv[1]);
  assert.equal(pathToFileURL(process.argv[1]).href, import.meta.url);
});
