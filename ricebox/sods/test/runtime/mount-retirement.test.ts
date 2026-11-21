import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Vfs, Dir} from '../../runtime/linux/fs.ts';
import {Kernel, Process} from '../../runtime/linux/process.ts';
import {tree, setSpread, SPREAD, copy, firstSpace, retireInitialTree} from '../../runtime/linux/mount.ts';
import {HOST} from '../../runtime/linux/cred.ts';

const made = (vfs = new Vfs()) => new Kernel({vfs, console: {write() {}, read: () => null}});
test('normal ended leaves walker and covered reverse edges until explicit initial-tree retirement', () => {
  const k = made(), vfs = k.vfs, proc = vfs.root.entries.get('proc')!;
  const mounts = tree(k.spaces.mnt.top), mounted = proc.covered!.find(m => m.space === k.spaces.mnt)!;
  k.halt();
  assert.equal(vfs.who.root, k.root);
  assert.ok(proc.covered!.includes(mounted));
  assert.equal(k.retireInitialMounts(), true);
  assert.equal(vfs.who.root.mnt, vfs.mount);
  assert.ok(!proc.covered?.includes(mounted));
  assert.ok(mounts.every(m => m.space === null && m.parent === null && m.children.size === 0));
  assert.equal(k.retireInitialMounts(), false);
});

test('retiring one initial tree preserves another kernel walker and shared covered ordering', () => {
  const vfs = new Vfs(), a = made(vfs), b = made(vfs), root = vfs.who.root;
  const proc = vfs.root.entries.get('proc')!, original = [...proc.covered!];
  const mine = new Set(tree(a.spaces.mnt.top));
  a.halt(); assert.equal(a.retireInitialMounts(), true);
  assert.equal(vfs.who.root, root);
  assert.deepEqual(proc.covered, original.filter(m => !mine.has(m)));
  assert.ok(b.root.mnt.children.size > 0);
  assert.ok(vfs.lookup('/proc') instanceof Dir);
  b.halt(); assert.equal(b.retireInitialMounts(), true);
});

for (const fault of ['refs', 'group', 'master', 'locked', 'missing', 'duplicate', 'foreign', 'cycle', 'duplicate-child'] as const) {
  test(`initial-tree preflight rejects ${fault} without partial detach`, () => {
    const k = made(), mounts = tree(k.spaces.mnt.top), child = mounts.find(m => m.point?.covered)!;
    const covered = child.point!.covered!, original = [...covered], oldSpace = child.space;
    if (fault === 'refs') child.refs = 1;
    if (fault === 'group') setSpread(child, SPREAD.SHARED);
    if (fault === 'master') child.master = 1;
    if (fault === 'locked') child.locked = true;
    if (fault === 'cycle') child.children.add(mounts[0]);
    if (fault === 'duplicate-child') mounts[0].children.add(mounts[2]);
    if (fault === 'missing') covered.splice(covered.indexOf(child), 1);
    if (fault === 'duplicate') covered.push(child);
    if (fault === 'foreign') child.space = {};
    const before = mounts.map(m => ({m, parent: m.parent, space: m.space, children: [...m.children]}));
    assert.equal(k.retireInitialMounts(), false);
    for (const old of before) { assert.equal(old.m.parent, old.parent); assert.equal(old.m.space, old.space); assert.deepEqual([...old.m.children], old.children); }
    child.refs = 0; child.space = oldSpace;
    if (fault === 'master') child.master = 0;
    if (fault === 'locked') child.locked = false;
    if (fault === 'cycle') child.children.delete(mounts[0]);
    if (fault === 'duplicate-child') mounts[0].children.delete(mounts[2]);
    if (fault === 'group') setSpread(child, SPREAD.PRIVATE);
    covered.splice(0, covered.length, ...original);
    assert.equal(k.retireInitialMounts(), true);
  });
}

test('raw process owner blocks initial namespace retirement', () => {
  const k = made(), p = new Process(k, null);
  k.procs.set(p.pid, p);
  assert.equal(k.retireInitialMounts(), false);
  k.procs.clear(); p.fs0.drop();
  assert.equal(k.retireInitialMounts(), true);
});

test('another namespace copy retains its own callbacks and is not mistaken for whole-kernel retirement', () => {
  const k = made(), duplicate = copy(k.root.mnt, k.root.node, {deep: true, whole: true});
  assert.equal(typeof duplicate, 'object');
  if (typeof duplicate === 'number') return;
  const separate = firstSpace(duplicate, HOST);
  const proc = k.vfs.root.entries.get('proc')!;
  const retained = proc.covered!.filter(m => m.space === separate);
  assert.ok(retained.length);
  k.halt(); assert.equal(k.retireInitialMounts(), true);
  assert.ok(retained.every(m => proc.covered!.includes(m)));
  // Test cleanup owns this separate graph; the Kernel action did not touch it.
  assert.equal(retireInitialTree(separate), true);
});

test('namespace descriptor ownership is not represented by the target tree mount refs', async () => {
  const {fileOf, spaceOf, namespaceWasExposed} = await import('../../runtime/linux/space.ts');
  const {Description} = await import('../../runtime/linux/fd.ts');
  const k = made(), ns = k.spaces.mnt;
  assert.equal(namespaceWasExposed(ns), false);
  const place = fileOf('mnt', ns), before = place.mnt.refs;
  assert.equal(namespaceWasExposed(ns), true);
  assert.equal(k.retireInitialMounts(), false); // issuance alone is conservatively unresolved
  assert.equal(fileOf('mnt', ns).node, place.node);
  const descriptor = new Description('file', {mnt: place.mnt, node: place.node}).retain();
  assert.equal(place.mnt.refs, before + 1);
  assert.ok(tree(ns.top).every(m => m.refs === 0));
  k.halt();
  assert.equal(k.retireInitialMounts(), false);
  descriptor.release();
  assert.equal(place.mnt.refs, before);
  assert.equal(k.retireInitialMounts(), false); // raw Place still exists, no negative owner proof
  assert.equal(spaceOf(place.node)?.ns, ns);
  // Explicit test owner drops the graph; no auto collection claims this alias.
  assert.equal(retireInitialTree(ns), true);
});
