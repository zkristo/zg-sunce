"""Polygon triangulation (ear clipping with holes), so roofs can be triangulated before they reach the browser.

A Python port of earcut by Mapbox (https://github.com/mapbox/earcut, ISC licence, © Mapbox), the algorithm
three.js uses in ShapeUtils.triangulateShape. The z-order hashing that earcut uses to speed up very large
polygons is left out: building parts here have at most a few hundred vertices.

    earcut(coords, hole_indices) -> flat list of vertex indices, three per triangle
coords is a flat [x0, y0, x1, y1, ...] list (outer ring first, then holes); hole_indices are the vertex
indices where each hole starts.
"""


class _Node:
    __slots__ = ("i", "x", "y", "prev", "next", "steiner")

    def __init__(self, i, x, y):
        self.i, self.x, self.y = i, x, y
        self.prev = self.next = None
        self.steiner = False


def earcut(data, hole_indices=()):
    outer_len = hole_indices[0] * 2 if hole_indices else len(data)
    outer = _linked_list(data, 0, outer_len, True)
    triangles = []
    if outer is None or outer.next is outer.prev:
        return triangles
    if hole_indices:
        outer = _eliminate_holes(data, hole_indices, outer)
    _earcut_linked(outer, triangles, 0)
    return triangles


def _linked_list(data, start, end, clockwise):
    last = None
    if clockwise == (_signed_area(data, start, end) > 0):
        for i in range(start, end, 2):
            last = _insert_node(i, data[i], data[i + 1], last)
    else:
        for i in range(end - 2, start - 1, -2):
            last = _insert_node(i, data[i], data[i + 1], last)
    if last is not None and _equals(last, last.next):
        _remove_node(last)
        last = last.next
    return last


def _filter_points(start, end=None):
    """Remove duplicate and collinear points."""
    if start is None:
        return start
    if end is None:
        end = start
    p = start
    while True:
        again = False
        if not p.steiner and (_equals(p, p.next) or _area(p.prev, p, p.next) == 0):
            _remove_node(p)
            p = end = p.prev
            if p is p.next:
                break
            again = True
        else:
            p = p.next
        if not again and p is end:
            break
    return end


def _earcut_linked(ear, triangles, pass_):
    if ear is None:
        return
    stop = ear
    while ear.prev is not ear.next:
        prev, nxt = ear.prev, ear.next
        if _is_ear(ear):
            triangles += (prev.i // 2, ear.i // 2, nxt.i // 2)
            _remove_node(ear)
            ear = stop = nxt.next
            continue
        ear = nxt
        if ear is stop:
            # No ears left: clean up and try again, then cure self-intersections, then split the polygon.
            if pass_ == 0:
                _earcut_linked(_filter_points(ear), triangles, 1)
            elif pass_ == 1:
                ear = _cure_local_intersections(_filter_points(ear), triangles)
                _earcut_linked(ear, triangles, 2)
            else:
                _split_earcut(ear, triangles)
            break


def _is_ear(ear):
    a, b, c = ear.prev, ear, ear.next
    if _area(a, b, c) >= 0:
        return False  # reflex
    x0, x1 = min(a.x, b.x, c.x), max(a.x, b.x, c.x)
    y0, y1 = min(a.y, b.y, c.y), max(a.y, b.y, c.y)
    p = c.next
    while p is not a:
        if (x0 <= p.x <= x1 and y0 <= p.y <= y1 and _point_in_triangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y)
                and _area(p.prev, p, p.next) >= 0):
            return False
        p = p.next
    return True


