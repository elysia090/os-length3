"""Browser reader for range-first physical-page bundles."""

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from kernel.pagefabric import (bundle_prefix_size, dump_bundle, project,
                               CiphertextDirectory, CiphertextGroup,
                               CiphertextRankRecord,
                               build_erasure_recovery_directory,
                               dump_ciphertext_directory,
                               encode_ciphertext_frame,
                               encode_ciphertext_row_aad,
                               opaque_row_locator)
from qm.laneops import OPS as LANE_OPS, evaluate as evaluate_lane, shape
from qm.pipeline import solve
from qm.pagearchive import pack_wasm_steps
from qm.steppage import (memory_shape, pack as pack_step,
                         projection_coordinate, relative_layout)
from qm.wasmbinary import index_module
from qm.wasmregions import pack as pack_regions
from qm.wasmphysical import DependencyWaves
from qm.wasmstate import decode_module, start_state
from qm.wasmwave import Operand, PureSlice, WaveExecutor, WaveNode
from vm import run as vm_run
from tests.test_wasmbinary import module as wasm_module


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which('node'), 'node is required')
class TestBrowserPageFabric(unittest.TestCase):
    def test_relative_exchange_resumes_inside_the_bootstrap_vm(self):
        layout = relative_layout((4, 4, 8))
        delta = (64 - 80) & ((1 << 64) - 1)
        saved = 0x1122334455667788
        saved_low = saved & 0xffffffff
        saved_high = saved >> 32
        right64 = (3 + delta) & ((1 << 64) - 1)
        flags = evaluate_lane('lane64.X86_FLAGS', (
            0x246, delta, 3, right64, 64 | (1 << 8)))
        compare_flags = evaluate_lane('lane64.X86_FLAGS', (
            0, 64, 80, delta, 64 | (3 << 8)))
        nodes = (
            WaveNode(1, 'lane64.SUBR', (
                Operand('local', 0), Operand('local', 1))),
            WaveNode(2, 'memory.i64.relative_exchange', (
                Operand('local', 0), Operand('local', 1),
                Operand('node', 1), Operand('local', 2),
                Operand('const', layout), Operand('const', 0xff),
                Operand('const', 2), Operand('local', 3),
                Operand('const', (1 << 64) - 8),
                Operand('local', 4), Operand('local', 3),
                Operand('const', (1 << 64) - 16),
                Operand('const', 0xaabbccddeeff0011))),
            WaveNode(3, 'memory.i64.relative_result', (
                Operand('node', 2), Operand('const', 1))),
            WaveNode(4, 'memory.i64.relative_result', (
                Operand('node', 2), Operand('const', 3))),
            WaveNode(5, 'memory.i64.relative_result', (
                Operand('node', 2), Operand('const', 4))),
            WaveNode(6, 'memory.i64.relative_result', (
                Operand('node', 2), Operand('const', 5))),
            WaveNode(7, 'memory.i64.relative_result', (
                Operand('node', 2), Operand('const', 0xfe))),
            WaveNode(8, 'memory.i64.relative_address', (
                Operand('local', 0), Operand('const', 8),
                Operand('const', (1 << 64) - 4), Operand('const', 8),
                Operand('const', memory_shape(8, virtual64=True)),
                Operand('node', 7))),
            WaveNode(9, 'memory.i64.pre_store', (
                Operand('local', 5), Operand('local', 4),
                Operand('const', 8),
                Operand('const', memory_shape(8, virtual64=True)),
                Operand('node', 8))),
            WaveNode(10, 'lane64.X86_COMPARE', (
                Operand('const', 0), Operand('local', 0),
                Operand('local', 1),
                Operand('const', 64 | (3 << 8)))),
        )
        plan = PureSlice(
            0, 0, 1, 1, 0, nodes,
            DependencyWaves(
                (0, 2, 3, 8, 9, 10),
                (1, 10, 2, 3, 4, 5, 6, 7, 8, 9),
                (0, 1, 2, 3, 3, 3, 3, 3, 4, 5, 1)),
            tuple(Operand('node', value)
                  for value in range(1, 11))
            + (Operand('local', 4),
               Operand('projection', projection_coordinate(2, 3)),
               Operand('projection', projection_coordinate(2, 0xfe)),
               Operand('projection', projection_coordinate(2, 0xfd))),
            tuple(Operand('local', index) for index in range(6)))
        physical = bytes(pack_step(plan))
        page = bytearray(65536)
        page[64:68] = (1).to_bytes(4, 'little')
        page[68:72] = (2).to_bytes(4, 'little')
        page[72:80] = (3).to_bytes(8, 'little')
        page[80:84] = (10).to_bytes(4, 'little')
        page[84:88] = (20).to_bytes(4, 'little')
        page[88:96] = (30).to_bytes(8, 'little')

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            step_path = root / 'relative-step.bin'
            memory_path = root / 'relative-memory.bin'
            step_path.write_bytes(physical)
            memory_path.write_bytes(page)
            driver = root / 'relative-step.mjs'
            wasm = (ROOT / 'web' / 'vm.wasm').as_posix()
            driver.write_text('''\
import { readFileSync } from 'node:fs';
const { instance } = await WebAssembly.instantiate(
  readFileSync(process.argv[2]), {});
const E = instance.exports;
const step = new Uint8Array(readFileSync(process.argv[3]));
const source = new Uint8Array(readFileSync(process.argv[4]));
const session = E.vm_step_acquire();
new Uint8Array(
  E.memory.buffer, E.vm_step_buffer(session), step.length).set(step);
if (!E.vm_step_open(session, step.length)
    || !E.vm_step_memory_open(session, source.length)) {
  throw new Error('relative fixture did not open');
}
const view = new DataView(E.memory.buffer);
const locals = E.vm_step_locals(session);
view.setBigUint64(locals, 64n, true);
view.setBigUint64(locals + 8, 80n, true);
view.setBigUint64(locals + 16, 0x246n, true);
view.setBigUint64(locals + 24, 72n, true);
view.setBigUint64(locals + 32, %dn, true);
view.setBigUint64(locals + 40, 128n, true);
const faults = [];
for (;;) {
  const status = E.vm_step_execute(session, 6, 0);
  if (status === 2) break;
  if (status !== 1) throw new Error(`execute:${status}:${E.vm_step_error(session)}`);
  const lease = E.vm_step_memory_lease(session);
  const page = E.vm_step_memory_page(session, lease);
  const bytes = E.vm_step_memory_page_size(session, lease);
  faults.push(page);
  new Uint8Array(
    E.memory.buffer, E.vm_step_memory_page_buffer(session, lease), bytes,
  ).set(source.subarray(page * 65536, page * 65536 + bytes));
  if (!E.vm_step_supply_memory_page(session, lease, page, bytes)) {
    throw new Error('supply failed');
  }
}
const stack = E.vm_step_stack(session);
const outputs = Array.from({length: 14}, (_, index) =>
  view.getBigUint64(stack + index * 8, true).toString());
const dirtyPage = E.vm_step_first_dirty_memory_page(session);
const lease = E.vm_step_memory_lease(session);
const dirty = new Uint8Array(
  E.memory.buffer, E.vm_step_memory_page_buffer(session, lease),
  E.vm_step_memory_page_size(session, lease),
);
const records = Buffer.from(dirty.slice(64, 96)).toString('hex');
const savedFrame = Buffer.from(dirty.slice(120, 128)).toString('hex');
const savedInjected = Buffer.from(dirty.slice(56, 64)).toString('hex');
E.vm_step_ack_memory_page(session, lease, dirtyPage);
E.vm_step_release(session);
process.stdout.write(JSON.stringify(
  {faults, outputs, dirtyPage, records, savedFrame, savedInjected}));
''' % saved, encoding='utf-8')
            run = subprocess.run(
                ['node', str(driver), wasm, str(step_path), str(memory_path)],
                check=False, capture_output=True, text=True,
                encoding='utf-8')
            self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout), {
            'faults': [0],
            'outputs': [
                str(delta), str(flags),
                str((saved_low + delta) & 0xffffffff),
                str((saved_high + delta) & 0xffffffff),
                str(30 - delta & ((1 << 64) - 1)), str(right64),
                str(26 | (36 << 32)),
                str(64 + 8 + ((30 - delta) & ((1 << 64) - 4))),
                '120', str(compare_flags),
                str(saved),
                str((saved_high + delta) & 0xffffffff),
                str(26 | (36 << 32)),
                str(0xaabbccddeeff0011),
            ],
            'dirtyPage': 0,
            'records': (
                (10 - delta & 0xffffffff).to_bytes(4, 'little')
                + (20 - delta & 0xffffffff).to_bytes(4, 'little')
                + (30 - delta & ((1 << 64) - 1)).to_bytes(8, 'little')
                + ((saved_low + delta) & 0xffffffff).to_bytes(4, 'little')
                + ((saved_high + delta) & 0xffffffff).to_bytes(4, 'little')
                + right64.to_bytes(8, 'little')).hex(),
            'savedFrame': saved.to_bytes(8, 'little').hex(),
            'savedInjected': (0xaabbccddeeff0011).to_bytes(
                8, 'little').hex(),
        })

    def test_secure_projection_recovers_ciphertext_through_the_vm_artifact(self):
        source = (Path(__file__).resolve().parents[3] / 'corpus' / 'storage'
                  / 'erasure_gf256_mul.c').read_text(encoding='utf-8')
        solved = solve(source, frontend='cfront')
        self.assertTrue(solved['ok'], solved.get('error'))
        target = next(item for item in solved['targets']
                      if item['name'] == 'wasm32' and item.get('ok'))
        artifact = vm_run.artifact_for(
            target['seq'], solved['frontend']['input_bits'],
            solved['frontend']['output_bits'])
        geometry = build_erasure_recovery_directory(2, 1)
        payload = b'A' * 64 + bytes(64) + b'B' * 64 + b'A' * 64

        with tempfile.TemporaryDirectory() as root:
            driver = Path(root) / 'secure-projector.mjs'
            modules = {
                'projector': (ROOT / 'web' / 'ciphertext-projector.js').as_uri(),
                'storage': (ROOT / 'web' / 'ciphertext-storage.js').as_uri(),
                'directory': (ROOT / 'web' / 'ciphertext-directory.js').as_uri(),
                'recovery': (ROOT / 'web' / 'erasure-recovery.js').as_uri(),
            }
            fixture = {
                'payload': payload.hex(), 'artifact': artifact.hex(),
                'ordinals': list(geometry.ordinal_by_mask),
                'coefficients': geometry.coefficients.hex(),
                'generator': geometry.generator.hex(),
            }
            driver.write_text(f'''\
import {{ readFileSync }} from 'node:fs';
const P = await import({json.dumps(modules['projector'])});
const C = await import({json.dumps(modules['storage'])});
const D = await import({json.dumps(modules['directory'])});
const R = await import({json.dumps(modules['recovery'])});
const F = {json.dumps(fixture)};
const unhex = value => new Uint8Array(Buffer.from(value, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
const geometry = {{
  dataShards: 2, parityShards: 1,
  ordinalByMask: Int16Array.from(F.ordinals),
  coefficients: unhex(F.coefficients), generator: unhex(F.generator),
}};
const module = await WebAssembly.compile(
  readFileSync({json.dumps((ROOT / 'web' / 'vm.wasm').as_posix())}),
);
const store = new C.MemoryCiphertextStore();
const masterKey = await C.importStorageMasterKey(new Uint8Array(32));
const projected = await P.projectCiphertextObject({{
  payload: unhex(F.payload), masterKey,
  volumeSalt: new Uint8Array(32).fill(0x56),
  volumeId: new Uint8Array(16).fill(0x49), generation: 3n,
  stores: [store], gfArtifact: unhex(F.artifact), geometries: [geometry],
  precompiled: module, pageBytes: 64, quantum: 64,
  dataShards: 2, parityShards: 1,
  objectSalt: new Uint8Array(32).fill(0x53),
}});
const openedDirectory = await C.openMetadataObject(
  projected.metadataKey, projected.directoryEnvelope, projected.metadataAad,
);
const directory = D.decodeCiphertextDirectory(openedDirectory);
const recovery = await R.createErasureRecovery({{
  artifact: unhex(F.artifact), geometries: directory.geometries,
  precompiled: module,
}});
const fabric = new C.CiphertextPageFabric({{
  directory, key: projected.rowKey,
  authenticatorKey: projected.authenticatorKey, tiers: [store],
  recoverCiphertext: recovery,
}});
const direct = await fabric.read(0, fabric.length);

const missing = directory.rows[1];
const reducedStore = new C.MemoryCiphertextStore();
for (let group = 0; group < directory.groups.length; group += 1) {{
  for (let slot = 0; slot < directory.groups[group].rows.length; slot += 1) {{
    if (group === missing.group && slot === missing.slot) continue;
    const locator = directory.groups[group].rows[slot].locator;
    const row = await store.get(locator);
    await reducedStore.put(locator, row.row, row.authenticator);
  }}
}}
const recoveredFabric = new C.CiphertextPageFabric({{
  directory, key: projected.rowKey,
  authenticatorKey: projected.authenticatorKey, tiers: [reducedStore],
  recoverCiphertext: recovery,
}});
const recovered = await recoveredFabric.read(0, recoveredFabric.length);
console.log(JSON.stringify({{
  direct: hex(direct), recovered: hex(recovered),
  ranks: Array.from(directory.ranks), groups: directory.groups.length,
  storedRows: store.rows.size, recoveredRows: recoveredFabric.recoveredRows,
  erasureCalls: projected.erasureCalls,
  recoveryCalls: recovery.calls(), recoveryMisses: recovery.misses(),
  directoryRoundtrip:
    hex(D.encodeCiphertextDirectory(directory)) === hex(openedDirectory),
}}));
''', encoding='utf-8')
            run = subprocess.run(
                ['node', str(driver)],
                capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
        result = json.loads(run.stdout)
        self.assertEqual(result['direct'], payload.hex())
        self.assertEqual(result['recovered'], payload.hex())
        self.assertEqual(result['ranks'], [1, 0, 2, 1])
        self.assertEqual(result['groups'], 1)
        self.assertEqual(result['storedRows'], 3)
        self.assertEqual(result['recoveredRows'], 1)
        self.assertEqual(result['erasureCalls'], 2 * (64 + 16))
        self.assertEqual(result['recoveryCalls'], 2 * (64 + 16))
        self.assertLessEqual(result['recoveryMisses'], 512)
        self.assertTrue(result['directoryRoundtrip'])

    def test_encrypted_directory_wire_matches_the_python_canonical_form(self):
        digest = hashlib.sha256(b'directory object').digest()
        directory = CiphertextDirectory(
            b'S' * 32, digest, 4, 190, 64, 64,
            (1, 0, 2),
            (CiphertextRankRecord(0, 0, 0, 23),
             CiphertextRankRecord(0, 1, 1, 41)),
            (CiphertextGroup(
                2, 1, 2, 128,
                (b'A' * 32, b'B' * 32, b'C' * 32)),),
            (build_erasure_recovery_directory(2, 1),))
        encoded = dump_ciphertext_directory(directory)

        with tempfile.TemporaryDirectory() as root:
            driver = Path(root) / 'directory.mjs'
            storage_module = (ROOT / 'web' / 'ciphertext-storage.js').as_uri()
            directory_module = (ROOT / 'web' / 'ciphertext-directory.js').as_uri()
            driver.write_text(f'''\
const C = await import({json.dumps(storage_module)});
const D = await import({json.dumps(directory_module)});
const unhex = value => new Uint8Array(Buffer.from(value, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
const plaintext = unhex({json.dumps(encoded.hex())});
const key = await C.importRowKey(new Uint8Array(32));
const aad = C.encodeObjectMetadataAad({{
  volumeId: new Uint8Array(16), objectSalt: new Uint8Array(32).fill(0x53),
  objectDigest: unhex({json.dumps(digest.hex())}), generation: 4n,
}});
const envelope = await C.sealMetadataObject(key, plaintext, aad);
const opened = await C.openMetadataObject(key, envelope, aad);
const decoded = D.decodeCiphertextDirectory(opened);
const roundtrip = D.encodeCiphertextDirectory(decoded);
let trailingRejected = false;
try {{
  D.decodeCiphertextDirectory(
    new Uint8Array([...opened, 0]),
  );
}} catch (_error) {{ trailingRejected = true; }}
console.log(JSON.stringify({{
  roundtrip: hex(roundtrip), generation: decoded.generation.toString(),
  logicalPages: decoded.ranks.length, ranks: Array.from(decoded.ranks),
  groups: decoded.groups.length, geometries: decoded.geometries.length,
  providerSeesPlaintext: hex(envelope).includes(hex(plaintext)),
  trailingRejected,
}}));
''', encoding='utf-8')
            run = subprocess.run(
                ['node', str(driver)], check=True,
                capture_output=True, text=True)
        self.assertEqual(json.loads(run.stdout), {
            'roundtrip': encoded.hex(), 'generation': '4',
            'logicalPages': 3, 'ranks': [1, 0, 2],
            'groups': 1, 'geometries': 1,
            'providerSeesPlaintext': False, 'trailingRejected': True,
        })

    def test_standard_aead_is_the_only_plaintext_admission_boundary(self):
        raw = b'A' * 64
        digest = hashlib.sha256(raw).digest()
        key = bytes(range(32))
        locator_key = bytes(range(32, 64))
        auth_key = bytes(range(64, 96))
        volume = b'V' * 16
        object_salt = b'\xa5' * 32
        object_digest = hashlib.sha256(b'object').digest()
        frame = encode_ciphertext_frame(0, len(raw), digest, raw)
        capacity = ((len(frame) + 63) // 64) * 64
        row_class = capacity // 64
        aad = encode_ciphertext_row_aad(
            object_salt, object_digest, 7, 0, 0, row_class,
            capacity, 0, len(raw), len(raw))
        locator = opaque_row_locator(
            locator_key, volume, object_salt, object_digest, 7, 0, 0)

        with tempfile.TemporaryDirectory() as directory:
            driver = Path(directory) / 'ciphertext.mjs'
            module = (ROOT / 'web' / 'ciphertext-storage.js').as_uri()
            fixture = {
                'raw': raw.hex(), 'digest': digest.hex(), 'key': key.hex(),
                'locatorKey': locator_key.hex(), 'volume': volume.hex(),
                'authKey': auth_key.hex(),
                'objectSalt': object_salt.hex(), 'rowClass': row_class,
                'objectDigest': object_digest.hex(), 'frame': frame.hex(),
                'capacity': capacity, 'aad': aad.hex(),
                'locator': locator.hex(),
            }
            driver.write_text(f'''\
const C = await import({json.dumps(module)});
const F = {json.dumps(fixture)};
const unhex = (value) => new Uint8Array(Buffer.from(value, 'hex'));
const hex = (value) => Buffer.from(value).toString('hex');
const key = await C.importRowKey(unhex(F.key));
const locatorKey = await C.importLocatorKey(unhex(F.locatorKey));
const authKey = await C.importRowAuthenticatorKey(unhex(F.authKey));
const masterKey = await C.importStorageMasterKey(unhex(F.key));
const volumeKeys = await C.deriveVolumeStorageKeys(
  masterKey, unhex(F.authKey), unhex(F.volume),
);
const objectSalt = unhex(F.objectSalt);
const objectKeys = await C.deriveObjectStorageKeys(
  masterKey, objectSalt, unhex(F.volume), unhex(F.objectDigest), 7n,
);
const frame = C.encodeCiphertextFrame(
  0, unhex(F.raw).length, unhex(F.digest), unhex(F.raw),
);
const padded = new Uint8Array(F.capacity); padded.set(frame);
const aad = C.encodeCiphertextRowAad({{
  objectSalt, objectDigest: unhex(F.objectDigest), generation: 7n,
  group: 0, slot: 0, rowClass: F.rowClass,
  capacity: F.capacity, codec: 0,
  canonicalExtent: unhex(F.raw).length, encodedExtent: unhex(F.raw).length,
}});
const projection = new C.ImmutableObjectProjection({{
  rowKey: key, authenticatorKey: authKey, locatorKey,
  volumeId: unhex(F.volume), objectSalt,
  objectDigest: unhex(F.objectDigest), generation: 7n,
}});
const sealed = await projection.sealRow({{
  group: 0, slot: 0, rowClass: F.rowClass, capacity: F.capacity, codec: 0,
  canonicalExtent: unhex(F.raw).length,
  encodedExtent: unhex(F.raw).length, paddedFrame: padded,
}});
const {{ ciphertext, authenticator, locator: locatorBytes }} = sealed;
const retried = await projection.retryRow(0, 0);
let duplicateSealRejected = false;
try {{
  await projection.sealRow({{
    group: 0, slot: 0, rowClass: F.rowClass, capacity: F.capacity, codec: 0,
    canonicalExtent: unhex(F.raw).length,
    encodedExtent: unhex(F.raw).length, paddedFrame: padded,
  }});
}} catch (_error) {{ duplicateSealRejected = true; }}
const memoryTier = new C.MemoryCiphertextStore();
const remoteTier = new C.MemoryCiphertextStore();
const changedCache = ciphertext.slice(); changedCache[0] ^= 1;
await memoryTier.put(locatorBytes, changedCache, authenticator);
await remoteTier.put(locatorBytes, ciphertext, authenticator);
const fetched = await C.fetchAuthenticatedRow(
  [memoryTier, remoteTier], authKey, locatorBytes,
);
const admitted = await C.admitCiphertextRow({{
  key, group: 0, slot: 0, aad,
  reconstructedCiphertext: fetched.ciphertext,
}});
const fabric = new C.CiphertextPageFabric({{
  directory: {{
    objectSalt, objectDigest: unhex(F.objectDigest), generation: 7n,
    algorithm: C.STORAGE_ALGORITHM_AES_256_GCM,
    length: unhex(F.raw).length, pageBytes: unhex(F.raw).length,
    ranks: new Uint32Array([1]),
    rows: [null, {{
      group: 0, slot: 0, codec: 0,
      encodedExtent: unhex(F.raw).length,
    }}],
    groups: [{{
      dataShards: 1, parityShards: 1,
      rowClass: F.rowClass, capacity: F.capacity,
      rows: [{{ locator: locatorBytes }}, {{ locator: new Uint8Array(32) }}],
    }}],
  }},
  key, authenticatorKey: authKey, tiers: [memoryTier, remoteTier],
}});
const fabricRead = await fabric.read(3, 5);
const coldTier = new C.MemoryCiphertextStore();
const recoveryFabric = new C.CiphertextPageFabric({{
  directory: fabric.directory, key, authenticatorKey: authKey,
  tiers: [coldTier],
  recoverCiphertext: async () => ciphertext,
}});
const recoveredRead = await recoveryFabric.read(1, 3);
let missingWithoutVmRejected = false;
try {{
  await new C.CiphertextPageFabric({{
    directory: fabric.directory, key, authenticatorKey: authKey,
    tiers: [coldTier],
  }}).read(0, 1);
}} catch (_error) {{ missingWithoutVmRejected = true; }}
const changed = ciphertext.slice(); changed[0] ^= 1;
let tamperRejected = false;
try {{
  await C.admitCiphertextRow({{
    key, group: 0, slot: 0, aad, reconstructedCiphertext: changed,
  }});
}} catch (_error) {{ tamperRejected = true; }}
const opaque = await C.opaqueRowLocator(
  locatorKey, unhex(F.volume), objectSalt, unhex(F.objectDigest), 7n, 0, 0,
);
const rootAad = C.encodeVolumeRootAad({{
  volumeId: unhex(F.volume), volumeSalt: unhex(F.authKey),
}});
const metadataAad = C.encodeObjectMetadataAad({{
  volumeId: unhex(F.volume), objectSalt,
  objectDigest: unhex(F.objectDigest), generation: 7n,
}});
const root = new TextEncoder().encode('fixed root descriptor');
const metadata = new TextEncoder().encode('encrypted direct directory');
const metadataEnvelope = await C.sealMetadataObject(key, metadata, metadataAad);
const openedMetadata = await C.openMetadataObject(
  key, metadataEnvelope, metadataAad,
);
const derivedMetadataEnvelope = await C.sealMetadataObject(
  volumeKeys.metadataKey, metadata, metadataAad,
);
const derivedMetadata = await C.openMetadataObject(
  volumeKeys.metadataKey, derivedMetadataEnvelope, metadataAad,
);
const derivedProjection = new C.ImmutableObjectProjection({{
  rowKey: objectKeys.rowKey, authenticatorKey: objectKeys.authenticatorKey,
  locatorKey: volumeKeys.locatorKey, volumeId: unhex(F.volume), objectSalt,
  objectDigest: unhex(F.objectDigest), generation: 7n,
}});
const derivedCiphertext = (await derivedProjection.sealRow({{
  group: 0, slot: 0, rowClass: F.rowClass, capacity: F.capacity, codec: 0,
  canonicalExtent: unhex(F.raw).length,
  encodedExtent: unhex(F.raw).length, paddedFrame: padded,
}})).ciphertext;
const derivedOpened = await C.openCiphertextRow(
  objectKeys.rowKey, 0, 0, aad, derivedCiphertext,
);
const register = new C.MemoryOpaqueRootRegister();
const preparedRoot = await C.prepareRootPublication({{
  key, descriptor: root, additionalData: rootAad,
}});
const envelope = await C.commitRootPublication({{
  register, envelope: preparedRoot,
}});
const retriedRoot = await C.commitRootPublication({{
  register, envelope: preparedRoot,
}});
const openedRoot = await C.openRootDescriptor(key, envelope, rootAad);
const nextLeft = new TextEncoder().encode('left root descriptor');
const nextRight = new TextEncoder().encode('right root descriptor');
const leftEnvelope = await C.prepareRootPublication({{
  key, descriptor: nextLeft, additionalData: rootAad,
}});
const rightEnvelope = await C.prepareRootPublication({{
  key, descriptor: nextRight, additionalData: rootAad,
}});
const outcomes = await Promise.allSettled([
  C.commitRootPublication({{
    register, expectedEnvelope: envelope, envelope: leftEnvelope,
  }}),
  C.commitRootPublication({{
    register, expectedEnvelope: envelope, envelope: rightEnvelope,
  }}),
]);
const current = await register.read();
const openedCurrent = await C.openRootDescriptor(key, current, rootAad);
console.log(JSON.stringify({{
  frame: hex(frame), aad: hex(aad), locator: hex(opaque),
  admitted: hex(admitted), tamperRejected,
  fabricRead: hex(fabricRead), releasedPages: fabric.releaseResident(),
  recoveredRead: hex(recoveredRead),
  recoveredRows: recoveryFabric.recoveredRows,
  missingWithoutVmRejected,
  authenticatorBytes: authenticator.length,
  rejectedTiers: fetched.rejected, selectedTier: fetched.tier,
  promotedCiphertext:
    hex((await memoryTier.get(locatorBytes)).row) === hex(ciphertext),
  retryIsImmutable:
    hex(retried.ciphertext) === hex(ciphertext)
      && hex(retried.authenticator) === hex(authenticator),
  duplicateSealRejected,
  rootRetryIsIdempotent: hex(retriedRoot) === hex(envelope),
  root: new TextDecoder().decode(openedRoot),
  metadata: new TextDecoder().decode(openedMetadata),
  derivedMetadata: new TextDecoder().decode(derivedMetadata),
  derivedFrameMatches: hex(derivedOpened) === hex(padded),
  providerSeesMetadata:
    new TextDecoder().decode(metadataEnvelope).includes('direct directory'),
  publishStates: outcomes.map((outcome) => outcome.status).sort(),
  currentRoot: new TextDecoder().decode(openedCurrent),
  providerSeesPlaintext: new TextDecoder().decode(current).includes('descriptor'),
}}));
''', encoding='utf-8')
            run = subprocess.run(
                ['node', str(driver)],
                capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
        result = json.loads(run.stdout)
        current = result.pop('currentRoot')
        self.assertIn(current, ('left root descriptor', 'right root descriptor'))
        self.assertEqual(result, {
            'frame': frame.hex(), 'aad': aad.hex(),
            'locator': locator.hex(), 'admitted': raw.hex(),
            'tamperRejected': True, 'root': 'fixed root descriptor',
            'metadata': 'encrypted direct directory',
            'derivedMetadata': 'encrypted direct directory',
            'derivedFrameMatches': True,
            'providerSeesMetadata': False,
            'fabricRead': (b'A' * 5).hex(), 'releasedPages': 1,
            'recoveredRead': (b'A' * 3).hex(), 'recoveredRows': 1,
            'missingWithoutVmRejected': True,
            'authenticatorBytes': 16,
            'rejectedTiers': 1, 'selectedTier': 1,
            'promotedCiphertext': True,
            'retryIsImmutable': True, 'duplicateSealRejected': True,
            'rootRetryIsIdempotent': True,
            'publishStates': ['fulfilled', 'rejected'],
            'providerSeesPlaintext': False,
        })

    def test_state_step_memory_region_rejects_wrong_pages_and_oob_access(self):
        raw = wasm_module(
            b'\x00\x20\x00\x28\x02\x00\x0b',
            kind=0x7f, memory=True)
        decoded = decode_module(raw)
        frame = start_state(decoded, 'f', (0,)).frames[-1]
        physical = bytes(pack_step(WaveExecutor(decoded).plan(frame)))

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            page = root / 'step.bin'
            page.write_bytes(physical)
            driver = root / 'memory-region.mjs'
            wasm = (ROOT / 'web' / 'vm.wasm').as_posix()
            driver.write_text('''\
import { readFileSync } from 'node:fs';
const { instance } = await WebAssembly.instantiate(
  readFileSync(process.argv[2]), {});
const E = instance.exports;
const step = new Uint8Array(readFileSync(process.argv[3]));
let session = 0n;
const install = () => {
  if (session && !E.vm_step_release(session)) throw new Error('release failed');
  session = E.vm_step_acquire();
  new Uint8Array(
    E.memory.buffer, E.vm_step_buffer(session), step.length).set(step);
  if (!E.vm_step_open(session, step.length)
      || !E.vm_step_memory_open(session, 65536)) {
    throw new Error('fixture did not open');
  }
};

install();
new DataView(E.memory.buffer).setBigUint64(
  E.vm_step_locals(session), 0n, true);
const fault = E.vm_step_execute(session, 1, 0);
const lease = E.vm_step_memory_lease(session);
const requested = E.vm_step_memory_page(session, lease);
const pageBytes = E.vm_step_memory_page_size(session, lease);
const wrong = E.vm_step_supply_memory_page(
  session, lease, 1, pageBytes);
const memoryPage = new Uint8Array(
  E.memory.buffer, E.vm_step_memory_page_buffer(session, lease), pageBytes);
memoryPage.set([0x78, 0x56, 0x34, 0x12]);
const supplied = E.vm_step_supply_memory_page(
  session, lease, 0, pageBytes);
const staleSupply = E.vm_step_supply_memory_page(
  session, lease, 0, pageBytes);
const done = E.vm_step_execute(session, 1, 0);
const value = new DataView(E.memory.buffer)
  .getBigUint64(E.vm_step_stack(session), true);

install();
new DataView(E.memory.buffer).setBigUint64(
  E.vm_step_locals(session), 65534n, true);
const outOfBounds = E.vm_step_execute(session, 1, 0);
const error = E.vm_step_error(session);
process.stdout.write(JSON.stringify({
  fault, requested, pageBytes, wrong, supplied, staleSupply, done,
  value: value.toString(), outOfBounds, error,
}));
''', encoding='utf-8')
            run = subprocess.run(
                ['node', str(driver), wasm, str(page)], check=False,
                capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout), {
            'fault': 1,
            'requested': 0,
            'pageBytes': 65536,
            'wrong': 0,
            'supplied': 1,
            'staleSupply': 0,
            'done': 2,
            'value': str(0x12345678),
            'outOfBounds': -1,
            'error': 10,
        })

    def test_cross_page_store_releases_both_pins_and_acks_one_lease_once(self):
        raw = wasm_module(
            b'\x00\x20\x00\x42\x01\x37\x03\x00\x0b',
            kind=0x7f, memory=True, result_count=0)
        decoded = decode_module(raw)
        frame = start_state(decoded, 'f', (65532,)).frames[-1]
        physical = bytes(pack_step(WaveExecutor(decoded).plan(frame)))

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            page = root / 'cross-page-step.bin'
            page.write_bytes(physical)
            driver = root / 'cross-page.mjs'
            wasm = (ROOT / 'web' / 'vm.wasm').as_posix()
            driver.write_text('''\
import { readFileSync } from 'node:fs';
const { instance } = await WebAssembly.instantiate(
  readFileSync(process.argv[2]), {});
const E = instance.exports;
const step = new Uint8Array(readFileSync(process.argv[3]));
const session = E.vm_step_acquire();
new Uint8Array(
  E.memory.buffer, E.vm_step_buffer(session), step.length).set(step);
if (!E.vm_step_open(session, step.length)
    || !E.vm_step_memory_open(session, 131072)) {
  throw new Error('cross-page fixture did not open');
}
new DataView(E.memory.buffer).setBigUint64(
  E.vm_step_locals(session), 65532n, true);
const faults = [];
for (;;) {
  const status = E.vm_step_execute(session, 1, 0);
  if (status === 2) break;
  if (status !== 1) throw new Error(`execute:${status}`);
  const lease = E.vm_step_memory_lease(session);
  const page = E.vm_step_memory_page(session, lease);
  const bytes = E.vm_step_memory_page_size(session, lease);
  faults.push(page);
  new Uint8Array(
    E.memory.buffer, E.vm_step_memory_page_buffer(session, lease), bytes,
  ).fill(0);
  if (!E.vm_step_supply_memory_page(session, lease, page, bytes)) {
    throw new Error('supply failed');
  }
}
const dirty = [];
let duplicateAck = 0;
let firstLease = 0n;
let firstPage = -1;
for (;;) {
  const page = E.vm_step_first_dirty_memory_page(session);
  if (page === -1) break;
  const lease = E.vm_step_memory_lease(session);
  const bytes = E.vm_step_memory_page_size(session, lease);
  const payload = new Uint8Array(
    E.memory.buffer, E.vm_step_memory_page_buffer(session, lease), bytes,
  );
  dirty.push({
    page,
    edge: page === 0
      ? Array.from(payload.slice(65532, 65536))
      : Array.from(payload.slice(0, 4)),
  });
  if (!E.vm_step_ack_memory_page(session, lease, page)) {
    throw new Error('ack failed');
  }
  if (!firstLease) {
    firstLease = lease;
    firstPage = page;
    duplicateAck = E.vm_step_ack_memory_page(session, lease, page);
  }
}
if (!E.vm_step_release(session)) throw new Error('release failed');
const nextSession = E.vm_step_acquire();
const staleAck = E.vm_step_ack_memory_page(
  nextSession, firstLease, firstPage);
E.vm_step_release(nextSession);
process.stdout.write(JSON.stringify({
  faults, dirty, duplicateAck, staleAck,
}));
''', encoding='utf-8')
            run = subprocess.run(
                ['node', str(driver), wasm, str(page)], check=False,
                capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout), {
            'faults': [0, 1],
            'dirty': [
                {'page': 0, 'edge': [1, 0, 0, 0]},
                {'page': 1, 'edge': [0, 0, 0, 0]},
            ],
            'duplicateAck': 1,
            'staleAck': 0,
        })

    def test_async_state_steps_share_one_workspace_without_interleaving(self):
        raw = wasm_module(
            b'\x00\x20\x00\x42\x03\x7c\x42\x04\x7c\x0b')
        decoded = decode_module(raw)
        frame = start_state(decoded, 'f', (5,)).frames[-1]
        physical = bytes(pack_step(WaveExecutor(decoded).plan(frame)))

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            page = root / 'step.bin'
            page.write_bytes(physical)
            driver = root / 'concurrent-steps.mjs'
            vm_module = (ROOT / 'web' / 'vm.js').as_uri()
            driver.write_text(f'''\
import {{ readFile }} from 'node:fs/promises';
import {{ fileURLToPath }} from 'node:url';
globalThis.fetch = async (input, options = {{}}) => {{
  const bytes = new Uint8Array(await readFile(fileURLToPath(String(input))));
  const range = new Headers(options.headers || {{}}).get('range');
  if (!range) return new Response(bytes, {{ status: 200 }});
  const match = /^bytes=(\\d+)-(\\d+)$/.exec(range);
  const start = Number(match[1]); const end = Number(match[2]) + 1;
  return new Response(bytes.slice(start, end), {{ status: 206 }});
}};
const vm = await import({json.dumps(vm_module)});
const page = new Uint8Array(await readFile(process.argv[2]));
let activeReads = 0;
let maximumReads = 0;
const source = {{
  length: page.length,
  read: async (offset, length) => {{
    activeReads += 1;
    maximumReads = Math.max(maximumReads, activeReads);
    await new Promise(resolve => setTimeout(resolve, 10));
    activeReads -= 1;
    return page.slice(offset, offset + length);
  }},
}};
const cuts = await Promise.all([
  vm.executeStateStep(source, 0, page.length, [5n]),
  vm.executeStateStep(source, 0, page.length, [9n]),
]);
process.stdout.write(JSON.stringify({{
  outputs: cuts.map(cut => cut.stack[0].toString()),
  maximumReads,
}}));
vm.release();
''', encoding='utf-8')
            run = subprocess.run(
                ['node', str(driver), str(page)], check=False,
                capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout), {
            'outputs': ['12', '16'],
            'maximumReads': 1,
        })

    def test_resident_pure_state_step_has_no_async_or_scalar_fallback(self):
        raw = wasm_module(
            b'\x00\x20\x00\x42\x03\x7c\x42\x04\x7c\x0b')
        decoded = decode_module(raw)
        frame = start_state(decoded, 'f', (5,)).frames[-1]
        physical = bytes(pack_step(WaveExecutor(decoded).plan(frame)))

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            page = root / 'step.bin'
            page.write_bytes(physical)
            driver = root / 'resident-step.mjs'
            vm_module = (ROOT / 'web' / 'vm.js').as_uri()
            driver.write_text(f'''\
import {{ readFile }} from 'node:fs/promises';
import {{ fileURLToPath }} from 'node:url';
globalThis.fetch = async (input, options = {{}}) => {{
  const bytes = new Uint8Array(await readFile(fileURLToPath(String(input))));
  const range = new Headers(options.headers || {{}}).get('range');
  if (!range) return new Response(bytes, {{ status: 200 }});
  const match = /^bytes=(\\d+)-(\\d+)$/.exec(range);
  const start = Number(match[1]); const end = Number(match[2]) + 1;
  return new Response(bytes.slice(start, end), {{ status: 206 }});
}};
const vm = await import({json.dumps(vm_module)});
await vm.load();
const page = new Uint8Array(await readFile(process.argv[2]));
const first = vm.executePureStateStepLoaded(page, [5n], []);
const second = vm.executePureStateStepLoaded(page, [9n], []);
process.stdout.write(JSON.stringify({{
  outputs: [first.stack[0].toString(), second.stack[0].toString()],
  work: first.work,
  span: first.span,
}}));
vm.release();
''', encoding='utf-8')
            run = subprocess.run(
                ['node', str(driver), str(page)], check=False,
                capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout), {
            'outputs': ['12', '16'],
            'work': 1,
            'span': 1,
        })

    def test_float_memory_view_faults_one_page_and_persists_one_dirty_cut(self):
        body = (b'\x00\x20\x00\x20\x00\x2a\x02\x60'
                b'\x43\x00\x00\x00\x00\x20\x00\x2d\x00\x64'
                b'\x1b\x38\x02\x58\x0b')
        raw = wasm_module(
            body, kind=0x7f, memory=True, result_count=0)
        decoded = decode_module(raw)
        frame = start_state(decoded, 'f', (0,)).frames[-1]
        physical = bytes(pack_step(WaveExecutor(decoded).plan(frame)))

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            page = root / 'step.bin'
            page.write_bytes(physical)
            driver = root / 'memory-step.mjs'
            vm_module = (ROOT / 'web' / 'vm.js').as_uri()
            driver.write_text(f'''\
import {{ readFile }} from 'node:fs/promises';
import {{ fileURLToPath }} from 'node:url';
globalThis.fetch = async (input, options = {{}}) => {{
  const bytes = new Uint8Array(await readFile(fileURLToPath(String(input))));
  const range = new Headers(options.headers || {{}}).get('range');
  if (!range) return new Response(bytes, {{ status: 200 }});
  const match = /^bytes=(\\d+)-(\\d+)$/.exec(range);
  const start = Number(match[1]); const end = Number(match[2]) + 1;
  return new Response(bytes.slice(start, end), {{ status: 206 }});
}};
const vm = await import({json.dumps(vm_module)});
const page = new Uint8Array(await readFile(process.argv[2]));
const bytes = new Uint8Array(65536);
bytes.set([0xef, 0xbe, 0xad, 0xde], 96);
bytes[100] = 1;
let reads = 0;
let writes = 0;
const memory = {{
  length: bytes.length,
  read: async (offset, length) => {{
    reads += 1;
    return bytes.slice(offset, offset + length);
  }},
  write: async (offset, payload) => {{
    writes += 1;
    bytes.set(payload, offset);
  }},
}};
const source = {{
  length: page.length,
  read: async (offset, length) => page.slice(offset, offset + length),
}};
const cut = await vm.executeStateStep(
  source, 0, page.length, [0n], [], {{ memory }},
);
console.log(JSON.stringify({{
  stored: Array.from(bytes.slice(88, 92)),
  reads, writes, work: cut.work, span: cut.span,
}}));
vm.release();
''', encoding='utf-8')
            run = subprocess.run(
                ['node', str(driver), str(page)], check=False,
                capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout), {
            'stored': [0xef, 0xbe, 0xad, 0xde],
            'reads': 1,
            'writes': 1,
            'work': 4,
            'span': 3,
        })

    def test_bootstrap_vm_executes_the_complete_integer_lane_vocabulary(self):
        jobs = []
        for operation in LANE_OPS:
            bits = 32 if operation.startswith('lane32.') else 64
            arity, constant_count, has_shift = shape(operation)
            values = [0x123456789abcdef0, 5, 3][:arity]
            constants = ([10, 20, 30, 40] if constant_count < 0
                         else [0x55] * constant_count)
            if has_shift:
                constants.append(7)
            arguments = tuple(
                [Operand('local', index) for index in range(arity)]
                + [Operand('const', value) for value in constants])
            plan = PureSlice(
                0, 0, 1, 1, 0,
                (WaveNode(1, operation, arguments),),
                DependencyWaves((0, 1), (1,), (0, 1)),
                (Operand('node', 1),),
                tuple(Operand('local', index) for index in range(arity)),
            )
            page = bytes(pack_step(plan))
            expected = evaluate_lane(operation, tuple(values + constants))
            jobs.append({
                'operation': operation,
                'page': page.hex(),
                'locals': list(map(str, values)),
                'expected': str(expected),
                'bits': bits,
            })

        with tempfile.TemporaryDirectory() as directory:
            driver = Path(directory) / 'lanes.mjs'
            wasm = (ROOT / 'web' / 'vm.wasm').as_posix()
            driver.write_text('''\
import { readFileSync } from 'node:fs';
const { instance } = await WebAssembly.instantiate(
  readFileSync(process.argv[2]), {});
const E = instance.exports;
const jobs = JSON.parse(readFileSync(0, 'utf8'));
const results = [];
for (const job of jobs) {
  const session = E.vm_step_acquire();
  const page = new Uint8Array(Buffer.from(job.page, 'hex'));
  new Uint8Array(
    E.memory.buffer, E.vm_step_buffer(session), page.length).set(page);
  if (!E.vm_step_open(session, page.length)) {
    results.push(`open:${E.vm_step_error(session)}`);
    E.vm_step_release(session);
    continue;
  }
  const memory = new DataView(E.memory.buffer);
  const localsAt = E.vm_step_locals(session);
  job.locals.forEach((value, index) => {
    memory.setBigUint64(localsAt + index * 8, BigInt(value), true);
  });
  if (E.vm_step_execute(session, job.locals.length, 0) !== 2) {
    results.push(`execute:${E.vm_step_error(session)}`);
    E.vm_step_release(session);
    continue;
  }
  results.push(memory.getBigUint64(
    E.vm_step_stack(session), true).toString());
  E.vm_step_release(session);
}
process.stdout.write(JSON.stringify(results));
''', encoding='utf-8')
            run = subprocess.run(
                ['node', str(driver), wasm], input=json.dumps(jobs),
                check=False, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
        actual = json.loads(run.stdout)
        failures = [
            (job['operation'], job['expected'], got)
            for job, got in zip(jobs, actual)
            if job['expected'] != got
        ]
        self.assertEqual(failures, [])

    def test_qm_state_step_runs_as_mapped_columns_inside_bootstrap_vm(self):
        raw = wasm_module(
            b'\x00\x20\x00\x42\x03\x7c\x42\x04\x7c\x0b')
        decoded = decode_module(raw)
        frame = start_state(decoded, 'f', (5,)).frames[-1]
        physical = bytes(pack_step(WaveExecutor(decoded).plan(frame)))

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            page = root / 'step.bin'
            page.write_bytes(physical)
            driver = root / 'step.mjs'
            vm_module = (ROOT / 'web' / 'vm.js').as_uri()
            driver.write_text(f'''\
import {{ readFile }} from 'node:fs/promises';
import {{ fileURLToPath }} from 'node:url';
globalThis.fetch = async (input, options = {{}}) => {{
  const bytes = new Uint8Array(await readFile(fileURLToPath(String(input))));
  const range = new Headers(options.headers || {{}}).get('range');
  if (!range) return new Response(bytes, {{ status: 200 }});
  const match = /^bytes=(\\d+)-(\\d+)$/.exec(range);
  const start = Number(match[1]); const end = Number(match[2]) + 1;
  return new Response(bytes.slice(start, end), {{ status: 206 }});
}};
const vm = await import({json.dumps(vm_module)});
const page = new Uint8Array(await readFile(process.argv[2]));
let reads = 0;
const source = {{
  length: page.length,
  read: async (offset, length) => {{
    reads += 1;
    return page.slice(offset, offset + length);
  }},
}};
const cut = await vm.executeStateStep(source, 0, page.length, [5n], []);
console.log(JSON.stringify({{
  functionIndex: cut.functionIndex,
  nextPc: cut.nextPc,
  locals: cut.locals.map(String),
  stack: cut.stack.map(String),
  work: cut.work,
  span: cut.span,
  reads,
}}));
vm.release();
''', encoding='utf-8')
            run = subprocess.run(
                ['node', str(driver), str(page)], check=False,
                capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
        result = json.loads(run.stdout)
        self.assertEqual(result, {
            'functionIndex': 0,
            'nextPc': 5,
            'locals': ['5'],
            'stack': ['12'],
            'work': 1,
            'span': 1,
            'reads': 1,
        })

    def test_compiler_and_interpreter_delivery_share_one_paged_wasm_shape(self):
        raw = wasm_module(
            b'\x00\x20\x00\x42\x03\x7c\x42\x04\x7c\x0b')
        indexed = index_module(raw)
        regions = bytes(pack_regions(indexed))
        steps = pack_wasm_steps(indexed)

        def projected(payload, page_size):
            manifest, store = project(
                payload, page_size=page_size, data_shards=2, parity_shards=1)
            wire = dump_bundle(manifest, store, 'data')
            prefix = bundle_prefix_size(wire)
            return wire, {
                'bytes': len(wire),
                'file': '',
                'prefix_bytes': prefix,
                'prefix_sha256': hashlib.sha256(wire[:prefix]).hexdigest(),
            }

        code_wire, code_delivery = projected(raw, 4096)
        region_wire, region_delivery = projected(regions, 4096)
        step_wire, step_delivery = projected(steps, 4096)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'code.pages').write_bytes(code_wire)
            (root / 'regions.pages').write_bytes(region_wire)
            (root / 'steps.pages').write_bytes(step_wire)
            code_delivery['file'] = 'code.pages'
            region_delivery['file'] = 'regions.pages'
            step_delivery['file'] = 'steps.pages'
            entry = {
                'bytes': len(raw),
                'sha256': hashlib.sha256(raw).hexdigest(),
                'delivery': code_delivery,
                'regions': {
                    'bytes': len(regions),
                    'sha256': hashlib.sha256(regions).hexdigest(),
                    'delivery': region_delivery,
                },
                'steps': {
                    'bytes': len(steps),
                    'sha256': hashlib.sha256(steps).hexdigest(),
                    'pages': 1,
                    'delivery': step_delivery,
                },
            }
            driver = root / 'paged-wasm.mjs'
            module = (ROOT / 'web' / 'paged-wasm.js').as_uri()
            driver.write_text(f'''\
import {{ readFile }} from 'node:fs/promises';
import {{ fileURLToPath }} from 'node:url';
globalThis.fetch = async (input, options = {{}}) => {{
  const bytes = new Uint8Array(await readFile(fileURLToPath(String(input))));
  const range = new Headers(options.headers || {{}}).get('range');
  if (!range) return new Response(bytes, {{ status: 200 }});
  const match = /^bytes=(\\d+)-(\\d+)$/.exec(range);
  const start = Number(match[1]); const end = Number(match[2]) + 1;
  return new Response(bytes.slice(start, end), {{ status: 206 }});
}};
const {{ openPagedWasm }} = await import({json.dumps(module)});
const opened = await openPagedWasm(
  {json.dumps(entry)}, new URL('compiler.json', {json.dumps(root.as_uri() + '/')})
);
const result = await opened.invoke(0, [5n], 1);
console.log(JSON.stringify({{
  result: result.toString(), layout: opened.layout(),
}}));
opened.release();
''', encoding='utf-8')
            run = subprocess.run(
                ['node', str(driver)], check=True,
                capture_output=True, text=True)
        result = json.loads(run.stdout)
        self.assertEqual(result['result'], '12')
        # The canonical code payload is cold: invocation selected its STEP
        # projection and touched only each authenticated delivery prefix.
        self.assertEqual(result['layout']['code']['rangeRequests'], 1)
        self.assertEqual(
            result['layout']['functions']['delivery']['rangeRequests'], 2)
        self.assertEqual(
            result['layout']['steps']['delivery']['rangeRequests'], 2)

    def test_child_wasm_body_runs_inside_the_bootstrap_vm(self):
        raw = wasm_module(
            b'\x00\x20\x00\x42\x03\x7c\x42\x04\x7c\x0b')
        body = index_module(raw).bodies[0]
        with tempfile.TemporaryDirectory() as directory:
            child = Path(directory) / 'child.wasm'
            child.write_bytes(raw)
            driver = Path(directory) / 'nested.mjs'
            vm_module = (ROOT / 'web' / 'vm.js').as_uri()
            driver.write_text(f'''\
import {{ readFile }} from 'node:fs/promises';
import {{ fileURLToPath }} from 'node:url';
globalThis.fetch = async (input, options = {{}}) => {{
  const bytes = new Uint8Array(await readFile(fileURLToPath(String(input))));
  const range = new Headers(options.headers || {{}}).get('range');
  if (!range) return new Response(bytes, {{ status: 200 }});
  const match = /^bytes=(\\d+)-(\\d+)$/.exec(range);
  const start = Number(match[1]); const end = Number(match[2]) + 1;
  return new Response(bytes.slice(start, end), {{ status: 206 }});
}};
const vm = await import({json.dumps(vm_module)});
const child = new Uint8Array(await readFile(process.argv[2]));
let reads = 0;
const source = {{
  length: child.length,
  read: async (offset, length) => {{
    reads += 1;
    return child.slice(offset, offset + length);
  }},
}};
const result = await vm.executeGuestBody(
  source, {body.start}, {body.end}, [5n], 1,
);
console.log(JSON.stringify({{ result: result.toString(), reads }}));
vm.release();
''', encoding='utf-8')
            run = subprocess.run(
                ['node', str(driver), str(child)], check=True,
                capture_output=True, text=True)
        result = json.loads(run.stdout)
        self.assertEqual(result, {'result': '12', 'reads': 1})

    def test_lazy_resource_cut_has_command_lifetime(self):
        with tempfile.TemporaryDirectory() as directory:
            driver = Path(directory) / 'resources.mjs'
            module = (ROOT / 'web' / 'wasi-preview1.js').as_uri()
            driver.write_text(f'''\
import {{
  LazyResourceCatalog, MemoryFileSystem, ResourceFault,
}} from {json.dumps(module)};
const source = new TextEncoder().encode('0123456789header-data');
let pageDrops = 0;
let backingDrops = 0;
const catalog = new LazyResourceCatalog({{
  format: 'tar-cut-v1', mount: '/usr',
  entries: [[0, 'include', 'd'], [7, '/stdint.h', 'f', 10, 11]],
}}, async (offset, length) => source.slice(offset, offset + length),
() => {{ pageDrops += 1; }}, () => {{ backingDrops += 1; }});
const fs = new MemoryFileSystem(catalog);
let fault = null;
try {{ fs.readFile('/usr/include/stdint.h'); }} catch (error) {{
  if (!(error instanceof ResourceFault)) throw error;
  fault = error.path;
}}
await fs.materialize(fault);
const value = new TextDecoder().decode(fs.readFile(fault));
const admitted = catalog.layout();
fs.releaseResources();
const cold = catalog.layout();
catalog.release();
console.log(JSON.stringify({{
  fault, value, admitted, cold, pageDrops, backingDrops,
}}));
''', encoding='utf-8')
            run = subprocess.run(
                ['node', str(driver)], check=True,
                capture_output=True, text=True)
        result = json.loads(run.stdout)
        self.assertEqual(result['fault'], '/usr/include/stdint.h')
        self.assertEqual(result['value'], 'header-data')
        self.assertEqual(result['admitted']['residentBytes'], 11)
        self.assertEqual(result['cold']['residentBytes'], 0)
        self.assertEqual(result['cold']['peakResidentBytes'], 11)
        self.assertEqual(result['pageDrops'], 2)
        self.assertEqual(result['backingDrops'], 1)

    def test_browser_reads_only_unique_touched_shards(self):
        page = 1 << 16
        payload = b'A' * page + bytes(page) + b'A' * page + b'B' * page
        manifest, store = project(
            payload, page_size=page, data_shards=3, parity_shards=2)
        wire = dump_bundle(manifest, store, 'data')
        prefix_bytes = bundle_prefix_size(wire)
        prefix_hash = hashlib.sha256(wire[:prefix_bytes]).hexdigest()

        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / 'fixture.pages'
            bundle.write_bytes(wire)
            driver = Path(directory) / 'driver.mjs'
            module = (ROOT / 'web' / 'page-fabric.js').as_uri()
            driver.write_text(f'''\
import {{ readFile }} from 'node:fs/promises';
import {{ openPageBundle }} from {json.dumps(module)};
const wire = await readFile(process.argv[2]);
const fabric = await openPageBundle({{
  blob: new Blob([wire]),
  prefixBytes: {prefix_bytes},
  prefixSha256: {json.dumps(prefix_hash)},
}});
const first = await fabric.read(7, 9);
const duplicate = await fabric.read({2 * page + 3}, 5);
const zero = await fabric.read({page + 11}, 4);
const last = await fabric.read({3 * page + 1}, 3);
console.log(JSON.stringify({{
  first: new TextDecoder().decode(first),
  duplicate: new TextDecoder().decode(duplicate),
  zero: Array.from(zero),
  last: new TextDecoder().decode(last),
  layout: fabric.layout(),
}}));
''', encoding='utf-8')
            run = subprocess.run(
                ['node', str(driver), str(bundle)], check=True,
                capture_output=True, text=True)
        result = json.loads(run.stdout)
        self.assertEqual(result['first'], 'A' * 9)
        self.assertEqual(result['duplicate'], 'A' * 5)
        self.assertEqual(result['zero'], [0] * 4)
        self.assertEqual(result['last'], 'B' * 3)
        self.assertEqual(result['layout']['verifiedShards'], 2)
        self.assertEqual(result['layout']['residentPages'], 2)
        self.assertEqual(result['layout']['rangeRequests'], 3)

    def test_whole_object_consumer_uses_one_payload_wave(self):
        page = 1 << 16
        payload = b'A' * page + bytes(page) + b'A' * page + b'B' * page
        manifest, store = project(
            payload, page_size=page, data_shards=3, parity_shards=2)
        wire = dump_bundle(manifest, store, 'data')
        prefix_bytes = bundle_prefix_size(wire)
        prefix_hash = hashlib.sha256(wire[:prefix_bytes]).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / 'fixture.pages'
            bundle.write_bytes(wire)
            driver = Path(directory) / 'whole.mjs'
            module = (ROOT / 'web' / 'page-fabric.js').as_uri()
            driver.write_text(f'''\
import {{ readFile }} from 'node:fs/promises';
import {{ createHash }} from 'node:crypto';
import {{ openPageBundle }} from {json.dumps(module)};
const wire = await readFile(process.argv[2]);
const fabric = await openPageBundle({{
  blob: new Blob([wire]), prefixBytes: {prefix_bytes},
  prefixSha256: {json.dumps(prefix_hash)},
}});
const bytes = await fabric.readAll(2);
console.log(JSON.stringify({{
  digest: createHash('sha256').update(bytes).digest('hex'),
  layout: fabric.layout(),
}}));
''', encoding='utf-8')
            run = subprocess.run(
                ['node', str(driver), str(bundle)], check=True,
                capture_output=True, text=True)
        result = json.loads(run.stdout)
        self.assertEqual(result['digest'], hashlib.sha256(payload).hexdigest())
        self.assertEqual(result['layout']['rangeRequests'], 2)
        self.assertEqual(result['layout']['residentPages'], 0)
        self.assertEqual(result['layout']['verifiedShards'], 2)

    def test_forward_page_wave_removes_sequential_range_n_plus_one(self):
        page = 1 << 16
        payload = b''.join(bytes([value]) * page for value in range(1, 6))
        manifest, store = project(
            payload, page_size=page, data_shards=3, parity_shards=2)
        wire = dump_bundle(manifest, store, 'data')
        prefix_bytes = bundle_prefix_size(wire)
        prefix_hash = hashlib.sha256(wire[:prefix_bytes]).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / 'fixture.pages'
            bundle.write_bytes(wire)
            driver = Path(directory) / 'wave.mjs'
            module = (ROOT / 'web' / 'page-fabric.js').as_uri()
            driver.write_text(f'''\
import {{ readFile }} from 'node:fs/promises';
import {{ openPageBundle }} from {json.dumps(module)};
const wire = await readFile(process.argv[2]);
const fabric = await openPageBundle({{
  blob: new Blob([wire]), prefixBytes: {prefix_bytes},
  prefixSha256: {json.dumps(prefix_hash)}, wavePages: 4, cachePages: 4,
}});
const observed = [];
for (let page = 0; page < 5; page += 1) {{
  observed.push((await fabric.read(page * {page}, 1))[0]);
}}
console.log(JSON.stringify({{ observed, layout: fabric.layout() }}));
''', encoding='utf-8')
            run = subprocess.run(
                ['node', str(driver), str(bundle)], check=True,
                capture_output=True, text=True)
        result = json.loads(run.stdout)
        self.assertEqual(result['observed'], [1, 2, 3, 4, 5])
        # Prefix + ranks 1..4 + rank 5, instead of prefix + five payloads.
        self.assertEqual(result['layout']['rangeRequests'], 3)
        self.assertEqual(result['layout']['verifiedShards'], 5)
        self.assertLessEqual(result['layout']['residentPages'], 4)

    def test_vm_loader_has_no_direct_wasm_fetch_route(self):
        with tempfile.TemporaryDirectory() as directory:
            driver = Path(directory) / 'load-vm.mjs'
            module = (ROOT / 'web' / 'vm.js').as_uri()
            driver.write_text(f'''\
import {{ readFile }} from 'node:fs/promises';
import {{ fileURLToPath }} from 'node:url';
globalThis.fetch = async (input, options = {{}}) => {{
  const bytes = new Uint8Array(await readFile(fileURLToPath(String(input))));
  const range = new Headers(options.headers || {{}}).get('range');
  if (!range) return new Response(bytes, {{ status: 200 }});
  const match = /^bytes=(\\d+)-(\\d+)$/.exec(range);
  if (!match) return new Response('', {{ status: 416 }});
  const start = Number(match[1]); const end = Number(match[2]) + 1;
  return new Response(bytes.slice(start, end), {{ status: 206 }});
}};
const vm = await import({json.dumps(module)});
const loaded = await vm.load();
console.log(JSON.stringify({{
  memoryBytes: loaded.exports.memory.buffer.byteLength,
  hasFeed: typeof loaded.exports.vm_feed === 'function',
}}));
vm.release();
''', encoding='utf-8')
            run = subprocess.run(
                ['node', str(driver)], check=True,
                capture_output=True, text=True)
        result = json.loads(run.stdout)
        self.assertEqual(result['memoryBytes'], 32 << 20)
        self.assertTrue(result['hasFeed'])

    def test_range_ignorant_server_is_downloaded_once_and_released(self):
        page = 1 << 16
        payload = b'A' * page + b'B' * page
        manifest, store = project(
            payload, page_size=page, data_shards=2, parity_shards=1)
        wire = dump_bundle(manifest, store, 'data')
        prefix_bytes = bundle_prefix_size(wire)
        prefix_hash = hashlib.sha256(wire[:prefix_bytes]).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / 'fixture.pages'
            bundle.write_bytes(wire)
            driver = Path(directory) / 'no-range.mjs'
            module = (ROOT / 'web' / 'page-fabric.js').as_uri()
            driver.write_text(f'''\
import {{ readFile }} from 'node:fs/promises';
import {{ openPageBundle }} from {json.dumps(module)};
const wire = new Uint8Array(await readFile(process.argv[2]));
let fetches = 0;
globalThis.fetch = async () => {{ fetches += 1; return new Response(wire); }};
const fabric = await openPageBundle({{
  url: 'https://static.invalid/fixture.pages',
  prefixBytes: {prefix_bytes}, prefixSha256: {json.dumps(prefix_hash)},
}});
const first = await fabric.read(0, 1);
const second = await fabric.read({page}, 1);
const before = fabric.layout();
fabric.release();
console.log(JSON.stringify({{
  fetches, values: [first[0], second[0]], before,
  backingReleased: fabric.source.full === null,
}}));
''', encoding='utf-8')
            run = subprocess.run(
                ['node', str(driver), str(bundle)], check=True,
                capture_output=True, text=True)
        result = json.loads(run.stdout)
        self.assertEqual(result['fetches'], 1)
        self.assertEqual(result['values'], [65, 66])
        self.assertEqual(result['before']['rangeRequests'], 1)
        self.assertEqual(result['before']['fetchedBytes'], len(wire))
        self.assertTrue(result['backingReleased'])


if __name__ == '__main__':
    unittest.main()
