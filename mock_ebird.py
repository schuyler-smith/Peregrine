"""Sample-data stand-in for eBird and Nominatim, used only for testing
(start the server with PEREGRINE_MOCK=1). Nothing here is real bird data."""
import hashlib
import re

SPECIES = [
    ("amecro", "American Crow", "Corvus brachyrhynchos", 0.95),
    ("blujay", "Blue Jay", "Cyanocitta cristata", 0.9),
    ("bkcchi", "Black-capped Chickadee", "Poecile atricapillus", 0.9),
    ("norcar", "Northern Cardinal", "Cardinalis cardinalis", 0.85),
    ("dowwoo", "Downy Woodpecker", "Dryobates pubescens", 0.8),
    ("whbnut", "White-breasted Nuthatch", "Sitta carolinensis", 0.75),
    ("mallar3", "Mallard", "Anas platyrhynchos", 0.8),
    ("cangoo", "Canada Goose", "Branta canadensis", 0.85),
    ("daejun", "Dark-eyed Junco", "Junco hyemalis", 0.7),
    ("eursta", "European Starling", "Sturnus vulgaris", 0.8),
    ("rebwoo", "Red-bellied Woodpecker", "Melanerpes carolinus", 0.6),
    ("tuftit", "Tufted Titmouse", "Baeolophus bicolor", 0.6),
    ("haiwoo", "Hairy Woodpecker", "Dryobates villosus", 0.45),
    ("gbheron", "Great Blue Heron", "Ardea herodias", 0.5),
    ("rethaw", "Red-tailed Hawk", "Buteo jamaicensis", 0.6),
    ("baleag", "Bald Eagle", "Haliaeetus leucocephalus", 0.4),
    ("buffle", "Bufflehead", "Bucephala albeola", 0.35),
    ("hoomer", "Hooded Merganser", "Lophodytes cucullatus", 0.3),
    ("gnwtea", "Green-winged Teal", "Anas crecca", 0.2),
    ("amtspa", "American Tree Sparrow", "Spizelloides arborea", 0.35),
    ("whtspa", "White-throated Sparrow", "Zonotrichia albicollis", 0.45),
    ("gockin", "Golden-crowned Kinglet", "Regulus satrapa", 0.3),
    ("brncre", "Brown Creeper", "Certhia americana", 0.25),
    ("pilwoo", "Pileated Woodpecker", "Dryocopus pileatus", 0.25),
    ("cedwax", "Cedar Waxwing", "Bombycilla cedrorum", 0.3),
    ("pinsis", "Pine Siskin", "Spinus pinus", 0.15),
    ("evegro", "Evening Grosbeak", "Coccothraustes vespertinus", 0.08),
    ("snobun", "Snow Bunting", "Plectrophenax nivalis", 0.1),
    ("roughl", "Rough-legged Hawk", "Buteo lagopus", 0.1),
    ("snoowl1", "Snowy Owl", "Bubo scandiacus", 0.05),
    ("tunswa", "Tundra Swan", "Cygnus columbianus", 0.12),
    ("lotduc", "Long-tailed Duck", "Clangula hyemalis", 0.1),
    ("comgol", "Common Goldeneye", "Bucephala clangula", 0.25),
    ("rengre", "Red-necked Grebe", "Podiceps grisegena", 0.04),
    ("norshr", "Northern Shrike", "Lanius borealis", 0.07),
    ("bohwax", "Bohemian Waxwing", "Bombycilla garrulus", 0.03),
]


