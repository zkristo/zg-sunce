#!/usr/bin/env python3
"""Build data/buildings.json and data/terrain.json from the City of Zagreb ZG3D 2022 open data.

Source: https://data.zagreb.hr (ZG3D 2022, building-part footprints with Z_Min / Z_Max).
Usage:  python3 tools/build_buildings.py
"""
import json
import math
from collections import defaultdict

from common import LAT0, LON0, Terrain, fetch, to_local, write_json

CKAN = "https://data.zagreb.hr/api/3/action/package_show?id="
# All 17 city districts (gradske četvrti) of Zagreb.
DISTRICTS = [
    "zg3d-gradska-cetvrt-donji-grad-2022",
    "zg3d-gradska-cetvrt-gornji-grad-2022",
    "zg3d-gradska-cetvrt-trnje-2022",
    "zg3d-gradska-cetvrt-maksimir-2022",
    "zg3d-gradska-cetvrt-pescenica-zitnjak-2022",
    "zg3d-gradska-cetvrt-novi-zagreb-istok-2022",
    "zg3d-gradska-cetvrt-novi-zagreb-zapad-2022",
    "zg3d-gradska-cetvrt-tresnjevka-sjever-2022",
    "zg3d-gradska-cetvrt-tresnjevka-jug-2022",
    "zg3d-gradska-cetvrt-crnomerec-2022",
    "zg3d-gradska-cetvrt-gornja-dubrava-2022",
    "zg3d-gradska-cetvrt-donja-dubrava-2022",
    "zg3d-gradska-cetvrt-stenjevec-2022",
    "zg3d-gradska-cetvrt-podsused-vrapce-2022",
    "zg3d-gradska-cetvrt-podsljeme-2022",
    "zg3d-gradska-cetvrt-sesvete",
    "zg3d-gradska-cetvrt-brezovica-2022",
]
MIN_HEIGHT = 2.0  # m
MIN_AREA = 4.0  # m2
TERRAIN_CELL = 40  # m
TERRAIN_RADIUS = 120  # m


def load_district(slug):
    with open(fetch(CKAN + slug, slug + ".meta.json"), encoding="utf-8") as f:
        resources = json.load(f)["result"]["resources"]
    url = next(r["url"] for r in resources if (r.get("format") or "").lower() == "geojson")
    with open(fetch(url, slug + ".geojson"), encoding="utf-8") as f:
        return json.load(f)["features"]


def simplify(ring):
    """Project a lon/lat ring to local metres; drop the closing point, near-duplicates and collinear points."""
    pts = []
    for c in ring[:-1] if ring[0][:2] == ring[-1][:2] else ring:
        p = to_local(c[0], c[1])
        if not pts or math.dist(p, pts[-1]) > 0.2:
            pts.append(p)
    if len(pts) > 1 and math.dist(pts[0], pts[-1]) <= 0.2:
        pts.pop()
    changed = True
    while changed and len(pts) > 3:
        changed = False
        for i in range(len(pts)):
            a, b, c = pts[i - 1], pts[i], pts[(i + 1) % len(pts)]
            cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            if abs(cross) / (math.dist(a, c) or 1e-9) < 0.1:
                del pts[i]
                changed = True
                break
    return pts


def area(pts):
    return 0.5 * sum(pts[i - 1][0] * pts[i][1] - pts[i][0] * pts[i - 1][1] for i in range(len(pts)))


def parts_of(features):
    """Yield (rings, z_min, z_max): outer ring first (CCW), then holes (CW)."""
    for f in features:
        g, p = f.get("geometry"), f["properties"]
        if not g or p.get("Z_Min") is None or p.get("Z_Max") is None:
            continue
        if p["Z_Max"] - p["Z_Min"] < MIN_HEIGHT:
            continue
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        for poly in polys:
            outer = simplify(poly[0])
            if len(outer) < 3 or abs(area(outer)) < MIN_AREA:
                continue
            # A few records carry a huge bounding rectangle instead of the footprint;
            # a footprint larger than the model's whole surface area is impossible.
            if p.get("SArea") and abs(area(outer)) > p["SArea"]:
                continue
            if area(outer) < 0:
                outer.reverse()
            rings = [outer]
            for hole in poly[1:]:
                h = simplify(hole)
                if len(h) >= 3 and abs(area(h)) >= MIN_AREA:
                    if area(h) > 0:
                        h.reverse()
                    rings.append(h)
            yield rings, p["Z_Min"], p["Z_Max"]


def centroid(ring):
    return sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)


