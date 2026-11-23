#!/usr/bin/env python3
"""Build data/buildings.bin and data/terrain.bin from the City of Zagreb ZG3D 2022 open data.

Roofs are triangulated here (tools/earcut.py), so the browser only has to copy the data to the GPU.
The file layout is described in tools/common.py.

Source: https://data.zagreb.hr (ZG3D 2022, building-part footprints with Z_Min / Z_Max).
Usage:  python3 tools/build_buildings.py
"""
import json
import math
from collections import defaultdict

from common import LAT0, LON0, M_PER_DEG_LAT, M_PER_DEG_LON, Terrain, feature_anchor, fetch, pack_buildings, pack_terrain, to_local, write_binary
from earcut import earcut

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
# Away from buildings the ground comes from the Copernicus DEM GLO-30 (30 m, free; © DLR e.V. 2010-2014 and
# © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA).
DEM_URL = "https://copernicus-dem-30m.s3.amazonaws.com/{0}/{0}.tif"
DEM_TILES = ["Copernicus_DSM_COG_10_N45_00_E015_00_DEM", "Copernicus_DSM_COG_10_N45_00_E016_00_DEM"]
DEM_NEAR, DEM_FAR = 300, 600  # m from the nearest buildings: blend from building-based ground to the DEM
PIT = 5  # m: building-based ground this far below the lowest DEM point around is a basement, not the ground


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
    """Yield (rings, z_min, z_max, anchor): outer ring first (CCW), then holes (CW); anchor decides the chunk."""
    for f in features:
        g, p = f.get("geometry"), f["properties"]
        if not g or p.get("Z_Min") is None or p.get("Z_Max") is None:
            continue
        if p["Z_Max"] - p["Z_Min"] < MIN_HEIGHT:
            continue
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        anchor = feature_anchor(g)
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
            yield rings, p["Z_Min"], p["Z_Max"], anchor


def roof_triangles(rings):
    """Roof triangles of a part (flat decimetre rings) as part-local vertex indices, counter-clockwise from above."""
    coords = [v for r in rings for v in r]
    holes, n = [], 0
    for r in rings[:-1]:
        n += len(r) // 2
        holes.append(n)
    tris = earcut(coords, holes)
    for t in range(0, len(tris), 3):
        a, b, c = tris[t : t + 3]
        if (coords[2 * b] - coords[2 * a]) * (coords[2 * c + 1] - coords[2 * a + 1]) - (coords[2 * b + 1] - coords[2 * a + 1]) * (coords[2 * c] - coords[2 * a]) < 0:
            tris[t + 1], tris[t + 2] = c, b
    return tris


def centroid(ring):
    return sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)


def _window(a, op):
    """3 × 3 neighbourhood of every cell (edges repeated): op = np.minimum / np.maximum, or None for the mean."""
    import numpy as np

    pad = np.pad(a, 1, mode="edge")
    views = [pad[1 + dj : pad.shape[0] - 1 + dj, 1 + di : pad.shape[1] - 1 + di] for dj in (-1, 0, 1) for di in (-1, 0, 1)]
    if op is None:
        return sum(views) / 9
    out = views[0]
    for v in views[1:]:
        out = op(out, v)
    return out


def dem_grid(x0, y0, nx, ny):
    """Copernicus GLO-30 surface heights at the terrain grid points (bilinear)."""
    import numpy as np
    import rasterio

    lon = LON0 + (x0 + np.arange(nx) * TERRAIN_CELL) / M_PER_DEG_LON
    lat = LAT0 + (y0 + np.arange(ny) * TERRAIN_CELL) / M_PER_DEG_LAT
    lo, la = np.meshgrid(lon, lat)
    out = np.full((ny, nx), np.nan)
    for tile in DEM_TILES:
        with rasterio.open(fetch(DEM_URL.format(tile), tile + ".tif", timeout=600)) as r:
            a = r.read(1).astype(np.float64)
            col, row = ~r.transform * (lo, la)
            col, row = col - 0.5, row - 0.5  # relative to pixel centres
            inside = (col >= -0.5) & (col <= r.width - 0.5) & (row >= -0.5) & (row <= r.height - 0.5) & np.isnan(out)
            c, rr = np.clip(col[inside], 0, r.width - 1), np.clip(row[inside], 0, r.height - 1)
            c0 = np.minimum(np.floor(c).astype(int), r.width - 2)
            r0 = np.minimum(np.floor(rr).astype(int), r.height - 2)
            fc, fr = c - c0, rr - r0
            out[inside] = (a[r0, c0] * (1 - fc) * (1 - fr) + a[r0, c0 + 1] * fc * (1 - fr)
                           + a[r0 + 1, c0] * (1 - fc) * fr + a[r0 + 1, c0 + 1] * fc * fr)
    if np.isnan(out).any():
        raise ValueError("terrain grid reaches beyond the downloaded DEM tiles")
    return out


