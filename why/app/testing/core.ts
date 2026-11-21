// Why test setup installs the core a page runs (testing/node-core.ts) before the tested modules load.
// Tests of a Remote can instead use the core with their own Remote (testing/remote.ts).
// It starts at the first question: a process that never asks one (the Remote's own tests) pays nothing.

import type {Ask} from '../../api/client.ts';
import {buildCoreWasm} from '../../build/core-wasm.ts';
import {nodeCore} from './node-core.ts';
import {useCore} from '../../api/host.ts';

let ask: Ask | undefined;
useCore((name, args) => (ask ??= nodeCore(buildCoreWasm({quiet: true}), {WHY_HOME: '/data', WHY_REMOTE: ''}))(name, args));
