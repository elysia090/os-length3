#!/usr/bin/env node
// Only stage an explicitly trusted prepared environment. No acquisition, execution or publishing.
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join, posix, resolve} from 'node:path';
import {browserModules, distributionAssets} from '../deployment/assets.ts';
import {blobAsset, releaseIndexAsset, readReleaseIndex, type About, type Index} from '../format/manifest.ts';
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
  const out = resolve(destination), root = resolve(dirname(source), plan.guest.directory);
  if (existsSync(out)) throw new Error(`Output already exists: ${out}`);
  const pins = [['webroot.json', plan.guest.webrootSha256], ['muk.json', plan.guest.mukSha256]] as const;
  for (const [name, expected] of pins) {
    const path = join(root, name);
    if (!lstatSync(path).isFile()) throw new Error(`${name} is not a regular file.`);
    checkPin(name, readFileSync(path), expected);
  }
  const files = distributionAssets(root);
  for (const [name, expected] of pins) checkPin(name, files.get('ricebox/' + name)!, expected);
  const release = JSON.parse(files.get('ricebox/webroot.json')!.toString('utf8')) as About;
  const descriptor = releaseIndexAsset(release);
  const index = readReleaseIndex(files.get('ricebox/' + descriptor.path)!, release);
  const maker = blobAsset(JSON.parse(files.get('ricebox/muk.json')!.toString('utf8')));
  const program = executable(index, plan.terminal.argv[0]!);
  files.set('ricebox-starter.json', Buffer.from(JSON.stringify({
    v: 1, generation: descriptor.sha256, makerSha256: maker.sha256, program, terminal: plan.terminal,
  }) + '\n'));
  for (const [name, bytes] of browserModules()) files.set(name, bytes);
  for (const name of ['index.html', 'shell.css']) files.set(name, readFileSync(new URL(name, import.meta.url)));
  for (const name of ['distribution/starter/shell.js', 'distribution/starter/plan.js',
    'everyday/terminal/vt.js', 'everyday/terminal/vt-view.js']) {
    files.set('ricebox-js/' + name, readFileSync(new URL('../../' + name, import.meta.url)));
  }
  // Missing or invalid inputs leave no output. Never overwrite an existing site.
  mkdirSync(out);
  for (const [name, bytes] of files) {
    const path = join(out, name);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, bytes, {flag: 'wx'});
  }
  console.log(`Ricebox terminal staged: ${out}`);
} catch (error) {
  console.error(`ricebox-stage-shell: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
