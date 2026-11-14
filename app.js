import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { MeshBVH } from 'three-mesh-bvh';
import SunCalc from 'suncalc';

// Scene coordinates: X = east, Y = up (metres above data z0), Z = south. Data files use x = east, y = north.

const DEG = Math.PI / 180;
const STEP = 5 * 60 * 1000; // slider / schedule resolution
const EYE = 1.2; // m above ground where a terrace is tested for sun
const CHUNK = 600; // m, buildings are split into square chunks so off-screen ones are skipped
const COLORS = { tree: 0xb1c2ab, evergreen: 0x8fa692, building: 0xcfd2d6, ground: 0xe6e8ea, day: 0xe9edf2, night: 0x161b26, dusk: 0xf1dcc8, sunWarm: 0xffdcb8 };
const SHADE = 0, TREE = 1, SUN = 2; // state of a terrace
const STATE_NAME = ['shade', 'tree', 'sun'];
const LEAF_ON = [415, 1031]; // deciduous trees carry leaves from 15 April to 31 October
const TREE_CELL = 25; // m, lookup grid for the tree shade test
const TREE_REACH = 250; // m, how far towards the sun a tree can still shade a terrace
const TREE_MAX_DIST = 2000; // m, trees are not drawn when the camera is further away
const TYPE_LABEL = { cafe: 'Kafić', bar: 'Bar', pub: 'Pub' };
const HEMI_INTENSITY = 0.9;
// Sun strength is raised as it gets lower so sunlit ground stays about equally bright all day.
const SUN_ON_GROUND = 1.75, SUN_MAX = 3.6;

const $ = (id) => document.getElementById(id);
const fmtTime = new Intl.DateTimeFormat('hr-HR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zagreb' });
const fmtDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zagreb' });
const hhmm = (t) => fmtTime.format(t);
const leafOn = (date) => { const d = fmtDay.format(date), md = d.slice(5, 7) * 100 + +d.slice(8); return md >= LEAF_ON[0] && md <= LEAF_ON[1]; };
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
let chunks, bvhTerrain; // chunks: [{ mesh, box, bvh }]
let trees = null; // { n, x, y, z, rh, rv, evergreen, grid } — crowns are ellipsoids centred at (x, y, z)
const treeGroup = new THREE.Group();
const treeMats = {
  leaf: new THREE.MeshLambertMaterial({ color: COLORS.tree, flatShading: true }),
  bare: new THREE.MeshLambertMaterial({ color: COLORS.tree, flatShading: true, transparent: true, opacity: 0.22, depthWrite: false }),
  evergreen: new THREE.MeshLambertMaterial({ color: COLORS.evergreen, flatShading: true }),
};
const deciduousMeshes = [];
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
controls.maxDistance = 12000;
controls.maxPolarAngle = 80 * DEG;
controls.zoomToCursor = true;
controls.touches.TWO = null; // two-finger gestures are handled in bindTouch

const hemi = new THREE.HemisphereLight(0xffffff, 0xd0d3d8, HEMI_INTENSITY);
const sun = new THREE.DirectionalLight(0xffffff, SUN_MAX);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(coarse ? 2048 : 4096);
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

const treeKey = (i, j) => (i + 4096) * 8192 + j + 4096;

// Every tree is a low-poly ellipsoid crown; the same ellipsoids are used for the shade test.
function buildTrees(data) {
  const n = data.t.length / 3;
  const t = { n, x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), rh: new Float32Array(n), rv: new Float32Array(n), evergreen: new Uint8Array(n), grid: new Map() };
  const cells = new Map();
  for (let k = 0; k < n; k++) {
    const x = data.t[3 * k] / 10, y = data.t[3 * k + 1] / 10, code = data.t[3 * k + 2];
    const h = data.h[code & 7], w = data.w[(code >> 3) & 3];
    t.x[k] = x;
    t.y[k] = y;
    t.rh[k] = w / 2;
    t.rv[k] = 0.3 * h;
    t.z[k] = ground(x, y) + h - t.rv[k];
    t.evergreen[k] = code >> 5;
    const key = treeKey(Math.floor(x / TREE_CELL), Math.floor(y / TREE_CELL));
    if (!t.grid.has(key)) t.grid.set(key, []);
    t.grid.get(key).push(k);
    const cell = Math.floor(x / CHUNK) + ',' + Math.floor(y / CHUNK) + ',' + t.evergreen[k];
    if (!cells.has(cell)) cells.set(cell, []);
    cells.get(cell).push(k);
  }
  const crown = new THREE.IcosahedronGeometry(1, 0);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  for (const list of cells.values()) {
    const evergreen = t.evergreen[list[0]];
    const mesh = new THREE.InstancedMesh(crown, evergreen ? treeMats.evergreen : treeMats.leaf, list.length);
    list.forEach((k, i) => {
      q.setFromAxisAngle(up, k * 2.4); // turn each crown differently so they do not look stamped
      mesh.setMatrixAt(i, m.compose(new THREE.Vector3(t.x[k], t.z[k], -t.y[k]), q, new THREE.Vector3(t.rh[k], t.rv[k], t.rh[k])));
    });
    mesh.computeBoundingSphere();
    mesh.castShadow = mesh.receiveShadow = true;
    if (!evergreen) deciduousMeshes.push(mesh);
    treeGroup.add(mesh);
  }
  return t;
}

