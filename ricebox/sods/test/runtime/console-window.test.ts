import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Kernel} from '../../runtime/linux.ts';
import {SIG} from '../../runtime/linux/signal.ts';

test('direct root console resizing does not truncate invalid numbers into Linux cells', () => {
  const console = {write() {}, read: () => null, interactive: true, screen: true, cols: 53, rows: 12};
  const signals: number[] = [];
  class Observed extends Kernel {
    override interrupt(sig: number = SIG.INT) { signals.push(sig); return true; }
  }
  const kernel = new Observed({console});
  for (const invalid of [NaN, Infinity, -1, 0, 1.25, 65536, Number.MAX_SAFE_INTEGER]) {
    assert.equal(kernel.resizeConsole(invalid, 31), false);
    assert.equal(kernel.resizeConsole(93, invalid), false);
    assert.deepEqual([console.cols, console.rows], [53, 12]);
  }
  assert.deepEqual(signals, []);
  assert.equal(kernel.resizeConsole(65535, 1), true);
  assert.equal(kernel.resizeConsole(65535, 1), false);
  assert.deepEqual([console.cols, console.rows], [65535, 1]);
  assert.deepEqual(signals, [SIG.WINCH]);
});
