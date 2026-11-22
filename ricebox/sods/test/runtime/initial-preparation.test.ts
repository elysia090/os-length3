import assert from 'node:assert/strict';
import {test} from 'node:test';
import {E, FsError} from '../../runtime/linux/fs.ts';
import {ImageSourceChangedError, Kernel} from '../../runtime/linux/process.ts';
import {prepare} from '../../runtime/translation/share.ts';
import {initialPreparationFor, loadTranslator} from '../../runtime/translation/translator.ts';

const header = [0, 97, 115, 109, 1, 0, 0, 0];
const name = (text: string) => [text.length, ...new TextEncoder().encode(text)];
const section = (id: number, bytes: number[]) => [id, bytes.length, ...bytes];
const body = (code: number[]) => [code.length + 2, 0, ...code, 0x0b];
const execSource = (response: Uint8Array) => Uint8Array.of(0x7f, 0x45, 0x4c, 0x46, ...response);
const quiet = {read: () => null, write() {}};

// The normal translator response ABI with one reused output buffer. The
// supplied bytes stand in for that output, not a guest ELF to be executed.
function responseModule(status: 0 | 1, prefix = 0): WebAssembly.Module {
  const i32 = 0x7f;
  const functions = ['sods_alloc', 'sods_translate', 'sods_output_ptr', 'sods_output_len', 'sods_budget', 'sods_run'];
  return new WebAssembly.Module(Uint8Array.of(...header,
    ...section(1, [4, 0x60, 1, i32, 1, i32, 0x60, 2, i32, i32, 1, i32, 0x60, 0, 1, i32, 0x60, 1, i32, 0]),
    ...section(3, [5, 0, 1, 2, 2, 3]),
    ...section(5, [1, 0, 1]),
    ...section(6, [1, i32, 1, 0x41, 0, 0x0b]),
    ...section(7, [1 + functions.length, ...name('memory'), 2, 0,
      ...functions.flatMap((fn, k) => [...name(fn), 0, Math.min(k, 4)])]),
    ...section(10, [5, ...body([0x41, 0]), ...body([0x20, 1, 0x24, 0, 0x41, status]),
      ...body([0x41, prefix]), ...body([0x23, 0, 0x41, prefix, 0x6b]), ...body([])]),
  ));
}

function guestWasm(value: number, maximum = true): Uint8Array<ArrayBuffer> {
  return Uint8Array.of(...header,
    ...section(2, [1, ...name('env'), ...name('memory'), 2, ...(maximum ? [1, 1, 2] : [0, 1])]),
    ...section(11, [1, 0, 0x41, 0, 0x0b, 2, value, value + 1]),
    ...section(0, [...name('witness'), value]),
    ...section(0, [...name('sods.facts'), 0x7b, 0x7d]),
  );
}

test('static preparation and the public raw result remain owned after the output buffer is reused', async () => {
  const translate = await loadTranslator(responseModule(0)), select = initialPreparationFor(translate);
  assert.ok(select);
  const first = guestWasm(7), later = guestWasm(91), raw = translate(first);
  assert.equal(initialPreparationFor(() => raw), undefined, 'a custom function does not supply a private view');
  for (const shared of [false, true]) {
    const want = prepare(first, {shared}), staged = select(first, shared);
    assert.ok(!('preparationError' in staged));
    assert.deepEqual(staged, want);
    assert.ok(staged.segments?.length);
    assert.deepEqual(translate(later), later);
    assert.deepEqual(staged, want, 'neither the prepared module nor its segments alias the reused memory');
    assert.deepEqual(raw, first, 'the ordinary public result still owns an independent snapshot');
    new WebAssembly.Module(staged.wasm);
  }
});

test('preparation failure is distinct from the translator declining an input', async () => {
  const brokenPrep = await loadTranslator(responseModule(0)), prepareFirst = initialPreparationFor(brokenPrep)!;
  const inlineOnly = guestWasm(7, false);
  assert.ok(!('preparationError' in prepareFirst(inlineOnly, false)));
  const failure = prepareFirst(inlineOnly, true);
  assert.ok('preparationError' in failure);
  assert.match(String(failure.preparationError), /shared memory needs a maximum/);
  assert.equal(brokenPrep.notProgram(failure.preparationError), false);
  const refusing = await loadTranslator(responseModule(1));
  const message = new TextEncoder().encode('declined by the fixture');
  assert.throws(() => initialPreparationFor(refusing)!(message, false), refusing.notProgram);
});

