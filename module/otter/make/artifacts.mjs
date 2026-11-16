// Deploy-time package discovery belongs to otter. A publisher pins one catalog;
// consumers resolve its exact versions, never a moving 'latest' or shell recipes.
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync, lstatSync, readlinkSync, symlinkSync, renameSync, rmSync, existsSync, readdirSync} from 'node:fs';
import {resolve, join, dirname, posix} from 'node:path';
const hash = b => createHash('sha256').update(b).digest('hex');
const nameOK = s => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(s);
const wordOK = s => typeof s === 'string' && s.length > 0 && !/\s/.test(s);
function pathOK(s) { return typeof s === 'string' && s.length > 0 && !s.includes('\\') && !s.includes('\0') && s.split('/').every(p => p && p !== '.' && p !== '..'); }
function descriptor(d) {
  if (!d || !/^[a-f0-9]{64}$/.test(d.sha256) || !Number.isSafeInteger(d.size) || d.size < 0) throw new Error('otter: invalid artifact identity');
}
export function resolvePackages(catalog, selected) {
  if (catalog?.format !== 'otter-packages-v1' || !catalog.packages || typeof catalog.packages !== 'object' || Array.isArray(catalog.packages)) throw new Error('otter: invalid package catalog');
  if (!Array.isArray(selected) || !selected.length || selected.some(n => !nameOK(n)) || new Set(selected).size !== selected.length) throw new Error('otter: select unique package names');
  const active = new Set(), done = new Set(), ordered = [];
  const visit = name => {
    if (done.has(name)) return;
    if (active.has(name)) throw new Error(`otter: dependency cycle at ${name}`);
    const p = Object.hasOwn(catalog.packages,name) && catalog.packages[name];
    if (!p) throw new Error(`otter: unknown package ${name}`);
    if (![p.version,p.source,p.key].every(wordOK) || !Array.isArray(p.requires) || p.requires.some(n => !nameOK(n)) || !Array.isArray(p.files)) throw new Error(`otter: invalid package ${name}`);
    const seen = new Set();
    for (const f of p.files) {
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
    for (const f of p.files) for (let parent = posix.dirname(f.path); parent !== '.'; parent = posix.dirname(parent)) if (seen.has(parent) && !p.files.find(f=>f.path===parent)?.directory) throw new Error('otter: file used as a parent directory');
    active.add(name); for (const n of p.requires) visit(n); active.delete(name); done.add(name); ordered.push(name);
  };
  for (const name of selected) visit(name);
  return ordered;
}
async function download(url, identity) {
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
  if (!response.ok || !response.body) throw new Error(`otter: artifact request failed (${response.status})`);
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > identity.size) throw new Error('otter: artifact exceeds declared size');
      chunks.push(chunk);
    }
  } catch (error) { throw error; }
  const bytes = Buffer.concat(chunks);
  if (size !== identity.size || hash(bytes) !== identity.sha256) throw new Error('otter: artifact integrity mismatch');
  return bytes;
}
function linkTarget(f) { return f.target.startsWith('/') ? posix.relative(posix.dirname(f.path),posix.normalize(f.target.slice(1))) || '.' : f.target; }
function validateCache(root, catalog, packages) {
  for (const name of packages) {
    const p = catalog.packages[name], directory = join(root,name);
    const expected = new Set(p.files.map(f=>f.path));
    const walk = (at, prefix='') => {
      if (!lstatSync(at).isDirectory() || lstatSync(at).isSymbolicLink()) throw new Error('otter: unsafe cache directory');
      for (const e of readdirSync(at,{withFileTypes:true})) {
        const path=prefix+e.name;
        if (e.isDirectory()) walk(join(at,e.name),path+'/');
        else if (!expected.has(path)) throw new Error('otter: unexpected cached artifact');
      }
    };
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('otter: unsafe cache root');
    walk(join(directory,'tree'));
    for (const key of ['version','source','key']) if (readFileSync(join(directory,key),'utf8') !== p[key]) throw new Error('otter: cached metadata changed');
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
export async function acquirePackages({catalog: pin, packages: selected, cache}) {
  descriptor(pin);
  if (pin.size > 8 * 1024 * 1024) throw new Error('otter: catalog exceeds 8 MiB');
  const catalog = JSON.parse((await download(pin.url,pin)).toString('utf8'));
  const packages = resolvePackages(catalog,selected), base = resolve(cache);
  const host = `${process.platform}-${process.arch}`;
  const toolset = catalog.toolchains?.[host];
  if (catalog.toolchains && !toolset) throw new Error(`otter: no toolchain for ${host}`);
  if (toolset) for (const n of ['sods','translator','muk']) descriptor(toolset[n]);
  const result = root => {
    if (toolset && (!lstatSync(join(root,'.tools')).isDirectory() || lstatSync(join(root,'.tools')).isSymbolicLink())) throw new Error('otter: unsafe tools directory');
    const tools = toolset && Object.fromEntries(['sods','translator','muk'].map(n=>{
      const d=toolset[n], path=join(root,'.tools',n), stat=lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size!==d.size || (stat.mode & 0o777)!==(n==='sods'?0o755:0o644) || hash(readFileSync(path))!==d.sha256) throw new Error('otter: cached tool changed');
      return [n,{path,sha256:d.sha256,size:d.size}];
    }));
    return {packages,packageCache:root,...(tools ? {tools} : {})};
  };
  mkdirSync(base,{recursive:true});
  const target = join(base,hash(Buffer.from(pin.sha256+'\n'+host+'\n'+packages.join('\n'))));
  if (existsSync(target)) { validateCache(target,catalog,packages); return result(target); }
  const work = mkdtempSync(join(base,'.otter-'));
  try {
    for (const name of packages) {
      const p=catalog.packages[name], directory=join(work,name); mkdirSync(join(directory,'tree'),{recursive:true});
      for (const key of ['version','source','key']) writeFileSync(join(directory,key),p[key]);
      for (const f of p.files) {
        const file=join(directory,'tree',f.path); mkdirSync(dirname(file),{recursive:true});
        if (f.directory === true) mkdirSync(file,{recursive:true,mode:f.mode});
        else if (f.target !== undefined) symlinkSync(linkTarget(f),file);
        else writeFileSync(file,await download(new URL(`blobs/${f.sha256}`,pin.url),f),{mode:f.mode});
      }
    }
    if (toolset) {
      mkdirSync(join(work,'.tools'));
      for (const n of ['sods','translator','muk']) writeFileSync(join(work,'.tools',n),await download(new URL(`blobs/${toolset[n].sha256}`,pin.url),toolset[n]),{mode:n==='sods'?0o755:0o644});
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
export function publishCatalog({packageCache, packages, toolchains, output}) {
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) throw new Error('otter: package requirements must be explicit');
  if (existsSync(output)) throw new Error('otter: output already exists');
  const catalog={format:'otter-packages-v1',packages:Object.create(null)}, blobs=new Map();
  for (const [name,requires] of Object.entries(packages)) {
    if (!nameOK(name)) throw new Error('otter: invalid package name');
    const source=join(resolve(packageCache),name), p={requires,files:[]};
    for (const k of ['version','source','key']) p[k]=readFileSync(join(source,k),'utf8').trim();
    const walk=(at,prefix='')=>{
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
    catalog.toolchains=Object.create(null);
    for (const [host,tools] of Object.entries(toolchains)) {
      if (!/^[a-z]+-[a-z0-9]+$/.test(host)) throw new Error('otter: invalid toolchain host');
      catalog.toolchains[host]=Object.create(null);
      for (const n of ['sods','translator','muk']) {
        const bytes=readFileSync(tools[n]),sha256=hash(bytes); blobs.set(sha256,bytes); catalog.toolchains[host][n]={sha256,size:bytes.length};
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
