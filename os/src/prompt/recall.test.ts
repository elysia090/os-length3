import assert from 'node:assert/strict';
import {test} from 'node:test';
import {caretLine, complete, pathWord, Recall} from './recall.ts';

test('the caret is on the first line until a line break comes before it, on the last until one comes after', () => {
  assert.deepEqual(caretLine('ls', 1), {first: true, last: true});
  assert.deepEqual(caretLine('a\nb', 0), {first: true, last: false});
  assert.deepEqual(caretLine('a\nb', 3), {first: false, last: true});
});

test('↑ walks back to the oldest line, ↓ forward to what was being written', () => {
  const lines = ['ls', 'pwd', 'pwd', '', 'echo hi'];
  const r = new Recall();
  assert.equal(r.newer(lines), null, 'not walking: ↓ is the box’s own');
  assert.equal(r.older(lines, 'half'), 'echo hi');
  assert.equal(r.older(lines, 'echo hi'), 'pwd', 'the same line twice in a row comes once, an empty one not at all');
  assert.equal(r.older(lines, 'pwd'), 'ls');
  assert.equal(r.older(lines, 'ls'), null, 'nothing older');
  assert.equal(r.newer(lines), 'pwd');
  assert.equal(r.newer(lines), 'echo hi');
  assert.equal(r.newer(lines), 'half', 'back to what was being written');
  assert.equal(r.newer(lines), null);
  assert.equal(new Recall().older([], ''), null, 'nothing run yet');
});

test('↑ walks only from the first line and ↓ only from the last, so a text of several lines is still edited with them', () => {
  const lines = ['ls', 'pwd'];
  const text = 'echo one\necho two';
  const r = new Recall();
  assert.equal(r.arrow('ArrowUp', text, text.length, lines), null, 'caret on the last line: ↑ moves it up');
  assert.equal(r.arrow('ArrowDown', text, 0, lines), null, 'caret on the first line, not walking: ↓ moves it down');
  assert.equal(r.arrow('ArrowUp', text, 3, lines), 'pwd', 'caret on the first line: the line before');
  assert.equal(r.arrow('ArrowUp', 'pwd', 3, lines), 'ls');
  assert.equal(r.arrow('ArrowDown', 'ls', 2, lines), 'pwd');
  assert.equal(r.arrow('ArrowDown', 'pwd', 3, lines), text, 'back to what was being written');
  const multi = new Recall();
  assert.equal(multi.arrow('ArrowUp', '', 0, ['a\nb', 'c']), 'c');
  assert.equal(multi.arrow('ArrowUp', 'c', 1, ['a\nb', 'c']), 'a\nb');
  assert.equal(multi.arrow('ArrowDown', 'a\nb', 0, ['a\nb', 'c']), null, 'a recalled line of two: ↓ on its first line moves the caret');
  assert.equal(multi.arrow('ArrowDown', 'a\nb', 3, ['a\nb', 'c']), 'c', 'and on its last walks on');
});

test('writing in the box ends the walk', () => {
  const r = new Recall();
  r.older(['a', 'b'], '');
  r.reset();
  assert.equal(r.newer(['a', 'b']), null);
  assert.equal(r.older(['a', 'b'], 'bx'), 'b');
});

test('the path before the caret, read against the repo', () => {
  assert.deepEqual(pathWord('cat src/ma', 10, 'notes'), {start: 4, dir: 'src', name: 'ma'});
  assert.deepEqual(pathWord('cat ./src/./ma', 14, 'notes'), {start: 4, dir: 'src', name: 'ma'});
  assert.deepEqual(pathWord('cat /root/notes/READ', 20, 'notes'), {start: 4, dir: '', name: 'READ'});
  assert.deepEqual(pathWord('ls|grep x>RE', 12, 'notes'), {start: 10, dir: '', name: 'RE'});
  assert.deepEqual(pathWord('cat src/ ', 8, 'notes'), {start: 4, dir: 'src', name: ''});
  assert.equal(pathWord('ls ', 3, 'notes'), null, 'nothing written');
  assert.equal(pathWord('', 0, 'notes'), null);
  assert.equal(pathWord('cat /etc/pa', 11, 'notes'), null, 'outside the repo');
  assert.equal(pathWord('cat ../x', 8, 'notes'), null);
  assert.equal(pathWord('echo $HO', 8, 'notes'), null);
});

test('one match is written out, several to what they share', () => {
  const dir = [{name: 'src', kind: 'dir'}, {name: 'README.md', kind: 'file'}, {name: 'readme.txt', kind: 'file'}, {name: 'run.sh', kind: 'file'}, {name: 'run.txt', kind: 'file'}, {name: '.env', kind: 'file'}];
  assert.deepEqual(complete('s', dir), {insert: 'rc/', choices: []});
  assert.deepEqual(complete('R', dir), {insert: 'EADME.md ', choices: []});
  assert.deepEqual(complete('r', dir), {insert: '', choices: ['readme.txt', 'run.sh', 'run.txt']});
  assert.deepEqual(complete('ru', dir), {insert: 'n.', choices: ['run.sh', 'run.txt']});
  assert.equal(complete('x', dir), null);
  assert.deepEqual(complete('', [{name: '.env', kind: 'file'}, {name: 'a', kind: 'file'}]), {insert: 'a ', choices: []}, 'a dot only when written');
  assert.deepEqual(complete('.', dir), {insert: 'env ', choices: []});
  assert.deepEqual(complete('my', [{name: 'my notes.md', kind: 'file'}]), {insert: '\\ notes.md ', choices: []});
});
