import assert from 'node:assert/strict';
import {test} from 'node:test';
import {finds, indentOf, parseEdit, plan, type Done} from './edit.ts';

/** `text` with `d` written into it, as the editor writes it. */
const apply = (text: string, d: Done) => text.slice(0, d.from) + d.insert + text.slice(d.to);

test('a line in the box is read as what it asks', () => {
  assert.deepEqual(parseEdit('12'), {kind: 'go', line: 12});
  assert.deepEqual(parseEdit(':7'), {kind: 'go', line: 7});
  assert.deepEqual(parseEdit('main'), {kind: 'find', text: 'main', exact: false});
  assert.deepEqual(parseEdit('/+x'), {kind: 'find', text: '+x', exact: true});
  assert.deepEqual(parseEdit('old → new'), {kind: 'replace', from: 'old', to: 'new'});
  assert.deepEqual(parseEdit('a->b'), {kind: 'replace', from: 'a', to: 'b'});
  assert.deepEqual(parseEdit('gone →'), {kind: 'replace', from: 'gone', to: ''});
  assert.deepEqual(parseEdit('+ two words'), {kind: 'add', text: 'two words'});
  assert.deepEqual(parseEdit('+'), {kind: 'add', text: ''});
  assert.deepEqual(parseEdit('+ a\nb'), {kind: 'add', text: 'a\nb'});
  assert.deepEqual(parseEdit('= anew'), {kind: 'set', text: 'anew'});
  assert.deepEqual(parseEdit('-'), {kind: 'drop', n: 1});
  assert.deepEqual(parseEdit('-3'), {kind: 'drop', n: 3});
  assert.deepEqual(parseEdit('>'), {kind: 'indent', by: 1, n: 1});
  assert.deepEqual(parseEdit('< 2'), {kind: 'indent', by: -1, n: 2});
  assert.deepEqual(parseEdit('@src/main.ts'), {kind: 'file', path: 'src/main.ts'});
  assert.deepEqual(parseEdit('@'), {kind: 'none'});
  assert.deepEqual(parseEdit('   '), {kind: 'none'});
});

test('small letters find either case; a capital, or /, finds exactly', () => {
  assert.deepEqual(finds('Main main MAIN', 'main', false), [0, 5, 10]);
  assert.deepEqual(finds('Main main MAIN', 'Main', false), [0]);
  assert.deepEqual(finds('Main main MAIN', 'main', true), [5]);
});

test('go and find move the caret; find goes on to the next and round, Shift back', () => {
  const text = 'one\ntwo\nthree two\n';
  assert.deepEqual(plan(parseEdit('2'), text, 0).go, {from: 4, to: 4, keep: ''});
  assert.equal(plan(parseEdit('99'), text, 0).go?.from, text.length, 'past the last line: the last');
  const f = plan(parseEdit('two'), text, 0, false, 'two');
  assert.deepEqual(f.go, {from: 4, to: 7, keep: 'two'});
  assert.equal(f.said, '1 of 2');
  assert.equal(plan(parseEdit('two'), text, 5).go?.from, 14, 'the first at or after the caret');
  // On one (gone to), it is where one is; Enter goes on, round, and Shift back.
  const on = plan(parseEdit('two'), text, 4, false, '', 7);
  assert.equal(on.said, '1 of 2');
  assert.equal(on.go?.from, 14);
  assert.equal(plan(parseEdit('two'), text, 14, false, '', 17).go?.from, 4, 'round to the first');
  assert.equal(plan(parseEdit('two'), text, 14, true, '', 17).go?.from, 4, 'Shift: the one before');
  assert.equal(plan(parseEdit('two'), text, 4, true, '', 7).go?.from, 14, 'Shift, round to the last');
  assert.equal(plan(parseEdit('nothing'), text, 0).said, 'Not in this file');
});

test('old → new writes new for every old, in one edit, the caret kept on its line', () => {
  const text = 'let a = a + 1;\nreturn a;\n';
  const p = plan(parseEdit('a → count'), text, text.indexOf('return'));
  assert.equal(p.marks.length, 3);
  assert.equal(apply(text, p.done!), 'let count = count + 1;\nreturn count;\n');
  assert.equal(apply(text, p.done!).slice(p.done!.caret).startsWith('return'), true);
  assert.equal(apply(text, plan(parseEdit(' + 1 →'), text, 0).done!), 'let a = a;\nreturn a;\n');
});

test('+ adds a line under the caret\'s, as indented as it is, and the box is ready for the next', () => {
  const text = 'if (x) {\n  go();\n}';
  const p = plan(parseEdit('+ stop();'), text, text.indexOf('go'));
  const after = apply(text, p.done!);
  assert.equal(after, 'if (x) {\n  go();\n  stop();\n}');
  assert.equal(p.done!.again, '+ ');
  // The caret on the new line: the next + goes under it.
  const q = plan(parseEdit('+ again();'), after, p.done!.caret);
  assert.equal(apply(after, q.done!), 'if (x) {\n  go();\n  stop();\n  again();\n}');
  assert.equal(apply('a', plan(parseEdit('+    own'), 'a', 0).done!), 'a\n   own', 'its own indent kept');
});

test('= writes the caret\'s line anew, its indent kept; - takes lines away, with their break', () => {
  const text = 'a\n\tb\nc\nd';
  assert.equal(apply(text, plan(parseEdit('= B'), text, 3).done!), 'a\n\tB\nc\nd');
  assert.equal(apply(text, plan(parseEdit('-'), text, 3).done!), 'a\nc\nd');
  assert.equal(apply(text, plan(parseEdit('-2'), text, 3).done!), 'a\nd');
  assert.equal(apply(text, plan(parseEdit('-9'), text, 3).done!), 'a', 'to the end: the break before them goes');
  assert.equal(apply('only', plan(parseEdit('-'), 'only', 0).done!), '');
  const last = plan(parseEdit('-'), text, text.length);
  assert.equal(apply(text, last.done!), 'a\n\tb\nc');
  assert.equal(last.done!.caret, 5, 'the caret on the line before');
});

test('> and < move lines in and out by the file\'s own indent', () => {
  assert.equal(indentOf('a\n  b\n    c\n'), '  ');
  assert.equal(indentOf('a\n\tb\n'), '\t');
  assert.equal(indentOf('plain'), '\t');
  const text = 'x\n  y\n  z\n';
  assert.equal(apply(text, plan(parseEdit('>2'), text, 2).done!), 'x\n    y\n    z\n');
  assert.equal(apply(text, plan(parseEdit('<'), text, 2).done!), 'x\ny\n  z\n');
  assert.equal(plan(parseEdit('<'), text, 0).done, null, 'nothing to move out');
});
