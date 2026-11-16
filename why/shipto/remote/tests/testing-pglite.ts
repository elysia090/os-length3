// For tests: PGlite as the tests' Remotes use it (testing.ts), the same Postgres asked the same things, sooner.
// Not part of the service.
//
// PGlite's own query (0.5, its BasePGlite in dist/chunk-*.js) hands Postgres a statement in three calls into
// its WebAssembly: parse and describe, then bind, describe and execute, then sync; and Postgres parses,
// analyses and plans the statement's text each time. A call costs some 100 µs before Postgres does anything,
// and parsing and planning as much again: a small statement took 600 µs, and a test of the Remote makes a
// hundred and more. Here a statement's text is parsed once, as a named statement (as a pooled driver keeps
// them, postgres.js's or pg's), with the types of its parameters and of its columns as Postgres described them;
// after that, each time it is asked is one call: bind, execute, sync. That is 120 µs.
//
// What Postgres does with a statement, says and sends back is the same: the same text and parameters, typed
// as it typed them, run in a transaction of its own or in the one open. A plan Postgres keeps is checked by
// Postgres before each use (a table altered, the role or search_path changed: it is made again); and once a
// statement other than reading, writing and a session's settings has run (a table made, altered or dropped, a
// role made, statements let go), every statement is parsed afresh, so none is ever read against a schema it
// was not parsed for. A result's values are parsed by the parser for their type where it is, `o.parsers`
// first, as PGlite's own copy of its parsers had them. The rest is PGlite's own, step for step: its locks, its
// blobs, its errors (a statement's, with the statement on them), its transactions.

import {MemoryFS, messages, PGlite, protocol, types, type QueryOptions, type Results, type Transaction} from '@electric-sql/pglite';
import {query as template} from '@electric-sql/pglite/template';

type Message = Awaited<ReturnType<PGlite['execProtocolStream']>>[number];
type Parsers = NonNullable<QueryOptions['parsers']>;
type Field = {name: string; dataTypeID: number};
/** A statement Postgres keeps under `name`: the types its parameters were given, the columns it answers with. */
type Statement = {name: string; params: number[]; fields: Field[]};
const {serialize} = protocol;

/** Messages for Postgres in one call: it reads them one after another, as if each had come in a call of its own. */
function together(each: Uint8Array[]) {
  if (each.length === 1) return each[0];
  const all = new Uint8Array(each.reduce((n, m) => n + m.length, 0));
  let at = 0;
  for (const m of each) { all.set(m, at); at += m.length; }
  return all;
}

/**
 * Commands after which every statement kept is still read as it was parsed: reading and writing rows, a
 * transaction's steps, a session's settings (a plan made under other ones Postgres makes again). Any other (a
 * table made, altered or dropped, a role made, a grant, DISCARD ALL, DEALLOCATE) and every statement is let go.
 */
const KEEPS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY', 'FETCH', 'MOVE', 'BEGIN', 'START TRANSACTION', 'COMMIT', 'ROLLBACK',
  'SAVEPOINT', 'RELEASE', 'SET', 'RESET', 'SHOW', 'LISTEN', 'UNLISTEN', 'NOTIFY', 'CLOSE CURSOR', 'CLOSE CURSOR ALL', 'LOCK TABLE', 'TRUNCATE TABLE',
  'DISCARD TEMP', 'DISCARD SEQUENCES', 'EXPLAIN', 'DECLARE CURSOR']);
/** At most this many kept at once; the one asked longest ago goes first. */
const KEPT = 500;

/**
 * What came back read as results, as PGlite reads them (parseResults): a value by the parser for its type in
 * `o.parsers` if it names that type, else in the database's own (`parsers`), else PGlite's defaults. `fields`,
 * the columns of a statement described before it ran (its own RowDescription, when there is one, comes first).
 */