let leafShown = true;
function showLeaves(leaf) {
  if (leaf === leafShown) return;
  leafShown = leaf;
  for (const mesh of deciduousMeshes) {
    mesh.material = leaf ? treeMats.leaf : treeMats.bare;
    mesh.castShadow = leaf;
  }
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
const mats = { sun: spriteMat('#ffb800'), tree: spriteMat('#7fa076'), shade: spriteMat('#55606e'), ring: spriteMat('#1f2933', true), user: spriteMat('#2f7cf6') };
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
    const px = 11 + 3 * c.state + (c.outdoor ? 3 : 0);
    c.sprite.material = mats[STATE_NAME[c.state]];
    c.sprite.renderOrder = 1 + c.state;
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
  return { alt: p.altitude, leaf: leafOn(date), dir: new THREE.Vector3(Math.sin(bearing) * ch, Math.sin(p.altitude), -Math.cos(bearing) * ch) };
}

const ray = new THREE.Ray();
function sunlit(cafe, s) {
  if (s.alt <= 0) return false;
  ray.origin.set(cafe.x, cafe.z + EYE, -cafe.y);
  ray.direction.copy(s.dir);
  for (const c of chunks) if (ray.intersectsBox(c.box) && c.bvh.raycastFirst(ray, THREE.DoubleSide)) return false;
  return !bvhTerrain.raycastFirst(ray, THREE.DoubleSide);
}

