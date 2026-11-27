import {h} from '../../ui/dom.ts';

// Kube's convex-squircle Searchbox uses n=1.5 and .7 refraction. Keep that outward bend but
// ease out its steepest rays to preserve the shape of what is underneath. This is not a magnifier
// over the entire panel. https://kube.io/blog/liquid-glass-css-svg/#searchbox
const BEVEL = 17, DEPTH = 12, CROWN_WIDTH = 13, IOR = 1.5, GAIN = .7;
const MAX_BEND = 2.55, MAX_SLOPE = .27, STEPS = 128;
const SCALE = 6.5;
const LIGHT = 105, LIGHT_X = Math.cos(LIGHT * Math.PI / 180), LIGHT_Y = -Math.sin(LIGHT * Math.PI / 180);
const NS = 'http://www.w3.org/2000/svg';
let next = 0;
const ease = (t: number) => t * t * (3 - 2 * t);

function glassSection(w: number, h: number, radius: number) {
  // Limit by both the actual rectangle and its corner: a short panel must still have a flat centre.
  const size = Math.max(.68, Math.min(1.15, Math.sqrt(Math.min(w / 396, h / 136, radius / 10))));
  const bevel = Math.min(BEVEL * size, w * .35, h * .35);
  const shoulder = bevel * .235;
  const crown = CROWN_WIDTH * size;
  const u = 1 - shoulder / crown;
  const height = (1 - u ** 4) ** .25;
  const incident = Math.atan((u / height) ** 3);
  const ray = GAIN * (DEPTH * size + crown * height) * Math.tan(incident - Math.asin(Math.sin(incident) / IOR));
  // Cubic easing keeps both ends flat. Its largest derivative is 1.5, so the sampling map can never
  // have a normal slope below .73. The shallow outer shoulder may shrink a detail, but never
  // changes the sign of the outward bend. There is no inward pocket or pinched return.
  // The corner's tangential sampling slope is 1 - bend/radius; protect it as well as the normal.
  const peak = Math.min(MAX_BEND * size, ray, MAX_SLOPE * (bevel - shoulder) / 1.5, radius ? .27 * radius : Infinity);
  const rise = Math.min(peak, shoulder * .10 / 1.5);
  const bend = new Float64Array(STEPS + 1), inclination = new Float64Array(STEPS + 1);
  for (let i = 0; i < STEPS; i++) {
    const d = i / STEPS * bevel;
    bend[i] = d < shoulder ? peak - rise * (1 - ease(d / shoulder))
      : peak * (1 - ease((d - shoulder) / (bevel - shoulder)));
    const z = Math.max(0, 1 - d / crown);
    const h = (1 - z ** 4) ** .25;
    inclination[i] = Math.atan(h ? (z / h) ** 3 : Infinity);
  }
  return {bevel,bend,inclination};
}

function sample(samples: Float64Array, at: number): number {
  const i = Math.floor(at), f = at - i;
  return samples[i]! * (1 - f) + samples[i + 1]! * f;
}

function reflected(x: number, nx: number, ny: number, inclination: number): number {
  if (ny === 0) return 0; // The straight sides are not lit.
  const facing = nx * LIGHT_X + ny * LIGHT_Y;
  const upper = ny < 0;
  const peak = .5 + (upper ? .24 : -.24) * LIGHT_X;
  const arm = (x - peak) / (x < peak ? peak : 1 - peak);
  const crown = 1 - arm * arm;
  // The crown is shallower across the middle: there the specular maximum lies a little farther
  // into the bevel. Through a corner it follows the same normal as the refraction.
  const deviation = (inclination - (1.30 - .69 * crown)) / .47;
  const profile = Math.max(0, 1 - deviation * deviation);
  const cap = upper ? .20 : .15;
  return 255 * cap * crown ** 2 * profile ** 2 * ny ** 2 * facing ** 2;
}

