// Deploy-time package discovery belongs to otter. A publisher pins one catalog;
// consumers resolve its exact versions, never a moving 'latest' or shell recipes.
import {createHash} from 'node:crypto';
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, lstatSync, readlinkSync, symlinkSync, renameSync, rmSync, existsSync, readdirSync} from 'node:fs';
import {resolve, join, dirname, posix} from 'node:path';
type Identity = {sha256: string; size: number};
type Artifact = Identity & {path: string; mode: number; directory?: false; target?: undefined};
type Directory = {path: string; directory: true; mode: number; target?: undefined};
type Link = {path: string; target: string; directory?: false};
type PackageFile = Artifact | Directory | Link;
type Package = {version: string; source: string; key: string; requires: string[]; files: PackageFile[]};
const toolNames = ['sods', 'translator', 'muk'] as const;
type ToolName = typeof toolNames[number];
type Tools<T> = Record<ToolName, T>;
type Catalog = {format: string; packages: Record<string, Package>; toolchains?: Record<string, Tools<Identity>>};
type Acquisition = {packages: string[]; packageCache: string; tools?: Tools<Identity & {path: string}>};
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nameOK = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(s);
const wordOK = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && !/\s/.test(s);
function pathOK(s: unknown): s is string { return typeof s === 'string' && s.length > 0 && !s.includes('\\') && !s.includes('\0') && s.split('/').every(p => p && p !== '.' && p !== '..'); }
function descriptor<T>(d: T): asserts d is T & Identity {
  if (!object(d) || typeof d.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(d.sha256) || typeof d.size !== 'number' || !Number.isSafeInteger(d.size) || d.size < 0) throw new Error('otter: invalid artifact identity');
}
function resolveSelection(catalog: unknown, selected: unknown): {packages: Record<string, Package>; ordered: string[]; toolchains: unknown} {
  if (!object(catalog) || catalog.format !== 'otter-packages-v1' || !object(catalog.packages)) throw new Error('otter: invalid package catalog');
  if (!Array.isArray(selected) || !selected.length || !selected.every(nameOK) || new Set(selected).size !== selected.length) throw new Error('otter: select unique package names');
  const active = new Set<string>(), ordered: string[] = [];
  const source = catalog.packages, packages: Record<string, Package> = Object.create(null);
  const visit = (name: string) => {
    if (Object.hasOwn(packages, name)) return;
    if (active.has(name)) throw new Error(`otter: dependency cycle at ${name}`);
    const p = Object.hasOwn(source,name) && source[name];
    if (!p) throw new Error(`otter: unknown package ${name}`);
    if (!object(p) || !wordOK(p.version) || !wordOK(p.source) || !wordOK(p.key) || !Array.isArray(p.requires) || p.requires.some(n => !nameOK(n)) || !Array.isArray(p.files)) throw new Error(`otter: invalid package ${name}`);
    const seen = new Set<string>();
    for (const value of p.files as unknown[]) {
      if (!object(value)) throw new Error(`otter: duplicate or unsafe path in ${name}`);
      const f = value;
      if (!pathOK(f.path) || seen.has(f.path)) throw new Error(`otter: duplicate or unsafe path in ${name}`);
      seen.add(f.path);
      if (f.directory === true) { if (f.mode !== 0o755 && f.mode !== 0o700) throw new Error('otter: invalid directory permissions'); }
      else if (f.target !== undefined) {
        // Guest-absolute links are represented relative to the package tree so
        // materializing a package never creates a host-absolute link.
        if (!wordOK(f.target) || f.target.includes('\\') || f.target.includes('\0')) throw new Error('otter: invalid symlink');
        const target = posix.normalize(f.target.startsWith('/') ? f.target.slice(1) : posix.join(posix.dirname(f.path),f.target));
        if (target === '..' || target.startsWith('../') || posix.isAbsolute(target)) throw new Error('otter: escaping symlink');
      } else { descriptor(f); if (f.mode !== 0o644 && f.mode !== 0o755) throw new Error('otter: unsupported file permissions'); }
    }
    // Every selected file and requirement above was checked. Unselected packages
    // remain unknown and are never exposed to cache/materialization code.
    const checked = p as Package;
    for (const f of checked.files) for (let parent = posix.dirname(f.path); parent !== '.'; parent = posix.dirname(parent)) if (seen.has(parent) && !checked.files.find(f=>f.path===parent)?.directory) throw new Error('otter: file used as a parent directory');
    active.add(name); for (const n of checked.requires) visit(n); active.delete(name); packages[name] = checked; ordered.push(name);
  };
  for (const name of selected) visit(name);
  return {packages, ordered, toolchains: catalog.toolchains};
}
export function resolvePackages(catalog: unknown, selected: unknown): string[] {
  return resolveSelection(catalog, selected).ordered;
}
async function download(url: string | URL, identity: Identity) {
  descriptor(identity);
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('otter: artifacts require HTTPS without embedded credentials');
  let response, current=parsed;
  for (let hops=0; hops<=5; hops++) {
    if (current.protocol !== 'https:' || current.username || current.password) throw new Error('otter: unsafe artifact redirect');
    response=await fetch(current,{redirect:'manual',signal:AbortSignal.timeout(120000)});
    if (![301,302,303,307,308].includes(response.status)) break;
    const location=response.headers.get('location');
    await response.body?.cancel();
    if (!location || hops===5) throw new Error('otter: invalid artifact redirect');
    current=new URL(location,current);
  }
  if (!response || !response.ok || !response.body) throw new Error(`otter: artifact request failed (${response?.status})`);
  const chunks: Uint8Array[] = []; let size = 0;
  // Node's fetch body implements async iteration; the shared tsconfig's DOM
  // stream typings do not include the separate DOM.AsyncIterable declarations.
  const body = response.body as typeof response.body & AsyncIterable<Uint8Array>;
  try {
    for await (const chunk of body) {
      size += chunk.length;
      if (size > identity.size) throw new Error('otter: artifact exceeds declared size');
      chunks.push(chunk);
    }
  } catch (error) { throw error; }
  const bytes = Buffer.concat(chunks);
  if (size !== identity.size || hash(bytes) !== identity.sha256) throw new Error('otter: artifact integrity mismatch');
  return bytes;
}
function linkTarget(f: Link) { return f.target.startsWith('/') ? posix.relative(posix.dirname(f.path),posix.normalize(f.target.slice(1))) || '.' : f.target; }
function validateCache(root: string, catalog: Pick<Catalog, 'packages'>, packages: string[]) {
  for (const name of packages) {
    const p = catalog.packages[name], directory = join(root,name);
    const expected = new Set(p.files.map(f=>f.path));
    const walk = (at: string, prefix=''): void => {
      if (!lstatSync(at).isDirectory() || lstatSync(at).isSymbolicLink()) throw new Error('otter: unsafe cache directory');
      for (const e of readdirSync(at,{withFileTypes:true})) {
        const path=prefix+e.name;
        if (e.isDirectory()) walk(join(at,e.name),path+'/');
        else if (!expected.has(path)) throw new Error('otter: unexpected cached artifact');
      }
    };
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('otter: unsafe cache root');
    walk(join(directory,'tree'));
    for (const key of (['version','source','key'] as const)) if (readFileSync(join(directory,key),'utf8') !== p[key]) throw new Error('otter: cached metadata changed');
    for (const f of p.files) {
      const file = join(directory,'tree',f.path);
      for (let parent = dirname(file); parent !== root; parent = dirname(parent)) if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) throw new Error('otter: unsafe cache parent');
      const stat = lstatSync(file);
      if (f.directory === true) { if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== f.mode) throw new Error('otter: cached directory changed'); }
      else if (f.target !== undefined) { if (!stat.isSymbolicLink() || readlinkSync(file) !== linkTarget(f)) throw new Error('otter: cached link changed'); }
      else if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== f.mode || stat.size !== f.size || hash(readFileSync(file)) !== f.sha256) throw new Error('otter: cached artifact changed');
    }
  }
}
export async function acquirePackages({catalog: pin, packages: selected, cache}: {catalog: Identity & {url: string}; packages: string[]; cache: string}): Promise<Acquisition> {
  descriptor(pin);
  if (pin.size > 8 * 1024 * 1024) throw new Error('otter: catalog exceeds 8 MiB');
  const decoded: unknown = JSON.parse((await download(pin.url,pin)).toString('utf8'));
  const selection = resolveSelection(decoded, selected);
  const catalog = {packages: selection.packages};
  const packages = selection.ordered, base = resolve(cache);
  const host = `${process.platform}-${process.arch}`;
  const offered = object(selection.toolchains) ? selection.toolchains[host] : undefined;
  if (selection.toolchains && !offered) throw new Error(`otter: no toolchain for ${host}`);
  let toolset: Tools<Identity> | undefined;
  if (offered) {
    if (!object(offered)) throw new Error('otter: invalid artifact identity');
    for (const n of toolNames) descriptor(offered[n]);
    toolset = offered as Tools<Identity>; // Each of the three identities was checked.
  }
  const result = (root: string): Acquisition => {
    if (toolset && (!lstatSync(join(root,'.tools')).isDirectory() || lstatSync(join(root,'.tools')).isSymbolicLink())) throw new Error('otter: unsafe tools directory');
    const selectedTools = toolset;
    const tools = selectedTools && Object.fromEntries(toolNames.map(n=>{
      const d=selectedTools[n], path=join(root,'.tools',n), stat=lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size!==d.size || (stat.mode & 0o777)!==(n==='sods'?0o755:0o644) || hash(readFileSync(path))!==d.sha256) throw new Error('otter: cached tool changed');
      return [n,{path,sha256:d.sha256,size:d.size}];
    })) as Tools<Identity & {path: string}> | undefined;
    return {packages,packageCache:root,...(tools ? {tools} : {})};
  };
  mkdirSync(base,{recursive:true});
  const target = join(base,hash(Buffer.from(pin.sha256+'\n'+host+'\n'+packages.join('\n'))));
  if (existsSync(target)) { validateCache(target,catalog,packages); return result(target); }
  const work = mkdtempSync(join(base,'.otter-'));
  try {
    for (const name of packages) {
      const p=catalog.packages[name], directory=join(work,name); mkdirSync(join(directory,'tree'),{recursive:true});
      for (const key of (['version','source','key'] as const)) writeFileSync(join(directory,key),p[key]);
      for (const f of p.files) {
        const file=join(directory,'tree',f.path); mkdirSync(dirname(file),{recursive:true});
        // Creation modes are filtered by the host umask; a parent may also
        // have been made implicitly for an earlier child. Apply guest modes
        // explicitly inside this private staging tree, never to its container.
        if (f.directory === true) { mkdirSync(file,{recursive:true}); chmodSync(file,f.mode); }
        else if (f.target !== undefined) symlinkSync(linkTarget(f),file);
        else { writeFileSync(file,await download(new URL(`blobs/${f.sha256}`,pin.url),f)); chmodSync(file,f.mode); }
      }
    }
    if (toolset) {
      mkdirSync(join(work,'.tools'));
      for (const n of toolNames) {
        const file=join(work,'.tools',n);
        writeFileSync(file,await download(new URL(`blobs/${toolset[n].sha256}`,pin.url),toolset[n]));
        chmodSync(file,n==='sods'?0o755:0o644);
      }
    }
    writeFileSync(join(work,'record'),packages.map(n=>`${n} ${catalog.packages[n].version}`).join('\n')+'\n');
    validateCache(work,catalog,packages);
    try { renameSync(work,target); }
    catch (error) { if (!existsSync(target)) throw error; validateCache(target,catalog,packages); }
    return result(target);
  } finally { rmSync(work,{recursive:true,force:true}); }
}

