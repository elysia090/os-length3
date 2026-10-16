// Open file descriptions and per-process descriptor tables.

export class Pipe {
  constructor() {
    this.chunks = [];
    this.size = 0;
    this.readers = 0;
    this.writers = 0;
  }
  write(bytes) {
    this.chunks.push(bytes.slice());
    this.size += bytes.length;
  }
  read(n) {
    const out = new Uint8Array(Math.min(n, this.size));
    let at = 0;
    while (at < out.length) {
      const c = this.chunks[0], take = Math.min(c.length, out.length - at);
      out.set(c.subarray(0, take), at);
      at += take;
      if (take === c.length) this.chunks.shift(); else this.chunks[0] = c.subarray(take);
    }
    this.size -= out.length;
    return out;
  }
}

/** One open file description, shared by dup'd and inherited descriptors. */
export class Description {
  constructor(kind, {node = null, pipe = null, flags = 0, path = ''} = {}) {
    this.kind = kind; // file | dir | pipe-r | pipe-w | console | device
    this.node = node;
    this.pipe = pipe;
    this.flags = flags;
    this.path = path;
    this.offset = 0;
    this.refs = 0;
    if (kind === 'pipe-r') pipe.readers++;
    if (kind === 'pipe-w') pipe.writers++;
  }
  retain() { this.refs++; return this; }
  release() {
    if (--this.refs > 0) return;
    if (this.kind === 'pipe-r') this.pipe.readers--;
    if (this.kind === 'pipe-w') this.pipe.writers--;
  }
}

export const MAX_FDS = 1024;

export class FdTable {
  constructor() {
    this.slots = new Map(); // fd -> {description, cloexec}
  }
  get(fd) { return this.slots.get(fd)?.description ?? null; }
  lowest(from = 0) {
    let fd = from;
    while (this.slots.has(fd)) fd++;
    return fd < MAX_FDS ? fd : -1;
  }
  install(description, {fd = this.lowest(), cloexec = false} = {}) {
    if (fd < 0) return -1;
    this.close(fd);
    this.slots.set(fd, {description: description.retain(), cloexec});
    return fd;
  }
  close(fd) {
    const slot = this.slots.get(fd);
    if (!slot) return false;
    this.slots.delete(fd);
    slot.description.release();
    return true;
  }
  setCloexec(fd, on) { const s = this.slots.get(fd); if (s) s.cloexec = on; }
  cloexec(fd) { return this.slots.get(fd)?.cloexec ?? false; }
  /** A child's table: the same descriptions, each retained once more. */
  fork() {
    const t = new FdTable();
    for (const [fd, s] of this.slots) t.slots.set(fd, {description: s.description.retain(), cloexec: s.cloexec});
    return t;
  }
  /** exec closes descriptors marked close-on-exec. */
  exec() { for (const [fd, s] of [...this.slots]) if (s.cloexec) this.close(fd); }
  closeAll() { for (const fd of [...this.slots.keys()]) this.close(fd); }
}
