#!/usr/bin/env python3
"""Build data/cafes.json from OpenStreetMap (Overpass API) and Overture Maps. Run after build_buildings.py.

OSM is the main source. Every café also gets its skyline (see skyline.py), which the app uses for the
building and terrain shade test; that part needs numpy. Cafés and bars that only Overture knows are added when Overture is
confident about them; run tools/fetch_overture.py first to download them (otherwise OSM only).
Café points usually sit inside the building, so every point is moved to the nearest open
spot next to it (street or square) — an approximation of where the terrace is.
Usage:  python3 tools/build_cafes.py
"""
import json
import math
import os
import re
import unicodedata
from collections import Counter, defaultdict

from common import CACHE, DATA, Index, Terrain, core_bbox, load_building_tops, load_buildings, overpass, to_local, to_lonlat, write_json
from skyline import Skylines, encode

OVERTURE = os.path.join(CACHE, "overture.places.json")  # written by tools/fetch_overture.py
KEEP_CLEARANCE = 1.0  # m: points at least this far from any wall are left where they are
TERRACE_CLEARANCE = 2.5  # m: moved points end up this far from the nearest wall
SEARCH_RADIUS = 30  # m
# Cafés just outside the displayed districts are kept too: the model has buildings 300 m beyond
# the district edge, so within this margin there are still enough shadow casters around them.
EDGE_MARGIN = 100  # m
# Overture merges business listings (mostly Facebook pages); only confident, open places are used.
OVERTURE_MIN_CONFIDENCE = 0.8
SAME_NAME_DISTANCE = 80  # m: same name this close to an OSM café = the same café
SAME_SPOT_DISTANCE = 10  # m: any OSM café this close = the same café under another name
MALL_FOOTPRINT = 5000  # m²: places inside a building this large are indoors (shopping centres)
OVERTURE_TYPE = {"cafe": "cafe", "coffee_shop": "cafe", "tea_room": "cafe", "pub": "pub", "irish_pub": "pub", "gastropub": "pub"}
# Overture listings filed as cafés or bars that are something else (found by reading the list).
NOT_CAFES = ["poslovna zgrada", "green promotion", "darts team", "pub crawl", "bravar", "hy plaza", "ibis", "klub dubrovcana"]
GENERIC_WORDS = r"\b(caffe|cafe|coffee|kafic|kavana|bar|pub|club|lounge|bistro|the|and)\b"


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


def name_key(name):
    """Name without accents, punctuation and words like "caffe bar", for matching across sources."""
    s = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "", re.sub(GENERIC_WORDS, " ", s.replace("&", " ")))


def footprint_area(ring):
    return abs(sum(ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1] for i in range(len(ring)))) / 2


def osm_places(parts, n_core):
    w, s, e, n = core_bbox(parts, n_core)
    query = f'[out:json][timeout:120];nwr["amenity"~"^(cafe|bar|pub)$"]({s:.5f},{w:.5f},{n:.5f},{e:.5f});out center tags;'
    with open(overpass(query, "cafes.overpass.json"), encoding="utf-8") as f:
        elements = json.load(f)["elements"]
    places = []
    for el in elements:
        tags = el.get("tags", {})
        lat = el.get("lat") or el.get("center", {}).get("lat")
        lon = el.get("lon") or el.get("center", {}).get("lon")
        if lat is None:
            continue
        x, y = to_local(lon, lat)
        places.append({
            "id": f'{el["type"][0]}{el["id"]}', "name": tags.get("name") or "", "type": tags["amenity"], "x": x, "y": y,
            "outdoor": tags.get("outdoor_seating") is not None,
            "skip": tags.get("access") == "private" or tags.get("outdoor_seating") == "no",
        })
    return places