// Does a tree crown stand between the terrace and the sun?
const treeCells = new Set();
function treeShaded(cafe, s) {
  if (!trees) return false;
  const t = trees, ox = cafe.x, oy = cafe.y, oz = cafe.z + EYE;
  const dx = s.dir.x, dy = -s.dir.z, dz = s.dir.y, flat = Math.hypot(dx, dy) || 1e-9;
  // Cells along the ground track of the ray, until it has climbed above the tallest tree.
  const reach = Math.min(TREE_REACH, (30 * flat) / Math.max(dz, 1e-3));
  treeCells.clear();
  for (let d = 0; d <= reach + TREE_CELL; d += TREE_CELL) {
    const i = Math.floor((ox + (dx / flat) * d) / TREE_CELL), j = Math.floor((oy + (dy / flat) * d) / TREE_CELL);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) treeCells.add(treeKey(i + a, j + b));
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

// State of one café at every slider step of the day (cached).
function schedule(cafe) {
  const key = cafe.id + state.day.key;
  if (!schedules.has(key)) {
    const s = new Array(state.day.n);
    for (let i = 0; i < s.length; i++) s[i] = stateAt(cafe, sunAt(new Date(state.day.start + i * STEP)));
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

function updateShadowFrustum() {
  const dist = camera.position.distanceTo(controls.target);
  const size = Math.min(6500, Math.max(350, dist * 1.4));
  const depth = 1.5 * size + 400; // how far along the sun ray shadow casters can be from the pivot
  const cam = sun.shadow.camera;
  cam.left = cam.bottom = -size;
  cam.right = cam.top = size;
  cam.near = 100;
  cam.far = 100 + 2 * depth;
  cam.updateProjectionMatrix();
  // Back faces cast the shadows, so a small bias is enough; a large one leaks light along wall bases.
  sun.shadow.bias = -(0.1 + size / sun.shadow.mapSize.x) / (2 * depth);
  sun.target.position.copy(controls.target);
  sun.position.copy(controls.target).addScaledVector(state.sunDir, depth + 100);
}

function applyTime() {
  const s = sunAt(state.time);
  state.alt = s.alt;
  if (s.alt > 0) state.sunDir.copy(s.dir);
  showLeaves(s.leaf);
  const deg = s.alt / DEG;
  const day = smoothstep(deg, -5, 4);
  const warm = 1 - smoothstep(deg, 2, 16);
  sun.intensity = Math.min(SUN_MAX, SUN_ON_GROUND / Math.max(Math.sin(s.alt), 0.01)) * smoothstep(deg, -0.5, 4);
  sun.color.set(0xffffff).lerp(new THREE.Color(COLORS.sunWarm), warm);
  hemi.intensity = 0.22 + (HEMI_INTENSITY - 0.22) * day;
  scene.background.set(COLORS.night).lerp(new THREE.Color(COLORS.day).lerp(new THREE.Color(COLORS.dusk), warm * 0.6), day);

  if (state.ready) {
    for (const c of cafes) c.state = stateAt(c, s);
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
  const ref = state.user || { x: controls.target.x, y: -controls.target.z };
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
  const seating = c.outdoor ? ' · terasa potvrđena u OSM-u' : '';
  return [
    el('h2', {}, c.name || 'Kafić bez imena'),
    el('div', { class: 'sub' }, (TYPE_LABEL[c.type] || 'Kafić') + seating + ' · ' + distanceLabel(c)),
    el('div', { class: 'status' }, el('span', { class: 'dot ' + STATE_NAME[c.state] }), ['U sjeni · ', 'Pod krošnjom · ', 'Na suncu '][c.state] + forecast(c)),
    bar,
    el('div', { class: 'ticks' }, el('span', {}, hhmm(d.sunrise)), el('span', {}, d.tomorrow ? 'sunce sutra' : 'sunce danas'), el('span', {}, hhmm(d.sunset))),
    el('div', { class: 'links' },
      el('a', { href: `https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lon}`, target: '_blank', rel: 'noopener' }, 'Google karte'),
      el('a', { href: `https://www.openstreetmap.org/${{ n: 'node', w: 'way', r: 'relation' }[c.id[0]]}/${c.id.slice(1)}`, target: '_blank', rel: 'noopener' }, 'OpenStreetMap')),
  ];
}

function listPanel() {
  const ref = state.user || { x: controls.target.x, y: -controls.target.z };
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
    requestRender();
  }
  $('panel').scrollTop = 0;
  renderPanel();
}

function select(cafe) {
  state.selected = cafe;
  ringSprite.position.copy(cafe.sprite.position);
  ringSprite.visible = true;
  animateView({ x: cafe.x, y: cafe.y, maxDist: 450 });
  openPanel('cafe');
}

// ---------- camera ----------

const shortestTurn = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Animate the camera: slide the pivot to (x, y), zoom in to maxDist and / or turn to the bearing theta.
function animateView({ x, y, maxDist, theta }) {
  const from = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
  const to = from.clone();
  if (maxDist) to.radius = Math.min(to.radius, maxDist);
  if (theta != null) to.theta = from.theta + shortestTurn(theta - from.theta);
  const fromT = controls.target.clone();
  const toT = x == null ? fromT.clone() : new THREE.Vector3(x, ground(x, y), -y);
  const travel = fromT.distanceTo(toT);
  // Long slides rise a little on the way so the route stays visible.
  const lift = Math.max(0, Math.min(travel * 0.5, 2500) - Math.max(from.radius, to.radius) * 0.5);
  tween = { t0: performance.now(), ms: Math.min(1800, 500 + travel * 0.35), from, to, fromT, toT, lift };
}

const tweenS = new THREE.Spherical();
function stepTween() {
  if (!tween) return;
  const k = Math.min(1, (performance.now() - tween.t0) / tween.ms), e = k * k * (3 - 2 * k);
  const { from, to } = tween;
  controls.target.lerpVectors(tween.fromT, tween.toT, e);
  tweenS.set(from.radius + (to.radius - from.radius) * e + tween.lift * Math.sin(Math.PI * e), from.phi + (to.phi - from.phi) * e, from.theta + (to.theta - from.theta) * e);
  camera.position.setFromSpherical(tweenS).add(controls.target);
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
  treeGroup.visible = camera.position.distanceTo(controls.target) < TREE_MAX_DIST;
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
    const d = Math.hypot(((v.x + 1) / 2) * innerWidth - clientX, ((1 - v.y) / 2) * innerHeight - clientY) - (c.state === SUN ? 4 : 0);
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
  $('btn-north').addEventListener('click', () => animateView({ theta: 0 }));
  $('btn-locate').addEventListener('click', locate);

  bindTouch();
  controls.addEventListener('change', () => { constrainView(); requestRender(); });
  addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}

// Two fingers: twisting turns the map, pinching zooms, sliding both fingers up or down tilts.
// Phones report each finger in its own event, so the gesture is judged from the movement since
// the fingers went down, and then locked (as in Google Maps) until a finger lifts.
const GESTURE_START = 12; // px of movement before the gesture is decided
function bindTouch() {
  const pts = new Map();
  let start = null, prev = null, mode = null; // mode: 'tilt' | 'map'
  const read = () => {
    const [a, b] = [...pts.values()];
    return { ax: a.x, bx: b.x, ay: a.y, by: b.y, mid: (a.y + b.y) / 2, angle: Math.atan2(b.y - a.y, b.x - a.x), dist: Math.hypot(b.x - a.x, b.y - a.y) };
  };
  const reset = () => { start = prev = pts.size === 2 ? read() : null; mode = null; };
  const release = (e) => { if (pts.delete(e.pointerId)) reset(); };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    reset();
  });
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pts.size !== 2 || !start) return;
    const cur = read();
    if (!mode) {
      const [a, b] = [...pts.values()];
      const da = cur.ay - start.ay, db = cur.by - start.by;
      const side = Math.max(Math.abs(a.x - start.ax), Math.abs(b.x - start.bx));
      const spread = Math.abs(cur.dist - start.dist);
      const both = Math.min(Math.abs(da), Math.abs(db)) >= GESTURE_START / 2;
      if (both && da * db > 0 && side < Math.min(Math.abs(da), Math.abs(db))) mode = 'tilt';
      else if ((both && da * db < 0) || spread >= GESTURE_START || side >= GESTURE_START || Math.max(Math.abs(da), Math.abs(db)) >= 3 * GESTURE_START) mode = 'map';
      else return;
      prev = start; // apply the movement made while deciding
    }
    const s = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    if (mode === 'tilt') {
      s.phi = Math.min(controls.maxPolarAngle, Math.max(0.01, s.phi - (cur.mid - prev.mid) * 0.006));
    } else {
      s.theta += shortestTurn(cur.angle - prev.angle);
      s.radius = Math.min(controls.maxDistance, Math.max(controls.minDistance, (s.radius * prev.dist) / Math.max(cur.dist, 1)));
    }
    camera.position.setFromSpherical(s).add(controls.target);
    prev = cur;
    requestRender();
  });
}