/** A single texture: RG refracts the backdrop, B weights the curved reflection. The centre is neutral. */
export function recentGlassMap(w: number, ht: number, r: number): Uint8ClampedArray<ArrayBuffer> {
  const map = new Uint8ClampedArray(w * ht * 4);
  const cx = w / 2, cy = ht / 2, radius = Math.min(r, cx, cy);
  const {bevel,bend,inclination} = glassSection(w, ht, radius);
  for (let y = 0; y < ht; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    map[i] = map[i + 1] = 128;
    map[i + 3] = 255;
    const px = x + .5 - cx, py = y + .5 - cy;
    const qx = Math.abs(px) - (cx - radius), qy = Math.abs(py) - (cy - radius);
    const inset = Math.max(qx, qy);
    if (inset <= Math.min(radius - bevel, 0)) continue;
    const dx = Math.max(qx, 0), dy = Math.max(qy, 0);
    const len = dx && dy ? Math.hypot(dx, dy) : dx || dy;
    const distance = len + Math.min(inset, 0) - radius;
    if (distance > 0 || distance <= -bevel) continue;
    const at = -distance / bevel * STEPS;
    const weight = sample(bend, at) * 255 / SCALE;
    const nx = Math.sign(px) * (len ? dx / len : +(qx > qy));
    const ny = Math.sign(py) * (len ? dy / len : +(qy >= qx));
    map[i] -= nx * weight;
    map[i + 1] -= ny * weight;
    if (ny) map[i + 2] = reflected((x + .5) / w, nx, ny, sample(inclination, at));
  }
  return map;
}

/** A decorative plane behind Recent activity's actual buttons; resize only, no pointer or scroll listeners. */
export function recentGlass(): HTMLElement {
  const surface = h('span', {class: 'home-recent-glass', 'aria-hidden': 'true'});
  surface.style.setProperty('--glass-light', `${LIGHT}deg`);
  // Use the SVG-as-backdrop path on Chromium. Other engines keep the same control and the CSS-only fallback.
  if (!/\b(?:Chrome|Chromium)\//.test(navigator.userAgent) || !CSS.supports('backdrop-filter', 'url(#home-recent-optics)')) return surface;

  const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>) => {
    const node = document.createElementNS(NS, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    return node;
  };
  const id = `home-recent-optics-${++next}`;
  const svg = el('svg', {width: '100%', height: '100%'});
  const filter = el('filter', {id, x: '0', y: '0', width: '100%', height: '100%', 'color-interpolation-filters': 'sRGB'});
  const image = el('feImage', {x: '0', y: '0', preserveAspectRatio: 'none', result: 'optics'});
  filter.append(image,
    // W3C samples x + scale * (R - .5), y + scale * (G - .5). B does not move the backdrop.
    el('feDisplacementMap', {in: 'SourceGraphic', in2: 'optics', scale: String(SCALE),
      xChannelSelector: 'R', yChannelSelector: 'G', result: 'bent'}),
    el('feColorMatrix', {in: 'optics', type: 'matrix', values: '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 1 0 0', result: 'sheen'}),
    el('feFlood', {class: 'home-recent-glint', result: 'light'}),
    el('feComposite', {in: 'light', in2: 'sheen', operator: 'in', result: 'reflected'}),
    el('feComposite', {in: 'reflected', in2: 'bent', operator: 'over'}));
  const defs = el('defs', {});
  defs.append(filter);
  svg.append(defs, el('rect', {class: 'home-recent-hairline'}));

  const canvas = document.createElement('canvas'), pen = canvas.getContext('2d');
  if (!pen) return surface;
  let last = '';
  new ResizeObserver(() => {
    const w = surface.offsetWidth, ht = surface.offsetHeight;
    if (!w || !ht) return;
    // Keep rebuilding work bounded for unusually large panels and accessibility sizes.
    if (w * ht > 260_000) {
      surface.style.removeProperty('--home-recent-optics');
      surface.removeAttribute('data-optical');
      last = '';
      return;
    }
    const radius = parseFloat(getComputedStyle(surface).borderTopLeftRadius);
    const key = `${w}:${ht}:${radius}`;
    if (last === key) return;
    last = key;
    canvas.width = w; canvas.height = ht;
    pen.putImageData(new ImageData(recentGlassMap(w, ht, radius), w, ht), 0, 0);
    image.setAttribute('width', String(w)); image.setAttribute('height', String(ht));
    image.setAttribute('href', canvas.toDataURL('image/png'));
    if (!svg.isConnected) surface.append(svg);
    surface.style.setProperty('--home-recent-optics', `url("#${id}")`);
    surface.setAttribute('data-optical', '');
  }).observe(surface);
  return surface;
}
