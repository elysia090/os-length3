#!/usr/bin/env node
// Consume a trusted prepared release. No acquisition, execution or publishing.
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {browserModules, distributionAssets} from '../deployment/assets.ts';
import {releaseVersion} from '../build/version.ts';
import type {About, Index} from '../format/manifest.ts';

const usage = 'Usage: ricebox-stage-shell PREPARED_ROOT NEW_SITE WEBROOT_JSON_SHA256 MUK_JSON_SHA256';
const digest = /^[0-9a-f]{64}$/;
function checkPin(name: string, bytes: Buffer, expected: string) {
  if (createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error(`${name} does not match the trusted release pin.`);
  }
}

try {
  const [input, destination, webPin = '', mukPin = '', ...extra] = process.argv.slice(2);
  if (!input || !destination || !digest.test(webPin) || !digest.test(mukPin) || extra.length) {
    throw new Error(usage);
  }
  const out = resolve(destination), root = resolve(input);
  if (existsSync(out)) throw new Error(`Output already exists: ${out}`);
  const pins = [['webroot.json', webPin], ['muk.json', mukPin]] as const;
  // Check the trusted metadata before following its references into the root.
  for (const [name, expected] of pins) {
    const path = join(root, name);
    if (!lstatSync(path).isFile()) throw new Error(`${name} is not a regular file.`);
    checkPin(name, readFileSync(path), expected);
  }
  const files = distributionAssets(root);
  // Check the exact copies that will be written, not merely earlier reads.
  for (const [name, expected] of pins) checkPin(name, files.get('ricebox/' + name)!, expected);
  const release = JSON.parse(files.get('ricebox/webroot.json')!.toString('utf8')) as About;
  const version = releaseVersion();
  if (release.version !== version) {
    throw new Error(`Prepared root version ${release.version} does not match this Ricebox package (${version}).`);
  }
  const index = JSON.parse(files.get('ricebox/' + release.index.path)!.toString('utf8')) as Index;
  if (!index.files.some(file => file.path === '/usr/bin/busybox' && file.size > 0 && (file.mode & 0o111))) {
    throw new Error('Prepare a shell root with executable /usr/bin/busybox before staging.');
  }
  for (const [name, bytes] of browserModules()) files.set(name, bytes);
  for (const name of ['index.html', 'shell.css']) files.set(name, readFileSync(new URL(name, import.meta.url)));
  // Preserve the browser shell's literal relative import of the runtime.
  files.set('ricebox-js/distribution/starter/shell.js', readFileSync(new URL('shell.js', import.meta.url)));
  // A missing or invalid dependency leaves no output. Never replace an existing site.
  mkdirSync(out);
  for (const [name, bytes] of files) {
    const path = join(out, name);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, bytes, {flag: 'wx'});
  }
  console.log(`Ricebox shell staged: ${out}`);
} catch (error) {
  console.error(`ricebox-stage-shell: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
