"""Triangles of ZG3D 3D buildings from the WKB that GDAL returns for FGDB multipatch features.

GDAL hands multipatches over as TIN / polyhedral surface / multipolygon WKB with Z (and sometimes M). This reads
any nesting of those and returns the corner points of every triangle; polygons with more than three corners
(rare in this data) are split into a fan.
"""
import struct

_POLYGON_TYPES = (3, 17)  # polygon, triangle
_COLLECTION_TYPES = (6, 7, 15, 16)  # multipolygon, geometry collection, polyhedral surface, TIN


def _read(b, o, out):
    order = "<" if b[o] == 1 else ">"
    (code,) = struct.unpack_from(order + "I", b, o + 1)
    o += 5
    if code & 0x80000000:  # EWKB-style flags
        base, dims = code & 0xFFFF, 3 + bool(code & 0x40000000)
    else:  # ISO: 1000 = Z, 2000 = M, 3000 = ZM
        base, dims = code % 1000, 2 + (code // 1000 in (1, 3)) + (code // 1000 in (2, 3))
    (n,) = struct.unpack_from(order + "I", b, o)
    o += 4
    if base in _POLYGON_TYPES:
        for r in range(n):
            (count,) = struct.unpack_from(order + "I", b, o)
            o += 4
            pts = [struct.unpack_from(order + "ddd", b, o + i * 8 * dims) for i in range(count)]
            o += count * 8 * dims
            if r == 0:  # holes do not occur in triangle faces
                if len(pts) > 1 and pts[0] == pts[-1]:
                    pts.pop()
                for k in range(1, len(pts) - 1):
                    out.append((pts[0], pts[k], pts[k + 1]))
        return o
    if base in _COLLECTION_TYPES:
        for _ in range(n):
            o = _read(b, o, out)
        return o
    raise ValueError(f"unsupported WKB geometry type {code}")


def triangles(wkb):
    """[(p0, p1, p2), ...] with p = (x, y, z) as stored (lon, lat, height for ZG3D)."""
    out = []
    _read(wkb, 0, out)
    return out
