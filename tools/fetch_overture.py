#!/usr/bin/env python3
"""Download café and bar places from Overture Maps (https://overturemaps.org) for build_cafes.py.

Overture is only published as GeoParquet, so this one tool needs DuckDB:
    pip install duckdb
    python3 tools/fetch_overture.py [release]      # e.g. 2026-11-18.0; default: the latest
Writes tools/cache/overture.places.json. Run after build_buildings.py and before build_cafes.py.
Licence: CDLA-Permissive-2.0 (some sources Apache-2.0); credit "Overture Maps Foundation".
"""
import json
import os
import re
import sys
import urllib.request

from common import CACHE, core_bbox, load_buildings

BUCKET = "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/"
# Overture taxonomy categories that are cafés, bars or pubs (restaurants, shops and clubs are left out).
CATEGORIES = [
    "cafe", "coffee_shop", "tea_room", "bar", "pub", "irish_pub", "gastropub", "wine_bar", "cocktail_bar",
    "beer_bar", "whiskey_bar", "sports_bar", "lounge", "beer_garden", "hookah_bar", "gay_bar",
]


def latest_release():
    with urllib.request.urlopen(BUCKET + "?list-type=2&prefix=release/&delimiter=/", timeout=60) as r:
        return sorted(re.findall(r"<Prefix>release/([^/<]+)/", r.read().decode()))[-1]


def main():
    import duckdb  # only this tool needs it

    release = sys.argv[1] if len(sys.argv) > 1 else latest_release()
    w, s, e, n = core_bbox(*load_buildings())
    con = duckdb.connect()
    con.sql("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    cats = ", ".join(f"'{c}'" for c in CATEGORIES)
    rows = con.sql(f"""
        SELECT id, names.primary, taxonomy.primary, confidence, operating_status, bbox.xmin, bbox.ymin, websites[1]
        FROM read_parquet('s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*.parquet')
        WHERE bbox.xmin BETWEEN {w} AND {e} AND bbox.ymin BETWEEN {s} AND {n} AND taxonomy.primary IN ({cats})
    """).fetchall()
    keys = ["id", "name", "category", "confidence", "status", "lon", "lat", "website"]
    os.makedirs(CACHE, exist_ok=True)
    with open(os.path.join(CACHE, "overture.places.json"), "w", encoding="utf-8") as f:
        json.dump({"release": release, "places": [dict(zip(keys, r)) for r in rows]}, f, ensure_ascii=False)
    print(f"  release {release}: {len(rows)} cafés and bars")


if __name__ == "__main__":
    main()
