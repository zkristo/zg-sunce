import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import SunCalc from 'suncalc';

// Scene coordinates: X = east, Y = up (metres above data z0), Z = south. Data files use x = east, y = north.

const DEG = Math.PI / 180;
const STEP = 5 * 60 * 1000; // slider / schedule resolution
const EYE = 1.2; // m above ground where a terrace is tested for sun
const CHUNK = 600; // m, buildings are split into square chunks so off-screen ones are skipped
const TERRAIN_TILE = 50; // terrain cells (2 km) per ground tile
// Detailed 3D buildings (real roofs), streamed per chunk from the tiles site (tools/build_tiles.py).
const TILES_URL = new URLSearchParams(location.search).get('tiles') || 'https://zkristo.github.io/zg-sunce-tiles/v3/';
const DETAIL_NEAR = 1000; // m from the camera to a chunk in view: load and show its detailed buildings ...
const DETAIL_AROUND = 300; // ... or to any chunk, in view or not, so turning around does not show blocks
const DETAIL_FAR = 1300; // back to blocks beyond this (the gap stops flickering at the edge)
const FAR_LEVEL = 3000; // m: further chunks draw only their big blocks and cast no shadows
const DETAIL_PARALLEL = 4; // downloads at a time
const DETAIL_BUDGET = matchMedia('(pointer: coarse)').matches ? 1.5e6 : 3e6; // triangles of detail kept in memory
const COLORS = { tree: 0xb1c2ab, evergreen: 0x8fa692, building: 0xcfd2d6, ground: 0xe6e8ea, day: 0xe9edf2, night: 0x161b26, dusk: 0xf1dcc8, sunWarm: 0xffdcb8 };
const SHADE = 0, TREE = 1, SUN = 2; // state of a terrace
const STATE_NAME = ['shade', 'tree', 'sun'];
const LEAF_ON = [415, 1031]; // deciduous trees carry leaves from 15 April to 31 October
const TREE_CELL = 25; // m, lookup grid for the tree shade test
const TREE_REACH = 250; // m, how far towards the sun a tree can still shade a terrace
const TREE_MAX_DIST = 2000; // m, trees are not drawn when the camera is further away
const DETAIL_MAX_DIST = 4000; // m, tram tracks and streams are not drawn when the camera is further away
// Map overlays drawn on the ground: colour, lift above the terrain (m), polygon offset (draw order).
const OVERLAY = { // colour, lift above the terrain (m), polygon offset (more negative = drawn on top)
  water: [0xa9bccb, 0.25, -2],
  square: [0xd6d9dd, 0.3, -3],
  path: [0xd2d5d9, 0.32, -3.5],
  road: [0xc4c8cd, 0.35, -4],
  stream: [0xa9bccb, 0.4, -5],
  tram: [0xa2a7ad, 0.45, -6],
  rail: [0x8d939b, 0.5, -7],
};
const LINE_OVERLAY = { rail: 'rail', tram: 'tram', stream: 'stream', path: 'path' }; // all other line classes are roads
const AREA_OVERLAY = ['water', 'square']; // area kinds in map.json
// Parks and woods colour the ground itself (data/landcover.bin, painted by tools/build_map.py).
const LAND_COLORS = { green: 0xd5ddcf, wood: 0xc6d1bf };
const RIBBON_SAMPLE = 5; // m, ribbons test the terrain this often ...
const RIBBON_TOLERANCE = 0.1; // m, ... and keep a vertex where leaving it out would cut more than this
const AREA_STEP = { water: 60, square: 30 }; // m, longest triangle edge in area fills
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
  ready: false, // map loaded, sun tests possible
  toastUntil: 0,
};

let geo, terrain, cafes, bounds;
let chunks; // building meshes, one per CHUNK square
let trees = null; // { n, x, y, z, rh, rv, evergreen, grid } — crowns are ellipsoids centred at (x, y, z)
const treeGroup = new THREE.Group();
const treeMats = {
  leaf: new THREE.MeshLambertMaterial({ color: COLORS.tree, flatShading: true, shadowSide: THREE.FrontSide }),
  bare: new THREE.MeshLambertMaterial({ color: COLORS.tree, flatShading: true, transparent: true, opacity: 0.22, depthWrite: false }),
  evergreen: new THREE.MeshLambertMaterial({ color: COLORS.evergreen, flatShading: true, shadowSide: THREE.FrontSide }),
};
const deciduousMeshes = [];
const buildingMaterial = new THREE.MeshLambertMaterial({ color: COLORS.building, flatShading: true, shadowSide: THREE.FrontSide });
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
// One finger and the left mouse button pan in bindPan, which keeps the grabbed spot under the pointer.
controls.touches.ONE = null;
controls.mouseButtons.LEFT = null;

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

// Once a buffer is on the GPU nothing reads it in JavaScript any more (no raycasts), so the copy is dropped.
function releaseArray() { this.array = null; }