// Publisher-side adapter for the existing build cache. Runtime dependencies are
// explicit; build.sh's 'needs' is deliberately NOT treated as runtime requires.
export function publishCatalog({packageCache, packages, toolchains, output}: {packageCache: string; packages: Record<string, string[]>; toolchains?: Record<string, Tools<string>>; output: string}): Identity {
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) throw new Error('otter: package requirements must be explicit');
  if (existsSync(output)) throw new Error('otter: output already exists');
  const catalog: Catalog = {format:'otter-packages-v1',packages:Object.create(null)}, blobs=new Map<string, Uint8Array>();
  for (const [name,requires] of Object.entries(packages)) {
    if (!nameOK(name)) throw new Error('otter: invalid package name');
    const source=join(resolve(packageCache),name);
    // Preserve the catalog's existing field insertion order (digest identity).
    const p = {requires, files: [] as PackageFile[], version: readFileSync(join(source,'version'),'utf8').trim(), source: readFileSync(join(source,'source'),'utf8').trim(), key: readFileSync(join(source,'key'),'utf8').trim()};
    const walk=(at: string,prefix=''): void=>{
      for (const e of readdirSync(at,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
        const path=prefix+e.name, file=join(at,e.name);
        if (e.isDirectory()) { p.files.push({path,directory:true,mode:lstatSync(file).mode & 0o777}); walk(file,path+'/'); }
        else if (e.isSymbolicLink()) p.files.push({path,target:readlinkSync(file)});
        else if (e.isFile()) {
          const bytes=readFileSync(file), sha256=hash(bytes), mode=lstatSync(file).mode & 0o111 ? 0o755 : 0o644;
          blobs.set(sha256,bytes); p.files.push({path,sha256,size:bytes.length,mode});
        } else throw new Error('otter: unsupported package file type');
      }
    };
    walk(join(source,'tree')); catalog.packages[name]=p;
  }
  if (toolchains) {
    const indexed: NonNullable<Catalog['toolchains']> = Object.create(null);
    catalog.toolchains=indexed;
    for (const [host,tools] of Object.entries(toolchains)) {
      if (!/^[a-z]+-[a-z0-9]+$/.test(host)) throw new Error('otter: invalid toolchain host');
      const identities: Tools<Identity> = Object.create(null);
      indexed[host]=identities;
      for (const n of toolNames) {
        const bytes=readFileSync(tools[n]),sha256=hash(bytes); blobs.set(sha256,bytes); identities[n]={sha256,size:bytes.length};
      }
    }
  }
  resolvePackages(catalog,Object.keys(packages));
  const bytes=Buffer.from(JSON.stringify(catalog)+'\n');
  mkdirSync(join(output,'blobs'),{recursive:true});
  for (const [sha256,content] of blobs) writeFileSync(join(output,'blobs',sha256),content);
  writeFileSync(join(output,'catalog.json'),bytes);
  return {sha256:hash(bytes),size:bytes.length};
}
