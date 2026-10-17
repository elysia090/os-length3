// Read-only diagnostic for the observed musl printf %n dispatch in dhcpcd 10.5.2.
// This neither executes ELF code nor proves arbitrary ELF/compiler correctness.
import {readFile, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const signature = Buffer.from('486304824801d0ffe0', 'hex');
const intStore = Buffer.from('488b4580448938', 'hex');
const guard = Buffer.from('4183fa07', 'hex');
const hex = value => `0x${value.toString(16)}`;

export async function inspectPrintfTable(path) {
  const file = resolve(path), size = (await stat(file)).size;
  if (size < 64 || size > 32 * 1024 * 1024) throw new Error('bounded ELF input required');
  const bytes = await readFile(file);
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62 ||
      ![2, 3].includes(bytes.readUInt16LE(16))) throw new Error('linked x86-64 ELF required');
  const number = value => {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ELF coordinate exceeds exact integer range');
    return Number(value);
  };
  const phAt = number(bytes.readBigUInt64LE(32)), phSize = bytes.readUInt16LE(54);
  const phCount = bytes.readUInt16LE(56), loads = [];
  if (phSize !== 56 || phCount > 128 || phAt + phCount * phSize > bytes.length)
    throw new Error('bounded ELF program headers required');
  for (let i = 0; i < phCount; ++i) {
    const at = phAt + i * phSize;
    if (bytes.readUInt32LE(at) !== 1) continue;
    const load = {flags: bytes.readUInt32LE(at + 4), offset: number(bytes.readBigUInt64LE(at + 8)),
      address: number(bytes.readBigUInt64LE(at + 16)), length: number(bytes.readBigUInt64LE(at + 32))};
    if (load.offset + load.length > bytes.length || !Number.isSafeInteger(load.address + load.length))
      throw new Error('load extent outside ELF');
    loads.push(load);
  }
  const extent = (address, length, executable = false) => {
    const load = loads.find(l => address >= l.address && address + length <= l.address + l.length &&
      (!executable || (l.flags & 1)));
    if (!load) throw new Error('diagnostic extent outside file-backed load');
    const offset = load.offset + address - load.address;
    return bytes.subarray(offset, offset + length);
  };
  const matches = [];
  for (const load of loads.filter(l => l.flags & 1)) {
    const code = bytes.subarray(load.offset, load.offset + load.length);
    for (let at = 7; at + signature.length <= code.length; ++at) {
      if (!code.subarray(at, at + signature.length).equals(signature) ||
          !code.subarray(at - 7, at - 4).equals(Buffer.from('488d15', 'hex')) ||
          code.subarray(Math.max(0, at - 23), at - 7).indexOf(guard) < 0) continue;
      const lea = load.address + at - 7;
      const table = lea + 7 + code.readInt32LE(at - 4);
      const rows = extent(table, 32);
      const targets = Array.from({length: 8}, (_, i) => table + rows.readInt32LE(i * 4));
      const actual = extent(targets[0], 16, true);
      matches.push({lea: hex(lea), table: hex(table), targets: targets.map(hex),
        caseZeroBytes: actual.toString('hex'), matchesKnownIntStore: actual.subarray(0, intStore.length).equals(intStore)});
    }
  }
  if (matches.length !== 1) throw new Error(`observed printf dispatch shape not uniquely recognized (${matches.length})`);
  return {format: 'dhcp-printf-table-inspection-v1', file, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), ...matches[0],
    status: matches[0].matchesKnownIntStore ? 'known-handler-match' : 'known-handler-mismatch',
    scope: 'observed dhcpcd 10.5.2 / musl dispatch and known int-store shape only; not a general ELF acceptance gate'};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length < 3) {
    process.stderr.write('usage: node inspect-dhcp-printf-table.mjs FILE.elf [...]\n');
    process.exitCode = 2;
  } else {
    for (const path of process.argv.slice(2)) {
      try {
        const report = await inspectPrintfTable(path);
        process.stdout.write(`${JSON.stringify(report)}\n`);
        if (!report.matchesKnownIntStore) process.exitCode = 1;
      } catch (error) {
        process.stderr.write(`${path}: ${error.message}\n`);
        process.exitCode = 2;
      }
    }
  }
}
