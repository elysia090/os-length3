import assert from 'node:assert/strict';
import {totalmem} from 'node:os';
import {statfsSync} from 'node:fs';
import {test} from 'node:test';
import {MEMORY_FLOOR, machine} from '../../runtime/linux/machine.ts';
import {Kernel} from '../../runtime/linux/process.ts';
import {Made} from '../../runtime/linux/made.ts';
import type {Console} from '../../runtime/linux/parts.ts';

// What programs are told of the machine is the machine: its memory and its storage as the host says them, not a
// number made up (/proc/meminfo said 4 GiB, statfs said nothing, on every machine).

test('the memory and storage told are the host\'s', () => {
  const m = machine({directory: '/'});
  assert.equal(m.memory, totalmem());
  const s = statfsSync('/');
  assert.equal(m.storage()?.total, s.blocks * s.bsize);
});

test('/proc/meminfo says the machine\'s memory; a host that cannot say gives the floor', () => {
  const told = (k: Kernel): number => {
    const meminfo = k.vfs.lookup('/proc/meminfo', '/');
    assert.ok(meminfo instanceof Made);
    return Number(/MemTotal:\s+(\d+) kB/.exec(new TextDecoder().decode(meminfo.snapshot().bytes()))?.[1]) * 1024;
  };
  const console: Console = {write() {}, read: () => null};
  assert.equal(told(new Kernel({console})), Math.floor(totalmem() / 1024) * 1024);
  assert.equal(told(new Kernel({console, machine: {memory: MEMORY_FLOOR, storage: () => null}})), MEMORY_FLOOR);
});
