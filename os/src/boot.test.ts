import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

// public/boot.js says why when the app cannot start: it must load before the app, as a classic script of
// its own (the policy runs no inline script), and run in a browser too old for the app itself.
const boot = readFileSync(new URL('../public/boot.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('the page loads boot.js before the app, as a plain script', () => {
  const at = index.indexOf('<script src="/boot.js"></script>');
  assert.ok(at > 0 && at < index.indexOf('type="module"'));
  assert.doesNotThrow(() => new Function(boot));
  const code = boot.replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\]|\\.)*'/g, "''");
  assert.doesNotMatch(code, /=>|\b(let|const|class|async|await)\b|`|\?\.|\?\?/);
});
