import {lstatSync, readdirSync, readlinkSync, openSync, readSync, closeSync} from 'node:fs';
import {resolve, posix} from 'node:path';
import {pathToFileURL} from 'node:url';

// Resolve names as the assembled root will, never following an absolute symlink on
// the build machine. In particular, the build machine's Python is not a dependency.
export function checkScripts(root: string): string[] {
  root = resolve(root);
  const errors: string[] = [];
  const locate = (name: string): string => {
    if (!name.startsWith('/')) throw new Error(`interpreter is not absolute: ${name}`);
    let parts = name.split('/'), done: string[] = [], links = 0;
    while (parts.length) {
      const part = parts.shift()!;
      if (!part || part === '.') continue;
      if (part === '..') { done.pop(); continue; }
      const at = '/' + [...done, part].join('/');
      const st = lstatSync(root + at);
      if (st.isSymbolicLink()) {
        if (++links > 40) throw new Error(`symlink loop: ${name}`);
        const target = readlinkSync(root + at);
        if (target.startsWith('/')) done = [];
        parts = [...target.split('/'), ...parts];
      } else {
        if (parts.some((p) => p && p !== '.') && !st.isDirectory()) throw new Error(`not a directory: ${at}`);
        done.push(part);
      }
    }
    return '/' + done.join('/');
  };
  const checked = new Set<string>();
  const inspect = (name: string, stack: string[] = []): void => {
    const at = locate(name), st = lstatSync(root + at);
    if (!st.isFile() || !(st.mode & 0o111)) throw new Error(`not an executable file: ${name}`);
    if (stack.includes(at)) throw new Error(`interpreter cycle: ${[...stack, at].join(' -> ')}`);
    if (checked.has(at)) return;
    const fd = openSync(root + at, 'r'), bytes = Buffer.alloc(256);
    let count: number;
    try { count = readSync(fd, bytes, 0, bytes.length, 0); } finally { closeSync(fd); }
    if (bytes[0] !== 35 || bytes[1] !== 33) { checked.add(at); return; }
    const text = bytes.subarray(2, count).toString(), end = text.indexOf('\n');
    if (end < 0 && count === bytes.length) throw new Error(`shebang exceeds the supported header: ${name}`);
    const line = (end < 0 ? text : text.slice(0, end)).replace(/^[ \t]+|[ \t]+$/g, '');
    if (line.includes('\r')) throw new Error(`carriage return in shebang: ${name}`);
    const match = /^(\S+)(?:[ \t]+(.*))?$/.exec(line);
    if (!match) throw new Error(`empty shebang: ${name}`);
    const interpreter = match[1]!, rest = match[2] ?? '';
    inspect(interpreter, [...stack, at]);
    if (posix.basename(interpreter) === 'env') {
      // Linux passes one optional argument, not shell words. Multiple arguments
      // need env's explicit -S. Keep quoted interpreter names intact.
      let words = [rest];
      if (/^-S(?:[ \t]|$)/.test(rest) || /^--split-string=/.test(rest)) {
        const split = rest.replace(/^-S[ \t]*|^--split-string=/, '');
        words = splitEnv(split);
      }
      const command = words[0];
      if (!command || command.startsWith('-') || command.includes('=')) throw new Error(`unsupported env command in ${name}: ${rest}`);
      if (command.includes('/')) inspect(command, [...stack, at]);
      else {
        let found: string | undefined;
        for (const dir of ['/usr/local/bin', '/usr/bin', '/bin']) {
          try { const p = locate(`${dir}/${command}`), s = lstatSync(root + p); if (s.isFile() && (s.mode & 0o111)) { found = p; break; } } catch { /* try the next root PATH entry */ }
        }
        if (!found) throw new Error(`env interpreter absent from root PATH: ${command}`);
        inspect(found, [...stack, at]);
      }
    }
    checked.add(at);
  };
  const walk = (dir: string) => {
    for (const entry of readdirSync(root + dir, {withFileTypes: true})) {
      const path = posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && !entry.name.endsWith('.sample') && (lstatSync(root + path).mode & 0o111)) {
        try { inspect(path); } catch (e) { errors.push(`${path}: ${(e as Error).message}`); }
      }
    }
  };
  walk('/');
  return errors;
}

function splitEnv(source: string): string[] {
  const words: string[] = []; let word = '', quote = '', started = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '$' || c === '\\') throw new Error('env -S expansion/escape needs an explicit, reproducible interpreter');
    if (quote) { if (c === quote) quote = ''; else word += c; started = true; }
    else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (/\s/.test(c)) { if (started) { words.push(word); word = ''; started = false; } }
    else { word += c; started = true; }
  }
  if (quote) throw new Error('unclosed quote in env -S');
  if (started) words.push(word);
  return words;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) { console.error('usage: scripts.ts ROOT'); process.exit(2); }
  const errors = checkScripts(process.argv[2]!);
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
}