// data/buildings.bin and data/terrain.bin (layout in tools/common.py): a 4-byte tag, the header length,
// a JSON header, then little-endian arrays that are used in place.
function readBinary(buf, tag) {
  const text = new TextDecoder();
  if (text.decode(new Uint8Array(buf, 0, 4)) !== tag) throw new Error(tag);
  const length = new DataView(buf).getUint32(4, true);
  return { header: JSON.parse(text.decode(new Uint8Array(buf, 8, length))), start: 8 + length };
}

// One chunk of buildings: every part is a prism (bottom and top vertices, walls, roof triangulated offline).
// Positions stay 16-bit decimetres relative to the chunk origin; the mesh is scaled and moved into place.
function buildBuildings(buf, [x0, y0, nParts, nRings, nVerts, nTris, offset, nBig = 0, nLandmark = 0]) {
  const heights = new Int16Array(buf, offset, 2 * nParts);
  const coords = new Int16Array(buf, offset + 4 * nParts, 2 * nVerts);
  const u8 = new Uint8Array(buf, offset + 4 * nParts + 4 * nVerts, 2 * nParts + nRings + 3 * nTris);
  const SIZES = nParts, ROOFS = nParts + nRings, ROOF = 2 * nParts + nRings;
  const pos = new Int16Array(nVerts * 6);
  const index = new Uint16Array(nVerts * 6 + nTris * 3);
  let v = 0, r = 0, k = 0, t = ROOF, ii = 0, bigEnd = 0, ordinaryEnd = 0;
  for (let p = 0; p < nParts; p++) {
    // Parts come big first, then small, then landmarks (tools/common.py): note where each group ends.
    if (p === nBig) bigEnd = ii;
    if (p === nParts - nLandmark) ordinaryEnd = ii;
    const base = heights[2 * p], top = heights[2 * p + 1];
    let n = 0;
    for (let q = 0; q < u8[p]; q++) n += u8[SIZES + r + q];
    let o = v;
    for (let q = 0; q < u8[p]; q++, r++) {
      const len = u8[SIZES + r];
      let x = 0, y = 0;
      for (let m = 0; m < len; m++, k++) {
        x += coords[2 * k];
        y += coords[2 * k + 1];
        const a = o + m, b = o + ((m + 1) % len);
        pos[3 * a] = pos[3 * (a + n)] = x;
        pos[3 * a + 1] = base;
        pos[3 * (a + n) + 1] = top;
        pos[3 * a + 2] = pos[3 * (a + n) + 2] = -y;
        index[ii++] = a; index[ii++] = b; index[ii++] = b + n;
        index[ii++] = a; index[ii++] = b + n; index[ii++] = a + n;
      }
      o += len;
    }
    for (let q = 0; q < 3 * u8[ROOFS + p]; q++) index[ii++] = v + n + u8[t++];
    v += 2 * n;
  }
  if (nBig >= nParts) bigEnd = ii;
  if (nLandmark === 0) ordinaryEnd = ii;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3).onUpload(releaseArray));
  g.setIndex(new THREE.BufferAttribute(index, 1).onUpload(releaseArray));
  g.computeBoundingSphere(); // for culling, before the arrays are released
  const mesh = new THREE.Mesh(g, buildingMaterial);
  mesh.position.set(x0 / 10, 0, -y0 / 10);
  mesh.scale.setScalar(0.1);
  mesh.userData = { bigEnd, ordinaryEnd, end: ii };
  return mesh;
}

// Height of the terrain mesh itself (its triangles, not the smoothed lookup of ground()),
// so overlays can lie exactly on it.
function terrainAt(x, y) {
  const t = terrain;
  const fx = Math.min(Math.max((x - t.x0) / t.cell, 0), t.nx - 1.001);
  const fy = Math.min(Math.max((y - t.y0) / t.cell, 0), t.ny - 1.001);
  const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
  const a = t.h[j * t.nx + i], b = t.h[j * t.nx + i + 1], c = t.h[(j + 1) * t.nx + i], d = t.h[(j + 1) * t.nx + i + 1];
  return (tx >= ty ? a + (b - a) * tx + (d - b) * ty : a + (d - c) * tx + (c - a) * ty) / 10;
}