function showUser(x, y) {
  state.user = { x, y };
  const inside = x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
  userSprite.visible = inside;
  if (inside) {
    userSprite.position.set(x, ground(x, y) + 2, -y);
    animateView({ x, y, maxDist: 700 });
  }
  return inside;
}

function locate() {
  if (!navigator.geolocation) return toast('Preglednik ne podržava lokaciju.');
  $('btn-locate').classList.add('active');
  if (state.user) showUser(state.user.x, state.user.y); // start sliding at once, the fresh fix follows
  navigator.geolocation.getCurrentPosition((p) => {
    $('btn-locate').classList.remove('active');
    const lat0 = geo.lat0 * DEG;
    const x = (p.coords.longitude - geo.lon0) * (111412.84 * Math.cos(lat0) - 93.5 * Math.cos(3 * lat0));
    const y = (p.coords.latitude - geo.lat0) * (111132.92 - 559.82 * Math.cos(2 * lat0) + 1.175 * Math.cos(4 * lat0));
    if (!showUser(x, y)) toast('Izvan si prikazanog područja – udaljenosti se ipak računaju od tebe.');
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
  let treeData;
  [geo, terrain, cafes, treeData] = await Promise.all([load('buildings'), load('terrain'), load('cafes'), load('trees').catch(() => null)]);

  bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const p of geo.parts.slice(0, geo.core)) {
    bounds.minX = Math.min(bounds.minX, p[2][0] / 10); bounds.maxX = Math.max(bounds.maxX, p[2][0] / 10);
    bounds.minY = Math.min(bounds.minY, p[2][1] / 10); bounds.maxY = Math.max(bounds.maxY, p[2][1] / 10);
  }

  const cells = new Map();
  for (const p of geo.parts) {
    const key = Math.floor(p[2][0] / 10 / CHUNK) + ',' + Math.floor(p[2][1] / 10 / CHUNK);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(p);
  }
  const material = new THREE.MeshLambertMaterial({ color: COLORS.building, flatShading: true });
  chunks = [...cells.values()].map((parts) => {
    const mesh = new THREE.Mesh(buildBuildings(parts), material);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.geometry.computeBoundingBox();
    scene.add(mesh);
    return { mesh, box: mesh.geometry.boundingBox };
  });
  const land = new THREE.Mesh(buildTerrain(terrain), new THREE.MeshLambertMaterial({ color: COLORS.ground }));
  land.receiveShadow = true;
  scene.add(land);
  geo.parts = null;

  if (treeData) trees = buildTrees(treeData);
  scene.add(treeGroup);

  for (const c of cafes) {
    c.state = SHADE;
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
  for (const c of chunks) c.bvh = new MeshBVH(c.mesh.geometry);
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
