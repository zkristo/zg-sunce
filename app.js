import * as THREE from 'three';
import SunCalc from 'suncalc';

// The 3D map itself (ground, buildings, trees, light, shadows, camera) comes from zagreb-dedede; this app adds the
// cafés, their sun and shade, the time bar and the panels. ?map=… loads the map module from elsewhere (testing).
const params = new URLSearchParams(location.search);
const MAP_URL = params.get('map') || 'https://zagreb-dedede.zvonimir-kristo.workers.dev/map/zagreb3d.js';

// Scene coordinates: X = east, Y = up (metres above data z0), Z = south. Data files use x = east, y = north.

const DEG = Math.PI / 180;
const STEP = 5 * 60 * 1000; // slider / schedule resolution
const EYE = 1.2; // m above ground where a terrace is tested for sun
const SHADE = 0, TREE = 1, SUN = 2; // state of a terrace
const STATE_NAME = ['shade', 'tree', 'sun'];
const TREE_REACH = 250; // m, how far towards the sun a tree can still shade a terrace

const $ = (id) => document.getElementById(id);
const fmtTime = new Intl.DateTimeFormat('hr-HR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zagreb' });
const fmtDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zagreb' });
const hhmm = (t) => fmtTime.format(t);

// ?now=2026-06-21T10:00 shifts the clock (handy for testing and for sharing a moment).
const nowParam = params.get('now');
const clockOffset = nowParam && !isNaN(Date.parse(nowParam)) ? Date.parse(nowParam) - Date.now() : 0;
const now = () => new Date(Date.now() + clockOffset);

const state = {
  live: true,
  time: now(),
  day: null, // { start, n, sunrise, sunset, tomorrow, key }
  alt: 0,
  cloud: null,
  selected: null,
  user: null, // { x, y } in data coordinates
  panel: null, // 'cafe' | 'list' | 'info'
  ready: false, // map loaded, sun tests possible
  toastUntil: 0,
};

let map, cafes;
const schedules = new Map();
const canvas = $('scene');
const coarse = matchMedia('(pointer: coarse)').matches;

// ---------- markers ----------

function dotTexture(fill, ring) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.beginPath();
  g.arc(32, 32, ring ? 26 : 24, 0, 2 * Math.PI);
  if (ring) {
    g.lineWidth = 6;
    g.strokeStyle = fill;
    g.stroke();
  } else {
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = 7;
    g.strokeStyle = '#fff';
    g.stroke();
    g.beginPath();
    g.arc(32, 32, 28.5, 0, 2 * Math.PI);
    g.lineWidth = 2;
    g.strokeStyle = 'rgba(0,0,0,.45)';
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const spriteMat = (fill, ring) => new THREE.SpriteMaterial({ map: dotTexture(fill, ring), sizeAttenuation: false, depthTest: false, transparent: true });
const mats = { ring: spriteMat('#1f2933', true), user: spriteMat('#2f7cf6') };
// Café dots: one point cloud per state (shade, tree, sun), so all dots of a colour are a single draw call.
const DOT_COLORS = ['#55606e', '#7fa076', '#ffb800'];
const markers = new THREE.Group();
markers.visible = false;
const dots = DOT_COLORS.map((fill, st) => {
  const material = new THREE.PointsMaterial({ map: dotTexture(fill), size: 1, sizeAttenuation: false, depthTest: false, transparent: true });
  const points = new THREE.Points(new THREE.BufferGeometry(), material);
  points.frustumCulled = false;
  points.renderOrder = 1 + st; // sunny dots on top
  markers.add(points);
  return points;
});
const ringSprite = new THREE.Sprite(mats.ring);
const userSprite = new THREE.Sprite(mats.user);
ringSprite.visible = userSprite.visible = false;
ringSprite.renderOrder = 4;
userSprite.renderOrder = 5;

// Dot sizes in CSS pixels, the same for every café in a state, and growing as the camera comes closer.
const pxScale = (px) => (px / innerHeight) * 2 * Math.tan((map.camera.fov * DEG) / 2);
const DOT_PX = [11, 12, 15]; // shade, tree, sun at the reference zoom
const DOT_ZOOM_REF = 700; // m from camera to pivot where dots have DOT_PX
const DOT_ZOOM_RANGE = [0.3, 1.8]; // smallest and largest factor on DOT_PX
let dotZoom = 0;
const zoomFactor = () => Math.min(DOT_ZOOM_RANGE[1], Math.max(DOT_ZOOM_RANGE[0], Math.sqrt(DOT_ZOOM_REF / map.camera.position.distanceTo(map.controls.target))));
function styleMarkers() {
  dotZoom = zoomFactor();
  const filled = [0, 0, 0];
  for (const d of dots) {
    if (!d.geometry.attributes.position) d.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cafes.length * 3), 3));
  }
  for (const c of cafes) {
    const attr = dots[c.state].geometry.attributes.position;
    attr.setXYZ(filled[c.state]++, c.pos.x, c.pos.y, c.pos.z);
  }
  dots.forEach((d, st) => {
    d.geometry.attributes.position.needsUpdate = true;
    d.geometry.setDrawRange(0, filled[st]);
    d.material.size = DOT_PX[st] * dotZoom; // CSS pixels
  });
  ringSprite.scale.setScalar(pxScale(Math.max(2 * DOT_PX[SUN] * dotZoom + 4, 16)));
  userSprite.scale.setScalar(pxScale(16));
}

