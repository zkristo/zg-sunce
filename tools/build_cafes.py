#!/usr/bin/env python3
"""Build data/cafes.json from OpenStreetMap (Overpass API). Run after build_buildings.py.

OSM café points usually sit inside the building, so every point is moved to the nearest open
spot next to it (street or square) — an approximation of where the terrace is.
Usage:  python3 tools/build_cafes.py
"""
import json
import math
import os

from common import DATA, Index, Terrain, fetch, load_buildings, to_local, to_lonlat, write_json

OVERPASS = "https://overpass-api.de/api/interpreter"
KEEP_CLEARANCE = 1.0  # m: points at least this far from any wall are left where they are
TERRACE_CLEARANCE = 2.5  # m: moved points end up this far from the nearest wall
SEARCH_RADIUS = 30  # m
# Cafés just outside the displayed districts are kept too: the model has buildings 300 m beyond
# the district edge, so within this margin there are still enough shadow casters around them.
EDGE_MARGIN = 100  # m


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
    core = Index(parts[:n_core])
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
        # Only cafés in or right next to the displayed districts.
        _, near = index.nearest(x, y, reach=3)
        if near is None or (near >= n_core and abs(core.nearest(x, y, reach=2)[0]) > EDGE_MARGIN):
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
