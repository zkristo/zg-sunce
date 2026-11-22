"""Skylines of café terraces, so the app can tell sun from building and terrain shade without 3D tests.

For every café and every 1° of compass direction this finds the highest angle above the horizon that a building
roof or the ground reaches, seen from the terrace (EYE m above the ground). The sun is blocked when its altitude
is below the skyline in its direction. Buildings are prisms with flat roofs, so this gives the same answer as
casting a ray at the sun, just worked out once here instead of in every visitor's browser.

Used by build_cafes.py. Needs numpy.
"""
import base64
import math

import numpy as np

EYE = 1.2  # m above the ground, as in app.js
BINS = 360  # compass directions, 1° each; bin k covers k°..k+1°, measured clockwise from north
STEPS_PER_DEGREE = 2  # stored as round(angle × 2) in one byte: 0.5° steps up to 127.5°
BUILDING_RANGE = 3000  # m
MIN_ANGLE = math.radians(0.5)  # buildings lower than this as seen from the terrace are skipped early
CELL = 250  # m, grid for finding nearby walls
TERRAIN_RANGE = 15000  # m


def _terrain_samples():
    """Distances along each direction at which the terrain is sampled: dense near the terrace, sparse far away."""
    d, out = 5.0, []
    while d < TERRAIN_RANGE:
        out.append(d)
        d += 5 if d < 200 else 20 if d < 1000 else d * 0.02
    return np.array(out)


class Skylines:
    def __init__(self, parts, tops, terrain):
        """parts: footprints as lists of rings of (x, y) in m; tops: roof height per part (same datum as terrain)."""
        ax, ay, bx, by, top = [], [], [], [], []
        for rings, t in zip(parts, tops):
            for ring in rings:
                for i in range(len(ring)):
                    (x0, y0), (x1, y1) = ring[i - 1], ring[i]
                    ax.append(x0), ay.append(y0), bx.append(x1), by.append(y1), top.append(t)
        self.ax, self.ay, self.bx, self.by, self.top = (np.array(v) for v in (ax, ay, bx, by, top))
        mx, my = (self.ax + self.bx) / 2, (self.ay + self.by) / 2
        self.half = np.hypot(self.bx - self.ax, self.by - self.ay) / 2
        cells = np.floor(mx / CELL).astype(np.int64) * 100000 + np.floor(my / CELL).astype(np.int64)
        order = np.argsort(cells, kind="stable")
        keys, starts = np.unique(cells[order], return_index=True)
        ends = np.append(starts[1:], len(order))
        self.grid = {int(k): order[s:e] for k, s, e in zip(keys, starts, ends)}

        self.terrain = terrain
        self.h = np.array(terrain.h).reshape(terrain.ny, terrain.nx)
        self.samples = _terrain_samples()
        centres = np.radians(np.arange(BINS) + 0.5)
        self.dir_e, self.dir_n = np.sin(centres), np.cos(centres)

    def _terrain_at(self, x, y):
        """Height of the terrain mesh itself (its triangles), as terrainAt() in app.js."""
        t = self.terrain
        fx = np.clip((x - t.x0) / t.cell, 0, t.nx - 1.001)
        fy = np.clip((y - t.y0) / t.cell, 0, t.ny - 1.001)
        i, j = fx.astype(np.int64), fy.astype(np.int64)
        tx, ty = fx - i, fy - j
        a, b = self.h[j, i], self.h[j, i + 1]
        c, d = self.h[j + 1, i], self.h[j + 1, i + 1]
        return np.where(tx >= ty, a + (b - a) * tx + (d - b) * ty, a + (d - c) * tx + (c - a) * ty)

    def of(self, x, y, z):
        """Skyline (radians per bin) of a terrace at (x, y) whose ground is at height z."""
        eye = z + EYE
        sky = np.zeros(BINS)

        # Terrain: sample along the centre ray of every bin.
        px = x + np.outer(self.dir_e, self.samples)
        py = y + np.outer(self.dir_n, self.samples)
        t = self.terrain
        inside = (px >= t.x0) & (px <= t.x0 + (t.nx - 1) * t.cell) & (py >= t.y0) & (py <= t.y0 + (t.ny - 1) * t.cell)
        ang = np.where(inside, np.arctan2(self._terrain_at(px, py) - eye, self.samples), -1.0)
        sky = np.maximum(sky, ang.max(axis=1))

        # Buildings: walls within range, each intersected with the centre ray of the bins it covers.
        reach = BUILDING_RANGE // CELL + 1
        ci, cj = math.floor(x / CELL), math.floor(y / CELL)
        idx = [self.grid[k] for di in range(-reach, reach + 1) for dj in range(-reach, reach + 1)
               if (k := (ci + di) * 100000 + cj + dj) in self.grid]
        if not idx:
            return sky
        idx = np.concatenate(idx)
        ax, ay, bx, by = self.ax[idx] - x, self.ay[idx] - y, self.bx[idx] - x, self.by[idx] - y
        rise = self.top[idx] - eye
        near = np.maximum(np.hypot((ax + bx) / 2, (ay + by) / 2) - self.half[idx], 0.1)
        keep = (rise > 0) & (near < BUILDING_RANGE) & (np.arctan2(rise, near) > MIN_ANGLE)
        ax, ay, bx, by, rise = ax[keep], ay[keep], bx[keep], by[keep], rise[keep]

        az_a = np.degrees(np.arctan2(ax, ay)) % 360
        az_b = np.degrees(np.arctan2(bx, by)) % 360
        delta = (az_b - az_a + 540) % 360 - 180
        lo = np.where(delta > 0, az_a, az_b)
        first = np.ceil(lo - 0.5).astype(np.int64)
        count = np.floor(lo + np.abs(delta) - 0.5).astype(np.int64) - first + 1
        has = count > 0
        if not has.any():
            return sky
        e = np.repeat(np.nonzero(has)[0], count[has])
        k = np.repeat(first[has], count[has]) + (np.arange(len(e)) - np.repeat(np.cumsum(count[has]) - count[has], count[has]))
        k %= BINS
        de, dn = self.dir_e[k], self.dir_n[k]
        ex, ey = bx[e] - ax[e], by[e] - ay[e]
        denom = de * ey - dn * ex
        ok = np.abs(denom) > 1e-12
        safe = np.where(ok, denom, 1.0)
        dist = (ax[e] * ey - ay[e] * ex) / safe  # along the ray
        s = (ax[e] * dn - ay[e] * de) / safe  # along the wall
        ok &= (dist > 0) & (s >= -1e-9) & (s <= 1 + 1e-9)
        np.maximum.at(sky, k[ok], np.arctan2(rise[e[ok]], dist[ok]))
        return sky


def encode(sky):
    """One byte per bin, round(angle in degrees × 2), as base64 for cafes.json."""
    steps = np.clip(np.round(np.degrees(np.maximum(sky, 0)) * STEPS_PER_DEGREE), 0, 255).astype(np.uint8)
    return base64.b64encode(steps.tobytes()).decode()
