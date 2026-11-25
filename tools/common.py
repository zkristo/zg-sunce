"""Shared helpers for the data tools: local projection, cached downloads, terrain lookup, building index."""
import functools
import gzip
import json
import math
import os
import struct
import sys
import time
import urllib.parse
import urllib.request
from array import array
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "tools", "cache")
DATA = os.path.join(ROOT, "data")

# Scene origin (Trg bana Jelačića). Local metres: x = east, y = north.
LAT0, LON0 = 45.8131, 15.9772
_phi = math.radians(LAT0)
M_PER_DEG_LAT = 111132.92 - 559.82 * math.cos(2 * _phi) + 1.175 * math.cos(4 * _phi)
M_PER_DEG_LON = 111412.84 * math.cos(_phi) - 93.5 * math.cos(3 * _phi)

USER_AGENT = "zg-sunce-data-tools/1.0"
CELL = 50  # m, spatial index cell


def to_local(lon, lat):
    return (lon - LON0) * M_PER_DEG_LON, (lat - LAT0) * M_PER_DEG_LAT


def to_lonlat(x, y):
    return LON0 + x / M_PER_DEG_LON, LAT0 + y / M_PER_DEG_LAT


def fetch(url, cache_name, data=None, timeout=180):
    """Download url into tools/cache/ (once) and return the local path."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, cache_name)
    if not os.path.exists(path):
        body = urllib.parse.urlencode(data).encode() if data else None
        req = urllib.request.Request(url, data=body, headers={"User-Agent": USER_AGENT})
        print(f"  downloading {cache_name} ...")
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r, open(path + ".part", "wb") as f:
                    while chunk := r.read(1 << 16):
                        f.write(chunk)
                break
            except OSError as e:  # the open data portal returns the odd 502
                if attempt == 3:
                    raise
                print(f"    {e}; retrying")
                time.sleep(5 * 2**attempt)
        os.replace(path + ".part", path)
    return path


# Public Overpass API servers, tried in order: the main one is not reachable from every network
# (GitHub Actions machines, for one).
OVERPASS_SERVERS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]


def overpass(query, cache_name, timeout=180):
    """Run an Overpass query (cached like fetch) on the first server that answers."""
    for i, url in enumerate(OVERPASS_SERVERS):
        try:
            return fetch(url, cache_name, data={"data": query}, timeout=timeout)
        except OSError as e:
            if i == len(OVERPASS_SERVERS) - 1:
                raise
            print(f"  {url} failed ({e}); trying the next Overpass server")


def write_json(name, obj):
    os.makedirs(DATA, exist_ok=True)
    path = os.path.join(DATA, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)
    print(f"  wrote data/{name}: {os.path.getsize(path) / 1024:.0f} KB")


class Terrain:
    """Regular grid of ground elevations with bilinear lookup (same layout as data/terrain.bin)."""

    def __init__(self, x0, y0, cell, nx, ny, h):
        self.x0, self.y0, self.cell, self.nx, self.ny, self.h = x0, y0, cell, nx, ny, h

    def at(self, x, y):
        fx = min(max((x - self.x0) / self.cell, 0), self.nx - 1.001)
        fy = min(max((y - self.y0) / self.cell, 0), self.ny - 1.001)
        i, j = int(fx), int(fy)
        tx, ty = fx - i, fy - j
        h, nx = self.h, self.nx
        a = h[j * nx + i] * (1 - tx) + h[j * nx + i + 1] * tx
        b = h[(j + 1) * nx + i] * (1 - tx) + h[(j + 1) * nx + i + 1] * tx
        return a * (1 - ty) + b * ty


# ---------- the map's buildings and ground ----------
#
# They come from the published 3D map (zagreb-dedede), the same files the app shows, so the café skylines always
# match the map. Layouts are described in zagreb-dedede's tools/common.py: buildings.bin ("ZGB1") and terrain.bin
# ("ZGT1"), each a 4-byte tag, a Uint32 header length, a JSON header and little-endian arrays, stored gzipped.

MAP_DATA = "https://zagreb-dedede.zvonimir-kristo.workers.dev/data/"
MAP_DATA_AGE = 12 * 3600  # s: a cached copy older than this is downloaded again


def _map_file(name):
    """Bytes of a binary map data file, downloaded (and joined from parts, see parts.json) into tools/cache/."""
    def fresh(file):
        path = os.path.join(CACHE, "map_" + file)
        if os.path.exists(path) and time.time() - os.path.getmtime(path) > MAP_DATA_AGE:
            os.remove(path)
        return fetch(MAP_DATA + file, "map_" + file)

    with open(fresh("parts.json"), encoding="utf-8") as f:
        n = json.load(f).get(name, 1)
    packed = b""
    for k in range(n):
        with open(fresh(f"{name}.gz" + (f".{k}" if n > 1 else "")), "rb") as f:
            packed += f.read()
    return gzip.decompress(packed)


def _unpack(name, tag):
    data = _map_file(name)
    if data[:4] != tag:
        raise ValueError(f"{name} is not a {tag.decode()} file")
    (n,) = struct.unpack_from("<I", data, 4)
    return json.loads(data[8 : 8 + n]), data, 8 + n


@functools.lru_cache(maxsize=1)
def _read_buildings():
    header, data, _ = _unpack("buildings.bin", b"ZGB1")
    parts, tops = [], []
    for x0, y0, n_parts, n_rings, n_verts, n_tris, off, *_ in header["chunks"]:
        heights = array("h", data[off : off + 4 * n_parts])
        coords = array("h", data[off + 4 * n_parts : off + 4 * n_parts + 4 * n_verts])
        if sys.byteorder != "little":
            heights.byteswap()
            coords.byteswap()
        u8 = data[off + 4 * n_parts + 4 * n_verts :]
        sizes_at, r, k = n_parts, 0, 0
        for p in range(n_parts):
            rings = []
            for _ in range(u8[p]):
                ring, x, y = [], x0, y0
                for m in range(u8[sizes_at + r]):
                    x, y = x + coords[2 * k], y + coords[2 * k + 1]
                    ring.append((x / 10, y / 10))
                    k += 1
                rings.append(ring)
                r += 1
            parts.append(rings)
            tops.append(heights[2 * p + 1] / 10)
    return header, parts, tops


def load_buildings():
    """(parts, n_core): footprints as lists of rings of (x, y) in m. All parts belong to the displayed area."""
    _, parts, _ = _read_buildings()
    return parts, len(parts)


def load_building_tops():
    """Roof height of every part in load_buildings() order, in m above z0 (the datum of the terrain)."""
    return _read_buildings()[2]


def load_terrain():
    """{x0, y0, cell, nx, ny, z0, h}: h in decimetres above z0, row by row from the south-west corner."""
    header, data, start = _unpack("terrain.bin", b"ZGT1")
    h = array("h", data[start : start + 2 * header["nx"] * header["ny"]])
    if sys.byteorder != "little":
        h.byteswap()
    return {**header, "h": h.tolist()}


def core_bbox(parts, n_core):
    """(west, south, east, north) in degrees around the displayed districts' buildings."""
    pts = [p for rings in parts[:n_core] for p in rings[0]]
    w, s = to_lonlat(min(p[0] for p in pts), min(p[1] for p in pts))
    e, n = to_lonlat(max(p[0] for p in pts), max(p[1] for p in pts))
    return w, s, e, n


