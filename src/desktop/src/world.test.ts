import assert from 'node:assert/strict';
import {test} from 'node:test';
import {HOST_EDGE, STATIONS, facingAway, pieces, volumeEdge} from './world.ts';
import {RAIL} from './purposes.ts';
import {orbit} from './scene/math.ts';

test('cube volume, not edge, is proportional to bytes', () => {
  const edge = volumeEdge(1, 8);
  assert.ok(Math.abs(edge ** 3 / HOST_EDGE ** 3 - 1 / 8) < 1e-12);
  assert.equal(volumeEdge(0, 8), 0);
  assert.equal(volumeEdge(5, 0), 0);
  assert.equal(volumeEdge(20, 8), HOST_EDGE);
});

test('every purpose has a station', () => {
  for (const p of RAIL) assert.ok(STATIONS[p.id], p.id);
});

test('without a measurement the host is a dashed frame, never a guessed fill', () => {
  const world = pieces(null);
  const host = world.find((p) => p.id === 'host')!;
  assert.ok(host.dash > 0 && host.fill === 0);
  assert.ok(!world.some((p) => p.id === 'host-used' || p.id === 'host-app'));
});

test('a measurement fills the host and shows the app share only when non-zero', () => {
  const world = pieces({total: 1000, free: 400, app: 0, layer: 'host-filesystem'});
  assert.ok(world.find((p) => p.id === 'host')!.dash === 0);
  assert.ok(world.some((p) => p.id === 'host-used'));
  assert.ok(!world.some((p) => p.id === 'host-app'));
  assert.equal(new Set(world.map((p) => p.id)).size, world.length);
});

test('away-facing stations put the camera on the home side of their subject', () => {
  for (const place of [[7, 0, -2], [-9, 0, 4], [0, 0, -12], [-4, 0, 11]] as const) {
    const yaw = facingAway([...place]);
    const eye = [place[0] + Math.sin(yaw) * 5, place[2] + Math.cos(yaw) * 5];
    assert.ok(Math.hypot(eye[0], eye[1]) < Math.hypot(place[0], place[2]));
  }
});

test('no station puts the lens inside or against the home volume', () => {
  for (const p of RAIL) {
    if (p.id === 'home' || p.id === 'file') continue;
    const s = STATIONS[p.id];
    const [x, y, z] = orbit(s.center, s.yaw, s.pitch, s.distance);
    const clear = Math.max(Math.abs(x), Math.abs(z)) > HOST_EDGE || y > HOST_EDGE + 1;
    assert.ok(clear, `${p.id} eye ${[x, y, z].map((v) => v.toFixed(1))}`);
  }
});