def _h(*parts):
    return int(hashlib.md5("|".join(map(str, parts)).encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


def answer(path, query):
    if path.startswith("ref/taxonomy"):
        return [{"sciName": s, "speciesCode": c, "comName": n, "category": "species"} for c, n, s, p in SPECIES]
    if path.startswith("ref/hotspot/geo"):
        lat = float(query.get("lat", 0)); lng = float(query.get("lng", 0))
        county = "US-NY-%03d" % (int(_h(round(lat, 1), round(lng, 1)) * 120) + 1)
        names = ["Marsh Trail", "Lakeshore Park", "Old Quarry", "Hawk Ridge", "River Flats",
                 "Pine Woods", "Sewage Ponds", "Cemetery", "Sod Farm", "Harbor Jetty", "Town Park", "Bog"]
        import math
        dist = float(query.get("dist", 25))
        out = []
        for i, nm in enumerate(names):
            # Spread the sample hotspots over a 50 km circle; eBird only returns those within dist.
            r_km = 50 * _h(i, "r") ** 0.6
            ang = _h(i, "a") * 2 * math.pi
            if r_km > dist:
                continue
            hlat = lat + r_km * math.cos(ang) / 111.0
            hlng = lng + r_km * math.sin(ang) / (111.0 * max(0.2, math.cos(math.radians(lat))))
            out.append({"locId": "L%d" % (int(_h(round(lat, 2), round(lng, 2), i) * 1e6)), "locName": "Sample " + nm,
                        "countryCode": "US", "subnational1Code": "US-NY", "subnational2Code": county,
                        "lat": hlat, "lng": hlng,
                        "numSpeciesAllTime": int(80 + _h(lat, i) * 200)})
        return out
    if path.startswith("product/spplist/"):
        loc = path.rsplit("/", 1)[-1]
        return [c for c, n, s_, p in SPECIES if _h(loc, c) < 0.25 + p * 0.6]
    if path.startswith("ref/region/info/"):
        code = path.rsplit("/", 1)[-1]
        return {"result": "Sample County %s, New York, US" % code[-3:]}
    m = re.match(r"data/obs/([^/]+)/historic/(\d+)/(\d+)/(\d+)", path)
    if m:
        import os, random
        if random.random() < float(os.environ.get("PEREGRINE_MOCK_FAIL", os.environ.get("BIRDTRIP_MOCK_FAIL", "0"))):
            raise RuntimeError("simulated eBird hiccup")
        region, y, mo, d = m.groups()
        if _h(region, y, mo, d, "empty") < 0.04:
            return []  # a day with no checklists
        bias = _h(region) * 0.3 - 0.15
        return [{"speciesCode": c, "comName": n, "sciName": s, "locName": "Sample", "howMany": 1}
                for c, n, s, p in SPECIES if _h(region, y, mo, d, c) < max(0.0, p + bias)]
    if path.startswith("data/obs/geo/recent"):
        return [{"speciesCode": c, "comName": n, "sciName": s}
                for c, n, s, p in SPECIES if _h("recent", query.get("lat"), c) < p * 0.6]
    return []


def drive(src, dests):
    """Made-up OSRM table answer: road distance about 1.3x straight-line, at 55 km/h."""
    import math
    def km(a, b):
        r = math.pi / 180
        h = math.sin((b[0] - a[0]) * r / 2) ** 2 + math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin((b[1] - a[1]) * r / 2) ** 2
        return 2 * 6371 * math.asin(math.sqrt(h))
    pts = [src] + list(dests)
    dist = [km(src, p) * 1300 for p in pts]
    return {"code": "Ok", "durations": [[d / 1000 / 55 * 3600 for d in dist]], "distances": [dist],
            "sources": [{"distance": 5.0}],
            "destinations": [{"distance": 900.0 if _h(p, "snap") < 0.15 else 20.0} for p in pts]}


def geocode(endpoint, query):
    if endpoint == "reverse":
        return {"name": "Sample Place", "display_name": "Sample Place, New York, USA",
                "address": {"town": "Sample Town", "county": "Sample County", "state": "New York"}}
    q = query.get("q", "Place")
    if "nowhere" in q.lower():
        return []
    off = _h(q)
    return [{"display_name": "%s, New York, USA" % q, "name": q.split(",")[0],
             "lat": str(42.0 + off * 1.5 + i * 0.3), "lon": str(-78.0 + off * 3 + i * 0.4)} for i in range(3)]
