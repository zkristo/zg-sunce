#!/usr/bin/env python3
"""Build data/cafes.json from OpenStreetMap (Overpass API). Run after build_buildings.py.

OSM café points usually sit inside the building, so every point is moved to the nearest open
spot next to it (street or square) — an approximation of where the terrace is.
Usage:  python3 tools/build_cafes.py
"""
import json
import math
import os
from collections import defaultdict

from common import DATA, Terrain, fetch, to_local, to_lonlat, write_json

OVERPASS = "https://overpass-api.de/api/interpreter"
CELL = 50  # m, spatial index cell
KEEP_CLEARANCE = 1.0  # m: points at least this far from any wall are left where they are
TERRACE_CLEARANCE = 2.5  # m: moved points end up this far from the nearest wall
SEARCH_RADIUS = 30  # m


def load_buildings():
    with open(os.path.join(DATA, "buildings.json"), encoding="utf-8") as f:
        b = json.load(f)
    parts = []
    for p in b["parts"]:
        parts.append([[(r[i] / 10, r[i + 1] / 10) for i in range(0, len(r), 2)] for r in p[2:]])
    return parts, b["core"]


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


def terrace_point(index, x, y):
    """Nearest spot with open space around it; None if the point is buried deep inside a block."""
    clearance, _ = index.nearest(x, y)
    if clearance >= KEEP_CLEARANCE:
        return x, y, False
    for r in range(1, SEARCH_RADIUS + 1):
        n = max(8, int(2 * math.pi * r / 1.5))
        for k in range(n):
            cx, cy = x + r * math.cos(2 * math.pi * k / n), y + r * math.sin(2 * math.pi * k / n)
            if index.nearest(cx, cy)[0] >= TERRACE_CLEARANCE:
                return cx, cy, True
    return None


def main():
    parts, n_core = load_buildings()
    index = Index(parts)
    with open(os.path.join(DATA, "terrain.json"), encoding="utf-8") as f:
        t = json.load(f)
    terrain = Terrain(t["x0"], t["y0"], t["cell"], t["nx"], t["ny"], [v / 10 for v in t["h"]])

    core_pts = [p for rings in parts[:n_core] for p in rings[0]]
    w, s = to_lonlat(min(p[0] for p in core_pts), min(p[1] for p in core_pts))
    e, n = to_lonlat(max(p[0] for p in core_pts), max(p[1] for p in core_pts))
    query = f'[out:json][timeout:120];nwr["amenity"~"^(cafe|bar|pub)$"]({s:.5f},{w:.5f},{n:.5f},{e:.5f});out center tags;'
    with open(fetch(OVERPASS, "cafes.overpass.json", data={"data": query}), encoding="utf-8") as f:
        elements = json.load(f)["elements"]

    cafes, moved, outside_area, buried = [], 0, 0, 0
    for el in elements:
        tags = el.get("tags", {})
        lat = el.get("lat") or el.get("center", {}).get("lat")
        lon = el.get("lon") or el.get("center", {}).get("lon")
        if lat is None or tags.get("access") == "private" or tags.get("outdoor_seating") == "no":
            continue
        x, y = to_local(lon, lat)
        # Only cafés in the displayed districts: the nearest building must be a core one.
        _, near = index.nearest(x, y, reach=3)
        if near is None or near >= n_core:
            outside_area += 1
            continue
        pt = terrace_point(index, x, y)
        if pt is None:
            buried += 1
            continue
        x, y, was_moved = pt
        moved += was_moved
        seating = tags.get("outdoor_seating")
        lon, lat = to_lonlat(x, y)
        cafes.append(
            {
                "id": f'{el["type"][0]}{el["id"]}',
                "name": tags.get("name") or "",
                "type": tags["amenity"],
                "x": round(x, 1),
                "y": round(y, 1),
                "z": round(terrain.at(x, y), 1),
                "lat": round(lat, 6),
                "lon": round(lon, 6),
                "outdoor": seating is not None,
            }
        )
    cafes.sort(key=lambda c: c["id"])
    print(f"  {len(cafes)} cafés ({moved} moved out of buildings), {outside_area} outside the area, {buried} without open space nearby")
    write_json("cafes.json", cafes)


if __name__ == "__main__":
    main()