def seg_dist(px, py, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    t = ((px - a[0]) * dx + (py - a[1]) * dy) / ((dx * dx + dy * dy) or 1e-9)
    t = min(1, max(0, t))
    return math.hypot(px - a[0] - t * dx, py - a[1] - t * dy)


def inside(px, py, rings):
    """Even-odd test over all rings, so holes (courtyards) count as outside."""
    c = False
    for ring in rings:
        for i in range(len(ring)):
            (x1, y1), (x2, y2) = ring[i - 1], ring[i]
            if (y1 > py) != (y2 > py) and px < x1 + (py - y1) * (x2 - x1) / (y2 - y1):
                c = not c
    return c


class Index:
    def __init__(self, parts):
        self.parts = parts
        self.grid = defaultdict(list)
        for idx, rings in enumerate(parts):
            xs, ys = [p[0] for p in rings[0]], [p[1] for p in rings[0]]
            for i in range(int(min(xs) // CELL), int(max(xs) // CELL) + 1):
                for j in range(int(min(ys) // CELL), int(max(ys) // CELL) + 1):
                    self.grid[(i, j)].append(idx)

    def nearest(self, x, y, reach=1):
        """(signed clearance, part index): clearance is negative inside a building."""
        ci, cj = int(x // CELL), int(y // CELL)
        best, best_idx, is_inside = math.inf, None, False
        for idx in {k for di in range(-reach, reach + 1) for dj in range(-reach, reach + 1) for k in self.grid.get((ci + di, cj + dj), ())}:
            rings = self.parts[idx]
            d = min(seg_dist(x, y, ring[i - 1], ring[i]) for ring in rings for i in range(len(ring)))
            if d < best:
                best, best_idx = d, idx
            is_inside = is_inside or inside(x, y, rings)
        return (-best if is_inside else best), best_idx

    def covers(self, x, y):
        """True if the point lies inside any footprint."""
        return any(inside(x, y, self.parts[idx]) for idx in self.grid.get((int(x // CELL), int(y // CELL)), ()))
