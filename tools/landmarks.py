#!/usr/bin/env python3
"""Pick the landmark buildings that the app shows in full 3D detail from any distance; writes data/landmarks.json.

A ZG3D building is a landmark if it is at least TALL metres high (Z_Max − Z_Min), or if its footprint holds an
OpenStreetMap building that is notable: one with a Wikidata link, a cathedral, church or chapel, or a chimney or
tower (the cathedral, Cibona, the TE-TO chimneys, HNK, St Mark's, …).
Usage:  python3 tools/landmarks.py      (run before build_buildings.py and build_tiles.py)
"""
import json
from collections import defaultdict

from build_buildings import DISTRICTS, load_district
from common import CELL, inside, load_terrain, overpass, seg_dist, to_local, to_lonlat, write_json

TALL = 40  # m
NEAR = 10  # m: an OSM point just outside a footprint (courtyard, arcade) still counts for that building


def notable_points():
    """(x, y, name) of notable OSM buildings in the map area."""
    t = load_terrain()
    w, s = to_lonlat(t["x0"], t["y0"])
    e, n = to_lonlat(t["x0"] + (t["nx"] - 1) * t["cell"], t["y0"] + (t["ny"] - 1) * t["cell"])
    bb = f"{s:.5f},{w:.5f},{n:.5f},{e:.5f}"
    query = f"""[out:json][timeout:180];
(
  way["building"]["wikidata"]({bb});
  relation["building"]["wikidata"]({bb});
  way["building"~"^(cathedral|church|chapel)$"]({bb});
  way["man_made"~"^(chimney|tower)$"]({bb});
  node["man_made"~"^(chimney|tower)$"]["height"]({bb});
);
out center tags;"""
    with open(overpass(query, "landmarks.overpass.json"), encoding="utf-8") as f:
        elements = json.load(f)["elements"]
    points = []
    for el in elements:
        c = el.get("center") or el
        if "lat" in c:
            points.append((*to_local(c["lon"], c["lat"]), el.get("tags", {}).get("name", "")))
    return points


def main():
    points = notable_points()
    grid = defaultdict(list)  # 50 m cell -> [(slug, OBJECTID, rings)]
    chosen, names = defaultdict(set), []
    for slug in DISTRICTS:
        for f in load_district(slug):
            g, p = f.get("geometry"), f["properties"]
            if not g:
                continue
            if p.get("Z_Max") is not None and p.get("Z_Min") is not None and p["Z_Max"] - p["Z_Min"] >= TALL:
                chosen[slug].add(p["OBJECTID"])
            polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
            for poly in polys:
                rings = [[to_local(c[0], c[1]) for c in ring] for ring in poly]
                xs, ys = [q[0] for q in rings[0]], [q[1] for q in rings[0]]
                for i in range(int(min(xs) // CELL), int(max(xs) // CELL) + 1):
                    for j in range(int(min(ys) // CELL), int(max(ys) // CELL) + 1):
                        grid[(i, j)].append((slug, p["OBJECTID"], rings))
    tall = sum(map(len, chosen.values()))
    matched = 0
    for x, y, name in points:
        best, best_d = None, NEAR
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for slug, oid, rings in grid.get((int(x // CELL) + di, int(y // CELL) + dj), ()):
                    if inside(x, y, rings):
                        best, best_d = (slug, oid), 0
                        break
                    d = min(seg_dist(x, y, r[k - 1], r[k]) for r in rings for k in range(len(r)))
                    if d < best_d:
                        best, best_d = (slug, oid), d
        if best:
            matched += best[1] not in chosen[best[0]]
            chosen[best[0]].add(best[1])
            if name:
                names.append(name)
    total = sum(map(len, chosen.values()))
    print(f"  {tall} buildings ≥ {TALL} m, {len(points)} notable OSM buildings adding {matched} more: {total} landmarks")
    print("  e.g. " + ", ".join(sorted(set(names))[:25]))
    write_json("landmarks.json", {"tall_m": TALL, "districts": {slug: sorted(ids) for slug, ids in sorted(chosen.items())}})


if __name__ == "__main__":
    main()