def build_terrain(parts):
    """Ground elevation grid: a low percentile of nearby Z_Min values (robust against roof-level parts)."""
    xs = [p for rings, _, _ in parts for p in rings[0]]
    x0 = min(p[0] for p in xs) - 2 * TERRAIN_CELL
    y0 = min(p[1] for p in xs) - 2 * TERRAIN_CELL
    nx = int((max(p[0] for p in xs) - x0) / TERRAIN_CELL) + 4
    ny = int((max(p[1] for p in xs) - y0) / TERRAIN_CELL) + 4

    buckets = defaultdict(list)
    for rings, zmin, _ in parts:
        cx, cy = centroid(rings[0])
        buckets[(int((cx - x0) // TERRAIN_RADIUS), int((cy - y0) // TERRAIN_RADIUS))].append((cx, cy, zmin))

    h = [None] * (nx * ny)
    for j in range(ny):
        for i in range(nx):
            x, y = x0 + i * TERRAIN_CELL, y0 + j * TERRAIN_CELL
            bi, bj = int((x - x0) // TERRAIN_RADIUS), int((y - y0) // TERRAIN_RADIUS)
            near = sorted(
                z
                for di in (-1, 0, 1)
                for dj in (-1, 0, 1)
                for (cx, cy, z) in buckets.get((bi + di, bj + dj), ())
                if (cx - x) ** 2 + (cy - y) ** 2 < TERRAIN_RADIUS**2
            )
            if len(near) >= 3:
                h[j * nx + i] = near[len(near) // 4]

    # Fill cells without buildings from their neighbours, then smooth.
    empty = [v is None for v in h]
    while any(v is None for v in h):
        nxt = h[:]
        for j in range(ny):
            for i in range(nx):
                if h[j * nx + i] is None:
                    vals = [
                        h[jj * nx + ii]
                        for ii, jj in ((i - 1, j), (i + 1, j), (i, j - 1), (i, j + 1))
                        if 0 <= ii < nx and 0 <= jj < ny and h[jj * nx + ii] is not None
                    ]
                    if vals:
                        nxt[j * nx + i] = sum(vals) / len(vals)
        h = nxt
    # Filled cells get many more passes: the fill leaves ridges that show up under a low sun.
    for step in range(40):
        nxt = h[:]
        for j in range(ny):
            for i in range(nx):
                if step >= 2 and not empty[j * nx + i]:
                    continue
                vals = [
                    h[jj * nx + ii]
                    for ii in (i - 1, i, i + 1)
                    for jj in (j - 1, j, j + 1)
                    if 0 <= ii < nx and 0 <= jj < ny
                ]
                nxt[j * nx + i] = sum(vals) / len(vals)
        h = nxt
    return Terrain(x0, y0, TERRAIN_CELL, nx, ny, h)


def main():
    print("Loading districts")
    parts = []
    for slug in DISTRICTS:
        n = len(parts)
        parts.extend(parts_of(load_district(slug)))
        print(f"  {slug}: {len(parts) - n} parts")
    core = parts

    print("Building terrain")
    terrain = build_terrain(parts)
    z0 = math.floor(min(terrain.h))

    def dm(v):
        return round(v * 10)

    out, skipped = [], 0
    n_core = 0
    for idx, (rings, zmin, zmax) in enumerate(parts):
        ground = terrain.at(*centroid(rings[0]))
        if zmax < ground + 1.5:
            skipped += 1
            continue
        # Walls start below the ground so nothing floats on slopes.
        base = min(zmin, ground) - 3
        out.append([dm(base - z0), dm(zmax - z0)] + [[dm(v) for p in ring for v in p] for ring in rings])
        if idx < len(core):
            n_core += 1
    print(f"  {len(out)} parts kept, {skipped} below ground skipped, {sum(len(r) // 2 for p in out for r in p[2:])} vertices")

    # parts: [base_dm, top_dm, outer_ring, hole, ...]; rings are flat [x, y, ...] in decimetres,
    # x = east, y = north of the origin; heights are decimetres above z0. The first `core` parts
    # belong to the displayed districts (now all of them), the rest would be shadow casters around them.
    write_json("buildings.json", {"lat0": LAT0, "lon0": LON0, "z0": z0, "core": n_core, "parts": out})
    write_json(
        "terrain.json",
        {"x0": terrain.x0, "y0": terrain.y0, "cell": terrain.cell, "nx": terrain.nx, "ny": terrain.ny, "z0": z0, "h": [dm(v - z0) for v in terrain.h]},
    )


if __name__ == "__main__":
    main()