// ---------- sun ----------

// Buildings and terrain: each café carries its skyline (tools/skyline.py), the highest angle above the
// horizon that roofs or the ground reach in every degree of compass direction, in half degrees.
function sunlit(cafe, s) {
  if (s.alt <= 0) return false;
  const azimuth = (Math.atan2(s.dir.x, -s.dir.z) / DEG + 360) % 360;
  return s.alt / DEG > cafe.sky[Math.floor(azimuth) % 360] / 2;
}

// Does a tree crown (the map's trees) stand between the terrace and the sun?
const treeCells = new Set();
function treeShaded(cafe, s) {
  const t = map.trees;
  if (!t) return false;
  const ox = cafe.x, oy = cafe.y, oz = cafe.z + EYE, cell = t.cell;
  const dx = s.dir.x, dy = -s.dir.z, dz = s.dir.y, flat = Math.hypot(dx, dy) || 1e-9;
  // Cells along the ground track of the ray, until it has climbed above the tallest tree.
  const reach = Math.min(TREE_REACH, (30 * flat) / Math.max(dz, 1e-3));
  treeCells.clear();
  for (let d = 0; d <= reach + cell; d += cell) {
    const i = Math.floor((ox + (dx / flat) * d) / cell), j = Math.floor((oy + (dy / flat) * d) / cell);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) treeCells.add(t.key(i + a, j + b));
  }
  for (const key of treeCells) {
    const list = t.grid.get(key);
    if (!list) continue;
    for (const k of list) {
      if (!s.leaf && !t.evergreen[k]) continue;
      // Ray against the crown ellipsoid, in the space where the crown is a unit sphere.
      const px = (ox - t.x[k]) / t.rh[k], py = (oy - t.y[k]) / t.rh[k], pz = (oz - t.z[k]) / t.rv[k];
      const c = px * px + py * py + pz * pz - 1;
      if (c <= 0) return true;
      const ux = dx / t.rh[k], uy = dy / t.rh[k], uz = dz / t.rv[k];
      const b = px * ux + py * uy + pz * uz;
      if (b < 0 && b * b - (ux * ux + uy * uy + uz * uz) * c >= 0) return true;
    }
  }
  return false;
}

const stateAt = (cafe, s) => (!sunlit(cafe, s) ? SHADE : treeShaded(cafe, s) ? TREE : SUN);

// The day shown on the slider: today, or tomorrow once the sun has set.
function computeDay(t) {
  let times = SunCalc.getTimes(t, map.geo.lat0, map.geo.lon0);
  if (t > times.sunset) times = SunCalc.getTimes(new Date(+t + 12 * 3600e3), map.geo.lat0, map.geo.lon0);
  const start = Math.ceil(times.sunrise / STEP) * STEP;
  return {
    start,
    n: Math.floor((times.sunset - start) / STEP) + 1,
    sunrise: times.sunrise,
    sunset: times.sunset,
    tomorrow: fmtDay.format(times.sunrise) !== fmtDay.format(t),
    key: fmtDay.format(times.sunrise),
  };
}

