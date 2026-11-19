#!/usr/bin/env python3
"""Peregrine - bird trip planner, local server.

Serves the web app and acts as a small proxy so the browser can talk to the
eBird API (which needs your API key in a header) and to OpenStreetMap's
Nominatim place search. Responses are cached on disk in ./cache so that
re-opening a trip is fast and eBird isn't asked the same thing twice.

Only the Python standard library is used. Run:  python server.py
"""
import base64
import csv
import datetime as dt
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import xml.etree.ElementTree as ET
import zipfile
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
DATA = os.path.join(ROOT, "data")
TRIPS = os.path.join(DATA, "trips")
CACHE = os.path.join(ROOT, "cache")
SETTINGS_FILE = os.path.join(DATA, "settings.json")
LIFELIST_FILE = os.path.join(DATA, "lifelist.json")

EBIRD = "https://api.ebird.org/v2/"
NOMINATIM = "https://nominatim.openstreetmap.org/"
USER_AGENT = "Peregrine-BirdTripPlanner/1.0 (personal, locally hosted)"

def env(name, default=""):
    """Settings come from PEREGRINE_<name> (older BIRDTRIP_<name> still works)."""
    return os.environ.get("PEREGRINE_" + name, os.environ.get("BIRDTRIP_" + name, default))


MOCK = env("MOCK") == "1"  # test-only sample data

# Running on a server (e.g. in Docker) - all optional; defaults are "this computer only".
HOST = env("HOST", "127.0.0.1")            # 0.0.0.0 = listen on the network
PASSWORD = env("PASSWORD")             # optional: ask for a password (any username)
ALLOWED_HOSTS = [h.strip().lower() for h in
                 env("ALLOWED_HOSTS").split(",") if h.strip()]
LOCAL_ONLY = HOST in ("127.0.0.1", "localhost", "::1")

for d in (DATA, TRIPS, CACHE):
    os.makedirs(d, exist_ok=True)

_upstream = threading.Semaphore(2)       # be polite to eBird: 2 at a time...
_pace_lock = threading.Lock()            # ...and at most ~3 new requests per second
_last_ebird = [0.0]
EBIRD_GAP = 0.34
_nominatim_lock = threading.Lock()       # Nominatim asks for <= 1 request/sec
_last_nominatim = [0.0]
_file_lock = threading.Lock()


# ---------------------------------------------------------------- helpers
def read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, obj):
    tmp = path + ".tmp"
    with _file_lock:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)


def get_key():
    return ((read_json(SETTINGS_FILE, {}).get("apiKey") or "").strip()
            or os.environ.get("EBIRD_API_KEY", "").strip())


def cache_ttl(path):
    """How long (seconds) to keep an eBird answer. None = forever."""
    m = re.search(r"/historic/(\d{4})/(\d{1,2})/(\d{1,2})", path)
    if m:
        try:
            day = dt.date(int(m[1]), int(m[2]), int(m[3]))
        except ValueError:
            return 86400
        # Old checklists rarely change; recent days still fill in.
        return None if (dt.date.today() - day).days > 60 else 86400
    if path.startswith("ref/") or path.startswith("product/spplist/"):
        return 30 * 86400
    return 3600  # recent observations


def cache_get(key, ttl):
    p = os.path.join(CACHE, hashlib.sha1(key.encode()).hexdigest() + ".json")
    entry = read_json(p, None)
    if not entry:
        return None
    if ttl is not None and time.time() - entry.get("ts", 0) > ttl:
        return None
    return entry.get("body")


def cache_put(key, body):
    p = os.path.join(CACHE, hashlib.sha1(key.encode()).hexdigest() + ".json")
    write_json(p, {"ts": time.time(), "key": key, "body": body})


