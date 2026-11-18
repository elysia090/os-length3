import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {verifiedCaptureCandidate, type CaptureCandidatePin} from '../../runtime/host/node/capture-artifact.ts';
import {memoryHost} from '../../runtime/linux/memory-host.ts';

const candidate = process.env.SODS_CAPTURE_CANDIDATE_WASM;
const normal = process.env.SODS_LINUX_WASM;
const probe = process.env.SODS_QUEUED_WORKER_PROBE_WASM;
const skip = candidate ? false : 'Requires the explicit capture-v1 candidate artifact';
const pin = (source: Uint8Array): CaptureCandidatePin => ({kind: 'sods-linux-capture-candidate-v1',
  byteLength: source.byteLength, sha256: createHash('sha256').update(source).digest('hex')});
const wireName = 'sods.linux.capture';

function customSection(name: string, bytes: Uint8Array) {
  const label = new TextEncoder().encode(name);
  const length = 1 + label.length + bytes.length;
  assert.ok(length < 128, 'fixture uses one byte LEB lengths');
  return new Uint8Array([0, length, label.length, ...label, ...bytes]);
}

function append(source: Uint8Array, tail: Uint8Array) {
  const bytes = new Uint8Array(source.length + tail.length);
  bytes.set(source); bytes.set(tail, source.length);
  return bytes;
}

test('exact pinned candidate admits Rust selection, never ordinary or captured startup', {skip}, () => {
  const source = new Uint8Array(readFileSync(candidate!));
  // CI supplies these independently from the trusted build. The loader
  // never treats a checksum accompanying an artifact download as trust.
  assert.ok(process.env.SODS_CAPTURE_CANDIDATE_SHA256 && process.env.SODS_CAPTURE_CANDIDATE_BYTES);
  const expected: CaptureCandidatePin = {kind: 'sods-linux-capture-candidate-v1',
    sha256: process.env.SODS_CAPTURE_CANDIDATE_SHA256, byteLength: Number(process.env.SODS_CAPTURE_CANDIDATE_BYTES)};
  const altered = source.slice(); altered[altered.length - 1] ^= 1;
  assert.throws(() => verifiedCaptureCandidate(altered, expected), /digest/);
  assert.throws(() => verifiedCaptureCandidate(source.slice(1), expected), /length/);
  const verified = verifiedCaptureCandidate(source, expected);
  source.fill(0); // Verification compiled the owned, exact snapshot.
  assert.throws(() => memoryHost(verified, 1, 1), /capture candidate/i);
  const names = new Set(WebAssembly.Module.exports(verified).map(x => x.name));
  assert.deepEqual([...names].filter(name => name.startsWith('linux_sendfile_')), [],
    'the capture-only candidate exposes no physical sendfile route, not even a negative qualifier');
  for (const forbidden of ['linux_sendfile_probe', 'linux_queued_worker_probe_write',
    'linux_startup_begin', 'linux_startup_begin_stdio', 'linux_capture_startup',
    'linux_execution_create']) assert.ok(!names.has(forbidden));
  const e = new WebAssembly.Instance(verified).exports;
  const call = (name: string, ...args: (number | bigint)[]) => (e[name] as (...args: (number | bigint)[]) => number)(...args);
  const result = () => (e.linux_result as () => bigint)();
  assert.equal(call('linux_capture_candidate'), 1);
  assert.equal(call('linux_capture_select', 1), -9);
  assert.equal(call('linux_init', 1, 8), 0);
  assert.equal(call('linux_bind', 1n), -12);
  assert.equal(call('linux_capture_select', 2), -12);
  assert.equal(call('linux_prepared_files', 8, 8, 4096, 8, 32, 32, 2, 8, 1, 64, 0), -12);
  assert.equal(call('linux_capture_select', 1), 0);
  assert.equal(call('linux_capture_select', 1), -4);
  assert.equal(call('linux_init', 1, 8), -9);
  assert.equal(call('linux_run_start', 1n), -11, 'selecting a candidate does not create an execution');
  assert.equal(call('linux_prepared_files', 8, 8, 4096, 8, 32, 32, 2, 8, 1, 64, 0), 0);
  assert.notEqual(result(), 0n);
});

test('candidate metadata rejects duplicates, incompatible revisions and premature ready claims', {skip}, () => {
  const source = new Uint8Array(readFileSync(candidate!));
  const sections = WebAssembly.Module.customSections(new WebAssembly.Module(source), wireName);
  assert.equal(sections.length, 1);
  const wire = new Uint8Array(sections[0]!);
  const frame = customSection(wireName, wire);
  const duplicate = append(source, frame);
  assert.throws(() => verifiedCaptureCandidate(duplicate, pin(duplicate)), /identity/);
  const frameAt = Buffer.from(source).indexOf(frame);
  assert.ok(frameAt >= 0 && Buffer.from(source).lastIndexOf(frame) === frameAt);
  const at = frameAt + frame.length - wire.length;
  for (const [byte, value] of [[8, 6], [9, 2], [10, 2], [11, 1]] as const) {
    const changed = source.slice(); changed[at + byte] = value;
    assert.throws(() => verifiedCaptureCandidate(changed, pin(changed)), /identity/);
  }
});

test('ordinary artifact with candidate metadata still cannot pass the surface gate', {
  skip: normal ? false : 'Requires the ordinary artifact',
}, () => {
  const underlying = new Uint8Array(readFileSync(normal!));
  const altered = append(underlying, customSection(wireName, new Uint8Array([83, 79, 68, 83, 67, 65, 80, 0, 7, 1, 1, 0])));
  assert.throws(() => verifiedCaptureCandidate(altered, pin(altered)), /surface/);
});

for (const [name, path] of [['ordinary', normal], ['fixture', probe]] as const) {
  test(`${name} artifact cannot impersonate the Rust capture candidate even with matching bytes`, {
    skip: path ? false : `Requires the ${name} artifact`,
  }, () => {
    const source = new Uint8Array(readFileSync(path!));
    assert.throws(() => verifiedCaptureCandidate(source, pin(source)), /capture candidate|probe/i);
  });
}
