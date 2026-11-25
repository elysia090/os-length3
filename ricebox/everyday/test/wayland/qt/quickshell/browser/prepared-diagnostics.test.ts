import assert from 'node:assert/strict';
import {test} from 'node:test';
import {rasterFile} from '../../../support/mirror-raster.ts';
import {PreparedClickDiagnostics} from './prepared-diagnostics.ts';

const indexSha256 = 'ab'.repeat(32), path = '/usr/lib/exact.so', origin = 'cd'.repeat(32) + '_4096_24';
const text = {role: 'library', address: 0x801000, bias: 0x800000, offset: 0x2000, length: 0x100} as const;
const contact = Uint8Array.of(1, 3, 4);
const raster = (sequence: number, width = 32, height = 24) => {
  const bytes = new Uint8Array(16 + width * height * 4), head = new DataView(bytes.buffer);
  bytes.set([82, 66, 70, 49]);
  [sequence, width, height].forEach((n, i) => head.setUint32(4 + 4 * i, n, true));
  return [{path: rasterFile, bytes}];
};

test('first-click receipt attributes only live window and gives no fake ELF identity', () => {
  const diagnostic = new PreparedClickDiagnostics(indexSha256, [{path, origin}]), {trace} = diagnostic;
  diagnostic.input(contact);
  diagnostic.frame(raster(1));
  diagnostic.input(Uint8Array.of(2, 4, 4)); // resize
  diagnostic.input(Uint8Array.of(1, 32, 4)); // outside raster
  trace.record(origin, text, text.address + 7, 'used'); // startup never appears
  assert.equal(trace.recording, false);
  diagnostic.input(contact);
  assert.equal(trace.recording, true);
  trace.record(origin, text, text.address + 9, 'entry-mismatch');
  trace.record('unverified-origin', text, text.address + 12, 'no-piece');
  assert.equal(diagnostic.frame(raster(1)), undefined); // repeating the raster does not close the window
  assert.equal(diagnostic.frame([...raster(2), ...raster(3)]), undefined); // canvas rejects an ambiguous batch
  assert.deepEqual(diagnostic.frame(raster(2)), {indexSha256, end: 'raster', fromSequence: 1, toSequence: 2, omitted: 0, samples: [
    {elf: {path, origin}, relativePc: 0x1009, fileOffset: 0x2009, decision: 'entry-mismatch'},
    {elf: null, relativePc: 0x100c, fileOffset: 0x200c, decision: 'no-piece'},
  ]});
  diagnostic.input(contact);
  trace.record(origin, text, text.address + 11, 'used');
  assert.equal(diagnostic.frame(raster(3)), undefined);
  assert.equal(diagnostic.finish('closed'), undefined);
});

test('receipt is bounded and cannot claim a geometry change as a matching raster', () => {
  const diagnostic = new PreparedClickDiagnostics(indexSha256, [{path, origin}]);
  diagnostic.frame(raster(1));
  diagnostic.input(contact);
  for (let i = 0; i < 700; i++) diagnostic.trace.record(origin, text, text.address + 7, 'no-piece');
  const receipt = diagnostic.frame(raster(2, 30));
  assert.equal(receipt?.end, 'geometry-changed');
  assert.equal(receipt?.samples.length, 512);
  assert.equal(receipt?.omitted, 188);
  const interrupted = new PreparedClickDiagnostics(indexSha256, [{path, origin}]);
  interrupted.frame(raster(1));
  interrupted.input(contact);
  assert.deepEqual(interrupted.finish('error'), {indexSha256, end: 'error', fromSequence: 1, toSequence: undefined, samples: [], omitted: 0});
});
