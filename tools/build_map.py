#!/usr/bin/env python3
"""Build data/map.json (water, roads, footpaths, railways) and data/landcover.bin (parks and woods) from OpenStreetMap.
Run after build_buildings.py.

Parks and woods are not drawn as shapes (woods alone would be millions of triangles over the hills): they are painted
into a 10 m grid that the ground shader uses for its colour. landcover.bin: "ZGL2", Uint32 header length, JSON header
{x0, y0, cell, nx, ny, scale} padded to 4 bytes, then two Uint8 per cell row by row from the south-west corner:
signed distances to the edge of any green (park, grass or wood) and of wood, 128 + scale × metres, positive inside
(the shader draws the edge where the interpolated distance crosses zero, so outlines are smooth, not stepped).

Everything is drawn flat on the terrain, so only outlines and centrelines are stored.
Usage:  python3 tools/build_map.py
"""
import json
import math
from collections import Counter

from common import _pack, load_terrain, overpass, to_local, to_lonlat, write_binary, write_json

SIMPLIFY = 0.5  # m, Douglas-Peucker tolerance

# Line classes: (name, drawn width in m). Order is the order in data/map.json "classes".
CLASSES = [
    ("motorway", 16), ("trunk", 14), ("primary", 12), ("secondary", 10), ("tertiary", 8),
    ("link", 7), ("street", 6), ("pedestrian", 5), ("rail", 3), ("tram", 2.4), ("stream", 3), ("path", 2),
]
CLASS_ID = {name: i for i, (name, _) in enumerate(CLASSES)}
HIGHWAY = {
    "motorway": "motorway", "trunk": "trunk", "primary": "primary", "secondary": "secondary",
    "tertiary": "tertiary", "unclassified": "street", "residential": "street", "living_street": "street",
    "pedestrian": "pedestrian", "footway": "path", "path": "path", "cycleway": "path", "steps": "path",
    "bridleway": "path",
}
AREA_WATER, AREA_PEDESTRIAN, AREA_GREEN, AREA_WOOD = 0, 1, 2, 3
AREA_NAME = {AREA_WATER: "water area", AREA_PEDESTRIAN: "pedestrian area", AREA_GREEN: "green area", AREA_WOOD: "wood"}
GREEN_SIMPLIFY = 1.5  # m: park and wood outlines need less detail than water and squares
LAND_CELL = 10  # m, landcover grid (≤ 4096 cells a side, the largest texture every phone takes)
LAND_VALUE = {AREA_GREEN: 128, AREA_WOOD: 255}
LAND_FINE = 2  # m: areas are painted this finely to measure the distance to their edges
LAND_SCALE = 9  # distance-field steps per metre: a byte holds ±14 m around the edge (a cell diagonal)
LAND_BLOCK = 256  # landcover cells per side of a block painted at a time


