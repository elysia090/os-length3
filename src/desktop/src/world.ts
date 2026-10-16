import type {Capacity} from './host.ts';
import type {PurposeId} from './purposes.ts';
import type {Piece, Station} from './scene/stage.ts';
import type {Vec3} from './scene/math.ts';

// The world is laid out on one floor. Each purpose is a place the camera
// travels to; magnitudes are volumes, so a cube's edge is the cube root of
// what it measures. Dashed frames are places with nothing connected yet.

/** Edge of the cube that stands for the whole measured capacity. */
export const HOST_EDGE = 4;

const PLACES: Record<PurposeId, Vec3> = {
  home: [0, 0, 0],
  file: [0, 0, 0],
  git: [12, 0, -5],
  forge: [10, 0, 8],
  runtime: [-12, 0, 5],
  remote: [0, 0, -18],
  topic: [-11, 0, -11],
  inbox: [-5, 0, 14],
  'new-repo': [10, 0, 8],
};

/**
 * Yaw that puts the camera between home and `place`, looking outward, so the
 * home volume never stands between the lens and the subject.
 */
export function facingAway(place: Vec3, offset = 0): number {
  return Math.atan2(-place[0], -place[2]) + offset;
}

const station = (id: PurposeId, lift: number, offset: number, pitch: number, distance: number, pool: number): Station => {
  const p = PLACES[id];
  return {center: [p[0], lift, p[2]], yaw: facingAway(p, offset), pitch, distance, pool};
};

export const STATIONS: Record<PurposeId, Station> = {
  home: {center: [0, 1.6, 0], yaw: 0.62, pitch: 0.42, distance: 22, pool: 9},
  file: {center: [0, 1.8, 0], yaw: 0.18, pitch: 0.2, distance: 12.5, pool: 4},
  git: station('git', 1.2, 0.35, 0.16, 7.5, 4),
  forge: station('forge', 0.8, -0.3, 0.12, 6.5, 3.5),
  runtime: station('runtime', 1.4, 0.3, 0.42, 8, 4),
  remote: station('remote', 5.5, 0.05, -0.18, 10, 5),
  topic: station('topic', 0.8, -0.25, 0.25, 8, 5),
  inbox: station('inbox', 0.8, 0.2, 0.22, 7.5, 4),
  'new-repo': station('new-repo', 0.9, 0.45, 0.32, 5.5, 3),
};

const WARM: Vec3 = [0.8, 0.74, 0.64];
const AMBER: Vec3 = [0.94, 0.55, 0.12];
const STEEL: Vec3 = [0.22, 0.26, 0.32];

const at = (place: Vec3, dx: number, y: number, dz: number): Vec3 => [place[0] + dx, y, place[2] + dz];

/** A frame for something that will live here but is not connected. */
function unconnected(id: string, position: Vec3, size: number, delay = 0): Piece {
  return {id, position, size, color: STEEL, fill: 0, glow: 0, edge: 0.6, dash: 3, delay};
}

/** Edge length whose volume is `part` of the host cube's volume. */
export function volumeEdge(part: number, whole: number): number {
  if (!(whole > 0) || !(part > 0)) return 0;
  return HOST_EDGE * Math.cbrt(Math.min(part / whole, 1));
}

export function pieces(capacity: Capacity | null): Piece[] {
  const home = PLACES.home;
  const out: Piece[] = [];
  if (capacity) {
    // Host volume as a lit frame, what is used as a solid filling it from the
    // floor, and this app's own share as an amber core.
    out.push({id: 'host', position: at(home, 0, HOST_EDGE / 2, 0), size: HOST_EDGE, color: WARM,
      fill: 0.04, glow: 0, edge: 0.9, dash: 0});
    const used = volumeEdge(capacity.total - capacity.free, capacity.total);
    if (used) out.push({id: 'host-used', position: at(home, 0, used / 2, 0), size: used, color: [0.05, 0.055, 0.065],
      fill: 1, glow: 0, edge: 0.35, dash: 0, delay: 0.15});
    const app = volumeEdge(capacity.app, capacity.total);
    if (app) out.push({id: 'host-app', position: at(home, HOST_EDGE / 2 + app, app / 2, HOST_EDGE / 2 - app / 2),
      size: app, color: AMBER, fill: 1, glow: 0.9, edge: 0.4, dash: 0, delay: 0.3});
  } else {
    out.push(unconnected('host', at(home, 0, HOST_EDGE / 2, 0), HOST_EDGE));
  }
  // Places that exist in the design but hold nothing real yet.
  out.push(unconnected('forge-plot', at(PLACES.forge, 0, 0.75, 0), 1.5, 0.2));
  out.push(unconnected('git-plot', at(PLACES.git, 0, 0.6, 0), 1.2, 0.25));
  for (let i = 0; i < 3; i++) {
    out.push({...unconnected(`runtime-layer-${i}`, at(PLACES.runtime, 0, 0.3 + i * 0.9, 0), 2.2 - i * 0.35, 0.3 + i * 0.08),
      fill: 0.02});
  }
  out.push(unconnected('remote', at(PLACES.remote, 0, 6, 0), 2.4, 0.35));
  out.push(unconnected('topic', at(PLACES.topic, 0, 0.5, 0), 1, 0.4));
  out.push(unconnected('inbox', at(PLACES.inbox, 0, 0.5, 0), 1, 0.45));
  return out;
}