def overture_places(osm, index, parts, stats):
    """Confident Overture cafés that are not already in OSM."""
    if not os.path.exists(OVERTURE):
        print("  (no Overture data: run tools/fetch_overture.py to add it)")
        return []
    with open(OVERTURE, encoding="utf-8") as f:
        data = json.load(f)
    cell = SAME_NAME_DISTANCE
    grid = defaultdict(list)
    for i, p in enumerate(osm):
        grid[(int(p["x"] // cell), int(p["y"] // cell))].append(i)
    keys = [name_key(p["name"]) for p in osm]
    areas = {}
    found = []
    for pl in sorted(data["places"], key=lambda p: -p["confidence"]):
        key = name_key(pl["name"])
        if pl["status"] == "permanently_closed" or pl["confidence"] < OVERTURE_MIN_CONFIDENCE or not key:
            stats["overture: closed, unnamed or not confident"] += 1
            continue
        plain = unicodedata.normalize("NFKD", pl["name"]).encode("ascii", "ignore").decode().lower()
        if any(word in plain for word in NOT_CAFES):
            stats["overture: not a café"] += 1
            continue
        x, y = to_local(pl["lon"], pl["lat"])
        cx, cy = int(x // cell), int(y // cell)
        nearby = [i for a in (-1, 0, 1) for b in (-1, 0, 1) for i in grid[(cx + a, cy + b)]
                  if math.dist((x, y), (osm[i]["x"], osm[i]["y"])) <= SAME_NAME_DISTANCE]
        if any(keys[i] and (key in keys[i] or keys[i] in key) for i in nearby) or any(
            math.dist((x, y), (osm[i]["x"], osm[i]["y"])) <= SAME_SPOT_DISTANCE for i in nearby
        ):
            stats["overture: already in OSM"] += 1
            continue
        if any(f[1] == key and math.dist((x, y), f[2]) <= SAME_NAME_DISTANCE for f in found):
            stats["overture: duplicate listing"] += 1
            continue
        clearance, part = index.nearest(x, y)
        if clearance < 0:
            if part not in areas:
                areas[part] = footprint_area(parts[part][0])
            if areas[part] > MALL_FOOTPRINT:
                stats["overture: inside a shopping centre or large building"] += 1
                continue
        found.append((pl, key, (x, y)))
    return [
        {"id": "o" + pl["id"], "name": pl["name"], "type": OVERTURE_TYPE.get(pl["category"], "bar"), "x": x, "y": y, "outdoor": False, "skip": False}
        for pl, _, (x, y) in found
    ]


def main():
    parts, n_core = load_buildings()
    index = Index(parts)
    core = Index(parts[:n_core])
    with open(os.path.join(DATA, "terrain.json"), encoding="utf-8") as f:
        t = json.load(f)
    terrain = Terrain(t["x0"], t["y0"], t["cell"], t["nx"], t["ny"], [v / 10 for v in t["h"]])

    stats = Counter()
    osm = osm_places(parts, n_core)
    extra = overture_places(osm, index, parts, stats)

    cafes, moved = [], 0
    for p in osm + extra:
        src = "overture" if p["id"][0] == "o" else "osm"
        if p["skip"]:
            stats[f"{src}: private or no outdoor seating"] += 1
            continue
        x, y = p["x"], p["y"]
        # Only cafés in or right next to the displayed districts.
        _, near = index.nearest(x, y, reach=3)
        if near is None or (near >= n_core and abs(core.nearest(x, y, reach=2)[0]) > EDGE_MARGIN):
            stats[f"{src}: outside the area"] += 1
            continue
        pt = terrace_point(index, x, y)
        if pt is None:
            stats[f"{src}: no open space nearby"] += 1
            continue
        x, y, was_moved = pt
        moved += was_moved
        stats[f"{src}: kept"] += 1
        lon, lat = to_lonlat(x, y)
        cafes.append(
            {
                "id": p["id"],
                "name": p["name"],
                "type": p["type"],
                "x": round(x, 1),
                "y": round(y, 1),
                "z": round(terrain.at(x, y), 1),
                "lat": round(lat, 6),
                "lon": round(lon, 6),
                "outdoor": p["outdoor"],
            }
        )
    cafes.sort(key=lambda c: c["id"])
    skylines = Skylines(parts, load_building_tops(), terrain)
    for c in cafes:
        # sky: 360 bytes (one per degree of compass direction, from north) = skyline angle × 2, base64
        c["sky"] = encode(skylines.of(c["x"], c["y"], c["z"]))
    for k in sorted(stats):
        print(f"  {stats[k]:5d}  {k}")
    print(f"  {len(cafes)} cafés ({moved} moved out of buildings)")
    write_json("cafes.json", cafes)


if __name__ == "__main__":
    main()
