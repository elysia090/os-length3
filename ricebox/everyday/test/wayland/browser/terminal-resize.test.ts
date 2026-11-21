import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {guestScreen} from './vt-screen.ts';
import {fitTerminalGrid, terminalResize, type ResizeRequest} from './terminal-resize.mts';
import {terminalStream} from './terminal-stream.mts';

const initial = {cols: 80, rows: 24};
const size = (cols: number, rows: number) => ({cols, rows});
function session(apply?: (grid: typeof initial, prefix: number) => void) {
  const sent: ResizeRequest[] = [], drawn: number[][] = [], faults: string[] = [];
  const resize = terminalResize(initial, request => sent.push(request), (grid, prefix) => {
    apply?.(grid, prefix);
    drawn.push([grid.cols, grid.rows, prefix]);
  }, reason => faults.push(reason));
  return {resize, sent, drawn, faults, marker: (index: number, sentBytes = 0) =>
    resize.marker({...sent[index], sentBytes})};
}

test('fit uses CSS cells, caps the bounded grid and does not resize a hidden or tiny TTY', () => {
  assert.deepEqual(fitTerminalGrid(763, 398, 7.25, 17.5), size(105, 22));
  assert.deepEqual(fitTerminalGrid(6000, 3000, 7, 17), size(240, 100));
  assert.deepEqual(fitTerminalGrid(16, 17, 8, 17), size(2, 1));
  for (const [w,h,cw,ch] of [[8,17,8,17], [0,17,8,17], [16,16,8,17], [16,17,0,17],
    [16,17,8,NaN], [Infinity,17,8,17]]) assert.equal(fitTerminalGrid(w!, h!, cw!, ch!), undefined);
});

test('one outstanding cut and only latest layout; a confirmed cut needs no success ACK', () => {
  const {resize, sent, drawn, marker, faults} = session();
  resize.offer(size(81, 21));
  assert.equal(sent.length, 0);
  resize.activate();
  resize.offer(size(61, 15));
  resize.offer(size(91, 31));
  assert.deepEqual(sent.map(x => [x.request,x.cols,x.rows]), [[1,81,21]]);
  marker(0, 8); // ACK is lost (or still behind this marker).
  assert.deepEqual(sent.map(x => [x.request,x.cols,x.rows]), [[1,81,21], [2,91,31]]);
  resize.reply({request: 1}); // Late ACK cannot apply a stale size.
  assert.deepEqual(drawn, [[81,21,8]]);
  marker(1, 21);
  resize.offer(size(91, 31));
  resize.activate();
  assert.deepEqual(drawn, [[81,21,8], [91,31,21]]);
  assert.deepEqual(faults, []);
  assert.equal(sent.length, 2);
  resize.close();
});

test('a return to the current grid while a different request is pending is not lost', () => {
  const {resize, sent, drawn, marker} = session();
  resize.activate();
  resize.offer(size(81, 21));
  resize.offer(initial);
  marker(0);
  assert.deepEqual(sent.map(x => [x.request,x.cols,x.rows]), [[1,81,21], [2,80,24]]);
  marker(1);
  assert.deepEqual(drawn, [[81,21,0], [80,24,0]]);
  resize.close();
});

test('hidden or invalid latest observation cancels a queued size but not its predecessor', () => {
  const {resize, sent, drawn, marker} = session();
  resize.activate();
  resize.offer(size(82, 26)); resize.offer(size(90, 32));
  resize.offer(undefined);
  marker(0);
  assert.equal(sent.length, 1);
  assert.deepEqual(drawn, [[82,26,0]]);
  resize.offer(size(1, 100)); resize.offer(size(80, 101));
  assert.equal(sent.length, 1);
  resize.close();
});

test('a cut checks all published bytes, retains decoder/CSI carry, and applies before following bytes', () => {
  const screen = guestScreen(80, 24);
  const stream = terminalStream(text => screen.write(text), () => screen.discardPartial());
  const encode = new TextEncoder();
  const {resize, drawn, marker} = session(({cols, rows}, prefix) => {
    stream.cut(prefix);
    screen.resize(cols, rows);
  });
  resize.activate();
  resize.offer(size(5, 24));
  stream.accept(encode.encode('old!'), 0);
  stream.flush();
  stream.accept(encode.encode('discard'), 0); // Stale epoch must still count.
  const first = encode.encode('\r\n\x1b[31');
  stream.accept(first, 1);
  marker(0, 4 + 7 + first.length);
  const second = encode.encode('m好AB');
  stream.accept(second.subarray(0, 2), 1); // An incomplete character at the next cut.
  resize.offer(size(4, 24));
  marker(1, 4 + 7 + first.length + 2);
  stream.accept(second.subarray(2), 1);
  assert.equal(screen.text(), 'old!\n好AB');
  assert.equal(screen.lines[1]!.st[0], screen.lines[1]!.st[3]);
  assert.notEqual(screen.lines[1]!.st[0], 0);
  stream.accept(encode.encode('Z'), 1);
  assert.equal(screen.text(), 'old!\n好AB\nZ');
  stream.seal(4 + 7 + first.length + second.length + 1);
  assert.throws(() => stream.cut(100));
  assert.equal(drawn.length, 2);
  resize.close();
});

test('wrong cuts and ACK-before-cut faults do not draw or replay a late result', () => {
  for (const wrong of [
    (s: ReturnType<typeof session>) => s.resize.reply({request: 1}),
    (s: ReturnType<typeof session>) => s.resize.marker({...s.sent[0], request: 2, sentBytes: 0}),
    (s: ReturnType<typeof session>) => s.resize.marker({...s.sent[0], cols: 71, sentBytes: 0}),
    (s: ReturnType<typeof session>) => s.marker(0, NaN),
    (s: ReturnType<typeof session>) => s.marker(0, -1),
    (s: ReturnType<typeof session>) => s.marker(0, 33), // Valid number, wrong stream prefix.
  ]) {
    const stream = terminalStream(() => {}, () => {});
    const s = session((_grid, prefix) => stream.cut(prefix));
    s.resize.activate(); s.resize.offer(size(75, 20)); s.resize.offer(size(74, 21));
    wrong(s);
    s.marker(0);
    assert.deepEqual(s.drawn, []);
    assert.deepEqual(s.faults, ['error']);
    assert.equal(s.sent.length, 1);
  }
});

test('typed rejection or teardown stops resizing without erasing the prior applied grid', () => {
  for (const ending of ['busy', 'closed', 'retire']) {
    const {resize, sent, drawn, faults, marker} = session();
    resize.activate(); resize.offer(size(50, 19)); marker(0, 12);
    resize.offer(size(40, 18)); resize.offer(size(99, 30));
    if (ending === 'retire') resize.close();
    else resize.reply({request: 2, error: ending});
    marker(1);
    resize.offer(size(10, 2));
    assert.equal(sent.length, 2);
    assert.deepEqual(drawn, [[50,19,12]]);
    assert.deepEqual(faults, ending === 'retire' ? [] : ['rejected']);
  }
});

test('loss of the required cut times out, and close cancels both timeout and late apply', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const timedOut = session(), ended = session();
  for (const s of [timedOut, ended]) { s.resize.activate(); s.resize.offer(size(62, 17)); }
  ended.resize.close();
  t.mock.timers.tick(5000);
  for (const s of [timedOut, ended]) {
    s.marker(0);
    assert.deepEqual(s.drawn, []);
    assert.equal(s.sent.length, 1);
  }
  assert.deepEqual(timedOut.faults, ['error']);
  assert.deepEqual(ended.faults, []);
});