test('static images match the raw path in inline and shared kernels', async () => {
  const translate = await loadTranslator(responseModule(0, 4)), response = guestWasm(11);
  for (const shared of [false, true]) {
    const kernel = new Kernel({translate, console: quiet});
    kernel.shared = shared;
    const source = kernel.vfs.writeFile('/program', execSource(response), 0o755);
    source.origin = 'unchanged root source';
    const image = kernel.image(source), want = prepare(response, {shared});
    assert.deepEqual(image.wasm, want.wasm);
    assert.deepEqual(image.segments, want.segments);
    translate(execSource(guestWasm(90)));
    assert.equal(kernel.image(source), image);
    assert.deepEqual(image.wasm, want.wasm);
    assert.deepEqual(image.segments, want.segments);
  }
});

test('custom prepare and shared accessors run once on the owned raw path', async () => {
  const translate = await loadTranslator(responseModule(0, 4)), response = guestWasm(11);
  for (const property of ['prepare', 'shared']) {
    const kernel = new Kernel({translate, console: quiet});
    const source = kernel.vfs.writeFile('/program', execSource(response), 0o755);
    let reads = 0;
    Object.defineProperty(kernel, property, {get() {
      reads++;
      translate(execSource(guestWasm(90)));
      return property === 'shared' ? true : (raw: Uint8Array) => {
        assert.deepEqual(raw, response);
        return prepare(raw, {shared: false});
      };
    }});
    assert.deepEqual(kernel.image(source).segments, prepare(response).segments);
    assert.equal(reads, 1);
  }
});

test('custom translator access stays in the translation try and error classifier', async () => {
  const ordinary = await loadTranslator(responseModule(0, 4)), rejected = new Error('custom translator lookup');
  for (const inherited of [false, true]) {
    const kernel = new Kernel({translate: ordinary, console: quiet});
    const source = kernel.vfs.writeFile('/program', execSource(guestWasm(11)), 0o755);
    let reads = 0, classified = 0;
    const classifiedTranslator = Object.assign(ordinary.bind(null), {notProgram(error: unknown) {
      classified++;
      return error === rejected;
    }});
    const owner = inherited ? Object.create(Kernel.prototype) : kernel;
    if (inherited) {
      Reflect.deleteProperty(kernel, 'translate');
      Object.setPrototypeOf(kernel, owner);
    }
    Object.defineProperty(owner, 'translate', {get() {
      if (++reads === 2) throw rejected;
      return classifiedTranslator;
    }});
    assert.throws(() => kernel.image(source), (error: unknown) => error instanceof FsError && error.errno === E.NOEXEC);
    assert.equal(reads, 3);
    assert.equal(classified, 1);
  }
});

test('host-provided byte lengths can choose preparation on the ordinary raw path', async () => {
  const translate = await loadTranslator(responseModule(0, 4)), response = guestWasm(11);
  for (const custom of ['own', 'subclass']) {
    const kernel = new Kernel({translate, console: quiet});
    const source = kernel.vfs.writeFile('/program', execSource(response), 0o755);
    source.origin = 'unchanged root source';
    const length = source.size;
    class HostBytes extends Uint8Array {}
    const bytes = custom === 'own' ? execSource(response) : new HostBytes(execSource(response));
    Object.defineProperty(custom === 'own' ? bytes : HostBytes.prototype, 'length', {get() {
      kernel.shared = true;
      return length;
    }});
    source.share = () => bytes;
    assert.deepEqual(kernel.image(source).wasm, prepare(response, {shared: true}).wasm);
  }
});

test('custom prepare keeps its source fence and preparation errors do not ask the classifier', async () => {
  const translate = await loadTranslator(responseModule(0, 4));
  const kernel = new Kernel({translate, console: quiet});
  kernel.shared = true;
  let classifications = 0;
  translate.notProgram = () => { classifications++; return true; };
  const inlineOnly = kernel.vfs.writeFile('/inline', execSource(guestWasm(11, false)), 0o755);
  assert.throws(() => kernel.image(inlineOnly), /shared memory needs a maximum/);
  assert.equal(classifications, 0);
  assert.equal(kernel.images.has(inlineOnly), false);

  const refusing = new Kernel({translate: await loadTranslator(responseModule(1, 4)), console: quiet});
  const declined = refusing.vfs.writeFile('/program', execSource(new TextEncoder().encode('fixture declined input')), 0o755);
  assert.throws(() => refusing.image(declined), (error: unknown) => error instanceof FsError && error.errno === E.NOEXEC);

  const changing = kernel.vfs.writeFile('/changing', execSource(guestWasm(9)), 0o755);
  kernel.prepare = (raw) => { changing.write(4, Uint8Array.of(1)); return prepare(raw); };
  assert.throws(() => kernel.image(changing), ImageSourceChangedError);
  assert.equal(kernel.images.has(changing), false);
});
