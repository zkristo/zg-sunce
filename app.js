import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { MeshBVH } from 'three-mesh-bvh';
import SunCalc from 'suncalc';

// Scene coordinates: X = east, Y = up (metres above data z0), Z = south. Data files use x = east, y = north.

const DEG = Math.PI / 180;
const STEP = 5 * 60 * 1000; // slider / schedule resolution
const EYE = 1.2; // m above ground where a terrace is tested for sun
const COLORS = { building: 0xcfd2d6, ground: 0xe6e8ea, day: 0xe9edf2, night: 0x161b26, dusk: 0xf1dcc8, sunWarm: 0xffdcb8 };
const TYPE_LABEL = { cafe: 'Kafić', bar: 'Bar', pub: 'Pub' };
const HEMI_INTENSITY = 0.9;
// Sun strength is raised as it gets lower so sunlit ground stays about equally bright all day.
const SUN_ON_GROUND = 1.75, SUN_MAX = 3.6;

const $ = (id) => document.getElementById(id);
const fmtTime = new Intl.DateTimeFormat('hr-HR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zagreb' });
const fmtDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zagreb' });
const hhmm = (t) => fmtTime.format(t);
const smoothstep = (x, a, b) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ?now=2026-06-21T10:00 shifts the clock (handy for testing and for sharing a moment).
const nowParam = new URLSearchParams(location.search).get('now');
const clockOffset = nowParam && !isNaN(Date.parse(nowParam)) ? Date.parse(nowParam) - Date.now() : 0;
const now = () => new Date(Date.now() + clockOffset);

const state = {
  live: true,
  time: now(),
  day: null, // { start, n, sunrise, sunset, tomorrow, key }
  sunDir: new THREE.Vector3(0, 1, 0),
  alt: 0,
  cloud: null,
  selected: null,
  user: null, // { x, y } in data coordinates
  panel: null, // 'cafe' | 'list' | 'info'
  ready: false, // BVH built, sun tests possible
  toastUntil: 0,
};

let geo, terrain, cafes, bounds;
let bvhBuildings, bvhTerrain;
let needsRender = true;
let tween = null;
const schedules = new Map();

// ---------- renderer, scene, camera ----------

const canvas = $('scene');
const coarse = matchMedia('(pointer: coarse)').matches;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(COLORS.day);

const camera = new THREE.PerspectiveCamera(40, 1, 5, 40000);
const controls = new MapControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.minDistance = 80;
controls.maxDistance = 7000;
controls.maxPolarAngle = 80 * DEG;
controls.zoomToCursor = true;

const hemi = new THREE.HemisphereLight(0xffffff, 0xd0d3d8, HEMI_INTENSITY);
const sun = new THREE.DirectionalLight(0xffffff, SUN_MAX);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(coarse ? 2048 : 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.4;
scene.add(hemi, sun, sun.target);

const requestRender = () => { needsRender = true; };

// ---------- geometry ----------

function ground(x, y) {
  const t = terrain;
  const fx = Math.min(Math.max((x - t.x0) / t.cell, 0), t.nx - 1.001);
  const fy = Math.min(Math.max((y - t.y0) / t.cell, 0), t.ny - 1.001);
  const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
  const a = t.h[j * t.nx + i] * (1 - tx) + t.h[j * t.nx + i + 1] * tx;
  const b = t.h[(j + 1) * t.nx + i] * (1 - tx) + t.h[(j + 1) * t.nx + i + 1] * tx;
  return (a * (1 - ty) + b * ty) / 10;
}

// Every part becomes a prism: shared bottom/top vertices, walls + roof (flat shading needs no normals).
function buildBuildings(parts) {
  let nPoints = 0;
  for (const p of parts) for (let r = 2; r < p.length; r++) nPoints += p[r].length / 2;
  const pos = new Float32Array(nPoints * 2 * 3);
  const index = [];
  let v = 0;
  for (const p of parts) {
    const base = p[0] / 10, top = p[1] / 10;
    const rings = [];
    let n = 0;
    for (let r = 2; r < p.length; r++) {
      const ring = [];
      for (let k = 0; k < p[r].length; k += 2) ring.push(new THREE.Vector2(p[r][k] / 10, p[r][k + 1] / 10));
      rings.push(ring);
      n += ring.length;
    }
    const flat = rings.flat();
    flat.forEach((pt, k) => {
      pos.set([pt.x, base, -pt.y], (v + k) * 3);
      pos.set([pt.x, top, -pt.y], (v + n + k) * 3);
    });
    let o = v;
    for (const ring of rings) {
      for (let k = 0; k < ring.length; k++) {
        const a = o + k, b = o + ((k + 1) % ring.length);
        index.push(a, b, b + n, a, b + n, a + n);
      }
      o += ring.length;
    }
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(rings[0], rings.slice(1))) {
      const A = flat[a], B = flat[b], C = flat[c];
      const ccw = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x) > 0;
      index.push(v + n + a, v + n + (ccw ? b : c), v + n + (ccw ? c : b));
    }
    v += 2 * n;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(Uint32Array.from(index), 1));
  return g;
}

