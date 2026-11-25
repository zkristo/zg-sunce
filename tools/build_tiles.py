#!/usr/bin/env python3
"""Build the detailed 3D building tiles (real roofs) that the app streams in when zoomed in.

Source: ZG3D 2022 LoD 2.2 multipatch models per city district (data.zagreb.hr, FGDB), the same buildings as the
blocks in data/buildings.bin. Every building is cleaned up (duplicate corners merged, flat triangles dropped, faces
turned outwards; optionally simplified with --keep), then put into the same 600 m chunk as its
block version (matched by OBJECTID, see feature_anchor in common.py), one file per chunk:
    <out>/v3/<i>_<j>.bin   "ZGD1", Uint32 header length, JSON header {x0, y0, verts, tris, index}, padding to 4 bytes,
                           Int16 positions [x, height, -y] in decimetres (x, y relative to the chunk origin x0, y0,
                           height above z0 of data/buildings.bin), then Uint16 or Uint32 triangle indices
    <out>/v3/landmarks.bin the landmark buildings (data/landmarks.json), which the app shows at any distance and the
                           chunk tiles leave out: "ZGM1", header {meshes: [[x0, y0, verts, tris, index, offset], ...]}
                           (one mesh per 2.4 km square, offset counted from the end of the header), each encoded as in a tile
    <out>/v3/index.json    {version, z0, chunk, landmarks: [bytes, triangles], tiles: {"i_j": [bytes, triangles]}}
Only chunks whose buildings all come from the processed districts are written, so a tile never hides a building.

Needs pyogrio (GDAL) and fast-simplification:  pip install -r tools/requirements.txt
Usage:  python3 tools/build_tiles.py [--out ../zg-sunce-tiles] [--districts donji-grad,trnje] [--keep 0.5]
Run after build_buildings.py. The output goes to the separate tiles repo (see README.md).
"""
import argparse
import glob
import json
import os
import shutil
import time
import zipfile
from collections import defaultdict

import numpy as np

from build_buildings import DISTRICTS, load_district
from common import CACHE, LAT0, LON0, M_PER_DEG_LAT, M_PER_DEG_LON, _pack, _unpack, chunk_of, feature_anchor, fetch, DATA, BUILDING_CHUNK
from multipatch import triangles

VERSION = 3
KEEP = 1.0  # share of a building's triangles kept by the simplification (1 = buildings exactly as modelled)
MIN_TRIANGLES = 12  # buildings this small are left as they are
SKIRT = 3.0  # m: the lowest vertices of a building go this far down, so it never floats over the coarse terrain
MAX_SIZE = 1000  # m: a few records are broken (a huge rectangle instead of the building); the blocks skip them too


def _download(slug, fmt, pattern):
    """Path of a district resource (downloaded and unpacked into tools/cache once)."""
    with open(fetch("https://data.zagreb.hr/api/3/action/package_show?id=" + slug, slug + ".meta.json"), encoding="utf-8") as f:
        resources = json.load(f)["result"]["resources"]
    url = next(r["url"] for r in resources if (r.get("format") or "").lower() == fmt)
    folder = os.path.join(CACHE, f"{slug}.{fmt}")
    if not glob.glob(os.path.join(folder, "**", pattern), recursive=True):
        with zipfile.ZipFile(fetch(url, f"{slug}.{fmt}.zip", timeout=600)) as z:
            z.extractall(folder)
    return glob.glob(os.path.join(folder, "**", pattern), recursive=True)[0]


def district_models(slug):
    """(OBJECTIDs, WKB multipatches, to_lonlat) of a district's 3D buildings; to_lonlat converts the file's x, y
    arrays to degrees (most districts are in degrees already, three in HTRS96/TM metres, EPSG:3765). The geodatabase
    is used where GDAL reads it; one district declares a geometry type pyogrio rejects, so its Shapefile is used,
    whose feature numbers start at 0."""
    import pyogrio

    try:
        path = _download(slug, "fgdb", "*.gdb")
        meta, fids, geoms, _ = pyogrio.raw.read(path, return_fids=True)
        ids = [int(f) for f in fids]
    except pyogrio.errors.GeometryError:
        path = _download(slug, "shp", "*.shp")
        meta, fids, geoms, _ = pyogrio.raw.read(path, return_fids=True)
        ids = [int(f) + 1 for f in fids]
    crs = meta.get("crs") or "EPSG:4326"
    if crs == "EPSG:4326":
        return ids, geoms, None
    from pyproj import Transformer

    return ids, geoms, Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform


def building_mesh(wkb, z0, keep=KEEP, to_lonlat=None):
    """(points in decimetres [x, y, height above z0], triangles) of one building, cleaned and simplified."""
    import fast_simplification

    tri = np.array(triangles(wkb), dtype=np.float64).reshape(-1, 3)
    if not len(tri):
        return None
    lon, lat = to_lonlat(tri[:, 0], tri[:, 1]) if to_lonlat else (tri[:, 0], tri[:, 1])
    x = (lon - LON0) * M_PER_DEG_LON
    y = (lat - LAT0) * M_PER_DEG_LAT
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


