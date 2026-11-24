// The receipts these integration fixtures observe through browser and Node adapters.
export type GuestEvent =
  | {type: 'output'; fd: number; bytes: Uint8Array; epoch: number}
  | {type: 'output-boundary'; sentBytes: number}
  | {type: 'tty'; lflag: number}
  | {type: 'waiting'; for: 'input' | 'time'; ms: number}
  | {type: 'threads'; apart: boolean}
  | {type: 'changes'; files: {path: string; bytes: Uint8Array}[]}
  | {type: 'exit'; status: number}
  | {type: 'error'; message: string}
  | {type: 'retiring'; failures?: string[]}
  | {type: 'terminal-geometry'; request: number; cols: number; rows: number; sentBytes: number}
  | ({type: 'terminal-size'; request: number} & (
    {cols: number; rows: number; changed: boolean; error?: never} | {error: string; changed?: never}));