class UpstreamError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def log_problem(msg):
    line = "%s  %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    print("  ! " + msg)
    try:
        with _file_lock, open(os.path.join(DATA, "problems.log"), "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def fetch(url, headers, tries=3, timeout=30):
    req = urllib.request.Request(url, headers=headers)
    delay = 2.0
    short = url.split("?")[0].replace(EBIRD, "eBird ")
    for attempt in range(tries):
        last = attempt == tries - 1
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8") or "null")
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and not last:
                wait = delay
                ra = e.headers.get("Retry-After") if e.headers else None
                if ra and ra.isdigit():
                    wait = min(int(ra), 60)
                log_problem("%s -> HTTP %s, retrying in %ds" % (short, e.code, wait))
                time.sleep(wait)
                delay *= 2
                continue
            log_problem("%s -> HTTP %s" % (short, e.code))
            if e.code == 429:
                raise UpstreamError(429, "eBird says we're asking too fast. Wait a few minutes and try again.")
            if e.code in (401, 403):
                raise UpstreamError(401, "eBird rejected the API key. Check it in Settings.")
            if e.code in (400, 404):
                raise UpstreamError(e.code, "eBird couldn't answer that request (%s)." % e.code)
            raise UpstreamError(502, "eBird returned an error (%s)." % e.code)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            log_problem("%s -> %s%s" % (short, getattr(e, "reason", e), "" if last else ", retrying"))
            if not last:
                time.sleep(delay)
                delay *= 2
                continue
            raise UpstreamError(503, "Couldn't reach the internet service (%s)." % getattr(e, "reason", e))
    raise UpstreamError(503, "Service unavailable.")


def ebird_get(path, query):
    """Fetch eBird path (e.g. 'data/obs/US-NY-109/historic/2023/5/14')."""
    qs = urllib.parse.urlencode(sorted(query.items()))
    key = "ebird:" + path + "?" + qs
    ttl = cache_ttl(path)
    hit = cache_get(key, ttl)
    if hit is not None:
        return hit
    if MOCK:
        import mock_ebird
        body = mock_ebird.answer(path, query)
    else:
        api_key = get_key()
        if not api_key:
            raise UpstreamError(400, "No eBird API key yet. Add it in Settings.")
        with _upstream:
            with _pace_lock:
                wait = EBIRD_GAP - (time.time() - _last_ebird[0])
                if wait > 0:
                    time.sleep(wait)
                _last_ebird[0] = time.time()
            body = fetch(EBIRD + path + ("?" + qs if qs else ""),
                         {"X-eBirdApiToken": api_key, "User-Agent": USER_AGENT},
                         tries=5, timeout=60)
    cache_put(key, body)
    return body


def nominatim_get(endpoint, query):
    qs = urllib.parse.urlencode(sorted(query.items()))
    key = "nominatim:" + endpoint + "?" + qs
    hit = cache_get(key, 30 * 86400)
    if hit is not None:
        return hit
    if MOCK:
        import mock_ebird
        body = mock_ebird.geocode(endpoint, query)
    else:
        with _nominatim_lock:
            wait = 1.05 - (time.time() - _last_nominatim[0])
            if wait > 0:
                time.sleep(wait)
            try:
                body = fetch(NOMINATIM + endpoint + "?" + qs, {"User-Agent": USER_AGENT})
            finally:
                _last_nominatim[0] = time.time()
    cache_put(key, body)
    return body


# ---------------------------------------------------------------- life list
def binomial(sci):
    parts = (sci or "").strip().split()
    return " ".join(parts[:2]).lower()


def parse_lifelist(raw):
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    rows = list(csv.reader(io.StringIO(text)))
    header_i = None
    for i, row in enumerate(rows[:20]):
        lowered = [c.strip().lower() for c in row]
        if "common name" in lowered or "scientific name" in lowered:
            header_i = i
            break
    if header_i is None:
        raise ValueError("This doesn't look like an eBird life list CSV "
                         "(no 'Common Name' / 'Scientific Name' column).")
    header = [c.strip().lower() for c in rows[header_i]]
    ci = header.index("common name") if "common name" in header else None
    si = header.index("scientific name") if "scientific name" in header else None
    cat_i = header.index("category") if "category" in header else None
    seen, species = set(), []
    for row in rows[header_i + 1:]:
        com = row[ci].strip() if ci is not None and ci < len(row) else ""
        sci = row[si].strip() if si is not None and si < len(row) else ""
        cat = row[cat_i].strip().lower() if cat_i is not None and cat_i < len(row) else ""
        if not com and not sci:
            continue
        # Skip things that aren't a species: "duck sp.", slashes, hybrids, domestics.
        if cat in ("spuh", "slash", "hybrid", "domestic"):
            continue
        # (a "/" after the first two words is a subspecies group, which is fine)
        if " sp." in com or "/" in binomial(sci) or " x " in sci or sci.endswith(" sp."):
            continue
        com_clean = re.sub(r"\s*\(.*?\)\s*$", "", com).strip()
        k = binomial(sci) or com_clean.lower()
        if k in seen:
            continue
        seen.add(k)
        species.append({"com": com_clean, "sci": " ".join(sci.split()[:2])})
    if not species:
        raise ValueError("No species found in that file.")
    return species


# ---------------------------------------------------------------- route import
MAX_IMPORT = 25
COORD_RE = re.compile(r"^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$")
SHORT_LINK = re.compile(r"^https?://(maps\.app\.goo\.gl|goo\.gl/maps|g\.co/kgs)/", re.I)


def _coord(text):
    m = COORD_RE.match(text or "")
    if not m:
        return None
    lat, lng = float(m[1]), float(m[2])
    return (lat, lng) if -90 <= lat <= 90 and -180 <= lng <= 180 else None


def _spread(points, k):
    """Pick k points evenly along a path (always keeping the start and the end)."""
    if len(points) <= k:
        return points
    return [points[round(i * (len(points) - 1) / (k - 1))] for i in range(k)]


def expand_short_link(url):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **kw):
            return None
    opener = urllib.request.build_opener(NoRedirect)
    for _ in range(5):
        if "google." in urllib.parse.urlsplit(url).netloc and "/maps" in url:
            return url
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 " + USER_AGENT})
        try:
            r = opener.open(req, timeout=15)
            loc = r.headers.get("Location")
            r.close()
        except urllib.error.HTTPError as e:
            loc = e.headers.get("Location") if e.headers else None
        except (urllib.error.URLError, OSError):
            loc = None
        if not loc:
            break
        url = urllib.parse.urljoin(url, loc)
    if "google." in urllib.parse.urlsplit(url).netloc and "/maps" in url:
        return url
    raise ValueError("Couldn't open that short link. Open it in your browser, then copy the full "
                     "address from the address bar (it starts with https://www.google.com/maps/) and paste that.")


