#!/usr/bin/env python3
"""Build data/trees.json from the City of Zagreb greenery cadastre. Run after build_buildings.py.

Source: public ArcGIS layer of the city's tree cadastre (trees on public land, mostly surveyed in
2016). Height and crown width come as classes, so every tree becomes a class-sized crown.
Usage:  python3 tools/build_trees.py
"""
import json
import re
import urllib.parse
from collections import Counter

from common import Index, fetch, load_buildings, to_local, to_lonlat, write_json

SERVICE = "https://services8.arcgis.com/Usi0jGQwMmBUpFjr/arcgis/rest/services/stablo_SpatialJoin/FeatureServer/0/query?"
PAGE = 2000
HEIGHTS = [4, 8, 13, 18, 23, 28]  # m, one per 'visina' class
WIDTHS = [4, 8, 13, 17]  # m, one per 'pr_krosnje' class
NEAR = 200  # m, trees are kept in grid cells at or next to displayed buildings
EVERGREEN = (
    "PINUS", "PICEA", "ABIES", "TAXUS", "THUJA", "CHAMAECYPARIS", "CEDRUS", "JUNIPERUS", "CUPRESS",
    "PSEUDOTSUGA", "SEQUOIA", "TSUGA", "ILEX", "BUXUS", "LAUROCERASUS", "MAGNOLIA GRANDIFLORA",
    "PLATYCLADUS", "CALOCEDRUS", "CRYPTOMERIA", "LIGUSTRUM", "PHOTINIA", "QUERCUS ILEX",
)


def size_class(text, n):
    """'do 5m' -> 0, 'od 6 do 10m' -> 1, ..., 'više od 25m' -> last class; blank -> 0."""
    text = (text or "").strip()
    nums = re.findall(r"\d+", text)
    if not nums or text.startswith("do"):
        return 0
    if text.startswith("vi"):
        return n - 1
    return min(n - 1, (int(nums[0]) - 1) // 5)


def pages(west, south, east, north):
    offset = 0
    while True:
        query = {
            "where": "1=1",
            "geometry": f"{west:.5f},{south:.5f},{east:.5f},{north:.5f}",
            "geometryType": "esriGeometryEnvelope",
            "inSR": 4326,
            "outSR": 4326,
            "outFields": "vrsta,visina,pr_krosnje",
            "orderByFields": "OBJECTID",
            "resultOffset": offset,
            "resultRecordCount": PAGE,
            "f": "json",
        }
        with open(fetch(SERVICE + urllib.parse.urlencode(query), f"trees.{offset:06d}.json"), encoding="utf-8") as f:
            page = json.load(f)
        yield from page["features"]
        if not page.get("exceededTransferLimit"):
            return
        offset += PAGE


def main():
    parts, n_core = load_buildings()
    index = Index(parts)
    core_pts = [p for rings in parts[:n_core] for p in rings[0]]
    cells = {(int(x // NEAR), int(y // NEAR)) for x, y in core_pts}
    cells = {(i + di, j + dj) for i, j in cells for di in (-1, 0, 1) for dj in (-1, 0, 1)}
    w, s = to_lonlat(min(p[0] for p in core_pts), min(p[1] for p in core_pts))
    e, n = to_lonlat(max(p[0] for p in core_pts), max(p[1] for p in core_pts))

    out, stats, deciduous = [], Counter(), Counter()
    for f in pages(w, s, e, n):
        a, g = f["attributes"], f.get("geometry")
        if not g:
            continue
        x, y = to_local(g["x"], g["y"])
        if (int(x // NEAR), int(y // NEAR)) not in cells:
            stats["outside the area"] += 1
            continue
        if index.covers(x, y):
            stats["inside a building"] += 1
            continue
        species = (a.get("vrsta") or "").upper()
        evergreen = any(k in species for k in EVERGREEN)
        hc = size_class(a.get("visina"), len(HEIGHTS))
        wc = size_class(a.get("pr_krosnje"), len(WIDTHS))
        while wc and WIDTHS[wc] > 1.2 * HEIGHTS[hc]:
            wc -= 1
        out += [round(x * 10), round(y * 10), hc | wc << 3 | evergreen << 5]
        stats["evergreen" if evergreen else "deciduous"] += 1
        stats[f"height {HEIGHTS[hc]} m"] += 1
        if not evergreen:
            deciduous[species] += 1
    print(f"  {len(out) // 3} trees kept;", ", ".join(f"{k}: {v}" for k, v in sorted(stats.items())))
    print("  most common species counted as deciduous:", ", ".join(k for k, _ in deciduous.most_common(40)))

    # t: flat [x, y, code, ...] in decimetres from the origin (x = east, y = north);
    # code = height class | crown width class << 3 | evergreen << 5; h and w give the class sizes in metres.
    write_json("trees.json", {"h": HEIGHTS, "w": WIDTHS, "t": out})


if __name__ == "__main__":
    main()
