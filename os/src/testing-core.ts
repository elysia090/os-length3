// For tests (node --test --import): every test process has the core a page runs (core.node.ts), over files
// of its own, before any module asks it. One on a Remote of its own (testing-remote.ts) takes another.

import {buildCoreWasm} from '../scripts/core-wasm.ts';
import {nodeCore} from './core.node.ts';
import {useCore} from './host.ts';

useCore(nodeCore(buildCoreWasm({quiet: true}), {LENGTH3_HOME: '/data', LENGTH3_REMOTE: ''}));