function buildTerrain(t) {
  const pos = new Float32Array(t.nx * t.ny * 3);
  const index = [];
  for (let j = 0; j < t.ny; j++) {
    for (let i = 0; i < t.nx; i++) {
      pos.set([t.x0 + i * t.cell, t.h[j * t.nx + i] / 10, -(t.y0 + j * t.cell)], (j * t.nx + i) * 3);
      if (i < t.nx - 1 && j < t.ny - 1) {
        const a = j * t.nx + i, b = a + 1, c = a + t.nx, d = c + 1;
        index.push(a, b, d, a, d, c);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

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
const mats = { sun: spriteMat('#ffb800'), shade: spriteMat('#55606e'), ring: spriteMat('#1f2933', true), user: spriteMat('#2f7cf6') };
const markers = new THREE.Group();
markers.visible = false;
const ringSprite = new THREE.Sprite(mats.ring);
const userSprite = new THREE.Sprite(mats.user);
ringSprite.visible = userSprite.visible = false;
ringSprite.renderOrder = 4;
userSprite.renderOrder = 5;
scene.add(markers, ringSprite, userSprite);

// Sprites keep a constant size in CSS pixels.
const pxScale = (px) => (px / innerHeight) * 2 * Math.tan((camera.fov * DEG) / 2);
function styleMarkers() {
  for (const c of cafes) {
    const px = (c.sunny ? 17 : 11) + (c.outdoor ? 3 : 0);
    c.sprite.material = c.sunny ? mats.sun : mats.shade;
    c.sprite.renderOrder = c.sunny ? 3 : 2;
    c.sprite.scale.setScalar(pxScale(px));
  }
  ringSprite.scale.setScalar(pxScale(34));
  userSprite.scale.setScalar(pxScale(16));
}

// ---------- sun ----------

function sunAt(date) {
  const p = SunCalc.getPosition(date, geo.lat0, geo.lon0);
  const bearing = p.azimuth + Math.PI; // SunCalc: 0 = south, positive towards west
  const ch = Math.cos(p.altitude);
  return { alt: p.altitude, dir: new THREE.Vector3(Math.sin(bearing) * ch, Math.sin(p.altitude), -Math.cos(bearing) * ch) };
}

const ray = new THREE.Ray();
function sunlit(cafe, s) {
  if (s.alt <= 0) return false;
  ray.origin.set(cafe.x, cafe.z + EYE, -cafe.y);
  ray.direction.copy(s.dir);
  return !bvhBuildings.raycastFirst(ray, THREE.DoubleSide) && !bvhTerrain.raycastFirst(ray, THREE.DoubleSide);
}

// The day shown on the slider: today, or tomorrow once the sun has set.
function computeDay(t) {
  let times = SunCalc.getTimes(t, geo.lat0, geo.lon0);
  if (t > times.sunset) times = SunCalc.getTimes(new Date(+t + 12 * 3600e3), geo.lat0, geo.lon0);
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

// Sun / shade for one café at every slider step of the day (cached).
function schedule(cafe) {
  const key = cafe.id + state.day.key;
  if (!schedules.has(key)) {
    const s = new Array(state.day.n);
    for (let i = 0; i < s.length; i++) s[i] = sunlit(cafe, sunAt(new Date(state.day.start + i * STEP)));
    schedules.set(key, s);
  }
  return schedules.get(key);
}

function forecast(cafe) {
  const s = schedule(cafe), d = state.day;
  const idx = Math.min(d.n - 1, Math.floor((state.time - d.start) / STEP));
  const at = (i) => (d.tomorrow && state.live ? 'sutra ' : '') + hhmm(d.start + i * STEP);
  if (cafe.sunny) {
    const end = s.indexOf(false, Math.max(0, idx + 1));
    return end < 0 ? `do zalaska (${hhmm(d.sunset)})` : `do ${at(end)}`;
  }
  const next = s.indexOf(true, Math.max(0, idx + 1));
  if (next >= 0) return `sunce od ${at(next)}`;
  return s.includes(true) ? 'danas više nema sunca' : 'nema sunca cijeli dan';
}

function updateShadowFrustum() {
  const dist = camera.position.distanceTo(controls.target);
  const size = Math.min(3500, Math.max(350, dist * 1.4));
  const cam = sun.shadow.camera;
  cam.left = cam.bottom = -size;
  cam.right = cam.top = size;
  cam.near = 100;
  cam.far = 12000;
  cam.updateProjectionMatrix();
  sun.target.position.copy(controls.target);
  sun.position.copy(controls.target).addScaledVector(state.sunDir, 6000);
}

function applyTime() {
  const s = sunAt(state.time);
  state.alt = s.alt;
  if (s.alt > 0) state.sunDir.copy(s.dir);
  const deg = s.alt / DEG;
  const day = smoothstep(deg, -5, 4);
  const warm = 1 - smoothstep(deg, 2, 16);
  sun.intensity = Math.min(SUN_MAX, SUN_ON_GROUND / Math.max(Math.sin(s.alt), 0.01)) * smoothstep(deg, -0.5, 4);
  sun.color.set(0xffffff).lerp(new THREE.Color(COLORS.sunWarm), warm);
  hemi.intensity = 0.22 + (HEMI_INTENSITY - 0.22) * day;
  scene.background.set(COLORS.night).lerp(new THREE.Color(COLORS.day).lerp(new THREE.Color(COLORS.dusk), warm * 0.6), day);

  if (state.ready) {
    for (const c of cafes) c.sunny = sunlit(c, s);
    styleMarkers();
  }
  updateUI();
  requestRender();
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
  $('mode').textContent = state.live ? 'uživo' : d.tomorrow ? 'sutra' : 'danas';
  $('mode').classList.toggle('live', state.live);
  $('btn-now').hidden = state.live;
  $('sunline').textContent = night ? 'sunce je ispod obzora' : `sunce ${Math.round(state.alt / DEG)}° nad obzorom`;
  $('t-rise').textContent = '↑ ' + hhmm(d.sunrise);
  $('t-set').textContent = hhmm(d.sunset) + ' ↓';
  $('t-day').textContent = d.tomorrow ? 'sutra' : 'danas';
  const slider = $('slider');
  slider.max = d.n - 1;
  slider.value = Math.min(d.n - 1, Math.max(0, Math.round((state.time - d.start) / STEP)));

  const count = $('count');
  count.hidden = !state.ready || night;
  if (state.ready) count.textContent = `☀ ${cafes.filter((c) => c.sunny).length} od ${cafes.length} terasa na suncu`;

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
  const ref = state.user || { x: controls.target.x, y: -controls.target.z };
  const m = Math.hypot(c.x - ref.x, c.y - ref.y);
  return m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

function cafePanel(c) {
  const s = schedule(c), d = state.day, n = s.length;
  // Sunny stretches of the day as a hard-edged gradient.
  const stops = [];
  for (let i = 0; i < n; i++) {
    if (s[i] && !s[i - 1]) stops.push(`transparent ${(i / n) * 100}%, var(--sun) ${(i / n) * 100}%`);
    if (s[i] && !s[i + 1]) stops.push(`var(--sun) ${((i + 1) / n) * 100}%, transparent ${((i + 1) / n) * 100}%`);
  }
  const pos = (state.time - d.start) / (n * STEP);
  const bar = el('div', { class: 'daybar', style: stops.length ? `background-image:linear-gradient(90deg,${stops.join(',')})` : '' });
  if (pos >= 0 && pos <= 1) bar.append(el('i', { style: `left:${pos * 100}%` }));
  const seating = c.outdoor ? ' · terasa potvrđena u OSM-u' : '';
  return [
    el('h2', {}, c.name || 'Kafić bez imena'),
    el('div', { class: 'sub' }, (TYPE_LABEL[c.type] || 'Kafić') + seating + ' · ' + distanceLabel(c)),
    el('div', { class: 'status' }, el('span', { class: 'dot ' + (c.sunny ? 'sun' : 'shade') }), (c.sunny ? 'Na suncu ' : 'U sjeni · ') + forecast(c)),
    bar,
    el('div', { class: 'ticks' }, el('span', {}, hhmm(d.sunrise)), el('span', {}, d.tomorrow ? 'sunce sutra' : 'sunce danas'), el('span', {}, hhmm(d.sunset))),
    el('div', { class: 'links' },
      el('a', { href: `https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lon}`, target: '_blank', rel: 'noopener' }, 'Google karte'),
      el('a', { href: `https://www.openstreetmap.org/${{ n: 'node', w: 'way', r: 'relation' }[c.id[0]]}/${c.id.slice(1)}`, target: '_blank', rel: 'noopener' }, 'OpenStreetMap')),
  ];
}

function listPanel() {
  const ref = state.user || { x: controls.target.x, y: -controls.target.z };
  const sunny = cafes.filter((c) => c.sunny).sort((a, b) => Math.hypot(a.x - ref.x, a.y - ref.y) - Math.hypot(b.x - ref.x, b.y - ref.y));
  const out = [
    el('h2', {}, `Na suncu (${sunny.length})`),
    el('div', { class: 'sub' }, `${hhmm(state.time)} · poredano po udaljenosti od ${state.user ? 'tebe' : 'središta karte'}`),
  ];
  if (!sunny.length) out.push(el('p', {}, state.alt <= 0 ? 'Sunce je ispod obzora.' : 'Trenutno nijedna terasa nije na suncu.'));
  out.push(el('ul', { class: 'cafelist' }, ...sunny.slice(0, 40).map((c) =>
    el('li', { onclick: () => select(c) },
      el('span', { class: 'dot sun' }),
      el('span', { class: 'name' }, c.name || 'Kafić bez imena'),
      el('span', { class: 'meta' }, `${forecast(c)} · ${distanceLabel(c)}`)))));
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
    requestRender();
  }
  $('panel').scrollTop = 0;
  renderPanel();
}

function select(cafe) {
  state.selected = cafe;
  ringSprite.position.copy(cafe.sprite.position);
  ringSprite.visible = true;
  flyTo(cafe.x, cafe.y, 450);
  openPanel('cafe');
}

// ---------- camera ----------

function flyTo(x, y, maxDist) {
  const target = new THREE.Vector3(x, ground(x, y), -y);
  const offset = camera.position.clone().sub(controls.target);
  if (maxDist && offset.length() > maxDist) offset.setLength(maxDist);
  tween = { t0: performance.now(), fromT: controls.target.clone(), fromP: camera.position.clone(), toT: target, toP: target.clone().add(offset) };
}

function stepTween() {
  if (!tween) return;
  const k = Math.min(1, (performance.now() - tween.t0) / 500), e = k * k * (3 - 2 * k);
  controls.target.lerpVectors(tween.fromT, tween.toT, e);
  camera.position.lerpVectors(tween.fromP, tween.toP, e);
  if (k === 1) tween = null;
  requestRender();
}

// Keep the view inside the model and the pivot on the ground.
function constrainView() {
  const t = controls.target;
  const x = Math.min(bounds.maxX, Math.max(bounds.minX, t.x));
  const z = Math.min(-bounds.minY, Math.max(-bounds.maxY, t.z));
  const y = ground(x, -z);
  camera.position.add(new THREE.Vector3(x - t.x, y - t.y, z - t.z));
  t.set(x, y, z);
}

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  if (cafes) styleMarkers();
  requestRender();
}

function frame() {
  requestAnimationFrame(frame);
  stepTween();
  controls.update();
  if (!needsRender) return;
  needsRender = false;
  updateShadowFrustum();
  renderer.render(scene, camera);
  $('needle').style.transform = `rotate(${controls.getAzimuthalAngle()}rad)`;
}

// ---------- interaction ----------

function pick(clientX, clientY) {
  const v = new THREE.Vector3();
  let best = null, bestD = coarse ? 30 : 20;
  for (const c of cafes) {
    v.copy(c.sprite.position).project(camera);
    if (v.z > 1) continue;
    const d = Math.hypot(((v.x + 1) / 2) * innerWidth - clientX, ((1 - v.y) / 2) * innerHeight - clientY) - (c.sunny ? 4 : 0);
    if (d < bestD) { best = c; bestD = d; }
  }
  return best;
}

function bindUI() {
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; tween = null; });
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
    state.live = false;
    state.time = new Date(state.day.start + e.target.value * STEP);
    applyTime();
  });
  $('btn-now').addEventListener('click', () => { state.live = true; tick(true); });
  $('btn-list').addEventListener('click', () => openPanel(state.panel === 'list' ? null : 'list'));
  $('btn-info').addEventListener('click', () => openPanel(state.panel === 'info' ? null : 'info'));
  $('panel-close').addEventListener('click', () => openPanel(null));
  $('btn-north').addEventListener('click', () => {
    const offset = camera.position.clone().sub(controls.target);
    const s = new THREE.Spherical().setFromVector3(offset);
    s.theta = 0;
    camera.position.copy(controls.target).add(offset.setFromSpherical(s));
    requestRender();
  });
  $('btn-locate').addEventListener('click', locate);

  controls.addEventListener('change', () => { constrainView(); requestRender(); });
  addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}