def _cure_local_intersections(start, triangles):
    p = start
    while True:
        a, b = p.prev, p.next.next
        if not _equals(a, b) and _intersects(a, p, p.next, b) and _locally_inside(a, b) and _locally_inside(b, a):
            triangles += (a.i // 2, p.i // 2, b.i // 2)
            _remove_node(p)
            _remove_node(p.next)
            p = start = b
        p = p.next
        if p is start:
            break
    return _filter_points(p)


def _split_earcut(start, triangles):
    a = start
    while True:
        b = a.next.next
        while b is not a.prev:
            if a.i != b.i and _is_valid_diagonal(a, b):
                c = _split_polygon(a, b)
                a = _filter_points(a, a.next)
                c = _filter_points(c, c.next)
                _earcut_linked(a, triangles, 0)
                _earcut_linked(c, triangles, 0)
                return
            b = b.next
        a = a.next
        if a is start:
            break


def _eliminate_holes(data, hole_indices, outer):
    queue = []
    for k, h in enumerate(hole_indices):
        start = h * 2
        end = hole_indices[k + 1] * 2 if k < len(hole_indices) - 1 else len(data)
        lst = _linked_list(data, start, end, False)
        if lst is None:
            continue
        if lst is lst.next:
            lst.steiner = True
        queue.append(_get_leftmost(lst))
    queue.sort(key=lambda n: n.x)
    for hole in queue:
        outer = _eliminate_hole(hole, outer)
    return outer


def _eliminate_hole(hole, outer):
    bridge = _find_hole_bridge(hole, outer)
    if bridge is None:
        return outer
    bridge_reverse = _split_polygon(bridge, hole)
    _filter_points(bridge_reverse, bridge_reverse.next)
    return _filter_points(bridge, bridge.next)


def _find_hole_bridge(hole, outer):
    """David Eberly's algorithm for finding a bridge between a hole and the outer polygon."""
    p, hx, hy, qx, m = outer, hole.x, hole.y, float("-inf"), None
    while True:
        if hy <= p.y and hy >= p.next.y and p.next.y != p.y:
            x = p.x + (hy - p.y) * (p.next.x - p.x) / (p.next.y - p.y)
            if hx >= x > qx:
                qx = x
                m = p if p.x < p.next.x else p.next
                if x == hx:
                    return m
        p = p.next
        if p is outer:
            break
    if m is None:
        return None
    stop, mx, my, tan_min = m, m.x, m.y, float("inf")
    p = m
    while True:
        if (hx >= p.x >= mx and hx != p.x
                and _point_in_triangle(hx if hy < my else qx, hy, mx, my, qx if hy < my else hx, hy, p.x, p.y)):
            tan = abs(hy - p.y) / (hx - p.x)
            if _locally_inside(p, hole) and (
                tan < tan_min or (tan == tan_min and (p.x > m.x or (p.x == m.x and _sector_contains_sector(m, p))))
            ):
                m, tan_min = p, tan
        p = p.next
        if p is stop:
            break
    return m


def _sector_contains_sector(m, p):
    return _area(m.prev, m, p.prev) < 0 and _area(p.next, m, m.next) < 0


def _get_leftmost(start):
    p = leftmost = start
    while True:
        if p.x < leftmost.x or (p.x == leftmost.x and p.y < leftmost.y):
            leftmost = p
        p = p.next
        if p is start:
            break
    return leftmost


def _point_in_triangle(ax, ay, bx, by, cx, cy, px, py):
    return ((cx - px) * (ay - py) >= (ax - px) * (cy - py) and (ax - px) * (by - py) >= (bx - px) * (ay - py)
            and (bx - px) * (cy - py) >= (cx - px) * (by - py))


def _is_valid_diagonal(a, b):
    return (a.next.i != b.i and a.prev.i != b.i and not _intersects_polygon(a, b) and (
        (_locally_inside(a, b) and _locally_inside(b, a) and _middle_inside(a, b)
         and (_area(a.prev, a, b.prev) != 0 or _area(a, b.prev, b) != 0))
        or (_equals(a, b) and _area(a.prev, a, a.next) > 0 and _area(b.prev, b, b.next) > 0)))


def _area(p, q, r):
    return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y)


def _equals(p1, p2):
    return p1.x == p2.x and p1.y == p2.y


def _sign(v):
    return (v > 0) - (v < 0)


def _on_segment(p, q, r):
    return min(p.x, r.x) <= q.x <= max(p.x, r.x) and min(p.y, r.y) <= q.y <= max(p.y, r.y)


def _intersects(p1, q1, p2, q2):
    o1, o2 = _sign(_area(p1, q1, p2)), _sign(_area(p1, q1, q2))
    o3, o4 = _sign(_area(p2, q2, p1)), _sign(_area(p2, q2, q1))
    if o1 != o2 and o3 != o4:
        return True
    return ((o1 == 0 and _on_segment(p1, p2, q1)) or (o2 == 0 and _on_segment(p1, q2, q1))
            or (o3 == 0 and _on_segment(p2, p1, q2)) or (o4 == 0 and _on_segment(p2, q1, q2)))


def _intersects_polygon(a, b):
    p = a
    while True:
        if p.i != a.i and p.next.i != a.i and p.i != b.i and p.next.i != b.i and _intersects(p, p.next, a, b):
            return True
        p = p.next
        if p is a:
            return False


def _locally_inside(a, b):
    if _area(a.prev, a, a.next) < 0:
        return _area(a, b, a.next) >= 0 and _area(a, a.prev, b) >= 0
    return _area(a, b, a.prev) < 0 or _area(a, a.next, b) < 0


def _middle_inside(a, b):
    p, inside, px, py = a, False, (a.x + b.x) / 2, (a.y + b.y) / 2
    while True:
        if ((p.y > py) != (p.next.y > py)) and p.next.y != p.y and px < (p.next.x - p.x) * (py - p.y) / (p.next.y - p.y) + p.x:
            inside = not inside
        p = p.next
        if p is a:
            return inside


def _split_polygon(a, b):
    a2, b2 = _Node(a.i, a.x, a.y), _Node(b.i, b.x, b.y)
    an, bp = a.next, b.prev
    a.next, b.prev = b, a
    a2.next, an.prev = an, a2
    a2.prev, b2.next = b2, a2
    b2.prev, bp.next = bp, b2
    return b2


def _insert_node(i, x, y, last):
    p = _Node(i, x, y)
    if last is None:
        p.prev = p.next = p
    else:
        p.next, p.prev = last.next, last
        last.next.prev = p
        last.next = p
    return p


def _remove_node(p):
    p.next.prev = p.prev
    p.prev.next = p.next


def _signed_area(data, start, end):
    total, j = 0, end - 2
    for i in range(start, end, 2):
        total += (data[j] - data[i]) * (data[i + 1] + data[j + 1])
        j = i
    return total
