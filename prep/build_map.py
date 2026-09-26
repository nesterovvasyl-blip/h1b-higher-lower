"""Build map.json: California county outlines as one SVG path + projected city points.

Source: us-atlas counties-10m TopoJSON (Census cartographic boundaries, clipped to
shoreline, so the Bay shows as water). Projection: equirectangular with cos(lat0)
scaling — fine for a schematic of one state.

Run: python3 prep/build_map.py
"""
import json
import math
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "prep" / "raw"
SRC_URL = "https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json"
SRC = RAW / "counties-10m.json"
OUT = ROOT / "map.json"

LAT0 = 37.0
K = 100  # SVG units per degree of latitude

# (lat, lon) for every city in data.json; cities missing here get no map.
CITIES = {
    "Burlingame": (37.584, -122.366), "Carlsbad": (33.158, -117.351),
    "Concord": (37.978, -122.031), "Culver City": (34.021, -118.396),
    "Cupertino": (37.323, -122.032), "Dublin": (37.702, -121.936),
    "Folsom": (38.678, -121.176), "Foster City": (37.559, -122.271),
    "Fremont": (37.548, -121.989), "Irvine": (33.684, -117.826),
    "Los Angeles": (34.052, -118.244), "Los Gatos": (37.227, -121.975),
    "Menlo Park": (37.453, -122.182), "Milpitas": (37.428, -121.907),
    "Mountain House": (37.783, -121.543), "Mountain View": (37.386, -122.084),
    "Oakland": (37.804, -122.271), "Palo Alto": (37.442, -122.143),
    "Pleasanton": (37.662, -121.875), "Redwood City": (37.485, -122.236),
    "Redwood Shores": (37.531, -122.248), "Roseville": (38.752, -121.288),
    "San Bruno": (37.630, -122.411), "San Diego": (32.716, -117.161),
    "San Francisco": (37.775, -122.419), "San Jose": (37.338, -121.886),
    "San Leandro": (37.725, -122.156), "San Mateo": (37.563, -122.326),
    "Santa Clara": (37.354, -121.955), "Santa Monica": (34.019, -118.491),
    "South San Francisco": (37.655, -122.408), "Stanford": (37.424, -122.166),
    "Sunnyvale": (37.369, -122.036), "Torrance": (33.836, -118.341),
    "Tracy": (37.740, -121.426), "Woodland Hills": (34.168, -118.606),
    # orientation labels only
    "Sacramento": (38.582, -121.494),
}
LANDMARKS = ["San Francisco", "Oakland", "San Jose", "Sacramento", "Los Angeles", "San Diego"]


def project(lon, lat):
    x = lon * math.cos(math.radians(LAT0)) * K
    y = -lat * K
    return x, y


def decode_arcs(topo):
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)
    return arcs


def ring_points(ring, arcs):
    pts = []
    for i in ring:
        a = arcs[i] if i >= 0 else arcs[~i][::-1]
        pts.extend(a if not pts else a[1:])
    return pts


def main():
    if not SRC.exists():
        print(f"downloading {SRC_URL}")
        urllib.request.urlretrieve(SRC_URL, SRC)
    topo = json.loads(SRC.read_text())
    arcs = decode_arcs(topo)

    ca = [g for g in topo["objects"]["counties"]["geometries"] if str(g.get("id", "")).startswith("06")]
    d = []
    for g in ca:
        polys = g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]]
        for poly in polys:
            for ring in poly:
                pts = [project(*p) for p in ring_points(ring, arcs)]
                d.append("M" + "L".join(f"{x:.1f},{y:.1f}" for x, y in pts) + "Z")

    all_pts = [project(*p) for g in ca for poly in (g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]])
               for ring in poly for p in ring_points(ring, arcs)]
    xs, ys = zip(*all_pts)
    out = {
        "bbox": [round(min(xs), 1), round(min(ys), 1), round(max(xs) - min(xs), 1), round(max(ys) - min(ys), 1)],
        "path": "".join(d),
        "cities": {c: [round(v, 1) for v in project(lon, lat)] for c, (lat, lon) in CITIES.items()},
        "landmarks": LANDMARKS,
    }
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"{len(ca)} CA counties, {OUT.name} {OUT.stat().st_size / 1024:.0f} KB")

    data = json.loads((ROOT / "data.json").read_text())
    missing = sorted({r["city"] for r in data} - CITIES.keys())
    print("cities without coords:", missing or "none")


if __name__ == "__main__":
    main()
