// For tests (node --test --import): every test process has the core a page runs (core.node.ts), over files
// of its own, before any module asks it. One on a Remote of its own (testing-remote.ts) takes another.
// It starts at the first question: a process that never asks one (the Remote's own tests) pays nothing.

import type {Ask} from './core-client.ts';
import {buildCoreWasm} from '../scripts/core-wasm.ts';
import {nodeCore} from './core.node.ts';
import {useCore} from './host.ts';

let ask: Ask | undefined;
useCore((name, args) => (ask ??= nodeCore(buildCoreWasm({quiet: true}), {LENGTH3_HOME: '/data', LENGTH3_REMOTE: ''}))(name, args));