def encode_mesh(x0, y0, meshes):
    """(header, body) of the buildings of one chunk, in the tile encoding."""
    pos, idx, base = [], [], 0
    for pts, faces in meshes:
        # Scene order: x, height, -y, relative to the chunk origin.
        pos.append(np.stack([pts[:, 0] - x0, pts[:, 2], -(pts[:, 1] - y0)], axis=1))
        idx.append(faces + base)
        base += len(pts)
    pos = np.concatenate(pos)
    idx = np.concatenate(idx)
    if pos.min() < -32768 or pos.max() > 32767:
        raise ValueError(f"chunk {x0}, {y0}: coordinates out of 16-bit range")
    wide = len(pos) > 65535
    header = {"x0": x0, "y0": y0, "verts": len(pos), "tris": len(idx), "index": 32 if wide else 16}
    body = pos.astype("<i2").tobytes()
    body += b"\0" * (-len(body) % 4)
    body += idx.astype("<u4" if wide else "<u2").tobytes()
    body += b"\0" * (-len(body) % 4)
    return header, body


def write_tile(path, x0, y0, meshes):
    header, body = encode_mesh(x0, y0, meshes)
    data = _pack(b"ZGD1", header, [body])
    with open(path, "wb") as f:
        f.write(data)
    return len(data), header["tris"]


LANDMARK_GROUP = 4  # chunks a side per landmark mesh (2.4 km): fewer draw calls; with buildings reaching up to
# MAX_SIZE beyond, decimetre positions still fit in 16 bits


def write_landmarks(path, chunks):
    """All landmark buildings in one file, one mesh per LANDMARK_GROUP × LANDMARK_GROUP chunks."""
    size = BUILDING_CHUNK * 10
    groups = defaultdict(list)
    for (ci, cj), meshes in chunks.items():
        groups[(ci // LANDMARK_GROUP, cj // LANDMARK_GROUP)].extend(meshes)
    table, bodies, offset = [], [], 0
    for (gi, gj), meshes in sorted(groups.items()):
        h, body = encode_mesh(gi * LANDMARK_GROUP * size, gj * LANDMARK_GROUP * size, meshes)
        table.append([h["x0"], h["y0"], h["verts"], h["tris"], h["index"], offset])
        bodies.append(body)
        offset += len(body)
    data = _pack(b"ZGM1", {"meshes": table}, bodies)
    with open(path, "wb") as f:
        f.write(data)
    return len(data), sum(row[3] for row in table)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(DATA), "..", "zg-sunce-tiles"))
    ap.add_argument("--districts", default="", help="comma-separated parts of district names; default all")
    ap.add_argument("--keep", type=float, default=KEEP, help="share of triangles to keep (1 = no simplification)")
    args = ap.parse_args()
    wanted = [d for d in DISTRICTS if not args.districts or any(w in d for w in args.districts.split(","))]
    z0 = _unpack(os.path.join(DATA, "buildings.bin"), b"ZGB1")[0]["z0"]
    with open(os.path.join(DATA, "landmarks.json"), encoding="utf-8") as f:
        landmark_ids = {(slug, oid) for slug, ids in json.load(f)["districts"].items() for oid in ids}

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

    chunks, landmark_chunks = defaultdict(list), defaultdict(list)
    for slug in wanted:
        t0 = time.time()
        fids, geoms, to_lonlat = district_models(slug)
        after = missing = broken = 0
        for fid, wkb in zip(fids, geoms):
            anchor = anchors.get((slug, fid))
            if anchor is None or wkb is None:
                missing += 1
                continue
            mesh = building_mesh(wkb, z0, args.keep, to_lonlat)
            if mesh is None:
                missing += 1
                continue
            if (mesh[0][:, :2].max(axis=0) - mesh[0][:, :2].min(axis=0)).max() > MAX_SIZE * 10:
                broken += 1
                continue
            after += len(mesh[1])
            (landmark_chunks if (slug, fid) in landmark_ids else chunks)[chunk_of(anchor)].append(mesh)
        print(f"  {slug}: {len(geoms)} buildings, {after} triangles, {missing} without geometry, {broken} broken, {time.time() - t0:.0f} s")

    for old in glob.glob(os.path.join(args.out, "v*")):
        shutil.rmtree(old)
    folder = os.path.join(args.out, f"v{VERSION}")
    os.makedirs(folder)
    size = BUILDING_CHUNK * 10
    tiles, skipped = {}, 0
    for (ci, cj), meshes in sorted(chunks.items()):
        if not chunk_districts[(ci, cj)] <= set(wanted):
            skipped += 1
            continue
        tiles[f"{ci}_{cj}"] = write_tile(os.path.join(folder, f"{ci}_{cj}.bin"), ci * size, cj * size, meshes)
    landmarks = write_landmarks(os.path.join(folder, "landmarks.bin"), landmark_chunks)
    with open(os.path.join(folder, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"version": VERSION, "z0": z0, "chunk": BUILDING_CHUNK, "landmarks": landmarks, "tiles": tiles}, f, separators=(",", ":"))
    print(f"  landmarks: {sum(map(len, landmark_chunks.values()))} buildings, {landmarks[1]} triangles, {landmarks[0] / 1e6:.1f} MB")
    total = sum(b for b, _ in tiles.values())
    print(f"  wrote {len(tiles)} tiles ({skipped} border chunks shared with other districts left out), "
          f"{sum(t for _, t in tiles.values())} triangles, {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
