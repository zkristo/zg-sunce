"""Shared helpers for the data tools: local projection, cached downloads, terrain lookup, building index."""
import json
import math
import os
import time
import urllib.parse
import urllib.request
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
    """Regular grid of ground elevations with bilinear lookup (same layout as data/terrain.json)."""

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


def load_buildings():
    with open(os.path.join(DATA, "buildings.json"), encoding="utf-8") as f:
        b = json.load(f)
    parts = []
    for p in b["parts"]:
        parts.append([[(r[i] / 10, r[i + 1] / 10) for i in range(0, len(r), 2)] for r in p[2:]])
    return parts, b["core"]



def load_building_tops():
    """Roof height of every part in load_buildings() order, in m above z0 (the datum of data/terrain.json)."""
    with open(os.path.join(DATA, "buildings.json"), encoding="utf-8") as f:
        return [p[1] / 10 for p in json.load(f)["parts"]]

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