// State of one café at every slider step of the day (cached).
function schedule(cafe) {
  const key = cafe.id + state.day.key;
  if (!schedules.has(key)) {
    const s = new Array(state.day.n);
    for (let i = 0; i < s.length; i++) s[i] = stateAt(cafe, map.sunAt(new Date(state.day.start + i * STEP)));
    schedules.set(key, s);
  }
  return schedules.get(key);
}

function forecast(cafe) {
  const s = schedule(cafe), d = state.day;
  const idx = Math.min(d.n - 1, Math.floor((state.time - d.start) / STEP));
  const at = (i) => (d.tomorrow && state.live ? 'sutra ' : '') + hhmm(d.start + i * STEP);
  if (cafe.state === SUN) {
    const end = s.findIndex((v, i) => i > idx && v !== SUN);
    return end < 0 ? `do zalaska (${hhmm(d.sunset)})` : `do ${at(end)}`;
  }
  const next = s.indexOf(SUN, Math.max(0, idx + 1));
  if (next >= 0) return `sunce od ${at(next)}`;
  return s.includes(SUN) ? 'danas više nema sunca' : 'nema sunca cijeli dan';
}

function applyTime() {
  const s = map.setTime(state.time); // light, sky, shadows and leaves
  state.alt = s.alt;
  if (state.ready) {
    for (const c of cafes) c.state = stateAt(c, s);
    styleMarkers();
  }
  updateUI();
  map.requestRender();
}

// ---------- UI ----------

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  e.append(...children);
  return e;
}

function updateUI() {
  const d = state.day, night = state.alt <= 0;
  $('clock').textContent = hhmm(state.time);
  $('clock').classList.toggle('past', !state.live && !timeTween);
  $('t-rise').textContent = hhmm(d.sunrise);
  $('t-set').textContent = hhmm(d.sunset);
  const slider = $('slider');
  slider.max = d.n - 1;
  slider.value = Math.min(d.n - 1, Math.max(0, Math.round((state.time - d.start) / STEP)));

  const count = $('count');
  count.hidden = !state.ready || night;
  const under = state.ready ? cafes.filter((c) => c.state === TREE).length : 0;
  if (state.ready) count.textContent = `☀ ${cafes.filter((c) => c.state === SUN).length} od ${cafes.length} terasa na suncu`;
  $('under').hidden = !under || night;
  $('under').textContent = `🌳 ${under} pod krošnjom`;

  const cloud = $('cloud'), cc = state.cloud;
  cloud.hidden = cc == null || !state.live || night;
  if (cc != null) {
    cloud.textContent = cc >= 80 ? `☁ Oblačno (${cc} %) – sunca vjerojatno nema` : cc >= 40 ? `⛅ Djelomično oblačno (${cc} %)` : `Vedro (${cc} % oblaka)`;
    cloud.classList.toggle('warn', cc >= 80);
  }

  const banner = $('banner');
  if (Date.now() >= state.toastUntil) {
    banner.hidden = !(night && state.live);
    banner.textContent = `Noć je – sunce izlazi ${d.tomorrow ? 'sutra ' : ''}u ${hhmm(d.sunrise)}. Klizačem pogledaj gdje će ga biti.`;
  }
  if (state.ready) renderPanel();
}

function toast(msg) {
  state.toastUntil = Date.now() + 4000;
  $('banner').textContent = msg;
  $('banner').hidden = false;
  setTimeout(updateUI, 4100);
}

