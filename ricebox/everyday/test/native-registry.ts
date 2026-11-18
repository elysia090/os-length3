// Offline comparison of declared requirements with a saved registry capture.
// No inferred client minimums, display access or executable invocation.
import {constants, closeSync, fstatSync, openSync, readSync} from 'node:fs';

// The recorder can retain six 1-MiB streams. JSON can expand a control byte
// into six characters; allow their envelope without allocating it on small reads.
const LIMIT = 40 * 1024 * 1024;
const usage = 'usage: native-registry.ts PREFLIGHT.json INTERFACE=MIN_VERSION [...]';
const name = '[A-Za-z_][A-Za-z0-9_]*';
const requirement = new RegExp(`^(${name})=([0-9]+)$`);
const header = new RegExp(`^interface: '(${name})',[ \\t]+version:[ \\t]+([0-9]+),[ \\t]+name:[ \\t]+([0-9]+)[ \\t]*$`);
const u32 = (text: string, positive: boolean) => {
  const value = Number(text);
  if (!Number.isInteger(value) || value < (positive ? 1 : 0) || value > 0xffffffff) throw new Error('invalid U32 registry identity or version');
  return value;
};

function readReport(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > LIMIT) throw new Error('preflight report must be a regular file of at most 40 MiB');
    const bytes = Buffer.allocUnsafe(stat.size);
    for (let at = 0; at < bytes.length;) {
      const count = readSync(fd, bytes, at, bytes.length - at, null);
      if (count === 0) throw new Error('preflight report size changed while reading');
      at += count;
    }
    if (readSync(fd, new Uint8Array(1), 0, 1, null) !== 0) throw new Error('preflight report size changed while reading');
    return JSON.parse(bytes.toString('utf8'));
  } finally { closeSync(fd); }
}

export function compareRegistry(args: readonly string[]) {
  const [path, ...listed] = args;
  if (!path || !listed.length) throw new Error(usage);
  const requested = new Map<string, number>();
  for (const item of listed) {
    const match = requirement.exec(item);
    if (!match || requested.has(match[1])) throw new Error('requirements must be unique INTERFACE=MIN_VERSION entries');
    requested.set(match[1], u32(match[2], true));
  }
  const report = readReport(path) as {kind?: unknown; visualAcceptance?: unknown; protocolCompatibility?: unknown; registry?: {stdout?: unknown}} | null;
  if (!report || report.kind !== 'everyday-native-preflight' || report.visualAcceptance !== 'not-tested' ||
      report.protocolCompatibility !== 'not-validated' || typeof report.registry?.stdout !== 'string') {
    throw new Error('expected an everyday native preflight report with raw registry stdout');
  }
  const globals = new Set<number>(), highest = new Map<string, number>();
  for (const line of report.registry.stdout.split(/\r?\n/)) {
    if (!line.trim() || /^[ \t]/.test(line)) continue; // subordinate properties are not globals
    const match = header.exec(line);
    if (!match) throw new Error('malformed registry global header');
    const version = u32(match[2], true), id = u32(match[3], false);
    if (globals.has(id)) throw new Error(`duplicate registry global ID: ${id}`);
    globals.add(id);
    highest.set(match[1], Math.max(highest.get(match[1]) ?? 0, version));
  }
  if (!globals.size) throw new Error('registry capture has no global headers');
  const requirements = [...requested].map(([name, minimum]) => {
    const advertised = highest.get(name) ?? null;
    return {name, minimum, advertised, status: advertised === null ? 'missing' : advertised < minimum ? 'too-old' : 'met'};
  });
  return {
    kind: 'everyday-native-registry-comparison', visualAcceptance: 'not-tested', protocolCompatibility: 'not-validated',
    matching: 'at-least-one-instance', satisfied: requirements.every(r => r.status === 'met'), requirements,
  };
}

if (import.meta.main) {
  try {
    const report = compareRegistry(process.argv.slice(2));
    console.log(JSON.stringify(report, null, 2));
    if (!report.satisfied) process.exitCode = 1;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}
