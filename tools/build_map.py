#!/usr/bin/env python3
"""Build data/map.json (water, roads, railways) from OpenStreetMap. Run after build_buildings.py.

Everything is drawn flat on the terrain, so only outlines and centrelines are stored.
Usage:  python3 tools/build_map.py
"""
import json
import math
from collections import Counter

from common import load_terrain, overpass, to_local, to_lonlat, write_json

SIMPLIFY = 0.5  # m, Douglas-Peucker tolerance

# Line classes: (name, drawn width in m). Order is the order in data/map.json "classes".
CLASSES = [
    ("motorway", 16), ("trunk", 14), ("primary", 12), ("secondary", 10), ("tertiary", 8),
    ("link", 7), ("street", 6), ("pedestrian", 5), ("rail", 3), ("tram", 2.4), ("stream", 3),
]
CLASS_ID = {name: i for i, (name, _) in enumerate(CLASSES)}
HIGHWAY = {
    "motorway": "motorway", "trunk": "trunk", "primary": "primary", "secondary": "secondary",
    "tertiary": "tertiary", "unclassified": "street", "residential": "street", "living_street": "street",
    "pedestrian": "pedestrian",
}
AREA_WATER, AREA_PEDESTRIAN = 0, 1


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


def project_ring(coords, box):
    ring = [to_local(lon, lat) for lon, lat in coords]
    if ring and ring[0] == ring[-1]:
        ring.pop()
    ring = clip_ring(ring, box)
    if len(ring) >= 4:
        # Split the loop at the point farthest from the start, so each half has a proper baseline.
        k = max(range(len(ring)), key=lambda i: math.dist(ring[0], ring[i]))
        ring = simplify(ring[: k + 1])[:-1] + simplify(ring[k:] + ring[:1])[:-1]
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
  way["natural"="water"]({bb});
  relation["natural"="water"]({bb});
);
out geom;"""
    with open(overpass(query, "map.overpass.json", timeout=400), encoding="utf-8") as f:
        elements = json.load(f)["elements"]

    lines, areas, stats = [], [], Counter()
    for el in elements:
        tags = el.get("tags", {})
        if el["type"] == "relation":
            if tags.get("type") != "multipolygon":
                continue
            outer = stitch([[(p["lon"], p["lat"]) for p in m.get("geometry", [])] for m in el["members"] if m.get("role") == "outer"])
            inner = stitch([[(p["lon"], p["lat"]) for p in m.get("geometry", [])] for m in el["members"] if m.get("role") == "inner"])
            holes = [h for h in (project_ring(r, box) for r in inner) if h]
            for r in outer:
                ring = project_ring(r, box)
                if ring:
                    # Holes are attached to every outer ring; the renderer ignores holes outside its outline.
                    areas.append([AREA_WATER, dm(ring)] + [dm(h) for h in holes])
                    stats["water area"] += 1
            continue
        coords = [(p["lon"], p["lat"]) for p in el.get("geometry", [])]
        if len(coords) < 2 or tags.get("tunnel") in ("yes", "culvert", "building_passage") or tags.get("layer", "0").startswith("-"):
            stats["skipped (tunnel / underground)"] += 1
            continue
        if tags.get("natural") == "water" or (tags.get("highway") == "pedestrian" and tags.get("area") == "yes"):
            if coords[0] != coords[-1]:
                continue
            ring = project_ring(coords, box)
            if ring:
                kind = AREA_WATER if tags.get("natural") == "water" else AREA_PEDESTRIAN
                areas.append([kind, dm(ring)])
                stats["water area" if kind == AREA_WATER else "pedestrian area"] += 1
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
    write_json("map.json", {"classes": [[name, round(width * 10)] for name, width in CLASSES], "lines": lines, "areas": areas})


if __name__ == "__main__":
    main()
