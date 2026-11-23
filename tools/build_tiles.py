#!/usr/bin/env python3
"""Build the detailed 3D building tiles (real roofs) that the app streams in when zoomed in.

Source: ZG3D 2022 LoD 2.2 multipatch models per city district (data.zagreb.hr, FGDB), the same buildings as the
blocks in data/buildings.bin. Every building is cleaned up (duplicate corners merged, flat triangles dropped, faces
turned outwards; optionally simplified with --keep), then put into the same 600 m chunk as its
block version (matched by OBJECTID, see feature_anchor in common.py), one file per chunk:
    <out>/v1/<i>_<j>.bin   "ZGD1", Uint32 header length, JSON header {x0, y0, verts, tris, index}, padding to 4 bytes,
                           Int16 positions [x, height, -y] in decimetres (x, y relative to the chunk origin x0, y0,
                           height above z0 of data/buildings.bin), then Uint16 or Uint32 triangle indices
    <out>/v1/index.json    {version, z0, chunk, tiles: {"i_j": [bytes, triangles]}}
Only chunks whose buildings all come from the processed districts are written, so a tile never hides a building.

Needs pyogrio (GDAL) and fast-simplification:  pip install -r tools/requirements.txt
Usage:  python3 tools/build_tiles.py [--out ../zg-sunce-tiles] [--districts donji-grad,trnje] [--keep 0.5]
Run after build_buildings.py. The output goes to the separate tiles repo (see README.md).
"""
import argparse
import glob
import json
import os
import time
import zipfile
from collections import defaultdict

import numpy as np

from build_buildings import DISTRICTS, load_district
from common import CACHE, LAT0, LON0, M_PER_DEG_LAT, M_PER_DEG_LON, _pack, _unpack, chunk_of, feature_anchor, fetch, DATA, BUILDING_CHUNK
from multipatch import triangles

VERSION = 2
KEEP = 1.0  # share of a building's triangles kept by the simplification (1 = buildings exactly as modelled)
MIN_TRIANGLES = 12  # buildings this small are left as they are
SKIRT = 3.0  # m: the lowest vertices of a building go this far down, so it never floats over the coarse terrain


def district_gdb(slug):
    """Path of the district's 3D model geodatabase (downloaded and unpacked into tools/cache once)."""
    with open(fetch("https://data.zagreb.hr/api/3/action/package_show?id=" + slug, slug + ".meta.json"), encoding="utf-8") as f:
        resources = json.load(f)["result"]["resources"]
    url = next(r["url"] for r in resources if (r.get("format") or "").lower() == "fgdb")
    folder = os.path.join(CACHE, slug + ".gdb")
    if not glob.glob(os.path.join(folder, "*.gdb")):
        with zipfile.ZipFile(fetch(url, slug + ".gdb.zip", timeout=600)) as z:
            z.extractall(folder)
    return glob.glob(os.path.join(folder, "*.gdb"))[0]


def building_mesh(wkb, z0, keep=KEEP):
    """(points in decimetres [x, y, height above z0], triangles) of one building, cleaned and simplified."""
    import fast_simplification

    tri = np.array(triangles(wkb), dtype=np.float64).reshape(-1, 3)
    if not len(tri):
        return None
    x = (tri[:, 0] - LON0) * M_PER_DEG_LON
    y = (tri[:, 1] - LAT0) * M_PER_DEG_LAT
    z = tri[:, 2]
    low = z.min()
    z = np.where(z < low + 0.2, z - SKIRT, z)
    # Weld corners that fall into the same decimetre; drop triangles that collapse.
    key = np.round(np.stack([x * 10, y * 10, (z - z0) * 10], axis=1)).astype(np.int64)
    points, faces = np.unique(key, axis=0, return_inverse=True)
    faces = faces.reshape(-1, 3)
    faces = faces[(faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])]
    if not len(faces):
        return None
    pts = points.astype(np.float64)
    if keep < 1 and len(faces) > MIN_TRIANGLES:
        centre = pts.mean(axis=0)
        target = max(MIN_TRIANGLES, int(len(faces) * keep))
        simple, faces = fast_simplification.simplify(pts - centre, faces.astype(np.int32), target_count=target)
        pts = np.round(simple + centre)
        pts, inverse = np.unique(pts, axis=0, return_inverse=True)
        faces = inverse.reshape(-1)[faces]
        faces = faces[(faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])]
    # Faces must point outwards (most come in turned inwards): flip the building if its volume is negative.
    a, b, c = (pts[faces[:, k]] - pts.mean(axis=0) for k in range(3))
    if np.einsum("ij,ij->i", a, np.cross(b, c)).sum() < 0:
        faces = faces[:, [0, 2, 1]]
    return pts.astype(np.int64), faces


