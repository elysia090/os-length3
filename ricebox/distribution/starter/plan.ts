// One author-controlled, build-time declaration, and the normalized data served with its site.
import {GUEST_SCREEN_LIMITS} from '../../everyday/terminal/vt.ts';

const sha256 = /^[a-f0-9]{64}$/;
const localText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');

function object(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) {
    throw new Error('Invalid ' + label);
  }
  return value as Record<string, unknown>;
}

function pin(value: unknown): value is string {
  return typeof value === 'string' && sha256.test(value);
}

function cells(value: unknown, limit: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= limit;
}

function terminal(value: unknown, defaultArgv?: readonly string[]) {
  const {argv = defaultArgv, cols = 80, rows = 24, autoStart = true} =
    object(value, ['argv', 'cols', 'rows', 'autoStart'], 'terminal declaration');
  if (!Array.isArray(argv) || !argv.length || argv.length > 64 || !argv.every(localText) ||
      !argv[0].startsWith('/') || !argv[0].slice(1).split('/').every(part => part && part !== '.' && part !== '..')) {
    throw new Error('terminal.argv must start with an absolute guest executable');
  }
  if (!cells(cols, GUEST_SCREEN_LIMITS.columns) || !cells(rows, GUEST_SCREEN_LIMITS.rows)) {
    throw new Error('Terminal geometry must be 1–240 columns by 1–100 rows');
  }
  if (typeof autoStart !== 'boolean') throw new Error('terminal.autoStart must be true or false');
  return {argv: [...argv] as string[], cols, rows, autoStart};
}

export function authoredPlan(value: unknown) {
  const {guest, terminal: requested} = object(value, ['guest', 'terminal'], 'Ricebox declaration; only guest and terminal are supported');
  const {directory = './prepared', webrootSha256, mukSha256} =
    object(guest, ['directory', 'webrootSha256', 'mukSha256'], 'prepared guest declaration');
  if (!localText(directory)) throw new Error('guest.directory must name a local prepared directory');
  if (!pin(webrootSha256) || !pin(mukSha256)) throw new Error('guest requires trusted SHA-256 pins for webroot.json and muk.json');
  return {guest: {directory, webrootSha256, mukSha256}, terminal: terminal(requested === undefined ? {} : requested, ['/bin/sh', '-i'])};
}

export function stagedPlan(value: unknown) {
  const {v, generation, makerSha256, program, terminal: requested} =
    object(value, ['v', 'generation', 'makerSha256', 'program', 'terminal'], 'staged terminal declaration');
  if (v !== 1 || !pin(generation) || !pin(makerSha256) || !localText(program) || !program.startsWith('/')) {
    throw new Error('Invalid staged guest identity');
  }
  return {generation, makerSha256, program, terminal: terminal(requested)};
}