function read(got: Message[], parsers: Parsers, o: QueryOptions | undefined, blob: Blob | undefined, fields: Field[] = []): Results[] {
  const own = o?.parsers;
  const value = (v: string | null, type: number) => {
    if (v === null) return null;
    // Told its type too, as PGlite tells it (an array's parser reads its elements by it).
    const parser: types.Parser | undefined = (own && Object.hasOwn(own, type) ? own[type] : parsers[type]) ?? types.parsers[type];
    return parser ? parser(v, type) : v;
  };
  const all: Results[] = [];
  let r: Results = {rows: [], fields}, affected = 0;
  for (const m of got) {
    switch (m.name) {
      case 'rowDescription':
        r.fields = (m as messages.RowDescriptionMessage).fields.map((f) => ({name: f.name, dataTypeID: f.dataTypeID}));
        break;
      case 'dataRow': {
        const cells = (m as messages.DataRowMessage).fields, f = r.fields;
        if (o?.rowMode === 'array') {
          r.rows.push(cells.map((v, i) => value(v, f[i].dataTypeID)));
        } else {
          const row: Record<string, unknown> = {};
          for (let i = 0; i < cells.length; i++) row[f[i].name] = value(cells[i], f[i].dataTypeID);
          r.rows.push(row);
        }
        break;
      }
      case 'commandComplete': {
        const words = (m as messages.CommandCompleteMessage).text.split(' '), command = words[0], n = parseInt(words[words.length - 1], 10);
        if (['INSERT', 'UPDATE', 'DELETE', 'COPY', 'MERGE'].includes(command)) affected += n;
        const done: Results & {rowCount?: number} = {...r, command, affectedRows: affected};
        if (!Number.isNaN(n)) done.rowCount = n;
        if (blob) done.blob = blob;
        all.push(done);
        r = {rows: [], fields: []};
        break;
      }
    }
  }
  if (all.length === 0) all.push({affectedRows: 0, rows: [], fields: []});
  return all;
}

/** An error of Postgres's with the statement it was about on it, as PGlite throws one. */
const about = (e: unknown, query: string, params: unknown[] | undefined, o: QueryOptions | undefined) =>
  e instanceof messages.DatabaseError ? Object.assign(e, {query, params, queryOptions: o}) : e;

export class QuickPGlite extends PGlite {
  /** Whether a transaction is open: its statements leave the files to be synced when it ends. */
  #inTransaction = false;
  /** The statements kept, by their text (and the types asked for their parameters), the one asked last, last. */
  #kept = new Map<string, Statement>();
  #named = 0;
  /** Statements let go, to be closed in Postgres at the start of the next call. */
  #closing: Uint8Array[] = [];

