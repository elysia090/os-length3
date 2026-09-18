// A small WASI Preview 1 host for compiler modules.
//
// It implements the 29 calls imported by the extracted Clang/LLVM core. The
// filesystem is in memory: immutable files point directly into the downloaded
// resource tar, while source, temporary, object, and output files use mutable
// Uint8Arrays. No package-specific runtime or component adapter is involved.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ERRNO = {
  SUCCESS: 0, BADF: 8, EXIST: 20, INVAL: 28, IO: 29, ISDIR: 31,
  NOENT: 44, NOTDIR: 54, NOTEMPTY: 55, NOTSUP: 58, PERM: 63,
};
const FILETYPE = { UNKNOWN: 0, CHARACTER: 2, DIRECTORY: 3, REGULAR: 4, SYMLINK: 7 };
const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 };
const FDFLAGS = { APPEND: 1 };

function align512(value) {
  return (value + 511) & ~511;
}

function tarString(bytes, start, length) {
  const field = bytes.subarray(start, start + length);
  const zero = field.indexOf(0);
  return decoder.decode(zero < 0 ? field : field.subarray(0, zero));
}

function tarNumber(bytes, start, length) {
  const text = tarString(bytes, start, length).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function normalizePath(value) {
  const parts = [];
  for (const part of String(value).replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function parentPath(path) {
  const at = path.lastIndexOf('/');
  return at <= 0 ? '/' : path.slice(0, at);
}

function baseName(path) {
  return path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);
}

function addParents(nodes, path) {
  let parent = parentPath(path);
  const missing = [];
  while (!nodes.has(parent)) {
    missing.push(parent);
    parent = parentPath(parent);
  }
  for (let i = missing.length - 1; i >= 0; i -= 1) {
    nodes.set(missing[i], { type: 'dir', ino: nodes.nextIno++ });
  }
}

export class ResourceFault extends Error {
  constructor(path) {
    super(`resource page is not resident: ${path}`);
    this.path = path;
  }
}

/**
 * A read-only filesystem cut whose bytes stay in a physical-page reader.
 *
 * `entries` is the prefix-coded tar index emitted by the distribution builder.
 * Metadata remains resident, while a file payload exists only between the
 * read fault that asked for it and the end of that compiler command.
 */
export class LazyResourceCatalog {
  constructor(index, read, releaseResident = null, release = null) {
    if (!['tar-cut-v1', 'tar-cut-v2'].includes(index?.format)
        || !Array.isArray(index.entries)) {
      throw new Error('compiler resource index is invalid');
    }
    const hasMode = index.format === 'tar-cut-v2';
    if (typeof read !== 'function') throw new Error('resource reader is missing');
    this.nodes = new Map();
    this.nextIno = 2;
    this.read = read;
    this.dropResidentPages = releaseResident;
    this.dropBacking = release;
    this.residentBytes = 0;
    this.peakResidentBytes = 0;
    this.materializedFiles = 0;
    this.readFaults = 0;
    this.pending = new Map();
    this.nodes.nextIno = 2;
    this.nodes.set('/', { type: 'dir', ino: 1 });
    const mount = normalizePath(index.mount || '/usr');
    addParents(this.nodes, mount);
    if (!this.nodes.has(mount)) {
      this.nodes.set(mount, { type: 'dir', ino: this.nodes.nextIno++ });
    }

    const hardlinks = [];
    let previous = '';
    for (const entry of index.entries) {
      if (!Array.isArray(entry) || entry.length < 3) {
        throw new Error('compiler resource index entry is invalid');
      }
      const shared = Number(entry[0]);
      if (!Number.isSafeInteger(shared) || shared < 0 || shared > previous.length) {
        throw new Error('compiler resource path cut is invalid');
      }
      const relative = previous.slice(0, shared) + String(entry[1]);
      if (!relative || relative.startsWith('/')
          || relative.split('/').some((part) => !part || part === '..')) {
        throw new Error('compiler resource path is invalid');
      }
      const path = normalizePath(`${mount}/${relative}`);
      addParents(this.nodes, path);
      const kind = entry[2];
      const modeAt = kind === 'f' ? 5 : kind === 'd' ? 3 : 4;
      const mode = hasMode ? Number(entry[modeAt]) : undefined;
      if (hasMode && (!Number.isSafeInteger(mode) || mode < 0
          || mode > 0o7777)) {
        throw new Error('compiler resource mode is invalid');
      }
      if (kind === 'd') {
        this.nodes.set(path, {
          type: 'dir', mode,
          ino: this.nodes.nextIno++,
        });
      } else if (kind === 'f') {
        const offset = Number(entry[3]);
        const size = Number(entry[4]);
        if (!Number.isSafeInteger(offset) || offset < 0
            || !Number.isSafeInteger(size) || size < 0) {
          throw new Error('compiler resource extent is invalid');
        }
        this.nodes.set(path, {
          type: 'file', data: null, size, offset, readonly: true,
          mode,
          resource: true, ino: this.nodes.nextIno++,
        });
      } else if (kind === 'l') {
        this.nodes.set(path, {
          type: 'symlink', target: String(entry[3] || ''),
          mode,
          ino: this.nodes.nextIno++,
        });
      } else if (kind === 'h') {
        const target = String(entry[3] || '');
        if (!target || target.startsWith('/')
            || target.split('/').some((part) => !part || part === '..')) {
          throw new Error('compiler resource hardlink is invalid');
        }
        hardlinks.push([path, normalizePath(`${mount}/${target}`)]);
      } else {
        throw new Error('compiler resource type is invalid');
      }
      previous = relative;
    }
    let unresolved = hardlinks;
    while (unresolved.length) {
      const pending = [];
      let admitted = 0;
      for (const [path, target] of unresolved) {
        const node = this.nodes.get(target);
        if (!node) {
          pending.push([path, target]);
          continue;
        }
        this.nodes.set(path, node);
        admitted += 1;
      }
      if (!admitted) throw new Error('compiler resource hardlink target is missing');
      unresolved = pending;
    }
    this.nextIno = this.nodes.nextIno;
  }

  async materialize(path) {
    const normalized = normalizePath(path);
    const node = this.nodes.get(normalized);
    if (!node || node.type !== 'file' || !node.resource) {
      throw new Error(`resource fault is outside the immutable catalog: ${normalized}`);
    }
    if (node.data !== null) return node.data;
    let pending = this.pending.get(normalized);
    if (!pending) {
      this.readFaults += 1;
      pending = (async () => {
        const data = await this.read(node.offset, node.size);
        if (!(data instanceof Uint8Array) || data.length !== node.size) {
          throw new Error(`resource payload has the wrong extent: ${normalized}`);
        }
        node.data = data;
        this.residentBytes += data.length;
        this.peakResidentBytes = Math.max(this.peakResidentBytes, this.residentBytes);
        this.materializedFiles += 1;
        return data;
      })().finally(() => this.pending.delete(normalized));
      this.pending.set(normalized, pending);
    }
    return pending;
  }

  releaseMaterialized() {
    const bytes = this.residentBytes;
    for (const node of this.nodes.values()) {
      if (node.resource && node.data !== null) node.data = null;
    }
    this.residentBytes = 0;
    if (this.dropResidentPages) this.dropResidentPages();
    return bytes;
  }

  release() {
    this.releaseMaterialized();
    if (this.dropBacking) this.dropBacking();
  }

  layout() {
    return {
      indexedNodes: this.nodes.size,
      residentBytes: this.residentBytes,
      peakResidentBytes: this.peakResidentBytes,
      materializedFiles: this.materializedFiles,
      readFaults: this.readFaults,
    };
  }
}

/** Parse a ustar archive without copying file payloads. */
export function parseTar(buffer, mount = '/usr') {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const nodes = new Map();
  nodes.nextIno = 2;
  nodes.set('/', { type: 'dir', ino: 1 });
  const root = normalizePath(mount);
  addParents(nodes, root);
  nodes.set(root, { type: 'dir', ino: nodes.nextIno++ });

  for (let offset = 0; offset + 512 <= bytes.length;) {
    const name = tarString(bytes, offset, 100);
    if (!name) break;
    const prefix = tarString(bytes, offset + 345, 155);
    const relative = prefix ? `${prefix}/${name}` : name;
    const size = tarNumber(bytes, offset + 124, 12);
    const type = String.fromCharCode(bytes[offset + 156] || 48);
    const path = normalizePath(`${root}/${relative}`);
    addParents(nodes, path);
    if (type === '5' || relative.endsWith('/')) {
      nodes.set(path, { type: 'dir', ino: nodes.nextIno++ });
    } else if (type === '0' || type === '\0') {
      const start = offset + 512;
      nodes.set(path, {
        type: 'file',
        data: bytes.subarray(start, start + size),
        size,
        readonly: true,
        ino: nodes.nextIno++,
      });
    }
    offset += 512 + align512(size);
  }
  return nodes;
}

export class MemoryFileSystem {
  constructor(resourceNodes = null) {
    const base = resourceNodes?.nodes || resourceNodes;
    this.nodes = base ? new Map(base) : new Map();
    this.resources = resourceNodes?.materialize ? resourceNodes : null;
    this.nextIno = resourceNodes?.nextIno || 2;
    if (!this.nodes.has('/')) this.nodes.set('/', { type: 'dir', ino: 1 });
    this.mkdir('/work');
    this.mkdir('/tmp');
  }

  node(path) {
    const normalized = normalizePath(path);
    const node = this.nodes.get(normalized);
    if (!node) throw Object.assign(new Error(`no such file: ${normalized}`), { errno: ERRNO.NOENT });
    return node;
  }

  mkdir(path) {
    const normalized = normalizePath(path);
    if (this.nodes.has(normalized)) return;
    const parent = this.node(parentPath(normalized));
    if (parent.type !== 'dir') throw Object.assign(new Error('parent is not a directory'), { errno: ERRNO.NOTDIR });
    this.nodes.set(normalized, { type: 'dir', ino: this.nextIno++ });
  }

  writeFile(path, value) {
    const normalized = normalizePath(path);
    const missing = [];
    let parentName = parentPath(normalized);
    while (!this.nodes.has(parentName)) {
      missing.push(parentName);
      parentName = parentPath(parentName);
    }
    for (let index = missing.length - 1; index >= 0; index -= 1) {
      this.mkdir(missing[index]);
    }
    const parent = this.node(parentPath(normalized));
    if (parent.type !== 'dir') throw Object.assign(new Error('parent is not a directory'), { errno: ERRNO.NOTDIR });
    const data = value instanceof Uint8Array ? value.slice() : encoder.encode(String(value));
    this.nodes.set(normalized, { type: 'file', data, ino: this.nextIno++ });
  }

  readFile(path) {
    const node = this.node(path);
    if (node.type !== 'file') throw Object.assign(new Error('path is not a file'), { errno: ERRNO.ISDIR });
    if (node.data === null) throw new ResourceFault(path);
    return node.data;
  }

  mutableFile(path) {
    const normalized = normalizePath(path);
    const node = this.node(normalized);
    if (node.type !== 'file') throw Object.assign(new Error('path is not a file'), { errno: ERRNO.ISDIR });
    if (node.data === null) throw new ResourceFault(normalized);
    if (!node.readonly) return node;
    const copy = {
      ...node, data: node.data.slice(), size: undefined, readonly: false,
    };
    this.nodes.set(normalized, copy);
    return copy;
  }

  children(path) {
    const normalized = normalizePath(path);
    const prefix = normalized === '/' ? '/' : `${normalized}/`;
    const found = [];
    for (const child of this.nodes.keys()) {
      if (!child.startsWith(prefix) || child === normalized) continue;
      const rest = child.slice(prefix.length);
      if (!rest.includes('/')) found.push(child);
    }
    return found.sort();
  }

  fork() {
    const copy = new MemoryFileSystem();
    copy.nodes = new Map();
    for (const [path, node] of this.nodes) {
      copy.nodes.set(path, node.readonly || node.type !== 'file'
        ? node : { ...node, data: node.data.slice() });
    }
    copy.nextIno = this.nextIno;
    copy.resources = this.resources;
    return copy;
  }

  async materialize(path) {
    if (!this.resources) throw new ResourceFault(path);
    return this.resources.materialize(path);
  }

  releaseResources() {
    return this.resources ? this.resources.releaseMaterialized() : 0;
  }
}

export class WasiExit extends Error {
  constructor(code) {
    super(`WASI process exited with status ${code}`);
    this.code = code;
  }
}

export class WasiPreview1 {
  constructor({ args, fs, stdout, stderr, env = {} }) {
    this.args = args;
    this.env = Object.entries(env).map(([key, value]) => `${key}=${value}`);
    this.fs = fs;
    this.stdout = stdout || (() => {});
    this.stderr = stderr || (() => {});
    this.memory = null;
    this.descriptors = new Map([
      [0, { type: 'input', data: new Uint8Array(), pos: 0 }],
      [1, { type: 'stream', write: this.stdout }],
      [2, { type: 'stream', write: this.stderr }],
      [3, { type: 'dir', path: '/' }],
    ]);
    this.nextFd = 4;
    this.lastError = null;

    const names = [
      'args_get', 'args_sizes_get', 'environ_get', 'environ_sizes_get',
      'clock_time_get', 'fd_close', 'fd_fdstat_get', 'fd_filestat_get',
      'fd_filestat_set_size', 'fd_filestat_set_times', 'fd_pread',
      'fd_prestat_get', 'fd_prestat_dir_name', 'fd_read', 'fd_readdir',
      'fd_seek', 'fd_write', 'path_create_directory', 'path_filestat_get',
      'path_link', 'path_open', 'path_readlink', 'path_remove_directory',
      'path_rename', 'path_symlink', 'path_unlink_file', 'poll_oneoff',
      'proc_exit', 'random_get',
    ];
    const api = {};
    for (const name of names) {
      api[name] = (...values) => {
        try {
          return this[name](...values);
        } catch (error) {
          if (error instanceof WasiExit || error instanceof ResourceFault) throw error;
          this.lastError = error;
          return error?.errno || ERRNO.IO;
        }
      };
    }
    this.imports = { wasi_snapshot_preview1: api };
  }

  setMemory(memory) {
    this.memory = memory;
  }

  view() {
    return new DataView(this.memory.buffer);
  }

  bytes() {
    return new Uint8Array(this.memory.buffer);
  }

  text(ptr, length) {
    return decoder.decode(this.bytes().subarray(ptr, ptr + length));
  }

  descriptor(fd) {
    const value = this.descriptors.get(fd);
    if (!value) throw Object.assign(new Error(`bad descriptor ${fd}`), { errno: ERRNO.BADF });
    return value;
  }

  path(fd, ptr, length) {
    const raw = this.text(ptr, length);
    if (raw.startsWith('/')) return normalizePath(raw);
    const descriptor = this.descriptor(fd);
    if (descriptor.type !== 'dir') throw Object.assign(new Error('descriptor is not a directory'), { errno: ERRNO.NOTDIR });
    return normalizePath(`${descriptor.path}/${raw}`);
  }

  writeStrings(strings, pointers, buffer) {
    const view = this.view();
    let cursor = buffer;
    strings.forEach((value, index) => {
      const encoded = encoder.encode(value);
      view.setUint32(pointers + index * 4, cursor, true);
      this.bytes().set(encoded, cursor);
      this.bytes()[cursor + encoded.length] = 0;
      cursor += encoded.length + 1;
    });
  }

  args_sizes_get(countPtr, sizePtr) {
    const view = this.view();
    view.setUint32(countPtr, this.args.length, true);
    view.setUint32(sizePtr, this.args.reduce((sum, value) => sum + encoder.encode(value).length + 1, 0), true);
    return 0;
  }

  args_get(pointers, buffer) {
    this.writeStrings(this.args, pointers, buffer);
    return 0;
  }

  environ_sizes_get(countPtr, sizePtr) {
    const view = this.view();
    view.setUint32(countPtr, this.env.length, true);
    view.setUint32(sizePtr, this.env.reduce((sum, value) => sum + encoder.encode(value).length + 1, 0), true);
    return 0;
  }

  environ_get(pointers, buffer) {
    this.writeStrings(this.env, pointers, buffer);
    return 0;
  }

  clock_time_get(clockId, _precision, resultPtr) {
    const milliseconds = clockId === 0 ? Date.now() : globalThis.performance.now();
    this.view().setBigUint64(resultPtr, BigInt(Math.floor(milliseconds * 1e6)), true);
    return 0;
  }

  fd_close(fd) {
    if (fd <= 3 || !this.descriptors.delete(fd)) return ERRNO.BADF;
    return 0;
  }

  fileType(descriptor) {
    if (descriptor.type === 'stream' || descriptor.type === 'input') return FILETYPE.CHARACTER;
    if (descriptor.type === 'dir') return FILETYPE.DIRECTORY;
    return FILETYPE.REGULAR;
  }

  fd_fdstat_get(fd, resultPtr) {
    const descriptor = this.descriptor(fd);
    const view = this.view();
    this.bytes().fill(0, resultPtr, resultPtr + 24);
    view.setUint8(resultPtr, this.fileType(descriptor));
    view.setUint16(resultPtr + 2, descriptor.append ? FDFLAGS.APPEND : 0, true);
    view.setBigUint64(resultPtr + 8, 0xffffffffffffffffn, true);
    view.setBigUint64(resultPtr + 16, 0xffffffffffffffffn, true);
    return 0;
  }

  writeFilestat(node, resultPtr) {
    const view = this.view();
    this.bytes().fill(0, resultPtr, resultPtr + 64);
    view.setBigUint64(resultPtr + 8, BigInt(node.ino || 1), true);
    view.setUint8(resultPtr + 16, node.type === 'dir' ? FILETYPE.DIRECTORY : node.type === 'symlink' ? FILETYPE.SYMLINK : FILETYPE.REGULAR);
    view.setBigUint64(resultPtr + 24, 1n, true);
    view.setBigUint64(resultPtr + 32, BigInt(node.size ?? node.data?.length ?? 0), true);
  }

  fd_filestat_get(fd, resultPtr) {
    const descriptor = this.descriptor(fd);
    if (descriptor.type === 'stream' || descriptor.type === 'input') {
      return this.writeFilestat({ type: 'file', data: new Uint8Array(), ino: fd + 1 }, resultPtr) || 0;
    }
    this.writeFilestat(this.fs.node(descriptor.path), resultPtr);
    return 0;
  }

  fd_filestat_set_size(fd, sizeValue) {
    const descriptor = this.descriptor(fd);
    if (descriptor.type !== 'file') return ERRNO.BADF;
    const node = this.fs.mutableFile(descriptor.path);
    const size = Number(sizeValue);
    const data = new Uint8Array(size);
    data.set(node.data.subarray(0, size));
    node.data = data;
    node.readonly = false;
    return 0;
  }

  fd_filestat_set_times() {
    return 0;
  }

  readInto(descriptor, iovs, iovsLength, resultPtr, offset = null) {
    const view = this.view();
    const node = descriptor.type === 'input' ? descriptor : this.fs.node(descriptor.path);
    if (node.type === 'dir') return ERRNO.ISDIR;
    if (node.data === null) throw new ResourceFault(descriptor.path);
    let position = offset === null ? descriptor.pos : Number(offset);
    let total = 0;
    for (let index = 0; index < iovsLength; index += 1) {
      const ptr = view.getUint32(iovs + index * 8, true);
      const length = view.getUint32(iovs + index * 8 + 4, true);
      const available = Math.min(length, Math.max(0, node.data.length - position));
      this.bytes().set(node.data.subarray(position, position + available), ptr);
      position += available;
      total += available;
      if (available < length) break;
    }
    if (offset === null) descriptor.pos = position;
    view.setUint32(resultPtr, total, true);
    return 0;
  }

  fd_read(fd, iovs, iovsLength, resultPtr) {
    return this.readInto(this.descriptor(fd), iovs, iovsLength, resultPtr);
  }

  fd_pread(fd, iovs, iovsLength, offset, resultPtr) {
    return this.readInto(this.descriptor(fd), iovs, iovsLength, resultPtr, offset);
  }

  fd_prestat_get(fd, resultPtr) {
    const descriptor = this.descriptor(fd);
    if (fd !== 3 || descriptor.type !== 'dir') return ERRNO.BADF;
    this.view().setUint8(resultPtr, 0);
    this.view().setUint32(resultPtr + 4, 1, true);
    return 0;
  }

  fd_prestat_dir_name(fd, resultPtr, length) {
    if (fd !== 3 || length < 1) return ERRNO.BADF;
    this.bytes()[resultPtr] = 47;
    return 0;
  }

  fd_readdir(fd, buffer, bufferLength, cookie, usedPtr) {
    const descriptor = this.descriptor(fd);
    if (descriptor.type !== 'dir') return ERRNO.NOTDIR;
    const current = this.fs.node(descriptor.path);
    const children = [
      { name: '.', node: current },
      { name: '..', node: this.fs.node(parentPath(descriptor.path)) },
      ...this.fs.children(descriptor.path).map((path) => ({ name: baseName(path), node: this.fs.node(path) })),
    ];
    let used = 0;
    for (let index = Number(cookie); index < children.length; index += 1) {
      if (bufferLength - used < 24) break;
      const entry = children[index];
      const name = encoder.encode(entry.name);
      const view = this.view();
      view.setBigUint64(buffer + used, BigInt(index + 1), true);
      view.setBigUint64(buffer + used + 8, BigInt(entry.node.ino || 1), true);
      view.setUint32(buffer + used + 16, name.length, true);
      view.setUint8(buffer + used + 20, entry.node.type === 'dir' ? FILETYPE.DIRECTORY : FILETYPE.REGULAR);
      this.bytes().fill(0, buffer + used + 21, buffer + used + 24);
      const copied = Math.min(name.length, bufferLength - used - 24);
      this.bytes().set(name.subarray(0, copied), buffer + used + 24);
      used += 24 + copied;
      if (copied < name.length) break;
    }
    this.view().setUint32(usedPtr, used, true);
    return 0;
  }

  fd_seek(fd, offset, whence, resultPtr) {
    const descriptor = this.descriptor(fd);
    if (descriptor.type !== 'file' && descriptor.type !== 'input') return ERRNO.BADF;
    const node = descriptor.type === 'input' ? descriptor : this.fs.node(descriptor.path);
    const base = whence === 0 ? 0 : whence === 1 ? descriptor.pos
      : (node.size ?? node.data?.length ?? 0);
    const position = base + Number(offset);
    if (position < 0) return ERRNO.INVAL;
    descriptor.pos = position;
    this.view().setBigUint64(resultPtr, BigInt(position), true);
    return 0;
  }

  fd_write(fd, iovs, iovsLength, resultPtr) {
    const descriptor = this.descriptor(fd);
    const view = this.view();
    let total = 0;
    for (let index = 0; index < iovsLength; index += 1) {
      const ptr = view.getUint32(iovs + index * 8, true);
      const length = view.getUint32(iovs + index * 8 + 4, true);
      const chunk = this.bytes().subarray(ptr, ptr + length);
      if (descriptor.type === 'stream') {
        descriptor.write(chunk.slice());
      } else if (descriptor.type === 'file') {
        const node = this.fs.mutableFile(descriptor.path);
        const position = descriptor.append ? node.data.length : descriptor.pos;
        const size = Math.max(node.data.length, position + length);
        const data = new Uint8Array(size);
        data.set(node.data);
        data.set(chunk, position);
        node.data = data;
        node.readonly = false;
        descriptor.pos = position + length;
      } else {
        return ERRNO.BADF;
      }
      total += length;
    }
    view.setUint32(resultPtr, total, true);
    return 0;
  }

  path_create_directory(fd, pathPtr, pathLength) {
    const path = this.path(fd, pathPtr, pathLength);
    if (this.fs.nodes.has(path)) return ERRNO.EXIST;
    this.fs.mkdir(path);
    return 0;
  }

  path_filestat_get(fd, _flags, pathPtr, pathLength, resultPtr) {
    this.writeFilestat(this.fs.node(this.path(fd, pathPtr, pathLength)), resultPtr);
    return 0;
  }

  path_link(oldFd, _flags, oldPtr, oldLength, newFd, newPtr, newLength) {
    const oldPath = this.path(oldFd, oldPtr, oldLength);
    const newPath = this.path(newFd, newPtr, newLength);
    if (this.fs.nodes.has(newPath)) return ERRNO.EXIST;
    this.fs.nodes.set(newPath, this.fs.node(oldPath));
    return 0;
  }

  path_open(fd, _dirFlags, pathPtr, pathLength, openFlags, _rights, _inheriting, fdFlags, resultPtr) {
    const path = this.path(fd, pathPtr, pathLength);
    let node = this.fs.nodes.get(path);
    if (!node) {
      if (!(openFlags & OFLAGS.CREAT)) return ERRNO.NOENT;
      this.fs.writeFile(path, new Uint8Array());
      node = this.fs.node(path);
    } else if ((openFlags & OFLAGS.CREAT) && (openFlags & OFLAGS.EXCL)) {
      return ERRNO.EXIST;
    }
    if ((openFlags & OFLAGS.DIRECTORY) && node.type !== 'dir') return ERRNO.NOTDIR;
    if ((openFlags & OFLAGS.TRUNC) && node.type === 'file') {
      node = this.fs.mutableFile(path);
      node.data = new Uint8Array();
      node.readonly = false;
    }
    const opened = this.nextFd++;
    this.descriptors.set(opened, node.type === 'dir'
      ? { type: 'dir', path }
      : { type: 'file', path, pos: 0, append: Boolean(fdFlags & FDFLAGS.APPEND) });
    this.view().setUint32(resultPtr, opened, true);
    return 0;
  }

  path_readlink(fd, pathPtr, pathLength, buffer, bufferLength, usedPtr) {
    const node = this.fs.node(this.path(fd, pathPtr, pathLength));
    if (node.type !== 'symlink') return ERRNO.INVAL;
    const target = encoder.encode(node.target);
    const length = Math.min(bufferLength, target.length);
    this.bytes().set(target.subarray(0, length), buffer);
    this.view().setUint32(usedPtr, length, true);
    return 0;
  }

  path_remove_directory(fd, pathPtr, pathLength) {
    const path = this.path(fd, pathPtr, pathLength);
    const node = this.fs.node(path);
    if (node.type !== 'dir') return ERRNO.NOTDIR;
    if (this.fs.children(path).length) return ERRNO.NOTEMPTY;
    this.fs.nodes.delete(path);
    return 0;
  }

  path_rename(oldFd, oldPtr, oldLength, newFd, newPtr, newLength) {
    const oldPath = this.path(oldFd, oldPtr, oldLength);
    const newPath = this.path(newFd, newPtr, newLength);
    const moved = [];
    for (const [path, node] of this.fs.nodes) {
      if (path === oldPath || path.startsWith(`${oldPath}/`)) {
        moved.push([path, normalizePath(newPath + path.slice(oldPath.length)), node]);
      }
    }
    if (!moved.length) return ERRNO.NOENT;
    for (const [path] of moved) this.fs.nodes.delete(path);
    for (const [, path, node] of moved) this.fs.nodes.set(path, node);
    return 0;
  }

  path_symlink(targetPtr, targetLength, fd, pathPtr, pathLength) {
    const path = this.path(fd, pathPtr, pathLength);
    if (this.fs.nodes.has(path)) return ERRNO.EXIST;
    this.fs.nodes.set(path, { type: 'symlink', target: this.text(targetPtr, targetLength), ino: this.fs.nextIno++ });
    return 0;
  }

  path_unlink_file(fd, pathPtr, pathLength) {
    const path = this.path(fd, pathPtr, pathLength);
    const node = this.fs.node(path);
    if (node.type === 'dir') return ERRNO.ISDIR;
    this.fs.nodes.delete(path);
    return 0;
  }

  poll_oneoff(inputPtr, outputPtr, count, resultPtr) {
    const view = this.view();
    for (let index = 0; index < count; index += 1) {
      const input = inputPtr + index * 48;
      const output = outputPtr + index * 32;
      this.bytes().fill(0, output, output + 32);
      view.setBigUint64(output, view.getBigUint64(input, true), true);
      view.setUint8(output + 10, view.getUint8(input + 8));
    }
    view.setUint32(resultPtr, count, true);
    return 0;
  }

  proc_exit(code) {
    throw new WasiExit(code);
  }

  random_get(ptr, length) {
    const target = this.bytes().subarray(ptr, ptr + length);
    for (let offset = 0; offset < target.length; offset += 65536) {
      globalThis.crypto.getRandomValues(target.subarray(offset, Math.min(offset + 65536, target.length)));
    }
    return 0;
  }
}