// Parks and woods: the ground shader looks up the landcover grid (0 ground, 128 park, 255 wood; blended between
// cells) and tints itself, so they cost no triangles.
function paintLand(material, buf) {
  const { header: h, start } = readBinary(buf, 'ZGL1');
  const tex = new THREE.DataTexture(new Uint8Array(buf, start, h.nx * h.ny), h.nx, h.ny, THREE.RedFormat, THREE.UnsignedByteType);
  tex.unpackAlignment = 1;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.landcover = { value: tex };
    shader.uniforms.landBox = { value: new THREE.Vector4(h.x0, h.y0, h.nx * h.cell, h.ny * h.cell) };
    shader.uniforms.landGreen = { value: new THREE.Color(LAND_COLORS.green) };
    shader.uniforms.landWood = { value: new THREE.Color(LAND_COLORS.wood) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec4 landBox;\nvarying vec2 vLand;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLand = vec2((position.x - landBox.x) / landBox.z, (-position.z - landBox.y) / landBox.w);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D landcover;\nuniform vec3 landGreen;\nuniform vec3 landWood;\nvarying vec2 vLand;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float land = texture2D(landcover, vLand).r;
        diffuseColor.rgb = land < 0.5 ? mix(diffuseColor.rgb, landGreen, land * 2.0) : mix(landGreen, landWood, land * 2.0 - 1.0);`);
  };
}

// The ground in square tiles, so the tiles off screen are skipped like building chunks. Normals come from the
// whole height grid (not tile by tile), so the shading has no seams at tile edges.
function buildTerrain(t, land) {
  const group = new THREE.Group();
  const material = new THREE.MeshLambertMaterial({ color: COLORS.ground });
  if (land) paintLand(material, land);
  const h = (i, j) => t.h[Math.min(Math.max(j, 0), t.ny - 1) * t.nx + Math.min(Math.max(i, 0), t.nx - 1)] / 10;
  for (let j0 = 0; j0 < t.ny - 1; j0 += TERRAIN_TILE) {
    for (let i0 = 0; i0 < t.nx - 1; i0 += TERRAIN_TILE) {
      const w = Math.min(TERRAIN_TILE, t.nx - 1 - i0) + 1, d = Math.min(TERRAIN_TILE, t.ny - 1 - j0) + 1;
      const pos = new Float32Array(w * d * 3), normal = new Float32Array(w * d * 3);
      const index = new Uint16Array((w - 1) * (d - 1) * 6);
      let k = 0;
      for (let b = 0; b < d; b++) {
        for (let a = 0; a < w; a++) {
          const i = i0 + a, j = j0 + b, v = (b * w + a) * 3;
          const ex = (h(i + 1, j) - h(i - 1, j)) / (2 * t.cell), ny = (h(i, j + 1) - h(i, j - 1)) / (2 * t.cell);
          const len = Math.hypot(ex, 1, ny);
          pos[v] = t.x0 + i * t.cell;
          pos[v + 1] = h(i, j);
          pos[v + 2] = -(t.y0 + j * t.cell);
          normal[v] = -ex / len;
          normal[v + 1] = 1 / len;
          normal[v + 2] = ny / len;
          if (a < w - 1 && b < d - 1) {
            // Same diagonal as terrainAt(): triangles (i, j)(i+1, j)(i+1, j+1) and (i, j)(i+1, j+1)(i, j+1).
            const p = b * w + a;
            index.set([p, p + 1, p + w + 1, p, p + w + 1, p + w], k);
            k += 6;
          }
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3).onUpload(releaseArray));
      g.setAttribute('normal', new THREE.BufferAttribute(normal, 3).onUpload(releaseArray));
      g.setIndex(new THREE.BufferAttribute(index, 1).onUpload(releaseArray));
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, material);
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
  return group;
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

// ---------- map overlays: water, squares, roads, railways ----------

const overlayGroups = {};
for (const kind of Object.keys(OVERLAY)) overlayGroups[kind] = new THREE.Group();

// Polyline -> flat strip on the terrain. Bridges run straight between the heights at their ends.
function addRibbon(out, xy, half, lift, bridge) {
  // Extra vertices only where the terrain bends under a segment (flat streets keep their two ends).
  const pts = [];
  for (let k = 0; k + 2 < xy.length; k += 2) {
    const [x0, y0, x1, y1] = [xy[k], xy[k + 1], xy[k + 2], xy[k + 3]];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / RIBBON_SAMPLE));
    const h = [];
    for (let i = 0; i <= n; i++) h.push(terrainAt(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n));
    const keep = new Uint8Array(n + 1);
    keep[0] = 1;
    const split = (a, b) => {
      let worst = 0, at = -1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs(h[i] - (h[a] + ((h[b] - h[a]) * (i - a)) / (b - a)));
        if (d > worst) { worst = d; at = i; }
      }
      if (worst > RIBBON_TOLERANCE) { keep[at] = 1; split(a, at); split(at, b); }
    };
    split(0, n);
    for (let i = 0; i < n; i++) if (keep[i]) pts.push([x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
  }
  pts.push([xy[xy.length - 2], xy[xy.length - 1]]);
  const h0 = terrainAt(...pts[0]), h1 = terrainAt(...pts[pts.length - 1]);
  const side = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let nx = -(b[1] - a[1]), ny = b[0] - a[0];
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    // Mitre: widen at bends so the strip keeps its width (limited at sharp corners).
    let m = 1;
    if (i > 0 && i < pts.length - 1) {
      const dx = pts[i][0] - a[0], dy = pts[i][1] - a[1], dl = Math.hypot(dx, dy) || 1;
      m = 1 / Math.max(0.5, Math.abs((-dy / dl) * nx + (dx / dl) * ny));
    }
    const h = bridge ? h0 + ((h1 - h0) * i) / (pts.length - 1) + 1 : null;
    for (const s of [1, -1]) {
      const x = pts[i][0] + s * nx * half * m, y = pts[i][1] + s * ny * half * m;
      side.push(x, (h ?? terrainAt(x, y)) + lift, -y);
    }
  }
  for (let i = 0; i + 1 < pts.length; i++) {
    const l0 = 6 * i, r0 = l0 + 3, l1 = l0 + 6, r1 = l0 + 9;
    for (const v of [l0, r0, l1, r0, r1, l1]) out.push(side[v], side[v + 1], side[v + 2]);
  }
}

// Normal of the ground at (x, y), as the terrain tiles shade it (from the whole height grid), so overlays are lit
// exactly like the ground under them instead of showing every triangle.
function terrainNormal(x, y) {
  const t = terrain, c = t.cell;
  const fx = Math.min(Math.max((x - t.x0) / c, 0), t.nx - 1), fy = Math.min(Math.max((y - t.y0) / c, 0), t.ny - 1);
  const i = Math.round(fx), j = Math.round(fy);
  const h = (a, b) => t.h[Math.min(Math.max(b, 0), t.ny - 1) * t.nx + Math.min(Math.max(a, 0), t.nx - 1)] / 10;
  const ex = (h(i + 1, j) - h(i - 1, j)) / (2 * c), ny = (h(i, j + 1) - h(i, j - 1)) / (2 * c);
  const len = Math.hypot(ex, 1, ny);
  return [-ex / len, 1 / len, ny / len];
}

function insideRing(x, y, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    if ((ring[i + 1] > y) !== (ring[j + 1] > y) && x < ring[j] + ((y - ring[j + 1]) * (ring[i] - ring[j])) / (ring[i + 1] - ring[j + 1])) c = !c;
  }
  return c;
}

// Polygon with holes -> triangles on the terrain, split until no edge is longer than AREA_STEP.
function addArea(out, rings, lift, step) {
  const [outer, ...holes] = rings;
  const kept = [outer, ...holes.filter((h) => insideRing(h[0], h[1], outer))];
  const toVec = (r) => { const v = []; for (let k = 0; k < r.length; k += 2) v.push(new THREE.Vector2(r[k], r[k + 1])); return v; };
  const vecs = kept.map(toVec);
  const verts = vecs.flat().map((p) => [p.x, p.y]);
  let tris = THREE.ShapeUtils.triangulateShape(vecs[0], vecs.slice(1)).flat();
  const L2 = step * step;
  const long = (a, b) => (verts[a][0] - verts[b][0]) ** 2 + (verts[a][1] - verts[b][1]) ** 2 > L2;
  for (let pass = 0; pass < 12; pass++) {
    // An edge is split exactly when it is long, so both triangles sharing it agree (no cracks).
    const mids = new Map(), next = [];
    const mid = (a, b) => {
      const key = a < b ? a * 4194304 + b : b * 4194304 + a;
      if (!mids.has(key)) { mids.set(key, verts.length); verts.push([(verts[a][0] + verts[b][0]) / 2, (verts[a][1] + verts[b][1]) / 2]); }
      return mids.get(key);
    };
    for (let t = 0; t < tris.length; t += 3) {
      const v = [tris[t], tris[t + 1], tris[t + 2]];
      const L = [long(v[0], v[1]), long(v[1], v[2]), long(v[2], v[0])];
      const n = L.filter(Boolean).length;
      if (n === 0) next.push(...v);
      else if (n === 3) {
        const x = mid(v[0], v[1]), y = mid(v[1], v[2]), z = mid(v[2], v[0]);
        next.push(v[0], x, z, x, v[1], y, z, y, v[2], x, y, z);
      } else if (n === 1) {
        const i = L.indexOf(true), a = v[i], b = v[(i + 1) % 3], c = v[(i + 2) % 3], x = mid(a, b);
        next.push(a, x, c, x, b, c);
      } else {
        const i = L.indexOf(false), c = v[i], a = v[(i + 1) % 3], b = v[(i + 2) % 3]; // short edge c-a
        const x = mid(a, b), y = mid(b, c);
        next.push(a, x, y, a, y, c, x, b, y);
      }
    }
    if (next.length === tris.length) break;
    tris = next;
  }
  for (const k of tris) out.push(verts[k][0], terrainAt(verts[k][0], verts[k][1]) + lift, -verts[k][1]);
}

function buildMap(data) {
  const buckets = new Map(); // kind|chunk -> positions
  const bucket = (kind, x, y) => {
    const key = kind + '|' + Math.floor(x / CHUNK) + ',' + Math.floor(y / CHUNK);
    if (!buckets.has(key)) buckets.set(key, []);
    return buckets.get(key);
  };
  for (const [kind, ...rings] of data.areas) {
    const name = AREA_OVERLAY[kind];
    const r = rings.map((ring) => ring.map((v) => v / 10));
    addArea(bucket(name, r[0][0], r[0][1]), r, OVERLAY[name][1], AREA_STEP[name]);
  }
  for (const [cls, bridge, ...coords] of data.lines) {
    const [name, width] = data.classes[cls];
    const kind = LINE_OVERLAY[name] || 'road';
    const xy = coords.map((v) => v / 10);
    addRibbon(bucket(kind, xy[0], xy[1]), xy, width / 20, OVERLAY[kind][1] + (bridge ? 0.05 : 0), bridge);
  }
  for (const [key, pos] of buckets) {
    const kind = key.split('|')[0];
    const [color, , units] = OVERLAY[kind];
    const g = new THREE.BufferGeometry();
    const positions = new Float32Array(pos), normals = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i += 3) normals.set(terrainNormal(pos[i], -pos[i + 2]), i);
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    const mesh = new THREE.Mesh(g, overlayMaterial(color, units));
    mesh.receiveShadow = true;
    g.computeBoundingSphere();
    overlayGroups[kind].add(mesh);
  }
  for (const group of Object.values(overlayGroups)) scene.add(group);
}

const overlayMats = new Map();
function overlayMaterial(color, units) {
  if (!overlayMats.has(color + ':' + units)) {
    overlayMats.set(color + ':' + units, new THREE.MeshLambertMaterial({
      color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: units,
    }));
  }
  return overlayMats.get(color + ':' + units);
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
scene.add(markers, ringSprite, userSprite);

// Dot sizes in CSS pixels, the same for every café in a state, and growing as the camera comes closer.
const pxScale = (px) => (px / innerHeight) * 2 * Math.tan((camera.fov * DEG) / 2);
const DOT_PX = [11, 12, 15]; // shade, tree, sun at the reference zoom
const DOT_ZOOM_REF = 700; // m from camera to pivot where dots have DOT_PX
const DOT_ZOOM_RANGE = [0.3, 1.8]; // smallest and largest factor on DOT_PX
let dotZoom = 0;
const zoomFactor = () => Math.min(DOT_ZOOM_RANGE[1], Math.max(DOT_ZOOM_RANGE[0], Math.sqrt(DOT_ZOOM_REF / camera.position.distanceTo(controls.target))));
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

function sunAt(date) {
  const p = SunCalc.getPosition(date, geo.lat0, geo.lon0);
  const bearing = p.azimuth + Math.PI; // SunCalc: 0 = south, positive towards west
  const ch = Math.cos(p.altitude);
  return { alt: p.altitude, leaf: leafOn(date), dir: new THREE.Vector3(Math.sin(bearing) * ch, Math.sin(p.altitude), -Math.cos(bearing) * ch) };
}

// Buildings and terrain: each café carries its skyline (tools/skyline.py), the highest angle above the
// horizon that roofs or the ground reach in every degree of compass direction, in half degrees.
function sunlit(cafe, s) {
  if (s.alt <= 0) return false;
  const azimuth = (Math.atan2(s.dir.x, -s.dir.z) / DEG + 360) % 360;
  return s.alt / DEG > cafe.sky[Math.floor(azimuth) % 360] / 2;
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
  // Sun-facing sides cast the shadows (shadowSide: FrontSide on the materials), so the caster is
  // a building's thickness away from the ground behind it and shadows start right at the wall base.
  // A depth bias of one shadow texel keeps the lit faces themselves free of self-shadowing; a normal
  // bias is avoided because it shortens shadows on the ground at low sun.
  const texel = (2 * size) / sun.shadow.mapSize.x;
  sun.shadow.bias = -texel / (2 * depth);
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
      // Cafés from Overture Maps (id "o…") have no OpenStreetMap page.
      c.id[0] === 'o' ? '' : el('a', { href: `https://www.openstreetmap.org/${{ n: 'node', w: 'way', r: 'relation' }[c.id[0]]}/${c.id.slice(1)}`, target: '_blank', rel: 'noopener' }, 'OpenStreetMap')),
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
  ringSprite.position.copy(cafe.pos);
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
  fling = null;
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

function frame() {
  requestAnimationFrame(frame);
  stepTimeTween();
  stepFling();
  stepTween();
  controls.update();
  if (!needsRender) return;
  needsRender = false;
  updateShadowFrustum();
  if (cafes && Math.abs(zoomFactor() - dotZoom) > 0.01) styleMarkers();
  updateDetail();
  const camDist = camera.position.distanceTo(controls.target);
  treeGroup.visible = camDist < TREE_MAX_DIST;
  overlayGroups.tram.visible = overlayGroups.stream.visible = camDist < DETAIL_MAX_DIST;
  overlayGroups.path.visible = camDist < TREE_MAX_DIST;
  renderer.render(scene, camera);
  $('needle').style.transform = `rotate(${controls.getAzimuthalAngle()}rad)`;
}

// ---------- detailed buildings ----------
//
// Blocks are always loaded. Chunks near the camera are swapped for the real 3D model once their tile has arrived;
// further away (or while a tile is loading, or if it fails) the blocks stay, so there are never holes.

const blockChunks = new Map(); // "i_j" → block mesh
const detail = new Map(); // "i_j" → { mesh, tris, used, ctrl }
let tileIndex = null; // "i_j" → [bytes, triangles]
let landmarksShown = false; // detailed landmarks loaded: block chunks leave their landmark parts out
let detailCheck = { t: 0, x: NaN, y: NaN, z: NaN };
const viewFrustum = new THREE.Frustum(), viewMatrix = new THREE.Matrix4(), chunkBox = new THREE.Box3();

async function loadTileIndex(z0) {
  try {
    const index = await (await fetch(TILES_URL + 'index.json')).json();
    if (index.z0 !== z0) return; // built for other building data: heights would not match
    tileIndex = index.tiles;
    requestRender();
    if (index.landmarks) loadLandmarks();
  } catch { /* no detailed buildings; the blocks stay */ }
}

// The landmarks (cathedral, Cibona, TE-TO chimneys, …): always in full detail, one mesh per chunk.
async function loadLandmarks() {
  try {
    const buf = await (await fetch(TILES_URL + 'landmarks.bin')).arrayBuffer();
    const { header, start } = readBinary(buf, 'ZGM1');
    for (const [x0, y0, verts, tris, bits, offset] of header.meshes) {
      const mesh = detailMesh(buf, start + offset, { x0, y0, verts, tris, index: bits });
      mesh.visible = true;
      scene.add(mesh);
    }
    landmarksShown = true;
    detailCheck.t = 0;
    requestRender();
  } catch { /* the landmarks stay blocks */ }
}

function chunkDistance(key) {
  const [i, j] = key.split('_').map(Number), p = camera.position;
  const x0 = i * CHUNK, z1 = -j * CHUNK; // chunk spans x0..x0+CHUNK east and z1-CHUNK..z1 south
  const dx = Math.max(x0 - p.x, 0, p.x - x0 - CHUNK), dz = Math.max(z1 - CHUNK - p.z, 0, p.z - z1);
  return Math.hypot(dx, Math.max(0, p.y - ground(p.x, -p.z) - 150), dz); // roofs stand below ~150 m
}

// Is the chunk (with a margin) in the camera's view? Heights cover the ground from the Sava to Sljeme.
function chunkInView(key) {
  const [i, j] = key.split('_').map(Number), m = 100;
  chunkBox.min.set(i * CHUNK - m, -50, -(j + 1) * CHUNK - m);
  chunkBox.max.set((i + 1) * CHUNK + m, 1200, -j * CHUNK + m);
  return viewFrustum.intersectsBox(chunkBox);
}

// Far chunks keep only their big blocks and cast no shadows; landmarks are left out once shown in detail.
function styleBlocks() {
  for (const [key, mesh] of blockChunks) {
    const far = chunkDistance(key) > FAR_LEVEL, d = mesh.userData;
    mesh.geometry.setDrawRange(0, far ? d.bigEnd : landmarksShown ? d.ordinaryEnd : d.end);
    mesh.castShadow = !far;
  }
}

function updateDetail() {
  const p = camera.position, now = performance.now();
  if (now - detailCheck.t < 250 && Math.hypot(p.x - detailCheck.x, p.y - detailCheck.y, p.z - detailCheck.z) < 20) return;
  detailCheck = { t: now, x: p.x, y: p.y, z: p.z };
  styleBlocks();
  if (!tileIndex) return;
  camera.updateMatrixWorld();
  viewFrustum.setFromProjectionMatrix(viewMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const wanted = [];
  let loading = 0;
  for (const key of Object.keys(tileIndex)) {
    const d = chunkDistance(key), have = detail.get(key);
    // Loaded tiles stay up to DETAIL_FAR (off-screen ones are skipped by the renderer anyway); new ones load
    // only in view within DETAIL_NEAR, or anywhere within DETAIL_AROUND.
    const want = have ? d < DETAIL_FAR : d < DETAIL_AROUND || (d < DETAIL_NEAR && chunkInView(key));
    if (have) {
      if (have.ctrl && !want) { have.ctrl.abort(); detail.delete(key); continue; }
      if (have.ctrl) { loading++; continue; }
      if (want) have.used = now;
      have.mesh.visible = want;
      const block = blockChunks.get(key);
      if (block) block.visible = !want;
    } else if (want) {
      wanted.push([d, key]);
    }
  }
  wanted.sort((a, b) => a[0] - b[0]);
  for (const [, key] of wanted.slice(0, Math.max(0, DETAIL_PARALLEL - loading))) loadTile(key);
  trimDetail();
}

async function loadTile(key) {
  const ctrl = new AbortController(), entry = { ctrl, tris: tileIndex[key][1], used: performance.now() };
  detail.set(key, entry);
  try {
    const buf = await (await fetch(`${TILES_URL}${key}.bin`, { signal: ctrl.signal })).arrayBuffer();
    const { header, start } = readBinary(buf, 'ZGD1');
    const mesh = detailMesh(buf, start, header);
    mesh.visible = false; // updateDetail decides
    scene.add(mesh);
    entry.mesh = mesh;
    entry.ctrl = null;
  } catch {
    detail.delete(key); // aborted or failed: the block stays
  }
  detailCheck.t = 0; // look again right away
  requestRender();
}

// Detailed buildings of one chunk (tile or landmark file): Int16 positions in decimetres from the chunk origin, then
// 16- or 32-bit indices; uploaded as they are and dropped from JavaScript afterwards.
function detailMesh(buf, at, { x0, y0, verts, tris, index: bits }) {
  const pos = new Int16Array(buf, at, verts * 3);
  const after = at + Math.ceil((verts * 6) / 4) * 4;
  const index = bits === 32 ? new Uint32Array(buf, after, tris * 3) : new Uint16Array(buf, after, tris * 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3).onUpload(releaseArray));
  g.setIndex(new THREE.BufferAttribute(index, 1).onUpload(releaseArray));
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, buildingMaterial);
  mesh.position.set(x0 / 10, 0, -y0 / 10);
  mesh.scale.setScalar(0.1);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

// Keep the detail that is not on screen only while it fits in the triangle budget, least recently used first out.
function trimDetail() {
  let total = 0;
  for (const e of detail.values()) total += e.tris;
  if (total <= DETAIL_BUDGET) return;
  const idle = [...detail].filter(([, e]) => e.mesh && !e.mesh.visible).sort((a, b) => a[1].used - b[1].used);
  for (const [key, e] of idle) {
    if (total <= DETAIL_BUDGET) break;
    scene.remove(e.mesh);
    e.mesh.geometry.dispose();
    detail.delete(key);
    total -= e.tris;
  }
}

// ---------- interaction ----------

function pick(clientX, clientY) {
  const v = new THREE.Vector3();
  let best = null, bestD = coarse ? 30 : 20;
  for (const c of cafes) {
    v.copy(c.pos).project(camera);
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
    timeTween = null;
    state.live = false;
    state.time = new Date(state.day.start + e.target.value * STEP);
    applyTime();
  });
  $('clock').addEventListener('click', backToNow);
  $('btn-list').addEventListener('click', () => openPanel(state.panel === 'list' ? null : 'list'));
  $('btn-info').addEventListener('click', () => openPanel(state.panel === 'info' ? null : 'info'));
  $('panel-close').addEventListener('click', () => openPanel(null));
  $('btn-north').addEventListener('click', () => animateView({ theta: 0 }));
  $('btn-locate').addEventListener('click', locate);

  bindTouch();
  bindPan();
  trackLayout();
  controls.addEventListener('change', () => { constrainView(); requestRender(); });
  addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}

// Two fingers: twisting turns the map, pinching zooms, sliding both fingers up or down tilts.
// Phones report each finger in its own event, so the gesture is judged from the movement since
// the fingers went down, and then locked (as in Google Maps) until a finger lifts.
const GESTURE_START = 6; // px each finger must move before the gesture is decided
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
      const va = [a.x - start.ax, a.y - start.ay], vb = [b.x - start.bx, b.y - start.by];
      const la = Math.hypot(...va), lb = Math.hypot(...vb);
      // Pinching moves the fingers along the line between them; a finger running ahead of the
      // other (common when tilting) moves across it.
      const ux = (start.bx - start.ax) / start.dist, uy = (start.by - start.ay) / start.dist;
      const pinch = Math.abs((vb[0] - va[0]) * ux + (vb[1] - va[1]) * uy);
      const upDown = (v) => Math.abs(v[1]) > Math.abs(v[0]);
      if (Math.min(la, lb) >= GESTURE_START) {
        // Both fingers have moved: tilt if both went mostly up or both mostly down, without pinching.
        const tilt = upDown(va) && upDown(vb) && va[1] * vb[1] > 0 && pinch < Math.max(Math.abs(va[1]), Math.abs(vb[1]));
        mode = tilt ? 'tilt' : 'map';
      } else if (pinch >= 3 * GESTURE_START || Math.max(la, lb) >= 16 * GESTURE_START) {
        mode = 'map'; // a clear pinch, or turning around a finger that stays put
      } else return;
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

// Panning as in Google Maps: the spot on the ground under the finger (or mouse) stays under it while dragging,
// and a flick keeps the map gliding for a moment after letting go.
const FLING_FRICTION = 300; // ms, time for a fling to slow to about a third
let fling = null; // { vx, vz, t }: m per ms, last step
function bindPan() {
  const pointers = new Set();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const caster = new THREE.Raycaster();
  const hit = new THREE.Vector3();
  let grab = null, track = [];
  const groundAt = (e) => {
    caster.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
    const p = caster.ray.intersectPlane(plane, hit);
    // Near the horizon the ground point runs away to infinity; ignore those.
    return p && p.distanceTo(camera.position) < 20 * camera.position.distanceTo(controls.target) ? p.clone() : null;
  };
  const start = (e) => {
    plane.constant = -controls.target.y;
    grab = groundAt(e);
    track = [];
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.add(e.pointerId);
    fling = null;
    if (pointers.size === 1) start(e);
    else grab = null; // two fingers: bindTouch turns and zooms
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pointers.size !== 1 || !pointers.has(e.pointerId)) return;
    if (!grab) return start(e); // the finger left after lifting the other one grabs again where it is
    const p = groundAt(e);
    if (!p) return;
    const dx = grab.x - p.x, dz = grab.z - p.z;
    controls.target.x += dx;
    controls.target.z += dz;
    camera.position.x += dx;
    camera.position.z += dz;
    constrainView();
    requestRender();
    track.push({ t: e.timeStamp, x: controls.target.x, z: controls.target.z }); // when the finger moved, not when handled
    if (track.length > 6) track.shift();
  });
  const end = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size) {
      grab = null;
      return;
    }
    // Speed over the last ~150 ms of movement, if the finger was still moving when it lifted.
    const now = e.timeStamp, last = track[track.length - 1], first = track.find((s) => now - s.t < 150);
    if (grab && last && first && now - last.t < 80 && last.t > first.t) {
      let vx = (last.x - first.x) / (last.t - first.t), vz = (last.z - first.z) / (last.t - first.t);
      const max = 0.004 * camera.position.distanceTo(controls.target), speed = Math.hypot(vx, vz);
      if (speed > max) { vx *= max / speed; vz *= max / speed; }
      fling = { vx, vz, t: performance.now() };
    }
    grab = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

