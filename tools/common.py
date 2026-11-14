"""Shared helpers for the data tools: local projection, cached downloads, terrain lookup."""
import json
import math
import os
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "tools", "cache")
DATA = os.path.join(ROOT, "data")

# Scene origin (Trg bana Jelačića). Local metres: x = east, y = north.
LAT0, LON0 = 45.8131, 15.9772
_phi = math.radians(LAT0)
M_PER_DEG_LAT = 111132.92 - 559.82 * math.cos(2 * _phi) + 1.175 * math.cos(4 * _phi)
M_PER_DEG_LON = 111412.84 * math.cos(_phi) - 93.5 * math.cos(3 * _phi)

USER_AGENT = "zg-sunce-data-tools/1.0"


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