function distanceLabel(c) {
  const ref = state.user || { x: map.controls.target.x, y: -map.controls.target.z };
  const m = Math.hypot(c.x - ref.x, c.y - ref.y);
  return m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

function cafePanel(c) {
  const s = schedule(c), d = state.day, n = s.length;
  // Stretches of sun and tree shade over the day as a hard-edged gradient.
  const stops = [];
  for (let i = 0, j; i < n; i = j) {
    for (j = i; j < n && s[j] === s[i]; j++);
    stops.push(`${['transparent', 'var(--tree)', 'var(--sun)'][s[i]]} ${(i / n) * 100}% ${(j / n) * 100}%`);
  }
  const pos = (state.time - d.start) / (n * STEP);
  const bar = el('div', { class: 'daybar', style: `background-image:linear-gradient(90deg,${stops.join(',')})` });
  if (pos >= 0 && pos <= 1) bar.append(el('i', { style: `left:${pos * 100}%` }));
  return [
    el('h2', { class: 'name' }, c.name || 'Kafić bez imena'),
    el('div', { class: 'dist' }, distanceLabel(c)),
    bar,
    sunTimes(s, d),
    el('div', { class: 'links' }, el('a', { href: googleMapsUrl(c), target: '_blank', rel: 'noopener' }, 'Google karte')),
  ];
}

// Times under the day bar: where each stretch of sun starts and ends, then sunrise and sunset at the ends. A time
// too close to one already placed is left out, so they never overlap (a short stretch keeps only its start).
const LABEL_WIDTH = 0.12; // share of the bar width one time takes, with a little space
function sunTimes(s, d) {
  const n = s.length, want = [];
  for (let i = 0, j; i < n; i = j) {
    for (j = i; j < n && s[j] === s[i]; j++);
    if (s[i] === SUN) want.push([i / n, d.start + i * STEP], [j / n, d.start + j * STEP]);
  }
  want.push([0, d.sunrise], [1, d.sunset]);
  // A time is centred under its spot, except near the ends, where it lines up with the bar's edge.
  const span = (f) => { const a = Math.min(Math.max(f - LABEL_WIDTH / 2, 0), 1 - LABEL_WIDTH); return [a, a + LABEL_WIDTH]; };
  const placed = [];
  for (const w of want) {
    const [a, b] = span(w[0]);
    if (placed.every((q) => { const [c, e] = span(q[0]); return b <= c || a >= e; })) placed.push(w);
  }
  return el('div', { class: 'suntimes' }, ...placed.map(([f, t]) =>
    el('span', { class: f < LABEL_WIDTH / 2 ? 'first' : f > 1 - LABEL_WIDTH / 2 ? 'last' : '', style: `left:${span(f)[0] * 100}%` }, hhmm(t))));
}

// Google Maps searched for the café's name at its spot, which opens the café's own page (busyness, reviews) rather
// than a bare pin; cafés without a name fall back to the coordinates.
function googleMapsUrl(c) {
  return c.name
    ? `https://www.google.com/maps/search/${encodeURIComponent(c.name)}/@${c.lat},${c.lon},19z`
    : `https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lon}`;
}

function listPanel() {
  const ref = state.user || { x: map.controls.target.x, y: -map.controls.target.z };
  const nearest = (st) => cafes.filter((c) => c.state === st).sort((a, b) => Math.hypot(a.x - ref.x, a.y - ref.y) - Math.hypot(b.x - ref.x, b.y - ref.y));
  const row = (c) => el('li', { onclick: () => select(c) },
    el('span', { class: 'dot ' + STATE_NAME[c.state] }),
    el('span', { class: 'name' }, c.name || 'Kafić bez imena'),
    el('span', { class: 'meta' }, `${forecast(c)} · ${distanceLabel(c)}`));
  const sunny = nearest(SUN), under = nearest(TREE);
  const out = [
    el('h2', {}, `Na suncu (${sunny.length})`),
    el('div', { class: 'sub' }, `${hhmm(state.time)} · poredano po udaljenosti od ${state.user ? 'tebe' : 'središta karte'}`),
  ];
  if (!sunny.length) out.push(el('p', {}, state.alt <= 0 ? 'Sunce je ispod obzora.' : 'Trenutno nijedna terasa nije na suncu.'));
  out.push(el('ul', { class: 'cafelist' }, ...sunny.slice(0, 40).map(row)));
  if (under.length) out.push(el('h2', {}, `Pod krošnjom (${under.length})`), el('ul', { class: 'cafelist' }, ...under.slice(0, 15).map(row)));
  return out;
}

function renderPanel() {
  const panel = $('panel'), body = $('panel-body');
  panel.hidden = !state.panel;
  $('btn-list').classList.toggle('active', state.panel === 'list');
  $('btn-info').classList.toggle('active', state.panel === 'info');
  if (!state.panel) return;
  const scroll = panel.scrollTop;
  if (state.panel === 'info') body.replaceChildren($('tpl-info').content.cloneNode(true));
  else body.replaceChildren(...(state.panel === 'cafe' ? cafePanel(state.selected) : listPanel()));
  panel.scrollTop = scroll;
}

function openPanel(name) {
  state.panel = name;
  if (name !== 'cafe') {
    state.selected = null;
    ringSprite.visible = false;
    map.requestRender();
  }
  $('panel').scrollTop = 0;
  renderPanel();
}

function select(cafe) {
  state.selected = cafe;
  ringSprite.position.copy(cafe.pos);
  ringSprite.visible = true;
  map.animateView({ x: cafe.x, y: cafe.y, maxDist: 450 });
  openPanel('cafe');
}

// Tapping the time slides the slider back to now; shadows and markers follow as if it were dragged.
let timeTween = null;
function backToNow() {
  if (state.live || timeTween) return;
  const from = +state.time, gap = Math.abs(+now() - from) / (state.day.n * STEP);
  timeTween = { t0: performance.now(), from, ms: Math.min(1400, 450 + 900 * gap) };
}

function stepTimeTween() {
  if (!timeTween) return;
  const k = Math.min(1, (performance.now() - timeTween.t0) / timeTween.ms), e = k * k * (3 - 2 * k);
  if (k === 1) {
    timeTween = null;
    state.live = true;
    tick(true);
    return;
  }
  state.time = new Date(timeTween.from + (+now() - timeTween.from) * e);
  applyTime();
}

// The buttons and the bottom sheet stack above the time bar, whatever their heights.
function trackLayout() {
  const root = document.documentElement, bar = $('timebar'), panel = $('panel');
  const wide = matchMedia('(min-width: 800px)');
  const update = () => {
    const gap = parseFloat(getComputedStyle(root).getPropertyValue('--gap'));
    root.style.setProperty('--bar', bar.offsetHeight + 'px');
    root.style.setProperty('--sheet', panel.hidden || wide.matches ? '0px' : panel.offsetHeight + gap + 'px');
  };
  new ResizeObserver(update).observe(bar);
  new ResizeObserver(update).observe(panel);
  addEventListener('resize', update);
  update();
}

// ---------- interaction ----------

function pick(clientX, clientY) {
  const v = new THREE.Vector3();
  let best = null, bestD = coarse ? 30 : 20;
  for (const c of cafes) {
    v.copy(c.pos).project(map.camera);
    if (v.z > 1) continue;
    const d = Math.hypot(((v.x + 1) / 2) * innerWidth - clientX, ((1 - v.y) / 2) * innerHeight - clientY) - (c.state === SUN ? 4 : 0);
    if (d < bestD) { best = c; bestD = d; }
  }
  return best;
}

function bindUI() {
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || !state.ready || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8 || performance.now() - down.t > 600) return;
    const c = pick(e.clientX, e.clientY);
    if (c) select(c);
    else if (state.panel === 'cafe') openPanel(null);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' && e.buttons === 0 && state.ready) canvas.style.cursor = pick(e.clientX, e.clientY) ? 'pointer' : '';
  });

  $('slider').addEventListener('input', (e) => {
    timeTween = null;
    state.live = false;
    state.time = new Date(state.day.start + e.target.value * STEP);
    applyTime();
  });
  $('clock').addEventListener('click', backToNow);
  $('btn-list').addEventListener('click', () => openPanel(state.panel === 'list' ? null : 'list'));
  $('btn-info').addEventListener('click', () => openPanel(state.panel === 'info' ? null : 'info'));
  $('panel-close').addEventListener('click', () => openPanel(null));
  $('btn-north').addEventListener('click', () => map.animateView({ theta: 0 }));
  $('btn-locate').addEventListener('click', locate);

  trackLayout();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}