function stepFling() {
  if (!fling) return;
  const now = performance.now(), dt = Math.min(now - fling.t, 50), k = Math.exp(-dt / FLING_FRICTION);
  fling.t = now;
  const move = FLING_FRICTION * (1 - k); // distance covered over dt while the speed decays
  controls.target.x += fling.vx * move;
  controls.target.z += fling.vz * move;
  camera.position.x += fling.vx * move;
  camera.position.z += fling.vz * move;
  fling.vx *= k;
  fling.vz *= k;
  constrainView();
  requestRender();
  if (Math.hypot(fling.vx, fling.vz) * 16 < 0.0005 * camera.position.distanceTo(controls.target)) fling = null;
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
  const get = (name) => fetch(`data/${name}`).then((r) => { if (!r.ok) throw new Error(name); return r; });
  const load = (name) => get(`${name}.json`).then((r) => r.json());
  const loadBinary = (name) => get(`${name}.bin`).then((r) => r.arrayBuffer());
  let buildingData, terrainData, treeData, mapData, landData;
  [buildingData, terrainData, cafes, treeData, mapData, landData] = await Promise.all([
    loadBinary('buildings'), loadBinary('terrain'), load('cafes'), load('trees').catch(() => null), load('map').catch(() => null),
    loadBinary('landcover').catch(() => null),
  ]);

  const b = readBinary(buildingData, 'ZGB1');
  geo = { lat0: b.header.lat0, lon0: b.header.lon0 };
  const [minX, minY, maxX, maxY] = b.header.bounds;
  bounds = { minX, minY, maxX, maxY };
  chunks = b.header.chunks.map((chunk) => {
    const mesh = buildBuildings(buildingData, chunk);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    blockChunks.set(`${chunk[0] / CHUNK / 10}_${chunk[1] / CHUNK / 10}`, mesh);
    return mesh;
  });
  loadTileIndex(b.header.z0);

  const t = readBinary(terrainData, 'ZGT1');
  terrain = { ...t.header, h: new Int16Array(terrainData, t.start, t.header.nx * t.header.ny) };
  scene.add(buildTerrain(terrain, landData));

  if (treeData) trees = buildTrees(treeData);
  if (mapData) buildMap(mapData);
  scene.add(treeGroup);

  for (const c of cafes) {
    c.sky = Uint8Array.from(atob(c.sky), (ch) => ch.charCodeAt(0));
    c.state = SHADE;
    c.pos = new THREE.Vector3(c.x, c.z + 2, -c.y);
  }

  controls.target.set(0, ground(0, 0), 0);
  camera.position.set(-260, controls.target.y + 560, 760);
  state.ready = true;
  markers.visible = true;
  bindUI();
  resize();
  tick(true);
  frame();
  $('loading').hidden = true;

  setInterval(tick, 10000);
  updateCloud();
  setInterval(updateCloud, 15 * 60 * 1000);
}

main().catch((e) => {
  console.error(e);
  $('loading').textContent = 'Greška pri učitavanju karte. Pokušaj osvježiti stranicu.';
});
