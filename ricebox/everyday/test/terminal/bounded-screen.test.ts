import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GUEST_SCREEN_LIMITS as limits, guestScreen, PLAIN} from '../../terminal/vt.ts';

test('bounded guest screen validates dimensions before allocating or resizing', () => {
  for (const [cols,rows] of [[1,4], [8,0], [30.5,3], [limits.columns+1,1], [80,limits.rows+1]]) {
    assert.throws(() => guestScreen(cols,rows), RangeError);
  }
  const screen = guestScreen(5,2);
  screen.write('keep');
  assert.throws(() => screen.resize(5,Infinity), RangeError);
  assert.equal(screen.text(),'keep');
  assert.equal(screen.lines.length,2);
  screen.resize(7,3);
  assert.equal(screen.lines[0].chars.length,7);
});

test('fragmented control limits discard only the oversized control and recover', () => {
  const screen = guestScreen(20,2);
  screen.write('A\x1b['+'1;'.repeat(limits.controlUnits/2));
  screen.write('31mB');
  screen.write('\x1b'+'#'.repeat(limits.controlUnits+1));
  screen.write('8C\x1b[3');
  screen.write('2mD');
  assert.equal(screen.text(),'ABCD');
  assert.deepEqual(screen.lines[0].st.slice(0,3), [0,0,0]);
  assert.equal(screen.styles.of(screen.lines[0].st[3]).fg,2);
});

test('bounded cells and color table keep prior content and ignore host OSC', () => {
  const screen = guestScreen(3,2);
  screen.write('A'+'\u0301'.repeat(limits.cellUnits+2));
  assert.equal(screen.lines[0].chars[0].length,limits.cellUnits);
  screen.write('\x1b]0;discard title\x07B');
  assert.equal(screen.lines[0].chars[1],'B');
  const color = (n: number) => ({...PLAIN,fg:0x1000000+n});
  const first = screen.styles.id(color(0));
  for (let i=1; i<limits.styles-1; i++) assert.ok(screen.styles.id(color(i)) > 0);
  assert.equal(screen.styles.id(color(limits.styles-1)),0);
  assert.equal(screen.styles.id(color(0)),first);
  assert.deepEqual(screen.styles.of(first),color(0));
});