def parse_google_maps(url):
    """Stops from a Google Maps link: /maps/dir/A/B/C, /maps/place/X, ?q=, ?api=1&origin=..."""
    if SHORT_LINK.match(url):
        url = expand_short_link(url)
    u = urllib.parse.urlsplit(url)
    q = dict(urllib.parse.parse_qsl(u.query))
    segs = u.path.split("/")
    out = []
    if "dir" in segs:
        names = []
        for seg in segs[segs.index("dir") + 1:]:
            if seg.startswith("@") or seg.startswith("data="):
                break
            if seg:  # an empty piece is "your location"
                names.append(urllib.parse.unquote_plus(seg).strip())
        # Exact positions for named places are in the data part as !1d<lng>!2d<lat>, in order.
        exact = [(float(b), float(a)) for a, b in re.findall(r"!1d(-?\d+\.\d+)!2d(-?\d+\.\d+)", url)]
        named = [n for n in names if not _coord(n)]
        exact_iter = iter(exact) if len(exact) == len(named) else None
        for n in names:
            c = _coord(n)
            if c:
                out.append({"name": None, "lat": c[0], "lng": c[1]})
            else:
                e = next(exact_iter) if exact_iter else None
                out.append({"name": n.split(",")[0].strip() if e else n,
                            "query": n, "lat": e[0] if e else None, "lng": e[1] if e else None})
    if not out and "place" in segs:
        i = segs.index("place")
        name = urllib.parse.unquote_plus(segs[i + 1]) if len(segs) > i + 1 else ""
        m = re.search(r"!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)", url) or re.search(r"/@(-?\d+\.\d+),(-?\d+\.\d+)", url)
        out.append({"name": name.split(",")[0] or None, "query": name,
                    "lat": float(m[1]) if m else None, "lng": float(m[2]) if m else None})
    if out:
        pass
    elif q.get("origin") or q.get("destination") or q.get("waypoints"):
        seq = [q.get("origin", "")] + q.get("waypoints", "").split("|") + [q.get("destination", "")]
        out = [{"name": None, "query": x.strip()} for x in seq if x.strip()]
    elif q.get("daddr") or q.get("saddr"):
        seq = [q.get("saddr", "")] + re.split(r"\s+to:\s*", q.get("daddr", ""))
        out = [{"name": None, "query": x.strip()} for x in seq if x.strip()]
    elif q.get("q"):
        out = [{"name": None, "query": q["q"].strip()}]
    if not out:
        raise ValueError("That Google Maps link doesn't list any stops. Open your directions with "
                         "all the stops added, then use Share → Copy link.")
    return out


