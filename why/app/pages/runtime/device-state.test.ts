import assert from 'node:assert/strict';
import {test} from 'node:test';
import {deviceStateKey} from './device-state.ts';
import type {Space} from '../../../api/host.ts';
import type {RepoSync} from '../../../shipto/lifecycle.ts';

const space: Space = {host_total: 100, host_free: 90, host: 'Estimated', allocated: 10, freeable: 10,
  items: [{id: 'repo:notes', what: 'notes', detail: 'repo', allocated: 10, room: 'Free', why: ''}], kept: false};
const sending: RepoSync = {where: 'sending', changed: 0, both: [], unsynced: []};
const key = (states: RepoSync[] = [sending], remote: Parameters<typeof deviceStateKey>[3] = [], connected = true, u = space) =>
  deviceStateKey(u, null, states, remote, connected);

test('sync-only changes invalidate Runtime even when every storage figure is unchanged', () => {
  const before = key();
  assert.notEqual(key([{...sending, where: 'synced', agreed: true}]), before);
  assert.notEqual(key([{...sending, where: 'offline', error: 'disconnected'}]), before);
  assert.equal(key([{...sending}]), before);
});

test('Remote-only repos and connection state invalidate Runtime independently of local bytes', () => {
  assert.notEqual(key([], [{name: 'there', head: null, version: 1, bytes: 7, updatedAt: 'now'}]), key([]));
  assert.notEqual(key([], [], false), key([]));
});

test('remeasuring identical storage does not redraw, but changed storage does', () => {
  assert.equal(key([sending], [], true, {...space, kept: true}), key());
  assert.notEqual(key([sending], [], true, {...space, allocated: 11}), key());
});