function showUser(x, y) {
  state.user = { x, y };
  const b = map.bounds, inside = x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
  userSprite.visible = inside;
  if (inside) {
    userSprite.position.set(x, map.ground(x, y) + 2, -y);
    map.animateView({ x, y, maxDist: 700 });
  }
  return inside;
}

// Position fix as local metres {x, y}, or null when unavailable (denied, no answer within 10 s, no GPS).
function getFix() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition((p) => {
      const lat0 = map ? map.geo.lat0 : 45.8131, lon0 = map ? map.geo.lon0 : 15.9772, phi = lat0 * DEG;
      resolve({
        x: (p.coords.longitude - lon0) * (111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi)),
        y: (p.coords.latitude - lat0) * (111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi)),
      });
    }, () => resolve(null), { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  });
}

async function locate() {
  if (!navigator.geolocation) return toast('Preglednik ne podržava lokaciju.');
  $('btn-locate').classList.add('active');
  if (state.user) showUser(state.user.x, state.user.y); // start sliding at once, the fresh fix follows
  const fix = await getFix();
  $('btn-locate').classList.remove('active');
  if (!fix) toast('Lokacija nije dostupna.');
  else if (!showUser(fix.x, fix.y)) toast('Izvan si prikazanog područja – udaljenosti se ipak računaju od tebe.');
}