DAY_RE = re.compile(r"^\s*(?:days?|nights?|d)\s*(\d{1,3})(?:\s*(?:[-–—&]|to)\s*\d{1,3})?\s*[:.\-–—)]*\s*(.*)$", re.I)
TRAVEL_RE = re.compile(r"^(?:(?:early\s+)?(?:morning|afternoon|evening)\s*:?\s*)?(?:we\s+)?(?:drive|driving|transfer|fly|flight|travel|depart(?:ure)?|arrive|arrival|return|continue|head|journey|move|go)\w*\s+(?:back\s+)?(?:to|in|at|into|for|from)?\s*", re.I)


NOT_PLACES = {"home", "arrival", "arrive", "departure", "depart", "departures", "end of tour", "tour ends",
              "free day", "rest day", "flight home", "international flight", "international flights",
              "the airport", "airport", "tbd", "tba", "travel day", "at leisure"}


def clean_place(text):
    """Turn an itinerary phrase like 'Drive to Kruger NP, birding en route' into a place."""
    t = text.strip()
    for _ in range(2):
        t = TRAVEL_RE.sub("", t).strip()
    # "Johannesburg to Wakkerstroom" -> where you end up that day
    m = re.match(r"^(.+?)\s+(?:to|→|->)\s+(.+)$", t)
    if m and len(m[2]) > 2:
        t = m[2]
    t = re.split(r"\s+[-–—]\s+|;|\(|\.\s|\.$|,\s*(?:birding|then|with|where)\b|\s+(?:birding|where|with|for|via|and then|then|en route|overnight)\b", t, maxsplit=1)[0]
    return t.strip(" .,:;")


def parse_place_list(text, suffix=""):
    out = []
    for line in text.splitlines():
        day = None
        m = DAY_RE.match(line)
        if m:
            day, line = int(m[1]), clean_place(m[2])
            if line.lower() in NOT_PLACES:
                continue
        else:
            # drop list markers like "1. ", "2) ", "- ", "• " (but not the "42." of "42.44, -76.5")
            line = re.sub(r"^\s*(?:\d+[.)]\s+|[-*•]\s*)", "", line).strip()
        if not line:
            continue
        c = _coord(line)
        if c:
            item = {"name": None, "lat": c[0], "lng": c[1]}
        else:
            q = line if not suffix or suffix.lower() in line.lower() else "%s, %s" % (line, suffix)
            item = {"name": None, "query": q, "label": line}
        item["day"] = day
        # A stay written on several lines ("Day 4: Kruger", "Day 5: Kruger") is one stop.
        if out and day is not None and item.get("label") and \
                item["label"].lower() == (out[-1].get("label") or "").lower():
            continue
        out.append(item)
    return out


def _kml_coords(text):
    pts = []
    for tok in (text or "").split():
        bits = tok.split(",")
        try:
            pts.append({"name": None, "lat": float(bits[1]), "lng": float(bits[0])})
        except (IndexError, ValueError):
            pass
    return pts


