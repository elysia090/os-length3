#!/usr/bin/env node
// Only stage an explicitly trusted prepared environment. No acquisition, execution or publishing.
import {createHash} from 'node:crypto';
import {constants, copyFileSync, linkSync, lstatSync, readFileSync, realpathSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, posix, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {browserModules} from '../deployment/assets.ts';
import {visitDistributionAssets} from '../deployment/local.ts';
import type {Index} from '../format/manifest.ts';
import {authoredPlan} from './plan.ts';
import {preview} from './preview.ts';

const usage = `Usage:
  ricebox-stage-shell [DECLARATION_JSON [NEW_SITE]]
  ricebox-stage-shell --preview [DECLARATION_JSON]

The defaults are ./ricebox.json and ./ricebox-site. Preview serves a temporary
site on loopback and removes it when stopped.

Minimal ricebox.json:
{
  "guest": {
    "webrootSha256": "<trusted SHA-256 of webroot.json>",
    "mukSha256": "<trusted SHA-256 of muk.json>"
  }
}

The prepared directory defaults to ./prepared next to ricebox.json. The
terminal starts /bin/sh -i with an 80 by 24 grid. Set guest.directory or
terminal.argv, terminal.cols, terminal.rows, and terminal.autoStart to override.`;

function readDeclaration(source: string) {
  try { return authoredPlan(JSON.parse(readFileSync(source, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${source}: declaration not found. See --help for an example.`);
    throw new Error(`${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Stage on the destination filesystem even when some parents are missing. */
function outputLocation(path: string) {
  let parent = dirname(path);
  const names = [basename(path)];
  while (!lstatSync(parent, {throwIfNoEntry: false})) {
    const above = dirname(parent);
    if (above === parent) throw new Error(`No existing parent directory for ${path}`);
    names.unshift(basename(parent));
    parent = above;
  }
  const directory = realpathSync(parent);
  return {directory, out: join(directory, ...names)};
}

function checkPin(name: string, bytes: Buffer, expected: string) {
  if (createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error(`${name} does not match the trusted release pin.`);
  }
}

/** Follow guest aliases in the authenticated index, never as host filesystem paths. */
function executable(index: Index, entry: string): string {
  const links = new Map(index.links.map(({path, target}) => [path, target]));
  let path = entry;
  for (let depth = 0; depth <= 40; depth++) {
    const parts = path.slice(1).split('/');
    let replaced = false;
    for (let i = 1; i <= parts.length; i++) {
      const alias = '/' + parts.slice(0, i).join('/');
      const link = links.get(alias);
      if (link === undefined) continue;
      if (typeof link !== 'string' || !link || link.includes('\0')) break;
      path = posix.resolve(posix.dirname(alias), link, ...parts.slice(i));
      replaced = true;
      break;
    }
    if (replaced) continue;
    if (index.files.some(file => file.path === path && file.size > 0 && (file.mode & 0o111))) return path;
    break;
  }
  throw new Error(`Guest terminal executable ${entry} is not present or executable in this prepared root. Set terminal.argv to an executable in that root.`);
}

async function stage(config: string, destination: string | AbortSignal) {
  const source = resolve(config), plan = readDeclaration(source);
  const root = resolve(dirname(source), plan.guest.directory);
  const target: {directory: string; out: string} | {directory: string; signal: AbortSignal} = typeof destination === 'string'
    ? outputLocation(resolve(destination)) : {directory: tmpdir(), signal: destination};
  if ('out' in target && lstatSync(target.out, {throwIfNoEntry: false})) throw new Error(`Output already exists: ${target.out}`);
  const pins = [['webroot.json', plan.guest.webrootSha256], ['muk.json', plan.guest.mukSha256]] as const;
  for (const [name, expected] of pins) {
    const path = join(root, name);
    if (!lstatSync(path).isFile()) throw new Error(`${name} is not a regular file.`);
    checkPin(name, readFileSync(path), expected);
  }
  // Store the verified bytes themselves, not paths back into the mutable input.
  const scratch = mkdtempSync(join(target.directory, '.ricebox-stage-'));
  const owner = lstatSync(scratch, {bigint: true});
  if (!owner.isDirectory()) throw new Error('Private staging directory is no longer a directory.');
  const ownsScratch = (): boolean => {
    const actual = lstatSync(scratch, {bigint: true, throwIfNoEntry: false});
    return !!actual?.isDirectory() && actual.dev === owner.dev && actual.ino === owner.ino;
  };
  try {
    const files = new Map<string, number>();
    const store = (name: string, bytes: Buffer) => {
      if (files.has(name)) return; // Repeated content addresses are still checked by the reader.
      const path = join(scratch, name);
      mkdirSync(dirname(path), {recursive: true});
      writeFileSync(path, bytes, {flag: 'wx'});
      files.set(name, bytes.length);
    };
    const {descriptor, index, maker} = visitDistributionAssets(root, {}, (path, bytes) => {
      for (const [name, expected] of pins) if (path === `ricebox/${name}`) checkPin(name, bytes, expected);
      store(path, bytes);
    });
    const program = executable(index, plan.terminal.argv[0]!);
    store('ricebox-starter.json', Buffer.from(JSON.stringify({
      v: 1, generation: descriptor.sha256, makerSha256: maker.sha256, program, terminal: plan.terminal,
    }) + '\n'));
    for (const [name, bytes] of browserModules({display: true})) store(name, bytes);
    const everyday = 'ricebox-js/everyday/src/surface.js';
    if (!files.has(everyday)) throw new Error('Everyday is missing from the browser package.');
    store('everyday.js', Buffer.from(`export * from ${JSON.stringify('./' + everyday)};\n`));
    for (const name of ['index.html', 'shell.css']) store(name, readFileSync(new URL(name, import.meta.url)));
    for (const name of ['distribution/starter/shell.js', 'distribution/starter/plan.js',
      'everyday/terminal/vt.js', 'everyday/terminal/vt-view.js']) {
      store('ricebox-js/' + name, readFileSync(new URL('../../' + name, import.meta.url)));
    }
    if (!ownsScratch()) throw new Error('Private staging directory changed.');
    if ('signal' in target) {
      await preview(scratch, files, target.signal);
      return;
    }
    const {out} = target;
    // Link only from the private snapshot and claim the destination exclusively.
    const parent = dirname(out);
    mkdirSync(parent, {recursive: true});
    if (realpathSync(parent) !== parent) throw new Error('Output parent changed while staging.');
    mkdirSync(out);
    for (const name of files.keys()) {
      const source = join(scratch, name), target = join(out, name);
      mkdirSync(dirname(target), {recursive: true});
      try { linkSync(source, target); }
      catch (error) {
        if (!['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        copyFileSync(source, target, constants.COPYFILE_EXCL);
        unlinkSync(source); // Copying need not retain a second copy of the rest of the site.
      }
    }
    console.log(`Ricebox terminal staged: ${out}`);
  } finally {
    if (ownsScratch()) rmSync(scratch, {recursive: true, force: true});
  }
}

try {
  const {values, positionals} = parseArgs({allowPositionals: true, options: {
    help: {type: 'boolean', short: 'h'}, preview: {type: 'boolean'},
  }});
  if (values.help) console.log(usage);
  else {
    const [config = 'ricebox.json', destination, ...extra] = positionals;
    if (extra.length || (values.preview && destination !== undefined)) throw new Error(usage);
    if (!values.preview) await stage(config, destination ?? 'ricebox-site');
    else {
      const controller = new AbortController(), stop = () => controller.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try { await stage(config, controller.signal); }
      finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    }
  }
} catch (error) {
  console.error(`ricebox-stage-shell: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