function locate() {
  if (!navigator.geolocation) return toast('Preglednik ne podržava lokaciju.');
  $('btn-locate').classList.add('active');
  navigator.geolocation.getCurrentPosition((p) => {
    $('btn-locate').classList.remove('active');
    const lat0 = geo.lat0 * DEG;
    const x = (p.coords.longitude - geo.lon0) * (111412.84 * Math.cos(lat0) - 93.5 * Math.cos(3 * lat0));
    const y = (p.coords.latitude - geo.lat0) * (111132.92 - 559.82 * Math.cos(2 * lat0) + 1.175 * Math.cos(4 * lat0));
    state.user = { x, y };
    if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) {
      toast('Izvan si prikazanog područja – udaljenosti se ipak računaju od tebe.');
    } else {
      userSprite.position.set(x, ground(x, y) + 2, -y);
      userSprite.visible = true;
      flyTo(x, y, 700);
    }
    openPanel('list');
  }, () => {
    $('btn-locate').classList.remove('active');
    toast('Lokacija nije dostupna.');
  }, { enableHighAccuracy: true, timeout: 10000 });
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
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${geo.lat0}&longitude=${geo.lon0}&current=cloud_cover`);
    state.cloud = Math.round((await r.json()).current.cloud_cover);
    updateUI();
  } catch { /* the cloud chip is optional */ }
}

// ---------- start ----------

async function main() {
  const load = (name) => fetch(`data/${name}.json`).then((r) => { if (!r.ok) throw new Error(name); return r.json(); });
  [geo, terrain, cafes] = await Promise.all([load('buildings'), load('terrain'), load('cafes')]);

  bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const p of geo.parts.slice(0, geo.core)) {
    bounds.minX = Math.min(bounds.minX, p[2][0] / 10); bounds.maxX = Math.max(bounds.maxX, p[2][0] / 10);
    bounds.minY = Math.min(bounds.minY, p[2][1] / 10); bounds.maxY = Math.max(bounds.maxY, p[2][1] / 10);
  }

  const buildings = new THREE.Mesh(buildBuildings(geo.parts), new THREE.MeshLambertMaterial({ color: COLORS.building, flatShading: true }));
  buildings.castShadow = buildings.receiveShadow = true;
  const land = new THREE.Mesh(buildTerrain(terrain), new THREE.MeshLambertMaterial({ color: COLORS.ground }));
  land.receiveShadow = true;
  scene.add(land, buildings);
  geo.parts = null;

  for (const c of cafes) {
    c.sprite = new THREE.Sprite(mats.shade);
    c.sprite.position.set(c.x, c.z + 2, -c.y);
    markers.add(c.sprite);
  }

  controls.target.set(0, ground(0, 0), 0);
  camera.position.set(-260, controls.target.y + 560, 760);
  bindUI();
  resize();
  tick(true);
  frame();
  $('loading').hidden = true;

  // The BVH takes a moment to build; the map is already usable meanwhile.
  await new Promise((r) => setTimeout(r, 30));
  bvhBuildings = new MeshBVH(buildings.geometry);
  bvhTerrain = new MeshBVH(land.geometry);
  state.ready = true;
  markers.visible = true;
  applyTime();

  setInterval(tick, 10000);
  updateCloud();
  setInterval(updateCloud, 15 * 60 * 1000);
}

main().catch((e) => {
  console.error(e);
  $('loading').textContent = 'Greška pri učitavanju karte. Pokušaj osvježiti stranicu.';
});