  /** Messages to Postgres in one call, after any closing; its errors thrown and its notices told as `o` says. */
  async #send(each: Uint8Array[], o?: QueryOptions) {
    const closing = this.#closing.splice(0);
    const got = await this.execProtocolStream(together(closing.length ? [...closing, serialize.sync(), ...each] : each), {...o, syncToFs: false});
    // A command that may have changed what a statement kept reads: every one is let go.
    for (const m of got) if (m.name === 'commandComplete' && !KEEPS.has((m as messages.CommandCompleteMessage).text.replace(/ \d+$/, '').replace(/ 0$/, ''))) this.#forget();
    return got;
  }

  /** Every statement kept let go, here and (with the next call) in Postgres. */
  #forget() {
    for (const s of this.#kept.values()) this.#closing.push(serialize.close({type: 'S', name: s.name}));
    this.#kept.clear();
  }

  /** The statement Postgres keeps for this text: kept from before, or parsed and described now. */
  async #statement(query: string, o?: QueryOptions): Promise<Statement> {
    const key = o?.paramTypes?.length ? `${o.paramTypes.join(',')}\0${query}` : query;
    const kept = this.#kept.get(key);
    if (kept) {
      this.#kept.delete(key);
      this.#kept.set(key, kept);
      return kept;
    }
    const name = `q${++this.#named}`;
    const said = await this.#send([serialize.parse({name, text: query, types: o?.paramTypes}), serialize.describe({type: 'S', name}), serialize.sync()], o);
    const s: Statement = {name, params: [], fields: []};
    for (const m of said) {
      if (m.name === 'parameterDescription') s.params = (m as messages.ParameterDescriptionMessage).dataTypeIDs;
      else if (m.name === 'rowDescription') s.fields = (m as messages.RowDescriptionMessage).fields.map((f) => ({name: f.name, dataTypeID: f.dataTypeID}));
    }
    this.#kept.set(key, s);
    if (this.#kept.size > KEPT) {
      const [oldest, gone] = this.#kept.entries().next().value!;
      this.#kept.delete(oldest);
      this.#closing.push(serialize.close({type: 'S', name: gone.name}));
    }
    return s;
  }

  #runQuery<T>(query: string, params: unknown[] = [], o?: QueryOptions): Promise<Results<T>> {
    return this._runExclusiveQuery(async () => {
      if (this.debug > 0) console.log('runQuery', query, params, o);
      await this._handleBlob(o?.blob);
      let got: Message[], s: Statement;
      try {
        s = await this.#statement(query, o);
        const values = params.map((v, k) => {
          const type = s.params[k];
          if (v == null) return null;
          const write = o?.serializers?.[type] ?? this.serializers[type];
          return write ? write(v) : (v as {toString(): string}).toString();
        });
        got = await this.#send([serialize.bind({statement: s.name, values}), serialize.execute({}), serialize.sync()], o);
      } catch (e) {
        throw about(e, query, params, o);
      }
      await this._cleanupBlob();
      await this.#synced();
      return read(got, this.parsers, o, await this._getWrittenBlob(), s.fields)[0] as Results<T>;
    });
  }

  #runExec(query: string, o?: QueryOptions): Promise<Results[]> {
    return this._runExclusiveQuery(async () => {
      if (this.debug > 0) console.log('runExec', query, o);
      await this._handleBlob(o?.blob);
      let got: Message[];
      try {
        got = await this.#send([serialize.query(query), serialize.sync()], o);
      } catch (e) {
        // What ran of its statements before the one that failed is not told: any of them may have changed a table.
        this.#forget();
        throw about(e, query, undefined, o);
      }
      // Not waited for, as PGlite does not.
      void this._cleanupBlob();
      await this.#synced();
      return read(got, this.parsers, o, await this._getWrittenBlob());
    });
  }

  /**
   * Its files synced, as PGlite syncs them after a statement outside a transaction: but for a database in memory
   * (as the tests' are), where syncing does nothing but wait its turn.
   */
  async #synced() {
    if (!this.#inTransaction && this.dataDir && !this.dataDir.startsWith('memory://')) await this.syncToFs();
  }

  override async query<T>(query: string, params?: unknown[], o?: QueryOptions): Promise<Results<T>> {
    await this._checkReady();
    return await this._runExclusiveTransaction(async () => await this.#runQuery<T>(query, params, o));
  }

  override async exec(query: string, o?: QueryOptions): Promise<Results[]> {
    await this._checkReady();
    return await this._runExclusiveTransaction(async () => await this.#runExec(query, o));
  }

  override async transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> {
    await this._checkReady();
    return await this._runExclusiveTransaction(async () => {
      await this.#runExec('BEGIN');
      this.#inTransaction = true;
      let closed = false;
      const open = () => { if (closed) throw new Error('Transaction is closed'); };
      const tx: Transaction = {
        query: async (query, params, o) => (open(), await this.#runQuery(query, params, o)),
        sql: async (strings, ...params) => {
          open();
          const {query, params: values} = template(strings, ...params);
          return await this.#runQuery(query, values);
        },
        exec: async (query, o) => (open(), await this.#runExec(query, o)),
        rollback: async () => { open(); await this.#runExec('ROLLBACK'); closed = true; },
        listen: async (channel, callback) => (open(), await this.listen(channel, callback, tx)),
        get closed() { return closed; },
      };
      try {
        const result = await callback(tx);
        if (!closed) { closed = true; await this.#runExec('COMMIT'); }
        this.#inTransaction = false;
        return result;
      } catch (e) {
        if (!closed) { closed = true; await this.#runExec('ROLLBACK'); }
        this.#inTransaction = false;
        throw e;
      }
    });
  }
}

// ---- a database's files, written as they are ----
//
// PGlite starts a database from a tarball (loadDataDir) by reading it whole, untarring it, and writing each file
// after asking, for each folder above it, whether it is there: a fifth of a second for a migrated database (42 MB,
// 1,235 files), each time one is made. And a tarball PGlite dumps is of a running Postgres, which each database
// made from it then recovers as from a crash, replaying what was written since its last checkpoint.
// Here a database's files are kept as Postgres leaves them when it shuts down (`DataDirFS.left`), and written into
// a new one's filesystem as they are, each folder made once: Postgres finds a database it shut down, and starts.

/** A database's files as Postgres left them when it shut down: its folders, parents first, and each file's bytes, by path in PGDATA. */
export interface DataDir { dirs: string[]; files: [string, Uint8Array][] }

/** Where PGlite keeps its database (its PGDATA). */
const PGDATA = '/pglite/data';
/** What of Emscripten's filesystem is used here. */
interface FS {
  mkdirTree(path: string): void;
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array, o?: {canOwn?: boolean}): void;
  readFile(path: string): Uint8Array;
  readdir(path: string): string[];
  stat(path: string): {mode: number};
  isDir(mode: number): boolean;
}
/** A WAL segment's name. */
const SEGMENT = /^pg_wal\/[0-9A-F]{24}$/;
/** Postgres's pages, a WAL segment's among them. */
const PAGE = 8192;

/**
 * PGlite's memory filesystem, holding `from` in PGDATA from the start (PGlite finds a database there, and starts
 * it; with none, it runs initdb); and, to `keep`, keeping what PGDATA holds once Postgres has shut down, as `left`.
 */
export class DataDirFS extends MemoryFS {
  left?: DataDir;
  readonly #from?: DataDir;
  readonly #keep: boolean;
  constructor(from?: DataDir, {keep = false} = {}) {
    super();
    this.#from = from;
    this.#keep = keep;
  }

  #fs = () => this.pg!.Module.FS as unknown as FS;

  override async initialSyncFs() {
    await super.initialSyncFs();
    if (!this.#from) return;
    const fs = this.#fs();
    fs.mkdirTree(PGDATA);
    for (const d of this.#from.dirs) fs.mkdir(`${PGDATA}/${d}`);
    // A copy each, the file's own from then on: what Postgres writes to it is this database's alone.
    for (const [path, bytes] of this.#from.files) fs.writeFile(`${PGDATA}/${path}`, Uint8Array.prototype.slice.call(bytes), {canOwn: true});
  }

  override async closeFs() {
    if (this.#keep) this.left = this.#left();
    await super.closeFs();
  }

  /** What PGDATA holds now. */
  #left() {
    const fs = this.#fs(), left: DataDir = {dirs: [], files: []};
    const walk = (dir: string) => {
      for (const name of fs.readdir(`${PGDATA}/${dir}`)) {
        if (name === '.' || name === '..') continue;
        const path = dir ? `${dir}/${name}` : name;
        if (fs.isDir(fs.stat(`${PGDATA}/${path}`).mode)) {
          left.dirs.push(path);
          walk(path);
          continue;
        }
        let bytes = fs.readFile(`${PGDATA}/${path}`);
        // A WAL segment is made whole, zeros past what was written: Postgres, shut down, reads no further than its
        // last checkpoint, and writes on from there. Kept to the page after the last written.
        if (SEGMENT.test(path)) {
          let end = bytes.length;
          while (end > 0 && bytes.subarray(end - PAGE, end).every((b) => b === 0)) end -= PAGE;
          bytes = bytes.slice(0, Math.min(bytes.length, end + PAGE));
        }
        left.files.push([path, bytes]);
      }
    };
    walk('');
    return left;
  }
}

/** A database's files as one run of bytes: its paths and sizes (JSON, after its length), then each file's bytes. */
export function packed(d: DataDir): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify({dirs: d.dirs, files: d.files.map(([p, b]) => [p, b.length])}));
  const all = new Uint8Array(4 + head.length + d.files.reduce((n, [, b]) => n + b.length, 0));
  new DataView(all.buffer).setUint32(0, head.length, true);
  all.set(head, 4);
  let at = 4 + head.length;
  for (const [, b] of d.files) { all.set(b, at); at += b.length; }
  return all;
}

/** What `packed` made, its files' bytes read where they lie. */
export function unpacked(all: Uint8Array): DataDir {
  const length = new DataView(all.buffer, all.byteOffset).getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(all.subarray(4, 4 + length))) as {dirs: string[]; files: [string, number][]};
  let at = 4 + length;
  return {dirs: head.dirs, files: head.files.map(([p, n]) => [p, all.subarray(at, (at += n))])};
}
