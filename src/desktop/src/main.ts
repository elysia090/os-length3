import {readCapacity, type Capacity} from './host.ts';
import {icon} from './icons.ts';
import {spring, step, settled} from './motion/spring.ts';
import {NEW_REPO, PURPOSES, RAIL, purpose, restorePurpose, stepPurpose, type PurposeId} from './purposes.ts';
import {Stage} from './scene/stage.ts';
import {HOST_EDGE, STATIONS, pieces, volumeEdge} from './world.ts';

const STORAGE_KEY = 'length3.os.purpose';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tabs = new Map<PurposeId, HTMLButtonElement>();
const stage = new Stage($<HTMLCanvasElement>('stage'));
let current: PurposeId = 'home';

function readStored(): string | null {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

function store(id: PurposeId) {
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* convenience only */ }
}

// ---- Rail: a light puck rides a spring to the chosen purpose ----

const puck = {y: spring(0), h: spring(56), frame: 0, last: 0};
function movePuck() {
  const tab = tabs.get(current)!;
  puck.y.target = tab.offsetTop; puck.h.target = tab.offsetHeight;
  if (!puck.frame) puck.frame = requestAnimationFrame(animatePuck);
}
function animatePuck(now: number) {
  puck.frame = 0;
  const dt = puck.last ? Math.min((now - puck.last) / 1000, 0.1) : 1 / 60;
  puck.last = now;
  const slow = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.001 : 1;
  step(puck.y, dt, 0.09 * slow); step(puck.h, dt, 0.09 * slow);
  // Stretch along the travel while moving, like a bead of light under glass.
  const stretch = Math.min(Math.abs(puck.y.velocity) * 0.04, 28);
  const el = $('puck');
  el.style.transform = `translateY(${(puck.y.value - stretch / 2).toFixed(1)}px)`;
  el.style.height = `${(puck.h.value + stretch).toFixed(1)}px`;
  if (!settled(puck.y, 0.05) || !settled(puck.h, 0.05)) puck.frame = requestAnimationFrame(animatePuck);
  else puck.last = 0;
}

function railButton(id: PurposeId): HTMLButtonElement {
  const p = purpose(id), button = document.createElement('button');
  button.type = 'button';
  button.id = `purpose-${id}`;
  button.className = id === 'new-repo' ? 'rail-item rail-new' : 'rail-item';
  button.setAttribute('role', 'tab');
  button.setAttribute('aria-controls', 'target');
  button.setAttribute('aria-label', p.label);
  const tag = document.createElement('span');
  tag.className = 'rail-tag';
  tag.textContent = p.label;
  tag.setAttribute('aria-hidden', 'true');
  button.append(icon(id), tag);
  button.addEventListener('click', () => select(id));
  button.addEventListener('keydown', (event) => {
    const next = stepPurpose(id, event.key);
    if (next === null) return;
    event.preventDefault();
    select(next);
    tabs.get(next)?.focus();
  });
  tabs.set(id, button);
  return button;
}

// ---- Selection: the camera travels, the title card cuts in ----

function select(id: PurposeId) {
  const p = purpose(id);
  current = id;
  for (const [tabId, tab] of tabs) {
    const selected = tabId === id;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  const target = $('target');
  target.setAttribute('aria-labelledby', `purpose-${id}`);
  $('target-index').textContent = String(RAIL.findIndex((r) => r.id === id) + 1).padStart(2, '0');
  $('target-title').textContent = p.label;
  $('target-role').textContent = p.role;
  target.classList.remove('cut');
  void target.offsetWidth; // restart the cut-in animation
  target.classList.add('cut');
  document.body.dataset.purpose = id;
  stage.go(STATIONS[id]);
  movePuck();
  if (id !== 'new-repo') store(id);
}

// ---- Measured volume, pinned into the world ----

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
function bytes(n: number): string {
  let i = 0;
  while (n >= 1000 && i < UNITS.length - 1) { n /= 1000; i++; }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)}<small>${UNITS[i]}</small>`;
}

const readouts = new Map<string, HTMLElement>();
function readout(id: 'total' | 'used' | 'app'): HTMLElement {
  let el = readouts.get(id);
  if (!el) {
    el = document.createElement('div');
    el.className = `anchor anchor-${id}`;
    el.hidden = true;
    $('anchors').append(el);
    readouts.set(id, el);
  }
  return el;
}

function showCapacity(capacity: Capacity | null) {
  stage.set(pieces(capacity));
  const total = readout('total'), used = readout('used'), app = readout('app');
  if (!capacity) {
    stage.pin('total', total, null); stage.pin('used', used, null); stage.pin('app', app, null);
    return;
  }
  const half = HOST_EDGE / 2, usedBytes = capacity.total - capacity.free;
  total.innerHTML = bytes(capacity.total);
  total.dataset.layer = capacity.layer;
  used.innerHTML = bytes(usedBytes);
  app.innerHTML = bytes(capacity.app);
  stage.pin('total', total, [half, HOST_EDGE, -half]);
  const usedEdge = volumeEdge(usedBytes, capacity.total);
  stage.pin('used', used, usedEdge ? [-usedEdge / 2, usedEdge, usedEdge / 2] : null);
  const appEdge = volumeEdge(capacity.app, capacity.total);
  stage.pin('app', app, appEdge ? [half + appEdge * 1.5, appEdge, half] : null);
}

async function refresh() { showCapacity(await readCapacity()); }

// ---- Start ----

$('rail-tabs').append(...PURPOSES.map((p) => railButton(p.id)), railButton(NEW_REPO.id));
$('strip-new').addEventListener('click', () => select('new-repo'));
showCapacity(null);
select(restorePurpose(readStored()));
void refresh();
addEventListener('focus', () => void refresh());
setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 15000);
addEventListener('resize', movePuck);
