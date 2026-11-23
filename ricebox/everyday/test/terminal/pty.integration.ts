import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {Worker as NodeWorker} from 'node:worker_threads';
import type {GuestEvent} from '../wayland/support/worker-events.ts';

// Run from the fresh offline npm consumer, with its exact installed Worker.
const {createRoot} = await import(import.meta.resolve('ricebox')) as typeof import('../../../distribution/runtime/root.ts');
const {shellStart} = await import(new URL('./shell-fixture.ts', import.meta.url).href) as typeof import('../wayland/browser/shell-fixture.ts');
const {guestScreen} = await import(new URL('./vt.ts', import.meta.url).href) as typeof import('../../terminal/vt.ts');
const {terminalStream} = await import(new URL('./terminal-stream.mts', import.meta.url).href) as typeof import('../wayland/browser/terminal-stream.mts');
const args = process.argv.slice(2);
assert.equal(args.length, 3, 'pass TRANSLATOR_WASM MUK STATIC_BUSYBOX');
const [translator, muk, busybox] = args.map(path => new Uint8Array(readFileSync(path)));
const entry = new URL('./worker.js', import.meta.resolve('ricebox')).href;
const resizeAdmitted = process.env.EVERYDAY_NO_RESIZE !== '1';
const dropResizeReply = process.env.EVERYDAY_DROP_RESIZE_REPLY === '1';
const apart = !process.env.SODS_INLINE;
const bridge = new URL('data:text/javascript,' + encodeURIComponent([
  "import {parentPort, workerData} from 'node:worker_threads';",
  "globalThis.self = {postMessage(value, {transfer=[]}={}) {",
  "  if (workerData.dropResizeReply && value.type === 'terminal-size' && value.request === 1) return;",
  "  parentPort.postMessage(value, transfer);",
  "}};",
  "await import(workerData.entry);",
  "parentPort.on('message', data => self.onmessage({data}));",
].join('\n')));
const root = createRoot({
  base: '/fixture/', first: [], usedKey: 'everyday-terminal-test-used', planKey: 'everyday-terminal-test-plan',
  message: key => key, missing: () => 'No default root', errorText: String,
});
const OriginalWorker = globalThis.Worker;
Object.assign(globalThis, {Worker: class {
  constructor(url: URL) {
    assert.equal(url.href, entry);
    return new NodeWorker(bridge, {workerData: {entry, dropResizeReply}});
  }
}});
let worker: NodeWorker;
try { worker = root.rootWorker() as unknown as NodeWorker; }
finally { globalThis.Worker = OriginalWorker; }

type Output = Extract<GuestEvent, {type: 'output'}>;
type Geometry = Extract<GuestEvent, {type: 'terminal-geometry'}>;
type SizeAnswer = Extract<GuestEvent, {type: 'terminal-size'}>;
const messages: GuestEvent[] = [], errors: unknown[] = [], output: Output[] = [];
const screen = guestScreen(53, 12);
const stream = terminalStream(text => screen.write(text), () => screen.discardPartial());
function hasInk(needle: string, fg: number) {
  return screen.lines.some(row => {
    // Both fixture witnesses are ASCII; indices are screen cell positions.
    const start = row.chars.join('').indexOf(needle);
    return start >= 0 && row.st.slice(start, start + needle.length).every(st => screen.styles.of(st).fg === fg);
  });
}
const encoder = new TextEncoder();
const send = (text: string) => worker.postMessage({type: 'input', bytes: encoder.encode(text)});
let received = 0;
const command = (text: string) => send(text + '\n');
const text = (epoch?: number, from = 0) => Buffer.concat(output.slice(from)
  .filter(m => epoch === undefined || m.epoch === epoch).map(m => m.bytes)).toString('utf8');