def parse_route_file(raw, filename):
    if raw[:2] == b"PK":  # KMZ is a zip with a .kml inside
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                kml = [n for n in z.namelist() if n.lower().endswith(".kml")]
                if not kml:
                    raise ValueError("There's no KML inside that KMZ file.")
                raw = z.read(kml[0])
        except zipfile.BadZipFile:
            raise ValueError("Couldn't open that KMZ file.")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        raise ValueError("Couldn't read that file. Use a GPX, KML or KMZ file.")
    local = lambda el: el.tag.rsplit("}", 1)[-1].lower() if isinstance(el.tag, str) else ""
    def child_name(el):
        for c in el:
            if local(c) == "name" and (c.text or "").strip():
                return c.text.strip()
        return None
    wpts, route, track = [], [], []
    for el in root.iter():
        t = local(el)
        if t in ("wpt", "rtept", "trkpt"):
            try:
                p = {"name": child_name(el), "lat": float(el.get("lat")), "lng": float(el.get("lon"))}
            except (TypeError, ValueError):
                continue
            {"wpt": wpts, "rtept": route, "trkpt": track}[t].append(p)
        elif t == "placemark":
            name = child_name(el)
            for c in el.iter():
                ct = local(c)
                if ct in ("point", "linestring"):
                    for cc in c.iter():
                        if local(cc) == "coordinates":
                            pts = _kml_coords(cc.text)
                            if ct == "point" and pts:
                                wpts.append(dict(pts[0], name=name))
                            elif ct == "linestring":
                                track.extend(pts)
    notes = []
    if wpts:
        stops = wpts
    elif route:
        stops = _spread(route, 10) if not any(p["name"] for p in route) else route
    elif track:
        stops = _spread(track, 6)
        notes.append("That file is a path without named stops, so I picked 6 evenly spaced points "
                     "along it. Move or delete any you don't want.")
    else:
        raise ValueError("No places or route found in that file.")
    return stops, notes


def resolve_stops(items):
    """Look up places that came without coordinates (Nominatim, about 1 per second)."""
    stops, failed, notes = [], [], []
    if len(items) > MAX_IMPORT:
        notes.append("Only the first %d stops were imported." % MAX_IMPORT)
        items = items[:MAX_IMPORT]
    for it in items:
        if it.get("lat") is not None and it.get("lng") is not None:
            stops.append({"name": it.get("name"), "lat": it["lat"], "lng": it["lng"], "day": it.get("day")})
            continue
        qtext = it.get("query") or it.get("name") or ""
        try:
            res = nominatim_get("search", {"q": qtext, "format": "jsonv2", "limit": "1"})
        except UpstreamError:
            res = []
        if res:
            r = res[0]
            nm = it.get("label") or r.get("name") or r.get("display_name", qtext).split(",")[0]
            stops.append({"name": nm or qtext, "lat": float(r["lat"]), "lng": float(r["lon"]), "day": it.get("day")})
        else:
            failed.append(it.get("label") or qtext)
    return {"stops": stops, "failed": failed, "notes": notes}


