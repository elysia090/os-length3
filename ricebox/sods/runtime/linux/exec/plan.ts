// Plan a static Linux replacement without changing a task or making its old
// process image unavailable. Artifact selection stays with the kernel cache.
import {utf8} from '../flow.ts';
import {E, FsError, type File} from '../fs.ts';
import type {Program, Range} from '../parts.ts';
import {execScope, execSource, type ExecSource, type ExecSourceOwner} from './source.ts';
import {staticStack, type StackLayout, type StaticStack} from './stack.ts';

export interface ExecRequest {
  readonly path: string;
  readonly argv: readonly string[];
  readonly env: readonly string[];
}
/** Artifact lookup is owned by the embedding kernel, not the plan. */
export interface StaticExecOwner<I extends Program> extends ExecSourceOwner {
  readonly kernel: ExecSourceOwner['kernel'] & {
    translated(node: File): boolean;
    keptFor(node: File): boolean;
    image(node: File, wait: boolean): I;
  };
}

/** Initial Linux state, independent of the dispatch backend. */
export interface ExecMetadata {
  readonly source: ExecSource;
  readonly exe: string;
  readonly argv: string[];
  readonly env: string[];
  readonly stack: StackLayout;
}

export interface StaticExecPlan<I extends Program> extends ExecMetadata {
  readonly image: I;
  readonly entry: bigint;
  readonly stack: StaticStack;
  readonly laid: Range[];
  check(): void;
}

// Use the existing shebang argument grammar; cap script nesting instead of
// depending on the host's recursion limit. No PT_INTERP support in this path.
const SCRIPT_LIMIT = 4;

export function planStaticExec<I extends Program>(process: StaticExecOwner<I>, request: ExecRequest): StaticExecPlan<I> {
  const scope = execScope(process), sources: ExecSource[] = [];
  const kernel = process.kernel, env = [...request.env];
  let {path} = request, argv = [...request.argv];
  for (;;) {
    const source = execSource(process, path, scope);
    sources.push(source);
    const {node} = source.at;
    let head: Uint8Array | null;
    // An attached or kept artifact needs no payload read just to establish
    // a static ELF candidate. Its source must still be executable now.
    try { head = kernel.translated(node) || kernel.keptFor(node) ? null : node.read(0, 128); }
    finally { source.check(); }
    if (head?.[0] === 0x23 && head[1] === 0x21) {
      if (sources.length > SCRIPT_LIMIT) throw new FsError(E.LOOP);
      const [interpreter = '', ...rest] = utf8(head).split('\n')[0].slice(2).trim().split(/\s+/);
      argv = [interpreter, ...rest.slice(0, 1), path, ...argv.slice(1)];
      path = interpreter;
      continue;
    }
    let image: I;
    try { image = kernel.image(node, !!process.call); }
    finally { source.check(); }
    const exe = source.describe(), entry = BigInt(image.facts.entry);
    const stack = staticStack(image.facts, argv, env);
    const laid = (image.segments ?? []).map((s): Range => [s.offset, s.offset + s.bytes.length]);
    const check = (): void => { for (const file of sources) file.check(); };
    check();
    return {source, exe, image, entry, argv, env, stack, laid, check};
  }
}