def rasterize(shapes, box, cell=LAND_CELL, size=None):
    """Paint [(value, [ring, ...]), ...] (rings in m; holes by even-odd) into a Uint8 grid of cell-sized cells
    (size = (nx, ny), by default enough to cover the box)."""
    import numpy as np

    LAND_CELL = cell
    nx, ny = size or (math.ceil((box[2] - box[0]) / LAND_CELL), math.ceil((box[3] - box[1]) / LAND_CELL))
    grid = np.zeros((ny, nx), np.uint8)
    for value, rings in shapes:
        a = np.concatenate([np.asarray(r, dtype=np.float64) for r in rings])
        b = np.concatenate([np.roll(np.asarray(r, dtype=np.float64), -1, axis=0) for r in rings])
        j0 = max(0, int((a[:, 1].min() - box[1]) // LAND_CELL))
        j1 = min(ny - 1, int((a[:, 1].max() - box[1]) // LAND_CELL))
        for j in range(j0, j1 + 1):
            yc = box[1] + (j + 0.5) * LAND_CELL
            cross = (a[:, 1] <= yc) != (b[:, 1] <= yc)
            if not cross.any():
                continue
            xa, ya, xb, yb = a[cross, 0], a[cross, 1], b[cross, 0], b[cross, 1]
            xs = np.sort(xa + (yc - ya) * (xb - xa) / (yb - ya))
            for left, right in zip(xs[::2], xs[1::2]):
                i0 = max(0, math.ceil((left - box[0]) / LAND_CELL - 0.5))
                i1 = min(nx - 1, math.floor((right - box[0]) / LAND_CELL - 0.5))
                if i1 >= i0:
                    grid[j, i0 : i1 + 1] = value
    return grid


def distance_field(shapes, box):
    """Landcover as two signed distance fields on the LAND_CELL grid, (ny, nx, 2) Uint8: channel 0 for any green
    (park or wood), channel 1 for wood; 128 + LAND_SCALE × metres to the nearest edge, positive inside. The app
    draws the edge where the interpolated value crosses 128, so outlines stay smooth and straight between cells."""
    import numpy as np
    from scipy.ndimage import distance_transform_edt

    nx, ny = math.ceil((box[2] - box[0]) / LAND_CELL), math.ceil((box[3] - box[1]) / LAND_CELL)
    if max(nx, ny) > 4096:
        raise ValueError("landcover grid larger than 4096 cells; raise LAND_CELL")
    out = np.zeros((ny, nx, 2), np.uint8)
    k = LAND_CELL // LAND_FINE
    margin = math.ceil(128 / LAND_SCALE / LAND_CELL) + 1  # cells: the distances that fit a byte
    bounds = [(min(min(x for x, _ in r) for r in rings), min(min(y for _, y in r) for r in rings),
               max(max(x for x, _ in r) for r in rings), max(max(y for _, y in r) for r in rings)) for _, rings in shapes]
    for bj in range(0, ny, LAND_BLOCK):
        for bi in range(0, nx, LAND_BLOCK):
            i0, j0 = bi - margin, bj - margin
            w, h = min(LAND_BLOCK, nx - bi) + 2 * margin, min(LAND_BLOCK, ny - bj) + 2 * margin
            sub = (box[0] + i0 * LAND_CELL, box[1] + j0 * LAND_CELL)
            end = (sub[0] + w * LAND_CELL, sub[1] + h * LAND_CELL)
            near = [s for s, b in zip(shapes, bounds) if b[0] < end[0] and b[2] > sub[0] and b[1] < end[1] and b[3] > sub[1]]
            fine = rasterize(near, (*sub, *end), LAND_FINE, (w * k, h * k))
            for c, mask in enumerate((fine > 0, fine == LAND_VALUE[AREA_WOOD])):
                if mask.all() or not mask.any():
                    d = np.full(mask.shape, 1e3 if mask.all() else -1e3)
                else:  # metres from each fine cell centre to the edge
                    d = (np.where(mask, distance_transform_edt(mask) - 0.5, 0.5 - distance_transform_edt(~mask))) * LAND_FINE
                d = d[k // 2 :: k, k // 2 :: k][margin : margin + min(LAND_BLOCK, ny - bj), margin : margin + min(LAND_BLOCK, nx - bi)]
                out[bj : bj + d.shape[0], bi : bi + d.shape[1], c] = np.clip(np.round(128 + LAND_SCALE * d), 0, 255)
    return out


def area_kind(tags):
    """Kind of a closed way or multipolygon, or None if it is not an area drawn on the map."""
    if tags.get("natural") == "water":
        return AREA_WATER
    if tags.get("highway") in ("pedestrian", "footway") and tags.get("area") == "yes":
        return AREA_PEDESTRIAN
    if tags.get("landuse") == "forest" or tags.get("natural") == "wood":
        return AREA_WOOD
    if tags.get("leisure") in ("park", "garden", "pitch") or tags.get("landuse") in (
        "grass", "recreation_ground", "meadow", "village_green", "cemetery"):
        return AREA_GREEN
    return None


def line_class(tags):
    if "highway" in tags:
        hw = tags["highway"]
        return CLASS_ID["link"] if hw.endswith("_link") else CLASS_ID.get(HIGHWAY.get(hw))
    if tags.get("railway") == "rail":
        return CLASS_ID["rail"]
    if tags.get("railway") == "tram":
        return CLASS_ID["tram"]
    if tags.get("waterway") in ("stream", "canal"):
        return CLASS_ID["stream"]
    return None


def simplify(pts, tol=SIMPLIFY):
    """Douglas-Peucker on a list of (x, y)."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy) or 1e-9
        best, idx = 0, None
        for i in range(a + 1, b):
            d = abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / length
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]


def clip_line(pts, box):
    """Split a polyline into runs inside the box; each run keeps one point beyond the edge."""
    x0, y0, x1, y1 = box
    inside = [x0 <= x <= x1 and y0 <= y <= y1 for x, y in pts]
    runs, cur = [], []
    for i, p in enumerate(pts):
        if inside[i] or (i > 0 and inside[i - 1]) or (i + 1 < len(pts) and inside[i + 1]):
            cur.append(p)
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    return [r for r in runs if len(r) >= 2]


def clip_ring(ring, box):
    """Sutherland-Hodgman against an axis-aligned box."""
    x0, y0, x1, y1 = box
    edges = [
        (lambda p: p[0] >= x0, lambda a, b: (x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0]))),
        (lambda p: p[0] <= x1, lambda a, b: (x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0]))),
        (lambda p: p[1] >= y0, lambda a, b: (a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0)),
        (lambda p: p[1] <= y1, lambda a, b: (a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1)),
    ]
    out = ring
    for keep, cut in edges:
        src, out = out, []
        for i, b in enumerate(src):
            a = src[i - 1]
            if keep(b):
                if not keep(a):
                    out.append(cut(a, b))
                out.append(b)
            elif keep(a):
                out.append(cut(a, b))
        if not out:
            return []
    return out


def area(ring):
    return 0.5 * sum(ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1] for i in range(len(ring)))


def stitch(ways):
    """Join open member ways of a multipolygon into closed rings."""
    rings, open_ = [], [list(w) for w in ways if len(w) >= 2]
    while open_:
        cur = open_.pop()
        while cur[0] != cur[-1]:
            for i, w in enumerate(open_):
                if w[0] == cur[-1]:
                    cur += w[1:]
                elif w[-1] == cur[-1]:
                    cur += w[-2::-1]
                elif w[-1] == cur[0]:
                    cur = w[:-1] + cur
                elif w[0] == cur[0]:
                    cur = w[:0:-1] + cur
                else:
                    continue
                open_.pop(i)
                break
            else:
                break  # cannot be closed (member outside the download)
        if cur[0] == cur[-1] and len(cur) >= 4:
            rings.append(cur)
    return rings


def project_ring(coords, box, tol=SIMPLIFY):
    ring = [to_local(lon, lat) for lon, lat in coords]
    if ring and ring[0] == ring[-1]:
        ring.pop()
    ring = clip_ring(ring, box)
    if len(ring) >= 4:
        # Split the loop at the point farthest from the start, so each half has a proper baseline.
        k = max(range(len(ring)), key=lambda i: math.dist(ring[0], ring[i]))
        ring = simplify(ring[: k + 1], tol)[:-1] + simplify(ring[k:] + ring[:1], tol)[:-1]
    return ring if len(ring) >= 3 and abs(area(ring)) >= 20 else None


def dm(ring):
    return [round(v * 10) for p in ring for v in p]


def main():
    t = load_terrain()
    box = (t["x0"], t["y0"], t["x0"] + (t["nx"] - 1) * t["cell"], t["y0"] + (t["ny"] - 1) * t["cell"])
    w, s = to_lonlat(box[0], box[1])
    e, n = to_lonlat(box[2], box[3])
    bb = f"{s:.5f},{w:.5f},{n:.5f},{e:.5f}"
    query = f"""[out:json][timeout:300];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$|^(unclassified|residential|living_street|pedestrian)$"]({bb});
  way["railway"~"^(rail|tram)$"]({bb});
  way["waterway"~"^(stream|canal)$"]({bb});
  way["highway"~"^(footway|path|cycleway|steps|bridleway)$"]({bb});
  way["natural"="water"]({bb});
  relation["natural"="water"]({bb});
  way["leisure"~"^(park|garden|pitch)$"]({bb});
  relation["leisure"~"^(park|garden|pitch)$"]({bb});
  way["landuse"~"^(grass|recreation_ground|meadow|village_green|cemetery|forest)$"]({bb});
  relation["landuse"~"^(grass|recreation_ground|meadow|village_green|cemetery|forest)$"]({bb});
  way["natural"="wood"]({bb});
  relation["natural"="wood"]({bb});
);
out geom;"""
    with open(overpass(query, "map.overpass.json", timeout=400), encoding="utf-8") as f:
        elements = json.load(f)["elements"]

    lines, areas, land, stats = [], [], [], Counter()
    for el in elements:
        tags = el.get("tags", {})
        if el["type"] == "relation":
            kind = area_kind(tags)
            if tags.get("type") != "multipolygon" or kind is None:
                continue
            tol = SIMPLIFY if kind in (AREA_WATER, AREA_PEDESTRIAN) else GREEN_SIMPLIFY
            outer = stitch([[(p["lon"], p["lat"]) for p in m.get("geometry", [])] for m in el["members"] if m.get("role") == "outer"])
            inner = stitch([[(p["lon"], p["lat"]) for p in m.get("geometry", [])] for m in el["members"] if m.get("role") == "inner"])
            holes = [h for h in (project_ring(r, box, tol) for r in inner) if h]
            for r in outer:
                ring = project_ring(r, box, tol)
                if ring:
                    if kind in LAND_VALUE:
                        land.append((LAND_VALUE[kind], [ring] + holes))
                    else:
                        # Holes are attached to every outer ring; the renderer ignores holes outside its outline.
                        areas.append([kind, dm(ring)] + [dm(h) for h in holes])
                    stats[AREA_NAME[kind]] += 1
            continue
        coords = [(p["lon"], p["lat"]) for p in el.get("geometry", [])]
        if len(coords) < 2 or tags.get("tunnel") in ("yes", "culvert", "building_passage") or tags.get("layer", "0").startswith("-"):
            stats["skipped (tunnel / underground)"] += 1
            continue
        kind = area_kind(tags)
        if kind is not None:
            if coords[0] != coords[-1]:
                continue
            ring = project_ring(coords, box, SIMPLIFY if kind in (AREA_WATER, AREA_PEDESTRIAN) else GREEN_SIMPLIFY)
            if ring:
                if kind in LAND_VALUE:
                    land.append((LAND_VALUE[kind], [ring]))
                else:
                    areas.append([kind, dm(ring)])
                stats[AREA_NAME[kind]] += 1
            continue
        if tags.get("indoor") not in (None, "no"):
            continue
        cls = line_class(tags)
        if cls is None:
            continue
        if tags.get("railway") == "rail" and tags.get("service") in ("siding", "yard", "spur"):
            stats["rail sidings skipped"] += 1
            continue
        bridge = 1 if tags.get("bridge") not in (None, "no") else 0
        for run in clip_line([to_local(lon, lat) for lon, lat in coords], box):
            run = simplify(run)
            lines.append([cls, bridge] + dm(run))
            stats[CLASSES[cls][0]] += 1

    print("  " + ", ".join(f"{k}: {v}" for k, v in sorted(stats.items())))
    # classes: [name, width_dm]; lines: [class, bridge, x, y, x, y, ...]; areas: [kind, outer, hole, ...]
    # (kind 0 = water, 1 = pedestrian square). Coordinates in decimetres, x = east, y = north.
    # Woods first, parks on top of them.
    grid = distance_field(sorted(land, key=lambda s: -s[0]), box)
    header = {"x0": box[0], "y0": box[1], "cell": LAND_CELL, "nx": grid.shape[1], "ny": grid.shape[0], "scale": LAND_SCALE}
    write_binary("landcover.bin", _pack(b"ZGL2", header, [grid.tobytes()]))
    write_json("map.json", {"classes": [[name, round(width * 10)] for name, width in CLASSES], "lines": lines, "areas": areas})


if __name__ == "__main__":
    main()
