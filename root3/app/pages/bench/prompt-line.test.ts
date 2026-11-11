import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {asOne, waitsAt} from './prompt-line.ts';

test('the prompt line waited at is one line, however many times the shell said it', () => {
  assert.equal(waitsAt('test $ '), 'test $ ');
  assert.equal(waitsAt('test/src $ '), 'test/src $ ');
  // Lines read one at a time: the shell waited at each, and wrote nothing between.
  assert.equal(waitsAt('test $ test $ test $ '), 'test $ ');
  assert.equal(waitsAt('iteration=1'), '');
  assert.equal(waitsAt('$ '), '');
});

test('one line goes as it is; more go as one line the shell runs whole', () => {
  assert.equal(asOne('pwd\n'), 'pwd\n');
  assert.equal(asOne('pwd'), 'pwd');
  assert.equal(asOne('x=42\necho "$x"\n'), `eval $'x=42\\necho "$x"'\n`);
  // What $'…' reads as its own (a backslash, a quote, a carriage return) is said so it is read as written.
  assert.equal(asOne("echo 'a\\b'\r\necho c"), `eval $'echo \\'a\\\\b\\'\\r\\necho c'\n`);
});

test('more than the shell holds on one line goes as the lines they are', () => {
  const lines = `${'echo x\n'.repeat(700)}`;
  assert.equal(asOne(lines), lines);
});

test('run as one, the lines do what they do read one at a time', { skip: !hasBash() }, () => {
  const lines = [
    'x=42',
    'echo "$((x + 8))"',
    "f() { local x=100; echo \"inside=$x\"; }",
    'f',
    "echo 'it'\\''s' \"a\\\\b\" $'tab\\there'",
    'for i in 1 2; do',
    '    echo "iteration=$i"',
    'done',
  ].join('\n');
  const one = asOne(`${lines}\n`);
  assert.equal(one.split('\n').length, 2);
  const read = (script: string) => execFileSync('bash', ['--norc', '--noprofile'], {input: script, encoding: 'utf-8'});
  assert.equal(read(one), read(`${lines}\n`));
});

function hasBash(): boolean {
  try { execFileSync('bash', ['-c', 'true']); return true; } catch { return false; }
}