def build_terrain(parts):
    """Ground elevation grid. Near buildings: a low percentile of nearby Z_Min values (robust against roof-level
    parts), with basement pits fixed from the DEM; far from buildings: the Copernicus DEM, blended in between."""
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

    import numpy as np

    B = np.array([np.nan if v is None else v for v in h]).reshape(ny, nx)
    built = ~np.isnan(B)
    surface = dem_grid(x0, y0, nx, ny)  # includes roofs and treetops
    low = _window(surface, np.minimum)  # lowest point within ±1 cell: the streets and yards in between
    ground = _window(low, np.maximum)  # "opening": buildings and trees narrower than ~120 m gone, slopes kept
    # Z_Min of deep underground parts drags the building-based ground into pits; the DEM knows better there.
    pits = built & (B < low - PIT)
    B[pits] = low[pits]

    # Fill cells without buildings from their neighbours, noting how far (in cells) each is from buildings.
    steps = np.where(built, 0, -1)
    k = 0
    while np.isnan(B).any():
        k += 1
        pad = np.pad(B, 1, constant_values=np.nan)
        near = np.stack([pad[1:-1, :-2], pad[1:-1, 2:], pad[:-2, 1:-1], pad[2:, 1:-1]])
        count = (~np.isnan(near)).sum(axis=0)
        fresh = np.isnan(B) & (count > 0)
        B[fresh] = (np.nansum(near, axis=0) / np.maximum(count, 1))[fresh]
        steps[fresh] = k
    # Filled cells get many more passes: the fill leaves ridges that show up under a low sun.
    for step in range(40):
        smooth = _window(B, None)
        B = np.where(built & (step >= 2), B, smooth)

    # Far from buildings (Medvednica, fields, the Sava outside the city) the DEM takes over; the median difference
    # where both exist (vertical datum, leftovers of buildings in the 30 m pixels) is taken off first.
    offset = np.median((B - ground)[built])
    dem = ground + offset
    for _ in range(2):
        dem = _window(dem, None)
    t = np.clip((steps * TERRAIN_CELL - DEM_NEAR) / (DEM_FAR - DEM_NEAR), 0, 1)
    w = t * t * (3 - 2 * t)
    h = (B * (1 - w) + dem * w).ravel().tolist()
    print(f"  {pits.sum()} basement pits fixed, DEM offset {offset:+.1f} m, {(w > 0).sum()} of {nx * ny} cells use the DEM")
    return Terrain(x0, y0, TERRAIN_CELL, nx, ny, h)


def main():
    print("Loading districts")
    parts = []
    for slug in DISTRICTS:
        n = len(parts)
        parts.extend(parts_of(load_district(slug)))
        print(f"  {slug}: {len(parts) - n} parts")

    print("Building terrain")
    terrain = build_terrain([p[:3] for p in parts])
    z0 = math.floor(min(terrain.h))

    def dm(v):
        return round(v * 10)

    out, anchors, skipped = [], [], 0
    for rings, zmin, zmax, anchor in parts:
        ground = terrain.at(*centroid(rings[0]))
        if zmax < ground + 1.5:
            skipped += 1
            continue
        # Walls start below the ground so nothing floats on slopes.
        base = min(zmin, ground) - 3
        out.append([dm(base - z0), dm(zmax - z0)] + [[dm(v) for p in ring for v in p] for ring in rings])
        anchors.append(anchor)
    print(f"  {len(out)} parts kept, {skipped} below ground skipped, {sum(len(r) // 2 for p in out for r in p[2:])} vertices")

    # parts: [base_dm, top_dm, outer_ring, hole, ...]; rings are flat [x, y, ...] in decimetres,
    # x = east, y = north of the origin; heights are decimetres above z0.
    write_binary("buildings.bin", pack_buildings(out, anchors, LAT0, LON0, z0, roof_triangles))
    header = {"x0": terrain.x0, "y0": terrain.y0, "cell": terrain.cell, "nx": terrain.nx, "ny": terrain.ny, "z0": z0}
    write_binary("terrain.bin", pack_terrain(header, [dm(v - z0) for v in terrain.h]))


if __name__ == "__main__":
    main()