// Live mode follows the clock: recompute once the minute changes.
let lastMinute = -1;
function tick(force) {
  const t = now(), minute = Math.floor(t / 60000);
  const day = computeDay(t);
  if (!state.day || (state.live && day.key !== state.day.key)) state.day = day;
  if (!state.live || (minute === lastMinute && !force)) return;
  lastMinute = minute;
  state.time = t;
  applyTime();
}

async function updateCloud() {
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${map.geo.lat0}&longitude=${map.geo.lon0}&current=cloud_cover`);
    state.cloud = Math.round((await r.json()).current.cloud_cover);
    updateUI();
  } catch { /* the cloud chip is optional */ }
}

// ---------- start ----------

async function main() {
  // Start where the user is: ask for the position right away (the first visit shows the browser's prompt). With
  // permission already given the fix comes quickly, so the map waits a moment for it and opens right there.
  const firstFix = getFix();
  const granted = await navigator.permissions?.query({ name: 'geolocation' }).then((r) => r.state === 'granted', () => false);
  const early = granted ? await Promise.race([firstFix, new Promise((r) => setTimeout(r, 2000, null))]) : null;
  const { createMap } = await import(MAP_URL);
  const tiles = params.get('tiles');
  [map, cafes] = await Promise.all([
    createMap({ canvas, ...(tiles && { tiles }), ...(early && Math.hypot(early.x, early.y) < 12000 && { view: { x: early.x, y: early.y, dist: 700 } }) }),
    fetch('data/cafes.json').then((r) => { if (!r.ok) throw new Error('cafes'); return r.json(); }),
  ]);
  map.scene.add(markers, ringSprite, userSprite);

  for (const c of cafes) {
    c.sky = Uint8Array.from(atob(c.sky), (ch) => ch.charCodeAt(0));
    c.state = SHADE;
    c.pos = new THREE.Vector3(c.x, c.z + 2, -c.y);
  }

  map.onFrame(stepTimeTween);
  map.onRender(() => {
    if (Math.abs(zoomFactor() - dotZoom) > 0.01) styleMarkers();
    $('needle').style.transform = `rotate(${map.controls.getAzimuthalAngle()}rad)`;
  });
  map.onResize(styleMarkers);
  state.ready = true;
  markers.visible = true;
  bindUI();
  styleMarkers();
  tick(true);
  $('loading').hidden = true;
  // Outside the map (or no answer) the view stays on the centre, without a message.
  firstFix.then((fix) => { if (fix && !state.user) showUser(fix.x, fix.y); });

  setInterval(tick, 10000);
  updateCloud();
  setInterval(updateCloud, 15 * 60 * 1000);
}

main().catch((e) => {
  console.error(e);
  $('loading').textContent = 'Greška pri učitavanju karte. Pokušaj osvježiti stranicu.';
});