const waits = (from: number, reason: 'input' | 'time') => messages.slice(from).some(m => m.type === 'waiting' && m.for === reason);
const ICANON = 2, ECHO = 8;
worker.on('error', e => errors.push(e));
worker.on('message', (msg: GuestEvent) => {
  messages.push(msg);
  if (msg.type === 'error') errors.push(new Error(msg.message));
  if (msg.type === 'output') {
    received += msg.bytes.length;
    if (received > 64 * 1024) {
      if (!errors.length) errors.push(new Error('Terminal fixture output exceeded its budget'));
      return;
    }
    output.push({...msg, bytes: Buffer.from(msg.bytes)});
    try { stream.accept(msg.bytes, msg.epoch); }
    catch (error) { errors.push(error); return; }
    worker.postMessage({type: 'drained', n: msg.bytes.length});
  }
  if (msg.type === 'output-boundary') {
    try { stream.seal(msg.sentBytes); }
    catch (error) { errors.push(error); }
  }
});
async function until(label: string, ready: () => boolean) {
  const deadline = performance.now() + 8000;
  while (!ready()) {
    if (errors.length) throw new AggregateError(errors, label + ': ' + text());
    if (performance.now() >= deadline) throw new Error('Timed out: ' + label + ': ' + text());
    await delay(10);
  }
  if (errors.length) throw new AggregateError(errors, label + ': ' + text());
}
const inputMode = () => (messages.findLast(m => m.type === 'tty')?.lflag ?? (ICANON | ECHO)) & (ICANON | ECHO);
try {
  const ask = (request: number, cols: number, rows: number) => worker.postMessage({type: 'terminal-resize', request, cols, rows});
  const answer = (request: number) => messages.find((m): m is SizeAnswer => m.type === 'terminal-size' && m.request === request);
  const geometry = (request: number) => messages.find((m): m is Geometry => m.type === 'terminal-geometry' && m.request === request);
  ask(7, 97, 29);
  await until('resize rejected before admission', () => !!answer(7));
  assert.equal(answer(7)?.error, 'inactive');
  worker.postMessage({...shellStart(translator, muk, busybox), cols: 53, rows: 12,
    ...(resizeAdmitted ? {terminalResize: true} : {})});
  await until('real interactive prompt', () => waits(0, 'input') && text().includes('everyday$'));
  assert.equal(messages.find(m => m.type === 'threads')?.apart, apart);
  const promptMode = inputMode();

  const first = messages.length;
  command("printf '<size:%s>\\n' \"$(/bin/busybox stty size)\"; printf '\\033[31mtty-color\\033[0m\\n'");
  await until('guest ioctl geometry and literal ANSI output', () =>
    waits(first, 'input') && text().includes('<size:12 53>') && text().includes('\x1b[31mtty-color\x1b[0m'));
  assert.ok(hasInk('tty-color', 1));

  if (resizeAdmitted) {
    const beforeTrap = messages.length;
    // An ordinary foreground program; interactive ash's own line editor
    // handles WINCH while reading its prompt, so it isn't the witness.
    const windowProbe = [
      'hits=0',
      'trap \'hits=$((hits+1)); printf "<winch:%s>\\n" "$(/bin/busybox stty size)"\' WINCH',
      'printf "<probe:%s>\\n" "$(/bin/busybox stty size)"',
      'while :; do if IFS= read -r line; then',
      '  case "$line" in',
      '    stop) break;;',
      '    count) printf "<size-after:%s hits:%s>\\n" "$(/bin/busybox stty size)" "$hits";;',
      '    hold) printf "<hold>\\n"; /bin/busybox sleep 1;;',
      '  esac',
      'fi; done',
    ].join('\n');
    command("/bin/busybox sh -c '" + windowProbe.replaceAll("'", "'\\''") + "'");
    await until('foreground child traps WINCH before its input wait', () =>
      waits(beforeTrap, 'input') && text().includes('<probe:12 53>'));
    ask(1, 93, 31);
    await until('live resize receipt and guest WINCH ioctl', () =>
      !!geometry(1) && (dropResizeReply || !!answer(1)) && text().includes('<winch:31 93>'));
    if (dropResizeReply) assert.equal(answer(1), undefined);
    else assert.deepEqual(answer(1), {type: 'terminal-size', request: 1, cols: 93, rows: 31, changed: true});

    ask(4, 93, 31);
    ask(3, 71, 22);
    ask(5, 65536, 22);
    await until('same-size, stale and invalid replies', () => !!answer(4) && !!answer(3) && !!answer(5));
    assert.deepEqual(answer(4), {type: 'terminal-size', request: 4, cols: 93, rows: 31, changed: false});
    assert.equal(answer(3)?.error, 'stale');
    assert.equal(answer(5)?.error, 'invalid-size');
    const beforeReadback = messages.length;
    command('count');
    await until('guest reads same geometry and exactly one signal after rejected/duplicate sets', () =>
      waits(beforeReadback, 'input') && text().includes('<size-after:31 93 hits:1>'));

    // Restore the starting dimensions so the preexisting 53x12 screen transport
    // checks below still describe the same visual grid they always tested.
    const beforeHold = messages.length;
    command('hold');
    await until('foreground guard sleeps before it can read more input', () =>
      waits(beforeHold, 'time') && text().includes('<hold>'));
    command('count'); // Already in FIFO when the resize command is admitted.
    ask(6, 53, 12);
    await until('resize signals again without discarding already queued input', () =>
      !!answer(6) && text().includes('<winch:12 53>') && text().includes('<size-after:12 53 hits:2>'));
    assert.equal(answer(6)?.changed, true);
    const beforeResize = Buffer.concat(output.map(m => m.bytes));
    const firstSignal = beforeResize.indexOf('<winch:31 93>');
    const secondSignal = beforeResize.indexOf('<winch:12 53>');
    const held = beforeResize.indexOf('<hold>');
    const firstGeometry = geometry(1), restored = geometry(6);
    assert.ok(firstGeometry && firstGeometry.sentBytes <= firstSignal);
    assert.ok(restored && held >= 0 && held + '<hold>'.length <= restored.sentBytes && restored.sentBytes <= secondSignal);
    assert.deepEqual(messages.filter(m => m.type === 'terminal-geometry').map(m => m.request), [1,4,6]);
    let published = 0;
    for (const message of messages) {
      if (message.type === 'output') published += message.bytes.length;
      if (message.type === 'terminal-geometry') {
        assert.equal(message.sentBytes, published);
        if (!dropResizeReply || message.request !== 1) {
          const size = answer(message.request);
          assert.ok(size && 'cols' in size && 'rows' in size);
          assert.deepEqual([message.cols, message.rows], [size.cols, size.rows]);
          assert.ok(messages.indexOf(message) < messages.indexOf(size));
        }
      }
    }
    assert.ok(output.every(m => m.epoch === 0));
    command('stop');
  } else {
    ask(1, 93, 31);
    await until('unadmitted screen rejects a resize', () => !!answer(1));
    assert.equal(answer(1)?.error, 'inactive');
    const beforeControl = messages.length;
    command("printf '<fixed:%s>\\n' \"$(/bin/busybox stty size)\"");
    await until('old-no-resize screen kept its original terminal', () =>
      waits(beforeControl, 'input') && text().includes('<fixed:12 53>'));
  }

  const beforeRaw = messages.length;
  command("/bin/busybox stty -icanon -echo min 1 time 0; " +
    "printf '\\033[?1049h\\033[H\\033[32malt-screen\\033[0m\\n<r%s>\\n' aw; " +
    "byte=$(/bin/busybox dd bs=1 count=1 2>/dev/null); /bin/busybox stty icanon echo; " +
    "printf '\\033[?1049l<read:%s>\\n' \"$byte\"; " +
    "IFS= read -r cooked; printf '<line:%s>\\n' \"$cooked\"");
  await until('raw no-echo guest read blocks', () =>
    inputMode() === 0 && text().includes('<raw>') && waits(beforeRaw, 'input'));
  assert.ok(screen.alternate && hasInk('alt-screen', 2));
  const beforeKey = messages.length;
  send('q'); // Deliberately no Enter afterward.
  await until('one raw byte read and a canonical read blocks in the same command', () =>
    waits(beforeKey, 'input') && inputMode() === (ICANON | ECHO) && text().includes('<read:q>'));
  assert.ok(!screen.alternate && !hasInk('alt-screen', 2) && screen.text().includes('<read:q>'));
  const beforeCooked = messages.length;
  command('cooked-answer');
  await until('the cooked line is read and the normal shell prompt resumes', () =>
    waits(beforeCooked, 'input') && inputMode() === promptMode && text().includes('<line:cooked-answer>'));

  const beforeHidden = messages.length;
  command("/bin/busybox stty -echo; printf '<h%s>\\n' ush; IFS= read -r value; " +
    "/bin/busybox stty echo; printf '<length:%s>\\n' \"${#value}\"");
  await until('canonical no-echo input', () => waits(beforeHidden, 'input') && text().includes('<hush>') &&
    inputMode() === ICANON);
  command('hidden-value');
  await until('guest consumed the masked line', () => text().includes('<length:12>'));
  assert.ok(!text().includes('hidden-value'));

  const beforeSleep = messages.length;
  command("printf '<s%s>\\n' leep; /bin/busybox sleep 30");
  await until('guest foreground sleep', () => text().includes('<sleep>') &&
    messages.slice(beforeSleep).some(m => m.type === 'waiting' && m.for === 'time' && m.ms >= 20_000));
  const beforeSignal = messages.length;
  worker.postMessage({type: 'interrupt', sig: 2, flush: stream.flush()});
  await until('Ctrl-C returned to a live prompt without waiting for sleep', () =>
    waits(beforeSignal, 'input') && inputMode() === promptMode && text(1).includes('everyday$'));
  const beforeRecovery = messages.length;
  command("printf '<after:%s>\\n' \"$((6*7))\"");
  await until('the same shell is usable after Ctrl-C', () => waits(beforeRecovery, 'input') &&
    text(1).includes('<after:42>') && !text(0).includes('<after:42>'));

  assert.ok(screen.text().includes('<after:42>'));
  if (resizeAdmitted) {
    ask(10, 53, 12);
    await until('same-size geometry cut after an actual Ctrl-C flush', () => !!geometry(10) && !!answer(10));
    const marker = geometry(10);
    assert.ok(marker);
    const before = messages.slice(0, messages.indexOf(marker)).filter(m => m.type === 'output');
    assert.ok(before.some(m => m.epoch === 0) && before.some(m => m.epoch === 1));
    assert.equal(marker.sentBytes, before.reduce((n, m) => n + m.bytes.length, 0));
    assert.equal(answer(10)?.changed, false);
  }
  command('exit');
  await until('guest exit', () => messages.some(m => m.type === 'exit'));
  assert.equal(messages.find(m => m.type === 'exit')?.status, 0);
  assert.equal(stream.sealed, true);
  stream.close();
  const boundary = messages.findIndex(m => m.type === 'output-boundary');
  assert.ok(boundary !== -1 && boundary < messages.findIndex(m => m.type === 'exit'));
  ask(8, 71, 22);
  await until('output-ended root rejects a late resize', () => !!answer(8));
  assert.equal(answer(8)?.error, 'closed');
  worker.postMessage({type: 'retire'});
  await until('root admission retirement', () => messages.some(m => m.type === 'retiring'));
  assert.deepEqual(messages.find(m => m.type === 'retiring')?.failures, []);
  ask(9, 71, 22);
  await until('retired root rejects a late resize', () => !!answer(9));
  assert.equal(answer(9)?.error, 'closed');
  const outputEnd = messages[boundary];
  assert.equal(outputEnd.type, 'output-boundary');
  assert.equal(outputEnd.sentBytes, received);
  assert.ok(!messages.slice(boundary + 1).some(m => m.type === 'output'));
  console.log(JSON.stringify({
    installedRootWorker: true, actualCpuWorker: apart, rows: 12, cols: 53,
    liveWindow: resizeAdmitted
      ? {changedRows: 31, changedCols: 93, sigwinch: 2, dropResizeReply, pendingInputRetained: true, lateClosed: true, orderedGeometry: true}
      : {admitted: false, unchangedRows: 12, unchangedCols: 53, lateClosed: true},
    ansi: true, alternateScreen: true, cookedEchoOff: true, rawKeyWithoutEnter: 'q',
    canonicalRestored: true, cookedReply: 'cooked-answer', promptMode: promptMode & ICANON ? 'line' : 'raw',
    recoveredAfterCtrlC: 42,
    outputBoundaryBytes: received, admissionRetired: true,
  }));
} finally { await worker.terminate(); }