# ---------------------------------------------------------------- handler
TRIP_ID = re.compile(r"^[a-z0-9-]{1,80}$")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def log_message(self, fmt, *args):  # keep the console quiet
        if env("VERBOSE"):
            super().log_message(fmt, *args)

    def end_headers(self):
        if not self.path.startswith("/vendor/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # -- small response helpers
    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def error_json(self, status, message):
        self.send_json({"error": message}, status)

    def body_bytes(self, limit=20 * 1024 * 1024):
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            raise ValueError("Upload too large.")
        return self.rfile.read(n) if n else b""

    # -- safety: only answer this computer's own browser tab
    def allowed(self, mutating=False):
        if PASSWORD:
            auth = self.headers.get("Authorization") or ""
            given = ""
            if auth.startswith("Basic "):
                try:
                    given = base64.b64decode(auth[6:]).decode("utf-8").split(":", 1)[-1]
                except (ValueError, UnicodeDecodeError):
                    given = ""
            if not hmac.compare_digest(given.encode(), PASSWORD.encode()):
                body = b"Password required."
                self.send_response(401)
                self.send_header("WWW-Authenticate", 'Basic realm="Peregrine", charset="UTF-8"')
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return False
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        ok_hosts = ["localhost", "127.0.0.1", "::1"] + ALLOWED_HOSTS
        # On your own PC only this computer is trusted. On a server, any address is fine
        # unless you list specific ones in PEREGRINE_ALLOWED_HOSTS.
        any_host = "*" in ALLOWED_HOSTS or (not LOCAL_ONLY and not ALLOWED_HOSTS)
        if not any_host and host not in ok_hosts:
            self.error_json(403, "This address isn't allowed. Add it to PEREGRINE_ALLOWED_HOSTS.")
            return False
        # A custom header can't be sent cross-site without a CORS preflight,
        # which this server never approves, so other websites can't change data.
        if mutating and self.headers.get("X-Peregrine") != "1":
            self.error_json(403, "Missing app header.")
            return False
        return True

    # -- routing
    def do_GET(self):
        if not self.allowed():
            return
        url = urllib.parse.urlsplit(self.path)
        q = dict(urllib.parse.parse_qsl(url.query))
        path = url.path
        try:
            if path.startswith("/api/ebird/"):
                sub = path[len("/api/ebird/"):]
                if ".." in sub or not re.match(r"^(data/obs|ref/hotspot|ref/region|product/spplist)/[A-Za-z0-9/_\-.]*$", sub):
                    return self.error_json(400, "Not an allowed eBird path.")
                return self.send_json(ebird_get(sub, q))
            if path == "/api/geocode":
                if not q.get("q", "").strip():
                    return self.send_json([])
                return self.send_json(nominatim_get("search", {
                    "q": q["q"], "format": "jsonv2", "limit": "6"}))
            if path == "/api/reverse":
                return self.send_json(nominatim_get("reverse", {
                    "lat": q.get("lat", ""), "lon": q.get("lng", ""),
                    "format": "jsonv2", "zoom": "12"}))
            if path == "/api/settings":
                k = get_key()
                return self.send_json({"hasKey": bool(k) or MOCK,
                                       "keyHint": (k[:3] + "…") if k else "",
                                       "mock": MOCK})
            if path == "/api/lifelist":
                return self.send_json(read_json(LIFELIST_FILE, {"species": []}))
            if path == "/api/trips":
                out = []
                for fn in os.listdir(TRIPS):
                    if fn.endswith(".json"):
                        t = read_json(os.path.join(TRIPS, fn), None)
                        if t:
                            out.append({"id": t.get("id"), "name": t.get("name"),
                                        "date": t.get("date"), "stops": len(t.get("stops", [])),
                                        "savedAt": t.get("savedAt")})
                out.sort(key=lambda t: t.get("savedAt") or "", reverse=True)
                return self.send_json(out)
            m = re.match(r"^/api/trips/([^/]+)$", path)
            if m:
                if not TRIP_ID.match(m[1]):
                    return self.error_json(400, "Bad trip id.")
                t = read_json(os.path.join(TRIPS, m[1] + ".json"), None)
                return self.send_json(t) if t else self.error_json(404, "Trip not found.")
            if path.startswith("/api/"):
                return self.error_json(404, "Unknown endpoint.")
            return super().do_GET()
        except UpstreamError as e:
            return self.error_json(e.status, e.message)
        except Exception as e:  # never leave the browser hanging
            return self.error_json(500, "Server error: %s" % e)

    def do_POST(self):
        if not self.allowed(mutating=True):
            return
        path = urllib.parse.urlsplit(self.path).path
        try:
            if path == "/api/settings":
                data = json.loads(self.body_bytes() or b"{}")
                # Remove spaces, line breaks and invisible characters picked up when copying,
                # plus quotes or a "key:" label; eBird itself decides if the key is valid.
                key = re.sub(r"[\s\u200b-\u200f\u2060\ufeff\"'`]", "", data.get("apiKey") or "")
                key = re.sub(r"^(api)?key[:=]", "", key, flags=re.I)
                if not key or len(key) > 100 or not key.isprintable():
                    return self.error_json(400, "Paste just the key itself (the code eBird showed you).")
                settings = read_json(SETTINGS_FILE, {})
                settings["apiKey"] = key
                write_json(SETTINGS_FILE, settings)
                if MOCK:
                    return self.send_json({"ok": True, "message": "Saved (sample-data mode)."})
                try:  # quick check that eBird accepts it
                    fetch(EBIRD + "data/obs/US-NY/recent?maxResults=1",
                          {"X-eBirdApiToken": key, "User-Agent": USER_AGENT})
                    return self.send_json({"ok": True, "message": "Saved. eBird accepted the key."})
                except UpstreamError as e:
                    return self.send_json({"ok": e.status != 401, "message": "Saved, but: " + e.message})
            if path == "/api/lifelist":
                species = parse_lifelist(self.body_bytes())
                name = urllib.parse.unquote(self.headers.get("X-Filename", "life list.csv"))
                obj = {"species": species, "filename": name,
                       "importedAt": dt.datetime.now().isoformat(timespec="minutes")}
                write_json(LIFELIST_FILE, obj)
                return self.send_json(obj)
            if path == "/api/import-route":
                ctype = (self.headers.get("Content-Type") or "").lower()
                if ctype.startswith("application/json"):
                    body = json.loads(self.body_bytes() or b"{}")
                    text = (body.get("text") or "").strip()
                    suffix = re.sub(r"[\r\n]+", " ", body.get("suffix") or "").strip()[:80]
                    if not text:
                        return self.error_json(400, "Paste a Google Maps link or a list of places first.")
                    link = re.search(r"https?://\S+", text)
                    if link and re.search(r"google\.|goo\.gl|g\.co/", link[0]):
                        items, notes = parse_google_maps(link[0].rstrip(").,")), []
                    elif link and len(text.split()) == 1:
                        return self.error_json(400, "That link isn't from Google Maps.")
                    else:
                        items, notes = parse_place_list(text, suffix), []
                else:
                    name = urllib.parse.unquote(self.headers.get("X-Filename", ""))
                    items, notes = parse_route_file(self.body_bytes(), name)
                out = resolve_stops(items)
                out["notes"] = notes + out["notes"]
                return self.send_json(out)
            if path == "/api/trips":
                trip = json.loads(self.body_bytes() or b"{}")
                if not isinstance(trip, dict) or not isinstance(trip.get("stops", []), list):
                    return self.error_json(400, "Not a trip.")
                tid = trip.get("id") or ""
                if not TRIP_ID.match(tid):
                    slug = re.sub(r"[^a-z0-9]+", "-", (trip.get("name") or "trip").lower()).strip("-")[:40]
                    tid = (slug or "trip") + "-" + secrets.token_hex(3)
                trip["id"] = tid
                trip["savedAt"] = dt.datetime.now().isoformat(timespec="seconds")
                write_json(os.path.join(TRIPS, tid + ".json"), trip)
                return self.send_json(trip)
            return self.error_json(404, "Unknown endpoint.")
        except ValueError as e:
            return self.error_json(400, str(e))
        except Exception as e:
            return self.error_json(500, "Server error: %s" % e)

    def do_DELETE(self):
        if not self.allowed(mutating=True):
            return
        path = urllib.parse.urlsplit(self.path).path
        m = re.match(r"^/api/trips/([^/]+)$", path)
        if m and TRIP_ID.match(m[1]):
            p = os.path.join(TRIPS, m[1] + ".json")
            if os.path.exists(p):
                os.remove(p)
            return self.send_json({"ok": True})
        if path == "/api/lifelist":
            if os.path.exists(LIFELIST_FILE):
                os.remove(LIFELIST_FILE)
            return self.send_json({"ok": True})
        return self.error_json(404, "Unknown endpoint.")


def main():
    port = int(env("PORT", "8765"))
    server = None
    for p in range(port, port + (10 if LOCAL_ONLY else 1)):
        try:
            server = ThreadingHTTPServer((HOST, p), Handler)
            port = p
            break
        except OSError:
            continue
    if server is None:
        print("Couldn't find a free port. Is the planner already running?")
        sys.exit(1)
    url = "http://localhost:%d/" % port
    print("Peregrine is running at %s" % url)
    if not LOCAL_ONLY:
        print("  Listening on %s:%d - %s, %s." % (
            HOST, port,
            "password protected" if PASSWORD else "no password",
            ("answering only " + ", ".join(ALLOWED_HOSTS)) if ALLOWED_HOSTS and "*" not in ALLOWED_HOSTS else "any address"))
    if MOCK:
        print("  (SAMPLE DATA MODE - not real eBird data)")
    if LOCAL_ONLY:
        print("Keep this window open while you use it. Press Ctrl+C to stop.")
    if "--no-browser" not in sys.argv and LOCAL_ONLY:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
