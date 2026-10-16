import {settled, spring, step, type Spring} from '../motion/spring.ts';
import {lookAt, multiply, orbit, perspective, type Vec3} from './math.ts';
import {Renderer, type Solid} from './renderer.ts';

/** Where the camera rests for a purpose: what it looks at and from where. */
export interface Station {
  center: Vec3;
  yaw: number;
  pitch: number;
  distance: number;
  /** Radius of the light pool on the floor around `center`. */
  pool: number;
}

export interface Piece extends Omit<Solid, 'reveal'> {
  id: string;
  /** Seconds after the piece first appears before it starts assembling. */
  delay?: number;
}

interface Live { piece: Piece; reveal: Spring; size: Spring; glow: Spring; born: number }

/** A DOM element pinned to a point in the world, hidden when behind the camera. */
interface Anchor { element: HTMLElement; position: Vec3 }

const CAMERA_HALF_LIFE = 0.32;
const PIECE_HALF_LIFE = 0.22;

/**
 * Owns the canvas, the camera springs and the pieces in the world. It renders
 * only while something moves, so an idle shell costs no frames.
 */
export class Stage {
  private renderer: Renderer;
  private camera = {cx: spring(0), cy: spring(0), cz: spring(0), yaw: spring(0), pitch: spring(0.3),
    distance: spring(30), pool: spring(6)};
  private parallax = {x: spring(0), y: spring(0)};
  private live = new Map<string, Live>();
  private anchors = new Map<string, Anchor>();
  private frame = 0;
  private last = 0;
  private time = 0;
  private reduced: boolean;

  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new Renderer(canvas);
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    this.reduced = motion.matches;
    motion.addEventListener('change', () => { this.reduced = motion.matches; this.wake(); });
    new ResizeObserver(() => this.wake()).observe(canvas);
    addEventListener('pointermove', (event) => {
      this.parallax.x.target = (event.clientX / innerWidth - 0.5);
      this.parallax.y.target = (event.clientY / innerHeight - 0.5);
      this.wake();
    }, {passive: true});
  }

  go(station: Station) {
    const c = this.camera;
    c.cx.target = station.center[0]; c.cy.target = station.center[1]; c.cz.target = station.center[2];
    // Take the short way round so a switch never spins the camera a full turn.
    const turn = Math.PI * 2;
    c.yaw.target = station.yaw + Math.round((c.yaw.value - station.yaw) / turn) * turn;
    c.pitch.target = station.pitch; c.distance.target = station.distance; c.pool.target = station.pool;
    this.wake();
  }

  /** Replace the world. New pieces assemble, kept pieces morph, gone pieces sink. */
  set(pieces: readonly Piece[]) {
    const now = this.time, keep = new Set<string>();
    for (const piece of pieces) {
      keep.add(piece.id);
      const live = this.live.get(piece.id);
      if (live) {
        live.piece = piece; live.size.target = piece.size; live.glow.target = piece.glow; live.reveal.target = 1;
      } else {
        const reveal = spring(0), size = spring(piece.size), glow = spring(piece.glow);
        reveal.target = 1;
        this.live.set(piece.id, {piece, reveal, size, glow, born: now + (piece.delay ?? 0)});
      }
    }
    for (const [id, live] of this.live) if (!keep.has(id)) live.reveal.target = 0;
    this.wake();
  }

  pin(id: string, element: HTMLElement, position: Vec3 | null) {
    if (position) this.anchors.set(id, {element, position});
    else { this.anchors.delete(id); element.hidden = true; }
    this.wake();
  }

  private place(viewProj: Float32Array, w: number, h: number) {
    for (const {element, position: [x, y, z]} of this.anchors.values()) {
      const cx = viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12];
      const cy = viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13];
      const cw = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];
      element.hidden = cw <= 0.1;
      if (element.hidden) continue;
      const sx = (cx / cw * 0.5 + 0.5) * w, sy = (0.5 - cy / cw * 0.5) * h;
      element.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)`;
    }
  }

  private wake() {
    if (!this.frame) this.frame = requestAnimationFrame((t) => this.tick(t));
  }

  private tick(now: number) {
    this.frame = 0;
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.1) : 1 / 60;
    this.last = now;
    this.time += dt;
    const slow = this.reduced ? 0.001 : 1;
    let moving = false;
    const advance = (s: Spring, halfLife: number) => { step(s, dt, halfLife * slow); if (!settled(s)) moving = true; };

    const c = this.camera;
    for (const s of Object.values(c)) advance(s, CAMERA_HALF_LIFE);
    advance(this.parallax.x, 0.5); advance(this.parallax.y, 0.5);

    const solids: Solid[] = [];
    for (const [id, live] of this.live) {
      if (this.time < live.born) { moving = true; continue; }
      advance(live.reveal, PIECE_HALF_LIFE); advance(live.size, PIECE_HALF_LIFE); advance(live.glow, PIECE_HALF_LIFE);
      if (live.reveal.target === 0 && live.reveal.value < 0.002) { this.live.delete(id); continue; }
      solids.push({...live.piece, size: live.size.value, glow: live.glow.value, reveal: live.reveal.value});
    }

    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr)), h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    this.renderer.resize(w, h);
    const center: Vec3 = [c.cx.value, c.cy.value, c.cz.value];
    const eye = orbit(center, c.yaw.value + this.parallax.x.value * 0.08,
      c.pitch.value + this.parallax.y.value * 0.04, c.distance.value);
    const viewProj = multiply(perspective(0.62, w / h, 0.1, 400), lookAt(eye, center));
    this.renderer.draw({viewProj, eye, pool: [center[0], center[2], c.pool.value], solids, time: this.time,
      grain: this.reduced ? 0 : 0.014});
    this.place(viewProj, this.canvas.clientWidth, this.canvas.clientHeight);
    if (moving) this.wake(); else this.last = 0;
  }
}
