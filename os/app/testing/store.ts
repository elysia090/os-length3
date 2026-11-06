// For tests only: one repo's files as the store keeps them, in memory.

/** A repo's files by path (a folder is null), with the store's calls over them. */
export function memoryRepo(files: Record<string, string | null>) {
  const under = (dir: string) => (dir ? `${dir}/` : '');
  const kids = (dir: string) => [...new Set(Object.keys(files).filter((p) => p.startsWith(under(dir)) && p !== dir).map((p) => p.slice(under(dir).length).split('/')[0]))];
  const isDir = (dir: string) => files[dir] === null || kids(dir).length > 0;
  return {
    files,
    async tree(_: string, dir: string) {
      if (dir && !isDir(dir)) throw new Error(`no ${dir}`);
      return kids(dir).map((name) => ({name, kind: typeof files[under(dir) + name] === 'string' ? 'file' : 'dir', size: 0}));
    },
    async read(_: string, path: string) { if (typeof files[path] !== 'string') throw new Error(`no ${path}`); return {text: files[path], truncated: false}; },
    async write(_: string, path: string, text: string) { if (typeof files[path] !== 'string') throw new Error(`no ${path}`); files[path] = text; return text.length; },
    async mkdir(_: string, path: string) { if (path in files) throw new Error('exists'); files[path] = null; },
    async add(_: string, dir: string, name: string, text: string) {
      const path = dir ? `${dir}/${name}` : name;
      if (path in files) throw new Error('exists');
      if (dir && !isDir(dir)) throw new Error(`no ${dir}`);
      files[path] = text;
      return text.length;
    },
    async remove(_: string, path: string) { delete files[path]; },
  };
}