def write_tile(path, x0, y0, meshes):
    pos, idx, base = [], [], 0
    for pts, faces in meshes:
        # Scene order: x, height, -y, relative to the chunk origin.
        pos.append(np.stack([pts[:, 0] - x0, pts[:, 2], -(pts[:, 1] - y0)], axis=1))
        idx.append(faces + base)
        base += len(pts)
    pos = np.concatenate(pos)
    idx = np.concatenate(idx)
    if pos.min() < -32768 or pos.max() > 32767:
        raise ValueError(f"tile {path}: coordinates out of 16-bit range")
    wide = len(pos) > 65535
    header = {"x0": x0, "y0": y0, "verts": len(pos), "tris": len(idx), "index": 32 if wide else 16}
    body = pos.astype("<i2").tobytes()
    body += b"\0" * (-len(body) % 4)
    body += idx.astype("<u4" if wide else "<u2").tobytes()
    data = _pack(b"ZGD1", header, [body])
    with open(path, "wb") as f:
        f.write(data)
    return len(data), len(idx)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(DATA), "..", "zg-sunce-tiles"))
    ap.add_argument("--districts", default="", help="comma-separated parts of district names; default all")
    ap.add_argument("--keep", type=float, default=KEEP, help="share of triangles to keep (1 = no simplification)")
    args = ap.parse_args()
    wanted = [d for d in DISTRICTS if not args.districts or any(w in d for w in args.districts.split(","))]
    z0 = _unpack(os.path.join(DATA, "buildings.bin"), b"ZGB1")[0]["z0"]

    # Which district each chunk's buildings come from, to write only chunks covered completely.
    print("Reading building outlines of all districts")
    chunk_districts = defaultdict(set)
    anchors = {}
    for slug in DISTRICTS:
        for f in load_district(slug):
            if f.get("geometry"):
                anchor = feature_anchor(f["geometry"])
                chunk_districts[chunk_of(anchor)].add(slug)
                if slug in wanted:
                    anchors[(slug, f["properties"]["OBJECTID"])] = anchor

    import pyogrio

    chunks = defaultdict(list)
    for slug in wanted:
        t0 = time.time()
        meta, fids, geoms, _ = pyogrio.raw.read(district_gdb(slug), return_fids=True)
        before = after = missing = 0
        for fid, wkb in zip(fids, geoms):
            anchor = anchors.get((slug, int(fid)))
            if anchor is None or wkb is None:
                missing += 1
                continue
            mesh = building_mesh(wkb, z0, args.keep)
            if mesh is None:
                missing += 1
                continue
            before += len(triangles(wkb))
            after += len(mesh[1])
            chunks[chunk_of(anchor)].append(mesh)
        print(f"  {slug}: {len(geoms)} buildings, {before} → {after} triangles, {missing} without geometry, {time.time() - t0:.0f} s")

    folder = os.path.join(args.out, f"v{VERSION}")
    os.makedirs(folder, exist_ok=True)
    for old in glob.glob(os.path.join(folder, "*.bin")):
        os.remove(old)
    size = BUILDING_CHUNK * 10
    tiles, skipped = {}, 0
    for (ci, cj), meshes in sorted(chunks.items()):
        if not chunk_districts[(ci, cj)] <= set(wanted):
            skipped += 1
            continue
        tiles[f"{ci}_{cj}"] = write_tile(os.path.join(folder, f"{ci}_{cj}.bin"), ci * size, cj * size, meshes)
    with open(os.path.join(folder, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"version": VERSION, "z0": z0, "chunk": BUILDING_CHUNK, "tiles": tiles}, f, separators=(",", ":"))
    total = sum(b for b, _ in tiles.values())
    print(f"  wrote {len(tiles)} tiles ({skipped} border chunks shared with other districts left out), "
          f"{sum(t for _, t in tiles.values())} triangles, {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
