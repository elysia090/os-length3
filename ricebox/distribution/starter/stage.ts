#!/usr/bin/env node
// Only stage an explicitly trusted prepared environment. No acquisition, execution or publishing.
import {createHash} from 'node:crypto';
import {constants, copyFileSync, existsSync, linkSync, lstatSync, readFileSync, realpathSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, posix, resolve} from 'node:path';
import {browserModules} from '../deployment/assets.ts';
import {visitDistributionAssets} from '../deployment/local.ts';
import type {Index} from '../format/manifest.ts';
import {authoredPlan} from './plan.ts';

const usage = 'Usage: ricebox-stage-shell DECLARATION_JSON NEW_SITE';
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
  throw new Error(`Guest terminal executable ${entry} is not present or executable in this prepared root.`);
}

try {
  const [config, destination, ...extra] = process.argv.slice(2);
  if (!config || !destination || extra.length) throw new Error(usage);
  const source = resolve(config), plan = authoredPlan(JSON.parse(readFileSync(source, 'utf8')));
  const requested = resolve(destination), root = resolve(dirname(source), plan.guest.directory);
  // Resolve a supported parent alias once for both staging and publication.
  const parent = realpathSync(dirname(requested)), out = join(parent, basename(requested));
  if (existsSync(out)) throw new Error(`Output already exists: ${out}`);
  const pins = [['webroot.json', plan.guest.webrootSha256], ['muk.json', plan.guest.mukSha256]] as const;
  for (const [name, expected] of pins) {
    const path = join(root, name);
    if (!lstatSync(path).isFile()) throw new Error(`${name} is not a regular file.`);
    checkPin(name, readFileSync(path), expected);
  }
  // Store the verified bytes themselves, not paths back into the mutable input.
  const scratch = mkdtempSync(join(parent, '.ricebox-stage-'));
  const owner = lstatSync(scratch, {bigint: true});
  if (!owner.isDirectory()) throw new Error('Private staging directory is no longer a directory.');
  const ownsScratch = (): boolean => {
    const actual = lstatSync(scratch, {bigint: true, throwIfNoEntry: false});
    return !!actual?.isDirectory() && actual.dev === owner.dev && actual.ino === owner.ino;
  };
  try {
    const files = new Set<string>();
    const store = (name: string, bytes: Buffer) => {
      if (files.has(name)) return; // Repeated content addresses are still checked by the reader.
      const path = join(scratch, name);
      mkdirSync(dirname(path), {recursive: true});
      writeFileSync(path, bytes, {flag: 'wx'});
      files.add(name);
    };
    const {descriptor, index, maker} = visitDistributionAssets(root, {}, (path, bytes) => {
      for (const [name, expected] of pins) if (path === `ricebox/${name}`) checkPin(name, bytes, expected);
      store(path, bytes);
    });
    const program = executable(index, plan.terminal.argv[0]!);
    store('ricebox-starter.json', Buffer.from(JSON.stringify({
      v: 1, generation: descriptor.sha256, makerSha256: maker.sha256, program, terminal: plan.terminal,
    }) + '\n'));
    for (const [name, bytes] of browserModules()) store(name, bytes);
    for (const name of ['index.html', 'shell.css']) store(name, readFileSync(new URL(name, import.meta.url)));
    for (const name of ['distribution/starter/shell.js', 'distribution/starter/plan.js',
      'everyday/terminal/vt.js', 'everyday/terminal/vt-view.js']) {
      store('ricebox-js/' + name, readFileSync(new URL('../../' + name, import.meta.url)));
    }
    // The destination stays absent on validation failure. Link only from our own
    // private snapshot: neither this nor the fallback overwrites an existing file.
    if (!ownsScratch()) throw new Error('Private staging directory changed.');
    mkdirSync(out);
    for (const name of files) {
      const source = join(scratch, name), target = join(out, name);
      mkdirSync(dirname(target), {recursive: true});
      try { linkSync(source, target); }
      catch (error) {
        if (!['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        copyFileSync(source, target, constants.COPYFILE_EXCL);
        unlinkSync(source); // Copying need not retain a second copy of the rest of the site.
      }
    }
  } finally {
    if (ownsScratch()) rmSync(scratch, {recursive: true, force: true});
  }
  console.log(`Ricebox terminal staged: ${out}`);
} catch (error) {
  console.error(`ricebox-stage-shell: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
