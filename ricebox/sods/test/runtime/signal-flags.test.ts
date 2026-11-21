import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Kernel, Process} from '../../runtime/linux/process.ts';
import {SIG, SA, send, take, SIGNAL_CALLS} from '../../runtime/linux/signal.ts';

test('signal frame and sigreturn preserve all six packed flags including AF', () => {
  for (const packed of [0n, 32n, 63n]) {
    const kernel = new Kernel({translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
    const p = new Process(kernel, null);
    p.memory = Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
    const task = kernel.newTask(p); p.tasks.add(task); p.task = task;
    let context = {regs: Array<bigint>(19).fill(0n), rip: 4096n};
    context.regs[4] = 60000n; context.regs[17] = packed; context.regs[18] = 0x400n;
    task.context = () => ({regs: context.regs.slice(), rip: context.rip});
    task.reg = n => context.regs[n];
    task.setContext = (regs, rip) => { context = {regs, rip}; };
    p.actions.set(SIG.USR1, {handler: 8192n, flags: SA.RESTORER, restorer: 12288n, mask: 0n});
    send(kernel, p, SIG.USR1, {}, task);
    assert.equal(take(kernel, task, task.context()), true);
    const frame = Number(context.regs[4]);
    const flags = p.view.getBigUint64(frame + 8 + 40 + 136, true);
    assert.equal(flags & 0x10n, packed & 32n ? 0x10n : 0n);
    // Handler edits AF in ucontext; sigreturn must consume the edited bit.
    p.view.setBigUint64(frame + 8 + 40 + 136, flags ^ 0x10n, true);
    context.regs[4] += 8n; // restorer entered after handler RET popped its address
    assert.throws(() => SIGNAL_CALLS[15].call(p, 0n, 0n, 0n, 0n, 0n, 0n));
    assert.equal(context.regs[17], packed ^ 32n);
    assert.equal(context.regs[18] & 0x400n, 0x400n);
    assert.equal(context.rip, 4096n);
  }
});
