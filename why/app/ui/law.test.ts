import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {CELL, eased, moveTime, SPRING} from './law.ts';

// The one law every move of the OS follows (law.ts), and that the sheets and the code have no other.

test('a move is off at once, most of the way in the first third of its time, at rest at its end, and never goes back', () => {
  assert.equal(eased(0), 0);
  assert.equal(eased(1), 1);
  assert.ok(eased(.05) > .05);
  assert.ok(eased(1 / 3) > .7 && eased(1 / 3) < .8);
  for (let u = 0; u < 1; u += .01) assert.ok(eased(u + .01) > eased(u));
});

test('its time is a quarter of a second, and up to 420 ms as the way is longer', () => {
  assert.equal(moveTime(0, 730), 250);
  assert.equal(moveTime(365, 730), 335);
  assert.equal(moveTime(730, 730), 420);
  assert.equal(moveTime(-5000, 730), 420);
  assert.equal(CELL, 24);
});

test('the curve a browser is given is the law\'s, and the sheets\' is the same one', () => {
  const samples = SPRING.match(/[\d.]+/g)!.map(Number);
  assert.equal(samples.length, 21);
  samples.forEach((v, i) => assert.ok(Math.abs(v - eased(i / 20)) < .001));
  const tokens = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
  assert.ok(tokens.includes(`--spring: ${SPRING.replace(/0\./g, '0.')};`) || tokens.replace(/\s+/g, ' ').includes(SPRING), 'tokens.css --spring is not law.ts SPRING');
});

test('no sheet moves a thing by another curve, or in a time that is not one of the law\'s', () => {
  const dir = new URL('../styles/', import.meta.url);
  const sheets = ['base', 'bench', 'bench-2', 'cards', 'file-tree', 'forge-band', 'forge-desk', 'forge-files', 'git-desk', 'home', 'motion', 'page', 'prompt', 'rail', 'search', 'server', 'shared', 'todo'];
  for (const name of sheets) {
    const css = readFileSync(new URL(`${name}.css`, dir), 'utf8');
    for (const [decl] of css.matchAll(/(?:transition|animation)(?:-duration|-timing-function)?: [^;}]*/g)) {
      // (What goes round for as long as it is there, a caret's blink or a lamp's breath, is not a move.)
      if (/infinite|steps\(/.test(decl)) continue;
      assert.doesNotMatch(decl, /cubic-bezier|ease/, `${name}.css: ${decl}`);
      for (const [time] of decl.matchAll(/(?<![\w.(-])\d*\.?\d+m?s\b/g)) {
        const ms = time.endsWith('ms') ? parseFloat(time) : parseFloat(time) * 1000;
        // (A length written out is a wait of none, or a mark that lingers a second and more: not a move's.)
        assert.ok(ms === 0 || ms >= 900, `${name}.css: ${decl}`);
      }
    }
  }
});
