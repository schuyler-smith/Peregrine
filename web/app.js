/* Peregrine (bird trip planner) — front end.
   Talks only to the local server (server.py), which proxies eBird and place search. */
"use strict";

// ------------------------------------------------------------------ helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const pct = (p) => (p >= 0.995 ? "100%" : p > 0 && p < 0.01 ? "<1%" : Math.round(p * 100) + "%");
const binom = (sci) => String(sci || "").trim().split(/\s+/).slice(0, 2).join(" ").toLowerCase();
const normCom = (c) => String(c || "").replace(/\s*\(.*?\)\s*$/, "").trim().toLowerCase();

function todayISO() {
  const d = new Date();
  return iso(d);
}
function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}
function niceDate(s, withYear = false) {
  const d = parseISO(s);
  if (!d) return "";
  return d.toLocaleDateString(undefined, withYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" });
}
function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

async function api(url, opts = {}) {
  let r;
  try {
    const method = (opts.method || "GET").toUpperCase();
    const headers = Object.assign({}, opts.headers, method === "GET" ? {} : { "X-Peregrine": "1" });
    r = await fetch(url, Object.assign({}, opts, { headers }));
  } catch (e) {
    throw new Error("Can't reach the planner's local server. Is its window still open?");
  }
  let body = null;
  try { body = await r.json(); } catch (e) { /* not JSON */ }
  if (!r.ok) {
    const err = new Error((body && body.error) || `Request failed (${r.status})`);
    err.status = r.status;
    throw err;
  }
  return body;
}

// Limit how many eBird requests run at once (the server limits too).
const limiter = (() => {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= 3 || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
})();

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// ------------------------------------------------------------------ state
const hsState = new Map(); // stopId -> {key, status, done, total, candidates, error}
const hsLists = new Map(); // locId -> Set of species codes
let hsVersion = 0;
const LS_KEY = "peregrine.current";
try { // carry over the trip you had open under the old name
  if (!localStorage.getItem(LS_KEY) && localStorage.getItem("birdtrip.current")) {
    localStorage.setItem(LS_KEY, localStorage.getItem("birdtrip.current"));
    localStorage.removeItem("birdtrip.current");
  }
} catch (e) { /* storage unavailable */ }
const state = {
  trip: blankTrip(),
  results: new Map(),   // stopId -> {sig, status, done, total, data, error}
  selected: null,
  tab: "trip",
  filters: { lifers: false, starred: false, min: 0, sort: "p", q: "" },
  lists: [],            // everyone's life lists: {id, name, count, sci:Set, com:Set, filename, importedAt}
  dirty: false,
  mock: false,
};

/* Display choices that belong to this browser, not to a trip. */
const PREFS_KEY = "peregrine.prefs";
const prefs = Object.assign({ hsMode: "each", hsSort: "birds", layer: "Street" },
  (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); } catch (e) { return {}; } })());
function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* storage unavailable */ } }

/* The trip's party is a list of life-list ids (null = everyone who has a list).
   priority is "all" or one list id: whose lifers count most. */
function blankTrip() {
  return { id: null, v: 2, name: "", date: "", window: 7, stops: [], stars: [], party: null, priority: "all" };
}
/* Dates: stop 1 is on the trip's start date; every later stop is the day after the
   stop before it, unless it has its own date, which then restarts the chain. */
function effectiveDates() {
  const out = new Map();
  let prev = "";
  state.trip.stops.forEach((s, i) => {
    const d = s.date || (i === 0 ? state.trip.date : prev ? iso(addDays(parseISO(prev), 1)) : "");
    out.set(s.id, d);
    prev = d;
  });
  return out;
}
function stopDate(stop) { return effectiveDates().get(stop.id) || stop.date || ""; }
function dayNumber(stop) {
  const first = state.trip.date || stopDate(state.trip.stops[0] || {});
  const d = stopDate(stop);
  if (!first || !d) return null;
  return Math.round((parseISO(d) - parseISO(first)) / 86400000) + 1;
}
function tripDateRange() {
  const ds = state.trip.stops.map(stopDate).filter(Boolean).sort();
  if (!ds.length) return state.trip.date ? niceDate(state.trip.date, true) : "";
  return ds[0] === ds[ds.length - 1] ? niceDate(ds[0], true) : `${niceDate(ds[0])} – ${niceDate(ds[ds.length - 1], true)}`;
}
function stopSig(stop) { return `${stop.lat.toFixed(4)},${stop.lng.toFixed(4)}|${stopDate(stop)}|${state.trip.window}`; }
function stopIndex(id) { return state.trip.stops.findIndex((s) => s.id === id); }
function stopById(id) { return state.trip.stops.find((s) => s.id === id); }

function markDirty() {
  state.dirty = true;
  $("#dirty").textContent = "• unsaved changes";
  persistLocal();
}
function markClean() {
  state.dirty = false;
  $("#dirty").textContent = "";
  persistLocal();
}
function persistLocal() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ trip: state.trip, dirty: state.dirty })); } catch (e) { /* storage unavailable */ }
}

// ------------------------------------------------------------------ likelihood
/* To stay light on eBird, each stop samples DAYS_PER_YEAR days spread evenly
   across the window (date ± N) in each of the YEARS most recent years whose window
   has fully passed: 5 × 4 = 20 requests, cached for good once fetched. */
const DAYS_PER_YEAR = 5, YEARS = 4;
function sampleOffsets(n) {
  const out = new Set();
  for (let i = 0; i < DAYS_PER_YEAR; i++) out.add(Math.round(-n + (i * 2 * n) / (DAYS_PER_YEAR - 1)));
  return Array.from(out);
}
function sampleDays(dateStr, n) {
  const base = parseISO(dateStr);
  const today = parseISO(todayISO());
  const years = [];
  for (let y = today.getFullYear(); years.length < YEARS && y > today.getFullYear() - 12; y--) {
    const center = new Date(y, base.getMonth(), base.getDate());
    if (addDays(center, n) < today) years.push(y);
  }
  const offsets = sampleOffsets(n);
  const days = [];
  for (const y of years) {
    const center = new Date(y, base.getMonth(), base.getDate());
    for (const k of offsets) days.push(addDays(center, k));
  }
  return { days, years, perYear: offsets.length };
}

/* Stops load one at a time, so a whole trip never hits eBird in one burst. */
let stopChain = Promise.resolve();
function inLine(fn) {
  const run = stopChain.then(fn, fn);
  stopChain = run.catch(() => {});
  return run;
}

function haversineKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function findRegion(stop) {
  for (const dist of [25, 75, 200]) {
    const hs = await limiter(() => api(`/api/ebird/ref/hotspot/geo?lat=${stop.lat.toFixed(4)}&lng=${stop.lng.toFixed(4)}&dist=${dist}&fmt=json`));
    if (Array.isArray(hs) && hs.length) {
      hs.sort((a, b) => haversineKm(stop, a) - haversineKm(stop, b));
      const h = hs[0];
      const code = h.subnational2Code || h.subnational1Code || h.countryCode;
      let name = code;
      try {
        const info = await limiter(() => api(`/api/ebird/ref/region/info/${encodeURIComponent(code)}`));
        if (info && info.result) name = info.result;
      } catch (e) { /* keep code */ }
      return { code, name };
    }
  }
  throw new Error("No eBird hotspots within 200 km of this stop, so there's no data to go on.");
}

function loadStop(stop) {
  if (!stopDate(stop)) {
    // No date yet: ask for it, then carry on with this search.
    pendingFind.add(stop.id);
    askDate(true);
    return;
  }
  const sig = stopSig(stop);
  const prev = state.results.get(stop.id);
  if (prev && prev.sig === sig && prev.status !== "error") return;
  const res = { sig, status: "loading", done: 0, total: 0, data: null, error: null, note: "Waiting for the stop before it…" };
  state.results.set(stop.id, res);
  render();
  const stale = () => state.results.get(stop.id) !== res;

  inLine(async () => {
    if (stale()) return;
    res.note = "";
    render();
    try {
      if (!stop.region || stop.regionFor !== `${stop.lat.toFixed(4)},${stop.lng.toFixed(4)}`) {
        stop.region = await findRegion(stop);
        stop.regionFor = `${stop.lat.toFixed(4)},${stop.lng.toFixed(4)}`;
        persistLocal();
      }
      if (stale()) return;
      const date = stopDate(stop);
      const n = state.trip.window;
      const { days, years, perYear } = sampleDays(date, n);
      res.total = days.length;
      const counts = new Map();
      let withData = 0, authError = null, loaded = 0;
      let failedDays = [];

      const fetchDay = (d) => limiter(async () => {
        if (stale() || authError) return;
        try {
          const obs = await api(`/api/ebird/data/obs/${encodeURIComponent(stop.region.code)}/historic/${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}?cat=species&detail=simple`);
          if (Array.isArray(obs) && obs.length) {
            withData++;
            const seenToday = new Set();
            for (const o of obs) {
              if (!o.speciesCode || seenToday.has(o.speciesCode)) continue;
              seenToday.add(o.speciesCode);
              const c = counts.get(o.speciesCode) || { code: o.speciesCode, com: o.comName, sci: o.sciName, n: 0 };
              c.n++;
              counts.set(o.speciesCode, c);
            }
          }
          loaded++;
        } catch (e) {
          if (e.status === 401 || e.status === 400) authError = e;
          failedDays.push(d);
        } finally {
          res.done = Math.min(res.total, loaded + failedDays.length);
          render();
        }
      });

      await Promise.all(days.map(fetchDay));
      // eBird slows down keys that ask a lot; wait, then retry just the missing days.
      for (const pause of [8, 30]) {
        if (stale() || authError || !failedDays.length) break;
        const retry = failedDays;
        failedDays = [];
        res.note = `eBird is busy. Retrying ${retry.length} days in ${pause}s…`;
        res.done = loaded;
        render();
        await new Promise((ok) => setTimeout(ok, pause * 1000));
        res.note = "";
        if (stale()) return;
        await Promise.all(retry.map(fetchDay));
      }
      res.note = "";
      if (stale()) return;
      if (authError) throw authError;
      if (loaded < days.length * 0.5) {
        throw new Error(`eBird is limiting requests right now (it slows down a key that asks a lot). Loaded ${loaded} of ${days.length} days. Those are kept, so wait a few minutes and click Try again.`);
      }

      const species = [];
      for (const c of counts.values()) species.push({ ...c, p: withData ? c.n / withData : 0, recent: false });

      // If the visit is within 30 days of today, add what's been seen nearby lately.
      const diff = Math.round((parseISO(date) - parseISO(todayISO())) / 86400000);
      let recentUsed = false;
      if (diff >= -30 && diff <= 30) {
        try {
          const rec = await limiter(() => api(`/api/ebird/data/obs/geo/recent?lat=${stop.lat.toFixed(4)}&lng=${stop.lng.toFixed(4)}&dist=25&back=30&cat=species`));
          recentUsed = true;
          const byCode = new Map(species.map((s) => [s.code, s]));
          for (const o of rec || []) {
            const s = byCode.get(o.speciesCode);
            if (s) s.recent = true;
            else {
              const ns = { code: o.speciesCode, com: o.comName, sci: o.sciName, n: 0, p: 0, recent: true };
              species.push(ns);
              byCode.set(ns.code, ns);
            }
          }
        } catch (e) { /* recent sightings are a bonus */ }
      }
      if (stale()) return;
      res.data = { species, withData, totalDays: days.length, missing: failedDays.length, years, perYear, window: n, date, recentUsed, region: stop.region };
      res.status = "done";
      stop.result = { sig: res.sig, data: res.data }; // saved with the trip, so reopening needs no new requests
      markDirty();
    } catch (e) {
      if (stale()) return;
      res.status = "error";
      res.error = e.message || String(e);
    }
    render();
  });
}

/* eBird is only asked when you click "Find birds": nothing searches on its own. */
const pendingFind = new Set();
function needsSearch(stop) {
  const r = state.results.get(stop.id);
  if (r && r.status === "loading") return false;
  return !r || r.status !== "done" || r.sig !== stopSig(stop);
}
function findBirds(stops) {
  const todo = stops.filter(needsSearch);
  if (todo.some((s) => !stopDate(s))) {
    todo.forEach((s) => pendingFind.add(s.id));
    askDate(true);
    return;
  }
  todo.forEach((s) => { state.results.delete(s.id); loadStop(s); });
}

// ------------------------------------------------------------------ life lists and party
function toList(obj) {
  const sp = obj.species || [];
  return {
    id: obj.id, name: obj.name || "Life list", count: sp.length,
    sci: new Set(sp.map((s) => binom(s.sci)).filter(Boolean)),
    com: new Set(sp.map((s) => normCom(s.com)).filter(Boolean)),
    filename: obj.filename || "", importedAt: obj.importedAt || "",
  };
}
function setLists(arr) {
  state.lists = (arr || []).filter((o) => o && o.id).map(toList);
  liferMemo.clear();
}
/** The life lists of the people on this trip. */
function partyLists() {
  const p = state.trip.party;
  return Array.isArray(p) ? state.lists.filter((l) => p.includes(l.id)) : state.lists;
}
/** The one person whose lifers count most, or null for "everyone". */
function priorityList() {
  const pr = state.trip.priority;
  return pr && pr !== "all" ? partyLists().find((l) => l.id === pr) || null : null;
}
function lifeOn() { return partyLists().length > 0; }
function lifeKey() {
  return state.lists.map((l) => l.id + ":" + l.name + ":" + l.count).join(",") + "|" + JSON.stringify(state.trip.party) + "|" + state.trip.priority;
}
function lacks(list, sp) { return !(list.sci.has(binom(sp.sci)) || list.com.has(normCom(sp.com))); }
/** Which people in the party would get this bird as a lifer. */
const liferMemo = new Map();
let liferMemoKey = "";
function liferFor(sp) {
  const k = lifeKey();
  if (k !== liferMemoKey) { liferMemo.clear(); liferMemoKey = k; }
  const key = sp.code + "|" + sp.sci;
  let who = liferMemo.get(key);
  if (!who) { who = partyLists().filter((l) => lacks(l, sp)); liferMemo.set(key, who); }
  return who;
}
/** Words for whose lifers the counts mean: "" for one person, " for Sam", " for anyone". */
function liferWho() {
  const pl = priorityList();
  if (pl) return partyLists().length > 1 ? ` for ${esc(pl.name)}` : "";
  return partyLists().length > 1 ? " for anyone" : "";
}
/** "Sam 12 · Alex 30" when more than one person is on the trip. */
function perPersonHTML(list) {
  const party = partyLists();
  if (party.length < 2) return "";
  return `<p class="per-person">${party.map((l) => `${esc(l.name)} <b>${list.filter((s) => lacks(l, s)).length}</b>`).join(" · ")}</p>`;
}
function liferTagHTML(sp) {
  const who = liferFor(sp);
  if (!who.length) return "";
  const multi = partyLists().length > 1;
  return `<span class="lifer-tag ${isLifer(sp) ? "" : "other"}">${multi ? "Lifer: " + who.map((l) => esc(l.name)).join(", ") : "Lifer"}</span>`;
}
function isStarred(sp) { return (state.trip.stars || []).includes(sp.code); }
function toggleStar(code) {
  const st = new Set(state.trip.stars || []);
  if (st.has(code)) st.delete(code); else st.add(code);
  state.trip.stars = Array.from(st);
  hsVersion++;
  markDirty();
  render();
}
/** A lifer for the prioritized person, or (for "everyone") for anyone in the party. */
function isLifer(sp) {
  if (!lifeOn()) return false;
  const pl = priorityList();
  return pl ? lacks(pl, sp) : liferFor(sp).length > 0;
}

// ------------------------------------------------------------------ map
const map = L.map("map", { zoomControl: true, worldCopyJump: true, doubleClickZoom: false }).setView([39.5, -98.35], 4);
/* Map styles: Street (OpenStreetMap), Satellite (Esri World Imagery with place labels),
   Terrain (OpenTopoMap). The choice is remembered in this browser. */
const EBIRD_CREDIT = ' · bird data <a href="https://ebird.org">eBird</a>';
const OSM_CREDIT = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";
const baseLayers = {
  Street: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: OSM_CREDIT + EBIRD_CREDIT,
  }),
  Satellite: L.layerGroup([
    L.tileLayer(ESRI + "World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19, maxNativeZoom: 18,
      attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community" + EBIRD_CREDIT,
    }),
    L.tileLayer(ESRI + "Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, maxNativeZoom: 18 }),
  ]),
  Terrain: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17, subdomains: "abc",
    attribution: OSM_CREDIT + ', SRTM · style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)' + EBIRD_CREDIT,
  }),
};
function useLayerClass(name) {
  const el = map.getContainer();
  for (const n of Object.keys(baseLayers)) el.classList.toggle("layer-" + n.toLowerCase(), n === name);
}
const firstLayer = baseLayers[prefs.layer] ? prefs.layer : "Street";
baseLayers[firstLayer].addTo(map);
useLayerClass(firstLayer);
L.control.layers(baseLayers, null, { position: "topright" }).addTo(map);
map.on("baselayerchange", (e) => {
  prefs.layer = e.name;
  savePrefs();
  useLayerClass(e.name);
  if (e.name === "Terrain" && map.getZoom() > 17) map.setZoom(17);
});
const routeLine = L.polyline([], { color: "#3d5a3a", weight: 3, opacity: 0.6, dashArray: "6 6" }).addTo(map);
const markers = new Map(); // stopId -> marker
let dragging = false;

map.on("dblclick", (e) => {
  const div = document.createElement("div");
  div.className = "add-pop";
  div.innerHTML = `<div>${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}</div><button class="primary small">＋ Add stop here</button>`;
  const pop = L.popup({ closeButton: false }).setLatLng(e.latlng).setContent(div).openOn(map);
  div.querySelector("button").addEventListener("click", () => {
    map.closePopup(pop);
    addStop(e.latlng.lat, e.latlng.lng);
  });
});

function pinHTML(stop, i) {
  const r = state.results.get(stop.id);
  let cls = "pin";
  if (stop.id === state.selected) cls += " sel";
  let badge = "";
  if (!r || (r.status === "done" && r.sig !== stopSig(stop))) cls += " waiting";
  if (r && r.status === "loading") cls += " loading";
  else if (r && r.status === "error") cls += " error";
  else if (r && r.status === "done") {
    const list = filteredForCounts(r.data.species);
    if (lifeOn()) {
      const n = list.filter(isLifer).length;
      if (n) badge = `<span class="badge">${n}</span>`;
    } else badge = `<span class="badge plain">${list.length}</span>`;
  }
  return `<div class="${cls}">${i + 1}${badge}</div>`;
}

function renderPins() {
  if (dragging) return;
  const ids = new Set(state.trip.stops.map((s) => s.id));
  for (const [id, m] of markers) if (!ids.has(id)) { m.remove(); markers.delete(id); }
  state.trip.stops.forEach((stop, i) => {
    const html = pinHTML(stop, i);
    let m = markers.get(stop.id);
    if (!m) {
      m = L.marker([stop.lat, stop.lng], { draggable: true, autoPan: true });
      m.on("click", () => selectStop(stop.id, true));
      m.on("dragstart", () => { dragging = true; });
      m.on("dragend", () => {
        dragging = false;
        const ll = m.getLatLng();
        const s = stopById(stop.id);
        if (!s) return;
        s.lat = ll.lat; s.lng = ll.lng;
        s.region = null;
        markDirty();
        nameFromMap(s);
        render();
      });
      m.addTo(map);
      markers.set(stop.id, m);
    }
    if (m._html !== html) {
      m.setIcon(L.divIcon({ className: "pin-wrap", html, iconSize: [30, 30], iconAnchor: [15, 15] }));
      m._html = html;
    }
    m.setLatLng([stop.lat, stop.lng]);
    const r = state.results.get(stop.id);
    let tip = `<b>${i + 1}. ${esc(stop.name)}</b>`;
    if (r && r.status === "done") {
      const list = filteredForCounts(r.data.species);
      tip += `<br>${list.length} species` + (lifeOn() ? ` · ${list.filter(isLifer).length} possible lifers${liferWho()}` : "");
    }
    if (m._tip !== tip) {
      m.unbindTooltip().bindTooltip(tip, { direction: "top", offset: [0, -14], className: "pin-tip" });
      m._tip = tip;
    }
  });
  routeLine.setLatLngs(state.trip.stops.map((s) => [s.lat, s.lng]));
}

function fitToStops() {
  const s = state.trip.stops;
  if (s.length === 1) map.setView([s[0].lat, s[0].lng], 10);
  else if (s.length > 1) map.fitBounds(L.latLngBounds(s.map((x) => [x.lat, x.lng])), { padding: [50, 50] });
}

// ------------------------------------------------------------------ stops
async function placeName(lat, lng) {
  try {
    const r = await api(`/api/reverse?lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}`);
    const a = (r && r.address) || {};
    const place = r.name || a.city || a.town || a.village || a.hamlet || a.suburb || a.county || a.state;
    const region = a.state || a.country;
    if (place) return region && region !== place ? `${place}, ${region}` : place;
  } catch (e) { /* fall through */ }
  return null;
}
async function nameFromMap(stop) {
  if (stop.nameEdited) return;
  const n = await placeName(stop.lat, stop.lng);
  if (n && !stop.nameEdited && stopById(stop.id)) {
    stop.name = n;
    persistLocal();
    renderStops();
    render();
  }
}

function addStop(lat, lng, name) {
  const stop = { id: uid(), name: name || `Stop ${state.trip.stops.length + 1}`, lat, lng, date: "", region: null, hotspots: 2, hsRadius: DEFAULT_RADIUS };
  if (name) stop.nameEdited = true;
  state.trip.stops.push(stop);
  markDirty();
  state.selected = stop.id;
  renderStops();
  if (!name) nameFromMap(stop);
  render();
}

function removeStop(id) {
  state.trip.stops = state.trip.stops.filter((s) => s.id !== id);
  state.results.delete(id);
  if (state.selected === id) state.selected = state.trip.stops[0]?.id || null;
  markDirty();
  renderStops();
  render();
}
function moveStop(id, dir) {
  const i = stopIndex(id), j = i + dir;
  const s = state.trip.stops;
  if (i < 0 || j < 0 || j >= s.length) return;
  [s[i], s[j]] = [s[j], s[i]];
  markDirty();
  renderStops();
  render();
}
function selectStop(id, showTab) {
  state.selected = id;
  if (showTab) setTab("stop");
  $$(".stop-row").forEach((el) => el.classList.toggle("sel", el.dataset.id === id));
  render();
}

function stopStatusHTML(stop) {
  const r = state.results.get(stop.id);
  const btn = (label) => `<button class="find-btn" data-find="${stop.id}">${label}</button>`;
  if (!r) return { meta: `${btn("🔍 Find birds")} <span class="muted">Not searched yet</span>`, cls: "" };
  if (r.status === "loading") {
    const w = r.total ? Math.round((r.done / r.total) * 100) : 4;
    return { meta: r.note || (r.total ? `Checking ${r.done} of ${r.total} sample days…` : "Finding the county…"), progress: r.note && !r.total ? null : w, cls: "" };
  }
  if (r.status === "error") return { meta: `${btn("Try again")} ${esc(r.error)}`, cls: "err" };
  const list = filteredForCounts(r.data.species);
  const where = r.data.region ? esc(r.data.region.name.split(",")[0]) + " · " : "";
  const lif = lifeOn() ? ` · <span class="lifers">${list.filter(isLifer).length} possible lifers${liferWho()}</span>` : "";
  if (r.sig !== stopSig(stop)) return { meta: `${btn("↻ Update")} <span class="stale-note">Changed since the last search</span><br>${where}${list.length} species${lif}`, cls: "" };
  return { meta: `${where}${list.length} species${lif}`, cls: "" };
}

function renderStops() {
  if (stopDrag) return; // redrawn when the drag ends
  const ol = $("#stops");
  if (!state.trip.stops.length) {
    ol.innerHTML = `<li class="empty">No stops yet. Search for a place, click the map, or <a class="import-link" data-import>import a whole route</a>.</li>`;
    return;
  }
  const dates = effectiveDates();
  ol.innerHTML = state.trip.stops.map((s, i) => {
    const d = dates.get(s.id) || "";
    const day = dayNumber(s);
    const how = s.date
      ? `<a class="auto-link" data-auto="${s.id}" title="Go back to the day after the previous stop">↺ auto</a>`
      : (i === 0 ? "trip start" : d ? "day after previous" : "");
    return `
    <li class="stop-row ${s.id === state.selected ? "sel" : ""}" data-id="${s.id}">
      <span class="num" title="Drag to reorder">${i + 1}</span>
      <div>
        <input class="stop-name" value="${esc(s.name)}" aria-label="Stop name">
        <div class="stop-sub">
          ${day ? `<span class="day">Day ${day}</span>` : ""}
          <input type="date" class="stop-date ${s.date ? "set" : "auto"}" value="${esc(d)}" title="Date at this stop. Later stops follow on from it.">
          <span class="fine" style="margin:0">${how}</span>
        </div>
        <div class="stop-meta"></div>
        <div class="progress" hidden><i></i></div>
      </div>
      <div class="stop-btns">
        <button class="icon" data-act="up" title="Move up">↑</button>
        <button class="icon" data-act="down" title="Move down">↓</button>
        <button class="icon" data-act="del" title="Remove stop">✕</button>
      </div>
    </li>`;
  }).join("");
  updateStopStatuses();
}

function updateStopStatuses() {
  for (const s of state.trip.stops) {
    const row = $(`.stop-row[data-id="${s.id}"]`);
    if (!row) continue;
    const st = stopStatusHTML(s);
    const meta = $(".stop-meta", row);
    meta.innerHTML = st.meta;
    meta.className = "stop-meta " + st.cls;
    const pr = $(".progress", row);
    pr.hidden = st.progress == null;
    if (st.progress != null) $("i", pr).style.width = st.progress + "%";
  }
}

/* Drag a stop's number to move it. Pointer events, so it works with a mouse or a finger. */
let stopDrag = null, justDragged = false;
$("#stops").addEventListener("pointerdown", (e) => {
  const handle = e.target.closest(".stop-row .num");
  if (!handle || e.button !== 0 || state.trip.stops.length < 2) return;
  e.preventDefault();
  handle.setPointerCapture(e.pointerId);
  stopDrag = { row: handle.closest(".stop-row"), startY: e.clientY, moved: false, scroll: 0, timer: null };
});
$("#stops").addEventListener("pointermove", (e) => {
  const d = stopDrag;
  if (!d) return;
  if (!d.moved && Math.abs(e.clientY - d.startY) < 5) return;
  if (!d.moved) { d.moved = true; d.row.classList.add("dragging"); document.body.classList.add("drag-stops"); }
  // Put the row before the first other row whose middle is below the pointer.
  const ol = $("#stops");
  const others = $$(".stop-row", ol).filter((r) => r !== d.row);
  const before = others.find((r) => { const b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
  if (before) { if (d.row.nextElementSibling !== before) ol.insertBefore(d.row, before); }
  else if (ol.lastElementChild !== d.row) ol.appendChild(d.row);
  // Scroll the panel when dragging near its top or bottom edge.
  const pane = $("#tab-trip"), pb = pane.getBoundingClientRect();
  d.scroll = e.clientY < pb.top + 40 ? -12 : e.clientY > pb.bottom - 40 ? 12 : 0;
  if (d.scroll && !d.timer) d.timer = setInterval(() => { if (stopDrag && stopDrag.scroll) pane.scrollTop += stopDrag.scroll; }, 30);
});
function endStopDrag() {
  const d = stopDrag;
  if (!d) return;
  stopDrag = null;
  clearInterval(d.timer);
  document.body.classList.remove("drag-stops");
  d.row.classList.remove("dragging");
  if (!d.moved) return;
  justDragged = true;
  setTimeout(() => { justDragged = false; }, 0);
  const order = $$("#stops .stop-row").map((r) => r.dataset.id);
  const before = state.trip.stops.map((s) => s.id).join(",");
  state.trip.stops.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  if (state.trip.stops.map((s) => s.id).join(",") !== before) markDirty();
  renderStops();
  render();
}
$("#stops").addEventListener("pointerup", endStopDrag);
$("#stops").addEventListener("pointercancel", endStopDrag);

$("#stops").addEventListener("click", (e) => {
  if (justDragged) return;
  const row = e.target.closest(".stop-row");
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.closest("[data-find], a")) return; // handled elsewhere; stay on this tab
  const auto = e.target.closest("[data-auto]");
  if (auto) {
    const st = stopById(auto.dataset.auto);
    if (st) { st.date = ""; markDirty(); renderStops(); render(); }
    return;
  }
  const act = e.target.closest("button")?.dataset.act;
  if (act === "up") return moveStop(id, -1);
  if (act === "down") return moveStop(id, 1);
  if (act === "del") return removeStop(id);
  if (e.target.matches("input")) { if (state.selected !== id) selectStop(id, false); return; }
  selectStop(id, true);
  const s = stopById(id);
  if (s) map.panTo([s.lat, s.lng]);
});
$("#stops").addEventListener("input", (e) => {
  const row = e.target.closest(".stop-row");
  const s = row && stopById(row.dataset.id);
  if (!s) return;
  if (e.target.classList.contains("stop-name")) {
    s.name = e.target.value;
    s.nameEdited = true;
    markDirty();
    render();
  }
});
$("#stops").addEventListener("change", (e) => {
  const row = e.target.closest(".stop-row");
  const s = row && stopById(row.dataset.id);
  if (!s || !e.target.classList.contains("stop-date")) return;
  const v = e.target.value || "";
  if (stopIndex(s.id) === 0 && !s.date) {
    // Changing the first stop's date moves the whole trip's start.
    if (v) { setTripDate(v, state.trip.window); renderStops(); }
    return;
  }
  s.date = v;
  markDirty();
  renderStops();
  render();
});

// ------------------------------------------------------------------ species lists
function tierOf(p) { return p >= 0.5 ? "t1" : p >= 0.15 ? "t2" : "t3"; }

/** What counts toward the headline numbers: the likelihood filter only. */
function filteredForCounts(species) {
  const min = state.filters.min;
  return species.filter((s) => s.p >= min || (min === 0 && s.recent));
}
function applyFilters(species) {
  const f = state.filters;
  let list = filteredForCounts(species);
  if (f.lifers) list = list.filter(isLifer);
  if (f.starred) list = list.filter(isStarred);
  if (f.q) {
    const q = f.q.toLowerCase();
    list = list.filter((s) => (s.com || "").toLowerCase().includes(q) || (s.sci || "").toLowerCase().includes(q));
  }
  list = list.slice();
  if (f.sort === "az") list.sort((a, b) => a.com.localeCompare(b.com));
  else list.sort((a, b) => b.p - a.p || (b.recent - a.recent) || a.com.localeCompare(b.com));
  return list;
}

function spRow(s, extra = "", titleText = "") {
  const lifer = isLifer(s);
  const on = isStarred(s);
  const tier = tierOf(s.p);
  const barTitle = titleText || (s.p ? `Reported on ${pct(s.p)} of sampled days` : "Not in the historic sample; seen nearby in the last 30 days");
  return `<li class="sp ${tier} ${lifer ? "lifer" : ""} ${on ? "starred" : ""}">
    <div>
      <button class="star-btn ${on ? "on" : ""}" data-star="${esc(s.code)}" title="${on ? "Remove from targets" : "Star as a target"}" aria-pressed="${on}">${on ? "★" : "☆"}</button><a href="https://ebird.org/species/${encodeURIComponent(s.code)}" target="_blank" rel="noopener">${esc(s.com)}</a>${liferTagHTML(s)}${s.recent ? `<span class="tag" title="Reported within 25 km in the last 30 days">recent nearby</span>` : ""}
      <div class="sci">${esc(s.sci)}</div>${extra}
    </div>
    <div class="sp-bar" title="${esc(barTitle)}"><div class="bar"><i style="width:${Math.max(2, Math.round(s.p * 100))}%"></i></div><span class="pct">${s.p ? pct(s.p) : "—"}</span></div>
  </li>`;
}

function tiersHTML(list) {
  const t1 = list.filter((s) => s.p >= 0.5).length, t2 = list.filter((s) => s.p >= 0.15 && s.p < 0.5).length;
  return `<div class="tiers"><span class="t1">Likely (50%+): ${t1}</span><span class="t2">Possible (15–50%): ${t2}</span><span class="t3">Long shot: ${list.length - t1 - t2}</span></div>`;
}
function lifeNudge() {
  if (lifeOn()) return "";
  return state.lists.length
    ? `<div class="nudge">Nobody with a life list is ticked in this trip's birding party, so lifers aren't shown. Pick who's coming in the Party tab.</div>`
    : `<div class="nudge">Import your eBird life list to see which of these would be lifers. <a data-open-settings>Open Settings</a></div>`;
}

function renderStopTab() {
  const el = $("#tab-stop");
  const stop = stopById(state.selected);
  if (!stop) {
    el.innerHTML = `<div class="empty">Click a pin on the map, or a stop in the Itinerary tab, to see its birds.</div>`;
    return;
  }
  const i = stopIndex(stop.id);
  const r = state.results.get(stop.id);
  const n = state.trip.stops.length;
  const nav = `<div class="stop-nav">
      <button class="ghost small" data-nav="-1" ${i === 0 ? "disabled" : ""} title="Previous stop (← key)">‹ Prev</button>
      <span>Stop ${i + 1} of ${n}</span>
      <button class="ghost small" data-nav="1" ${i === n - 1 ? "disabled" : ""} title="Next stop (→ key)">Next ›</button>
    </div>`;
  let html = nav + `<div class="sum"><h2>${i + 1}. ${esc(stop.name)}</h2>
    <div class="where">${dayNumber(stop) ? `Day ${dayNumber(stop)} · ` : ""}${niceDate(stopDate(stop), true)}${r?.data?.region ? " · " + esc(r.data.region.name) : stop.region ? " · " + esc(stop.region.name) : ""}</div>`;
  if (!r) {
    const d = stopDate(stop);
    el.innerHTML = html + `</div><div class="find-box">
      <p>${d ? `Ready to look up birds for <b>${niceDate(d, true)}</b> (±${state.trip.window} days).` : `Set the trip's start date first.`} Check the date and window, then:</p>
      <button class="primary" data-find="${stop.id}">🔍 Find birds for this stop</button>
      <p class="fine">About 25 eBird requests (fewer if some days were looked up before).</p></div>`;
    return;
  }
  if (r.status === "loading") {
    const w = r && r.total ? Math.round((r.done / r.total) * 100) : 3;
    html += `</div><div class="loading-box">${r && r.note ? esc(r.note) + "<br>" : ""}${r && r.total ? `Checking ${r.total} sample days on eBird… ${r.done}/${r.total}` : r && r.note ? "" : "Finding the nearest eBird county…"}<div class="progress"><i style="width:${w}%"></i></div></div>`;
    el.innerHTML = html;
    return;
  }
  if (r.status === "error") {
    html += `</div><div class="nudge" style="background:#f7e1da;border-color:#e3b3a4">${esc(r.error)} ${/key|settings/i.test(r.error) ? `<a data-open-settings>Open Settings</a> · ` : ""}<a data-retry="${stop.id}">Try again</a></div>`;
    el.innerHTML = html;
    return;
  }
  const d = r.data;
  if (r.sig !== stopSig(stop)) {
    html += `<div class="nudge stale-box">These results are for <b>${niceDate(d.date, true)}</b>, ±${d.window} days${stop.region && d.region && stop.region.code !== d.region.code ? ` in ${esc(d.region.name.split(",")[0])}` : ""}. The stop has changed since. <button class="primary small" data-find="${stop.id}">↻ Update</button></div>`;
  }
  const counted = filteredForCounts(d.species);
  const lifers = counted.filter(isLifer).length;
  html += lifeOn()
    ? `<p class="big"><b>${lifers}</b>possible lifer${lifers === 1 ? "" : "s"}${liferWho()} here</p>` + perPersonHTML(counted)
    : `<p class="big plain"><b>${counted.length}</b>species possible here</p>`;
  html += `<p class="method">${counted.length} species reported in ${esc(d.region.name.split(",")[0])} on sample days within ±${d.window} of ${niceDate(d.date)}, ${d.years[d.years.length - 1]}–${d.years[0]} (${d.perYear} days spread across the window in each year; ${d.withData} of ${d.totalDays} sample days had checklists${d.missing ? `; ${d.missing} days couldn't be fetched from eBird, so <a data-retry="${stop.id}">try again</a> later to fill them in` : ""})${d.recentUsed ? ", plus sightings within 25 km in the last 30 days" : ""}.</p>`;
  html += tiersHTML(counted) + `</div>` + lifeNudge() + hotspotBoxHTML(stop, d);
  const list = applyFilters(d.species);
  html += list.length
    ? `<ul class="splist">${list.map((s) => spRow(s, "", s.p ? `Reported on ${s.n} of ${d.withData} days` : "")).join("")}</ul>`
    : `<div class="empty">No birds match these filters.</div>`;
  el.innerHTML = html;
}

function wholeTrip() {
  const agg = new Map();
  let loaded = 0;
  state.trip.stops.forEach((stop, i) => {
    const r = state.results.get(stop.id);
    if (!r || r.status !== "done") return;
    loaded++;
    for (const s of filteredForCounts(r.data.species)) {
      let a = agg.get(s.code);
      if (!a) agg.set(s.code, (a = { code: s.code, com: s.com, sci: s.sci, p: 0, recent: false, at: [] }));
      a.at.push({ i, id: stop.id, p: s.p });
      if (s.p > a.p) a.p = s.p;
      a.recent = a.recent || s.recent;
    }
  });
  return { species: Array.from(agg.values()), loaded };
}

function renderWholeTab() {
  const el = $("#tab-whole");
  const n = state.trip.stops.length;
  if (!n) {
    el.innerHTML = `<div class="empty">Add some stops and the combined list for the whole trip will appear here.</div>`;
    return;
  }
  const { species, loaded } = wholeTrip();
  const lifers = species.filter(isLifer).length;
  let html = `<div class="sum"><h2>${esc(state.trip.name || "This trip")}</h2>
    <div class="where">${n} stop${n === 1 ? "" : "s"} · ${tripDateRange() ? tripDateRange() + ` · ±${state.trip.window} days` : `no date yet (<a data-ask-date>set it</a>)`}</div>`;
  const starredN = species.filter(isStarred).length;
  html += `<p class="big plain"><b>${species.length}</b>species possible${lifeOn() ? ` · <span style="color:var(--gold)"><b style="font-size:inherit">${lifers}</b> lifer${lifers === 1 ? "" : "s"}${liferWho()}</span>` : ""}${starredN ? ` · <span class="starred-count">★ ${starredN} starred</span>` : ""}</p>` + (lifeOn() ? perPersonHTML(species) : "");
  const unsearched = state.trip.stops.filter(needsSearch).length;
  if (unsearched) html += `<div class="nudge">${unsearched} of ${n} stop${n === 1 ? "" : "s"} ${unsearched === 1 ? "hasn't" : "haven't"} been searched${loaded ? " or changed since" : ""}. <button class="primary small" data-find-all>🔍 Find birds for ${unsearched === 1 ? "it" : "them"}</button></div>`;
  else if (loaded < n) html += `<p class="method">Still loading ${n - loaded} of ${n} stops…</p>`;
  else html += `<p class="method">Each bird shows its best chance at any one stop. Numbered chips show where it's been reported; gold is the best stop. Click a chip to open that stop.</p>`;
  html += tiersHTML(species) + `</div>` + lifeNudge();
  const list = applyFilters(species);
  html += list.length
    ? `<ul class="splist">${list.map((s) => {
        const best = s.at.reduce((a, b) => (b.p > a.p ? b : a));
        const chips = s.at.sort((a, b) => a.i - b.i).map((x) => `<button class="chip ${x === best ? "best" : ""}" data-stop="${x.id}" title="${esc(state.trip.stops[x.i]?.name)}: ${x.p ? pct(x.p) : "recent"}">${x.i + 1}</button>`).join("");
        return spRow(s, `<div class="at">${chips} ${s.at.length} of ${n} stop${n === 1 ? "" : "s"}</div>`, `Best stop: ${state.trip.stops[best.i]?.name}`);
      }).join("")}</ul>`
    : `<div class="empty">${loaded ? "No birds match these filters." : "Loading…"}</div>`;
  el.innerHTML = html;
}

/* The birding party (Party tab) and the "lifers for" picker (filter bar). */
let partyKey = "";
function renderParty() {
  const key = lifeKey();
  if (key === partyKey) return;
  partyKey = key;
  const box = $("#party");
  const party = partyLists();
  const pl = priorityList();
  const whoOpts = `<option value="all" ${pl ? "" : "selected"}>Everyone</option>` +
    party.map((l) => `<option value="${esc(l.id)}" ${pl && pl.id === l.id ? "selected" : ""}>${esc(l.name)}</option>`).join("");
  if (!state.lists.length) {
    box.innerHTML = `<h2 class="party-h">Birding party</h2>
      <div class="empty">No life lists yet. <a data-open-settings>Import them in Settings</a>, one for each person you bird with, then pick who's on this trip here.</div>`;
  } else {
    box.innerHTML = `<h2 class="party-h">Birding party</h2>
      <p class="fine">Tick who's on this trip. Star (☆) one person to put their lifers first, or leave everyone unstarred to plan for the whole party. Saved with the trip.</p>
      <ul class="party-list">${state.lists.map((l) => {
        const on = party.includes(l);
        const star = pl && pl.id === l.id;
        return `<li class="${on ? "on" : ""} ${star ? "prio" : ""}">
          <label class="party-who"><input type="checkbox" data-party="${esc(l.id)}" ${on ? "checked" : ""}> <b>${esc(l.name)}</b></label>
          <span class="fine">${l.count} species</span>
          <button type="button" class="star-btn ${star ? "on" : ""}" data-prio="${esc(l.id)}" ${on ? "" : "disabled"}
            title="${!on ? "Add them to the party first" : star ? "Stop prioritizing (plan for everyone)" : `Prioritize ${esc(l.name)}'s lifers`}" aria-pressed="${star}">${star ? "★" : "☆"}</button>
        </li>`;
      }).join("")}</ul>
      <p class="party-mode">${!party.length ? "Nobody is ticked, so lifers aren't shown."
        : pl ? `<b>★ ${esc(pl.name)}</b> is prioritized: their lifers count most, and lifers for the others only break ties.`
        : party.length > 1 ? "<b>Planning for everyone:</b> a bird counts as a lifer if it's new for anyone, and birds new for more of the party rank higher."
        : `Planning for <b>${esc(party[0].name)}</b>.`}</p>
      <p class="life-status"><a data-open-settings>Add or manage life lists</a></p>`;
  }
  const f = $("#fWho");
  f.innerHTML = whoOpts;
  f.hidden = party.length < 2;
}
function setParty(ids) {
  // Everyone ticked is stored as "everyone" so new lists join the trip automatically.
  state.trip.party = ids.length === state.lists.length ? null : ids;
  if (state.trip.priority !== "all" && !ids.includes(state.trip.priority)) state.trip.priority = "all";
  hsVersion++;
  markDirty();
  render();
}
function setPriority(v) {
  state.trip.priority = v || "all";
  hsVersion++;
  markDirty();
  render();
}
document.addEventListener("change", (e) => {
  if (e.target.matches("[data-party]")) setParty($$("[data-party]").filter((c) => c.checked).map((c) => c.dataset.party));
  if (e.target.matches("#fWho")) setPriority(e.target.value);
});
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-prio]");
  if (b && !b.disabled) setPriority(state.trip.priority === b.dataset.prio ? "all" : b.dataset.prio);
});

// ------------------------------------------------------------------ render loop
let rafPending = false;
const lastKeys = { stop: "", whole: "" };
function render() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    renderPins();
    renderHotspotLayer();
    updateStopStatuses();
    renderFindAll();
    const common = JSON.stringify([state.filters, lifeKey(), prefs, state.trip.name, state.trip.date, state.trip.window, state.trip.stops.map((s) => [s.id, s.name, stopDate(s)]), state.trip.stars, hsVersion]);
    if (state.tab === "stop") {
      const r = state.results.get(state.selected);
      const selStop = stopById(state.selected);
      const key = common + "|" + state.selected + "|" + (selStop ? stopSig(selStop) : "") + "|" + (r ? r.status + r.done + r.total + r.sig + (r.note || "") : "none") + "|" + JSON.stringify(selStop?.hotspots) + selStop?.hsRadius + "|" + selStop?.hsMinutes + Array.from(hsOpen).join(",");
      if (key !== lastKeys.stop) { lastKeys.stop = key; renderStopTab(); }
    }
    if (state.tab === "whole") {
      const key = common + "|" + state.trip.stops.map((s) => { const r = state.results.get(s.id); return stopSig(s) + (r ? r.status + r.sig : "-"); }).join(",");
      if (key !== lastKeys.whole) { lastKeys.whole = key; renderWholeTab(); }
    }
    renderParty();
  });
}

function setTab(tab) {
  state.tab = tab;
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#tab-trip").hidden = tab !== "trip";
  $("#tab-stop").hidden = tab !== "stop";
  $("#tab-whole").hidden = tab !== "whole";
  $("#tab-party").hidden = tab !== "party";
  $("#filters").hidden = tab === "trip" || tab === "party";
  lastKeys.stop = lastKeys.whole = "";
  render();
}
$$(".tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-open-settings]")) { e.preventDefault(); openSettings(); }
  if (e.target.closest("[data-ask-date]")) { e.preventDefault(); askDate(true); }
  const nav = e.target.closest("[data-nav]");
  if (nav) { stepStop(+nav.dataset.nav); return; }
  const star = e.target.closest("[data-star]");
  if (star) { e.preventDefault(); toggleStar(star.dataset.star); return; }
  const hsRun = e.target.closest("[data-hs-run]");
  if (hsRun) { const st = stopById(hsRun.dataset.hsRun); if (st) runHotspots(st); }
  if (e.target.closest("[data-import]")) { e.preventDefault(); $("#btnImportRoute").click(); }
  const chip = e.target.closest(".chip[data-stop]");
  if (chip) { selectStop(chip.dataset.stop, true); const s = stopById(chip.dataset.stop); if (s) map.panTo([s.lat, s.lng]); }
  const retry = e.target.closest("[data-retry]");
  if (retry) { const s = stopById(retry.dataset.retry); if (s) { state.results.delete(s.id); findBirds([s]); } }
  const find = e.target.closest("[data-find]");
  if (find) { e.preventDefault(); const s = stopById(find.dataset.find); if (s) findBirds([s]); return; }
  if (e.target.closest("[data-find-all]")) { e.preventDefault(); findBirds(state.trip.stops); return; }
});

// filters
$("#fLifers").addEventListener("change", (e) => { state.filters.lifers = e.target.checked; render(); });
$("#fStarred").addEventListener("change", (e) => { state.filters.starred = e.target.checked; render(); });
document.addEventListener("change", (e) => {
  const c = e.target.closest("[data-hs-count]");
  const lim = e.target.closest("[data-hs-limit]");
  const st = stopById(c?.dataset.hsCount || lim?.dataset.hsLimit);
  if (!st) return;
  if (c) st.hotspots = +c.value;
  if (lim) {
    const [kind, v] = lim.value.split(":");
    if (kind === "min") st.hsMinutes = +v;
    else { st.hsMinutes = null; st.hsRadius = +v; }
  }
  hsVersion++;
  markDirty();
  render();
});
$("#fMin").addEventListener("change", (e) => { state.filters.min = +e.target.value; render(); });
$("#fSort").addEventListener("change", (e) => { state.filters.sort = e.target.value; render(); });
$("#fSearch").addEventListener("input", (e) => { state.filters.q = e.target.value.trim(); render(); });

// ------------------------------------------------------------------ trip controls
$("#tripName").addEventListener("input", (e) => { state.trip.name = e.target.value; markDirty(); render(); });
$("#tripDate").addEventListener("change", (e) => {
  if (!e.target.value) { e.target.value = state.trip.date; return; }
  setTripDate(e.target.value, state.trip.window);
});

function setTripDate(date, win) {
  state.trip.date = date;
  state.trip.window = win;
  $("#tripDate").value = date;
  $("#tripWindow").value = String(win);
  updateDateNeed();
  markDirty();
  renderStops();
  render();
}
function updateDateNeed() {
  const need = !state.trip.date;
  $("#tripDate").classList.toggle("need", need);
  $("#dateNeed").hidden = !need;
}

/** Ask for the trip date (once per trip unless the person asks for it). */
let dateAsked = false;
function askDate(force = false) {
  const dlg = $("#dateDlg");
  if (dlg.open || (!force && dateAsked)) return;
  dateAsked = true;
  $("#dlgDate").value = state.trip.date || "";
  $("#dlgWindow").value = String(state.trip.window);
  for (const d of $$("dialog[open]")) d.close();
  dlg.showModal();
  setTimeout(() => $("#dlgDate").focus(), 50);
}
$("#dateForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#dlgDate").value;
  if (!parseISO(v)) { $("#dlgDate").focus(); return; }
  $("#dateDlg").close();
  setTripDate(v, +$("#dlgWindow").value);
  // If the date was asked for because you clicked "Find birds", carry on with that search.
  const waiting = state.trip.stops.filter((st) => pendingFind.has(st.id));
  pendingFind.clear();
  if (waiting.length) findBirds(waiting);
});
$("#dateDlg").addEventListener("close", () => { if (!state.trip.date) pendingFind.clear(); });
$("#tripWindow").addEventListener("change", (e) => { state.trip.window = +e.target.value; markDirty(); renderStops(); render(); });

$("#searchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#searchInput").value.trim();
  const ul = $("#searchResults");
  if (!q) { ul.innerHTML = ""; return; }
  ul.innerHTML = `<li class="fine">Searching…</li>`;
  try {
    const res = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
    if (!res.length) { ul.innerHTML = `<li class="fine">No places found. Try adding a state or country.</li>`; return; }
    ul.innerHTML = res.map((r, i) => `<li data-i="${i}"><b>＋</b> ${esc(r.display_name)}</li>`).join("");
    $$("li[data-i]", ul).forEach((li) => li.addEventListener("click", () => {
      const r = res[+li.dataset.i];
      const short = r.name || r.display_name.split(",").slice(0, 2).join(",");
      addStop(parseFloat(r.lat), parseFloat(r.lon), short);
      ul.innerHTML = "";
      $("#searchInput").value = "";
      fitToStops();
    }));
  } catch (err) {
    ul.innerHTML = `<li class="fine">${esc(err.message)}</li>`;
  }
});

/* Hotspot search distances. Trips saved with the old 25 km choice become 20 km. */
const RADII = [1, 5, 10, 20, 50], DEFAULT_RADIUS = 10;
/* Or a drive-time limit: hotspots are searched within a straight-line distance that a
   drive of that long could reach, then kept only if the road route fits the time. */
const DRIVE_MINS = [15, 30, 45, 60, 90];
function limitOf(stop) {
  const m = DRIVE_MINS.includes(+stop.hsMinutes) ? +stop.hsMinutes : null;
  return m ? { min: m, km: Math.min(50, Math.max(5, Math.ceil(m * 0.9))) } : { min: null, km: radiusOf(stop.hsRadius) };
}
function limitText(stop) {
  const l = limitOf(stop);
  return l.min ? `a ${l.min} min drive` : `${l.km} km`;
}
function radiusOf(v) {
  v = +v;
  if (RADII.includes(v)) return v;
  return v === 25 ? 20 : DEFAULT_RADIUS;
}

function loadTrip(trip, { clean = true } = {}) {
  const t = blankTrip();
  state.trip = {
    id: trip.id || null,
    name: trip.name || "",
    v: 2,
    stars: Array.isArray(trip.stars) ? trip.stars.filter((x) => typeof x === "string") : [],
    party: Array.isArray(trip.party) ? trip.party.filter((x) => typeof x === "string") : null,
    priority: typeof trip.priority === "string" ? trip.priority : "all",
    date: parseISO(trip.date) ? trip.date : "",
    window: [3, 5, 7, 10, 15].includes(+trip.window) ? +trip.window : 7,
    stops: (trip.stops || []).filter((s) => isFinite(s.lat) && isFinite(s.lng)).map((s) => ({
      id: s.id || uid(), name: s.name || "Stop", lat: +s.lat, lng: +s.lng,
      date: parseISO(s.date) ? s.date : (!(trip.v >= 2) && parseISO(trip.date) ? trip.date : ""),
      region: s.region || null, regionFor: s.regionFor, nameEdited: !!s.nameEdited,
      hotspots: [1, 2, 3, 4, 5].includes(+s.hotspots) ? +s.hotspots : 2,
      hsRadius: radiusOf(s.hsRadius),
      hsMinutes: DRIVE_MINS.includes(+s.hsMinutes) ? +s.hsMinutes : null,
      result: s.result && s.result.sig && s.result.data ? s.result : null,
      hsCache: s.hsCache && s.hsCache.key && Array.isArray(s.hsCache.candidates) ? s.hsCache : null,
    })),
  };
  state.results.clear();
  hsState.clear();
  hsVersion++;
  // Bring back saved results and hotspot plans (no eBird requests).
  for (const st of state.trip.stops) {
    if (st.result) state.results.set(st.id, { sig: st.result.sig, status: "done", data: st.result.data });
    if (st.hsCache) {
      for (const c of st.hsCache.candidates) hsLists.set(c.locId, new Set(c.codes || []));
      hsState.set(st.id, { key: st.hsCache.key, status: "done", candidates: st.hsCache.candidates.map(({ codes, ...c }) => c),
        maybe: Array.isArray(st.hsCache.maybe) ? st.hsCache.maybe : [], note: st.hsCache.note || "" });
    }
  }
  state.selected = state.trip.stops[0]?.id || null;
  $("#tripName").value = state.trip.name;
  $("#tripDate").value = state.trip.date;
  $("#tripWindow").value = String(state.trip.window);
  dateAsked = false;
  updateDateNeed();
  if (clean) markClean(); else markDirty();
  renderStops();
  fitToStops();
  render();
}

function confirmDiscard() {
  return !state.dirty || !state.trip.stops.length || confirm("You have unsaved changes to this trip. Discard them?");
}

$("#btnNew").addEventListener("click", () => {
  if (!confirmDiscard()) return;
  loadTrip(blankTrip());
  map.setView([39.5, -98.35], 4);
  setTab("trip");
  $("#tripName").focus();
});

$("#btnSave").addEventListener("click", saveTrip);
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveTrip(); }
});
async function saveTrip() {
  if (!state.trip.name.trim()) {
    const n = prompt("Name this trip:", "");
    if (n === null) return;
    state.trip.name = n.trim() || "Untitled trip";
    $("#tripName").value = state.trip.name;
  }
  try {
    const saved = await api("/api/trips", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.trip) });
    state.trip.id = saved.id;
    markClean();
    toast(`Saved “${state.trip.name}”`);
  } catch (e) {
    toast("Couldn't save: " + e.message);
  }
}

$("#btnTrips").addEventListener("click", openTrips);
async function openTrips() {
  const ul = $("#tripsList");
  ul.innerHTML = `<li class="fine">Loading…</li>`;
  $("#tripsDlg").showModal();
  try {
    const trips = await api("/api/trips");
    if (!trips.length) { ul.innerHTML = `<li class="fine">No saved trips yet. Build one and press Save.</li>`; return; }
    ul.innerHTML = trips.map((t) => `<li>
      <div class="tn"><b>${esc(t.name || "Untitled trip")}</b><span>${niceDate(t.date, true)} · ${t.stops} stop${t.stops === 1 ? "" : "s"}</span></div>
      <button class="primary small" data-open="${esc(t.id)}">Open</button>
      <button class="ghost small" data-del="${esc(t.id)}" data-name="${esc(t.name)}">Delete</button></li>`).join("");
  } catch (e) {
    ul.innerHTML = `<li class="fine">${esc(e.message)}</li>`;
  }
}
$("#tripsList").addEventListener("click", async (e) => {
  const open = e.target.closest("[data-open]");
  const del = e.target.closest("[data-del]");
  if (open) {
    if (!confirmDiscard()) return;
    try {
      const t = await api(`/api/trips/${encodeURIComponent(open.dataset.open)}`);
      $("#tripsDlg").close();
      loadTrip(t);
      setTab(state.trip.stops.length ? "whole" : "trip");
    } catch (err) { toast(err.message); }
  } else if (del) {
    if (!confirm(`Delete “${del.dataset.name || "this trip"}”? This can't be undone.`)) return;
    await api(`/api/trips/${encodeURIComponent(del.dataset.del)}`, { method: "DELETE" }).catch((err) => toast(err.message));
    if (state.trip.id === del.dataset.del) { state.trip.id = null; markDirty(); }
    openTrips();
  }
});

$("#btnExport").addEventListener("click", () => {
  const data = { app: "peregrine", version: 1, trip: state.trip };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (state.trip.name || "trip").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$("#btnImport").addEventListener("click", () => $("#importFile").click());
$("#importFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f || !confirmDiscard()) return;
  try {
    const obj = JSON.parse(await f.text());
    const trip = obj.trip || obj;
    if (!Array.isArray(trip.stops)) throw new Error("not a trip file");
    trip.id = null; // importing makes a new trip; Save won't overwrite another one
    loadTrip(trip, { clean: false });
    toast(`Imported “${trip.name || "trip"}”. Press Save to keep it.`);
  } catch (err) {
    toast("That file isn't a Peregrine trip.");
  }
});

// ------------------------------------------------------------------ settings
$$("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

async function openSettings(welcome = false) {
  $("#welcome").hidden = !welcome;
  $("#keyMsg").textContent = "";
  $("#lifeMsg").textContent = "";
  renderListsManager();
  try {
    const s = await api("/api/settings");
    $("#keyInput").placeholder = s.keyHint ? `Key saved (${s.keyHint}). Paste a new one to replace it.` : "Paste your eBird API key";
  } catch (e) { /* ignore */ }
  if (!$("#settingsDlg").open) $("#settingsDlg").showModal();
}
$("#btnSettings").addEventListener("click", () => openSettings());

$("#keyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const m = $("#keyMsg");
  const key = $("#keyInput").value.trim();
  if (!key) return;
  m.className = "msg"; m.textContent = "Checking with eBird…";
  try {
    const r = await api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: key }) });
    m.className = "msg " + (r.ok ? "ok" : "bad");
    m.textContent = r.message;
    $("#keyInput").value = "";
    if (r.ok) {
      // retry any stops that failed for lack of a key
      toast("Key saved. Click Find birds to search.");
    }
  } catch (err) { m.className = "msg bad"; m.textContent = err.message; }
});

/* Life lists: one per person, each with a name. */
function renderListsManager() {
  const ul = $("#listsList");
  ul.innerHTML = state.lists.length ? state.lists.map((l) => `<li data-list="${esc(l.id)}">
      <input class="list-name" value="${esc(l.name)}" aria-label="Name for this life list" maxlength="40">
      <span class="fine">${l.count} species${l.importedAt ? ` · ${esc(l.importedAt.slice(0, 10))}` : ""}</span>
      <label class="ghost small file-btn" title="Load a newer CSV for this person">Update<input type="file" accept=".csv,text/csv" data-replace="${esc(l.id)}" hidden></label>
      <button class="ghost small" type="button" data-del-list="${esc(l.id)}">Delete</button></li>`).join("")
    : `<li class="fine">No life lists yet.</li>`;
}
async function reloadLists() {
  setLists(await api("/api/lifelists"));
  hsVersion++;
  renderListsManager();
  render();
}
async function uploadList(file, { id = "", name = "" } = {}) {
  const m = $("#lifeMsg");
  m.className = "msg"; m.textContent = "Reading…";
  try {
    const obj = await api(`/api/lifelists${id ? "?id=" + encodeURIComponent(id) : ""}`, {
      method: "POST",
      headers: { "Content-Type": "text/csv", "X-Filename": encodeURIComponent(file.name), "X-List-Name": encodeURIComponent(name) },
      body: await file.text(),
    });
    // A new person joins the open trip's party.
    if (!id && Array.isArray(state.trip.party)) { state.trip.party.push(obj.id); markDirty(); }
    await reloadLists();
    m.className = "msg ok"; m.textContent = `${obj.name}: ${obj.species.length} species loaded from ${obj.filename}.`;
  } catch (err) { m.className = "msg bad"; m.textContent = err.message; }
}
$("#lifeFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  await uploadList(f, { name: $("#newListName").value.trim() });
  $("#newListName").value = "";
});
$("#listsList").addEventListener("change", async (e) => {
  const li = e.target.closest("[data-list]");
  if (!li) return;
  if (e.target.matches("[data-replace]")) {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) await uploadList(f, { id: li.dataset.list });
  } else if (e.target.matches(".list-name")) {
    try {
      await api(`/api/lifelists/${encodeURIComponent(li.dataset.list)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: e.target.value }) });
      await reloadLists();
    } catch (err) { $("#lifeMsg").className = "msg bad"; $("#lifeMsg").textContent = err.message; }
  }
});
$("#listsList").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del-list]");
  if (!del) return;
  const l = state.lists.find((x) => x.id === del.dataset.delList);
  if (!l || !confirm(`Remove ${l.name}'s life list from the planner? You can import it again later.`)) return;
  await api(`/api/lifelists/${encodeURIComponent(l.id)}`, { method: "DELETE" }).catch((err) => toast(err.message));
  await reloadLists();
  $("#lifeMsg").className = "msg"; $("#lifeMsg").textContent = `${l.name}'s life list removed.`;
});

// ------------------------------------------------------------------ import a route
function addStops(list, replace) {
  if (replace) { state.trip.stops = []; state.results.clear(); }
  const added = list.map((p, i) => {
    const s = { id: uid(), name: p.name || `Stop ${state.trip.stops.length + i + 1}`, lat: +p.lat, lng: +p.lng, date: p.date || "", region: null, hotspots: 2, hsRadius: DEFAULT_RADIUS };
    if (p.name) s.nameEdited = true;
    return s;
  });
  state.trip.stops.push(...added);
  if (added.length) state.selected = added[0].id;
  markDirty();
  updateDateNeed();
  renderStops();
  fitToStops();
  for (const s of added) if (!s.nameEdited) nameFromMap(s);
  render();
}

$("#btnImportRoute").addEventListener("click", () => {
  $("#importMsg").textContent = "";
  $("#importMsg").className = "msg";
  if (!$("#importDay1").value && state.trip.date) $("#importDay1").value = state.trip.date;
  $("#importDlg").showModal();
  setTimeout(() => $("#importText").focus(), 50);
});
$("#btnDoImport").addEventListener("click", async () => {
  const m = $("#importMsg");
  const file = $("#importRouteFile").files[0];
  const text = $("#importText").value.trim();
  if (!file && !text) { m.className = "msg bad"; m.textContent = "Paste a link or some places, or choose a file."; return; }
  const hasDays = !file && /^\s*(?:days?|nights?|d)\s*\d/im.test(text);
  const day1 = $("#importDay1").value;
  if (hasDays && !parseISO(day1)) { m.className = "msg bad"; m.textContent = "Your list has day numbers. Set the date of Day 1 so each stop gets the right date."; $("#importDay1").focus(); return; }
  const btn = $("#btnDoImport");
  btn.disabled = true;
  m.className = "msg";
  m.textContent = "Finding the places… (about a second each)";
  try {
    const r = file
      ? await api("/api/import-route", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name) }, body: await file.arrayBuffer() })
      : await api("/api/import-route", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, suffix: $("#importSuffix").value.trim() }) });
    if (!r.stops.length) {
      m.className = "msg bad";
      m.textContent = "Couldn't find any of those places." + (r.failed.length ? " Try adding the state or country to each line." : "");
      return;
    }
    const replace = $("#importReplace").checked;
    if (hasDays) {
      for (const st of r.stops) if (st.day) st.date = iso(addDays(parseISO(day1), st.day - 1));
      if (replace || !state.trip.date || !state.trip.stops.length) {
        state.trip.date = day1;
        $("#tripDate").value = day1;
      }
    }
    addStops(r.stops, replace);
    const extra = [...(r.notes || [])];
    if (r.failed.length) extra.push(`Couldn't find: ${r.failed.join("; ")}. Try adding the state or country, or add those by searching.`);
    if (extra.length) {
      m.className = "msg " + (r.failed.length ? "bad" : "ok");
      m.textContent = `Added ${r.stops.length} stop${r.stops.length === 1 ? "" : "s"}. ` + extra.join(" ");
      $("#importText").value = r.failed.join("\n");
      $("#importRouteFile").value = "";
    } else {
      $("#importDlg").close();
      $("#importText").value = "";
      $("#importRouteFile").value = "";
      toast(`Added ${r.stops.length} stop${r.stops.length === 1 ? "" : "s"}`);
    }
  } catch (e) {
    m.className = "msg bad";
    m.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------------ start
window.addEventListener("beforeunload", () => persistLocal());

(async function init() {
  let restored = null;
  try { restored = JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch (e) { /* ignore */ }
  try { setLists(await api("/api/lifelists")); } catch (e) { /* none */ }
  let settings = { hasKey: false };
  try { settings = await api("/api/settings"); } catch (e) { toast(e.message); }
  state.mock = !!settings.mock;
  $("#mockBanner").hidden = !state.mock;
  if (restored && restored.trip) loadTrip(restored.trip, { clean: !restored.dirty });
  else loadTrip(blankTrip());
  if (!settings.hasKey) openSettings(true);
})();

// ------------------------------------------------------------------ best hotspots at a stop
/* For a stop, look at the eBird hotspots within the chosen distance that have the most
   species (up to 10), and read each one's all-time species list (1 request each, saved
   30 days). Two ways to show them:
   - "Each on its own": every hotspot is ranked by the birds on its own list.
   - "Best combination": the set of N hotspots that together cover the most, shown in
     the order that adds the most first (B shows what it adds on top of A).
   A bird's value is its likelihood around the date, multiplied by 100 if starred, then by
   how many people in the party it's a lifer for (or, with one person prioritized, mostly
   whether it's a lifer for them), and almost nothing otherwise. */
const MAX_CANDIDATES = 10;
const LETTERS = "ABCDEFGHIJ";
const hsOpen = new Set();   // "stopId|locId" rows that show their birds
const hsDays = new Map();   // daysKey -> what each hotspot reported around the dates
const driveTried = new Set();

function hsKey(stop) {
  const l = limitOf(stop);
  return `${stop.lat.toFixed(4)},${stop.lng.toFixed(4)}|${l.min ? l.min + "min" : l.km}`;
}
const DRIVE_POOL = 25;       // most places one routing request can take
const LONG_WAY = 3;          // road km more than this times the straight-line km...
const LONG_WAY_FACTOR = 0.8; // ...ranks a hotspot a little lower in "Best birds"

async function runHotspots(stop) {
  const key = hsKey(stop);
  const st = { key, status: "loading", done: 0, total: 0, candidates: [], maybe: [], note: "", error: null };
  hsState.set(stop.id, st);
  hsVersion++;
  render();
  const stale = () => hsState.get(stop.id) !== st;
  try {
    const lim = limitOf(stop);
    const radius = lim.km;
    const hs = await limiter(() => api(`/api/ebird/ref/hotspot/geo?lat=${stop.lat.toFixed(4)}&lng=${stop.lng.toFixed(4)}&dist=${radius}&fmt=json`));
    if (stale()) return;
    let near = (Array.isArray(hs) ? hs : [])
      .map((h) => ({ locId: h.locId, name: h.locName, lat: h.lat, lng: h.lng, n: h.numSpeciesAllTime || 0, dist: haversineKm(stop, h) }))
      .filter((h) => h.locId && h.dist <= radius)   // exactly within the distance chosen
      .sort((a, b) => b.n - a.n || a.dist - b.dist);
    if (lim.min && near.length) {
      // Drive-time limit: route to the busiest hotspots first, keep the ones that fit.
      const pool = near.slice(0, DRIVE_POOL);
      let r = null;
      try { r = await driveRequest(stop, pool); } catch (e) { /* fall back to straight-line distance */ }
      if (stale()) return;
      if (r) {
        pool.forEach((c, i) => { c.drive = driveFrom(r, i); });
        near = pool.filter((c) => c.drive && c.drive.min <= lim.min);
        // Over the time only because no mapped road reaches them: they may really be closer.
        st.maybe = pool.filter((c) => c.drive && c.drive.approx && c.drive.min > lim.min)
          .sort((a, b) => a.dist - b.dist).slice(0, 4);
        if (!near.length) throw new Error(`No eBird hotspots within ${limitText(stop)} of this stop. Try a longer drive.`);
      } else {
        st.note = `Driving times aren't available right now, so this used straight-line distance (up to ${radius} km) instead of ${limitText(stop)}.`;
      }
    }
    const cands = near.slice(0, MAX_CANDIDATES);
    if (!cands.length) throw new Error(`No eBird hotspots within ${radius} km of this stop. Try a bigger distance.`);
    st.total = cands.length;
    await Promise.all(cands.map((c) => limiter(async () => {
      if (stale()) return;
      if (!hsLists.has(c.locId)) {
        try {
          const codes = await api(`/api/ebird/product/spplist/${encodeURIComponent(c.locId)}`);
          hsLists.set(c.locId, new Set(Array.isArray(codes) ? codes : []));
        } catch (e) {
          if (e.status === 401) throw e;
          hsLists.set(c.locId, null); // couldn't load this one; skip it
        }
      }
      st.done++;
      hsVersion++;
      render();
    })));
    if (stale()) return;
    st.candidates = cands.filter((c) => hsLists.get(c.locId));
    if (!st.candidates.length) throw new Error("Couldn't load the hotspot species lists from eBird. Try again in a few minutes.");
    st.status = "done";
    stop.hsCache = { key, candidates: st.candidates.map((c) => ({ ...c, codes: Array.from(hsLists.get(c.locId)) })), maybe: st.maybe, note: st.note };
    markDirty();
    fetchDrive(stop);
  } catch (e) {
    if (stale()) return;
    st.status = "error";
    st.error = e.message || String(e);
  }
  hsVersion++;
  render();
}

/* Driving time from the stop's pin to each hotspot: one request for all of them. */
function driveRequest(stop, places) {
  const to = places.map((c) => `${(+c.lat).toFixed(5)},${(+c.lng).toFixed(5)}`).join("|");
  return api(`/api/drive?from=${stop.lat.toFixed(5)},${stop.lng.toFixed(5)}&to=${encodeURIComponent(to)}`);
}
function driveFrom(r, i) {
  const offRoad = (m) => m != null && m > 500;
  const d = r.dests[i];
  return d && d.min != null ? { min: d.min, km: d.km, approx: offRoad(d.snapM) || offRoad(r.srcSnapM) } : null;
}
/** Road distance far longer than straight-line: a mountain, lake or river in the way. */
function longWay(h) {
  const d = h.drive;
  return !!(d && d.km != null && h.dist >= 0.5 && d.km > LONG_WAY * h.dist && d.km - h.dist > 5);
}
async function fetchDrive(stop) {
  const st = hsState.get(stop.id);
  if (!st || st.status !== "done" || !st.candidates.length) return;
  if (st.candidates.every((c) => c.drive !== undefined)) return;
  const tryKey = stop.id + "|" + st.key;
  if (driveTried.has(tryKey)) return;
  driveTried.add(tryKey);
  st.driveStatus = "loading";
  hsVersion++;
  render();
  try {
    const r = await driveRequest(stop, st.candidates);
    if (hsState.get(stop.id) !== st) return;
    st.candidates.forEach((c, i) => {
      c.drive = driveFrom(r, i);
      const saved = stop.hsCache && stop.hsCache.candidates.find((x) => x.locId === c.locId);
      if (saved) saved.drive = c.drive;
    });
    st.driveStatus = "done";
    markDirty();
  } catch (e) {
    st.driveStatus = "error";
    st.driveError = e.message;
  }
  hsVersion++;
  render();
}
function driveMin(h) { return h.drive && h.drive.min != null ? h.drive.min : Infinity; }
function driveHTML(h) {
  if (h.drive === undefined) return "";
  if (!h.drive) return ` · <span class="drive" title="The routing service found no road route">no road route</span>`;
  const m = Math.round(h.drive.min);
  const t = m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
  const tip = (h.drive.approx ? "Approximate: the stop or hotspot is away from roads, so this goes to the nearest road point. " : "") +
    "Driving time by car on OpenStreetMap roads, without traffic.";
  return ` · <span class="drive" title="${esc(tip)}">🚗 ${h.drive.approx ? "~" : ""}${t} (${h.drive.km} km by road)</span>`;
}

function birdValue(sp) {
  const base = 0.25 + (sp.p || 0);
  if (isStarred(sp)) return 100 * base;
  if (!lifeOn()) return base;
  const who = liferFor(sp);
  const pl = priorityList();
  if (pl) {
    const mine = who.includes(pl);
    const others = who.length - (mine ? 1 : 0);
    return (mine ? 1 + 0.05 * others : 0.01 + 0.01 * others) * base;
  }
  return (who.length || 0.01) * base;
}

function* combos(n, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc.slice(); return; }
  for (let i = start; i <= n - (k - acc.length); i++) { acc.push(i); yield* combos(n, k, i + 1, acc); acc.pop(); }
}

/** Hotspots for this stop's birds, either each on its own or the best combination of N. */
function planHotspots(stop, data) {
  const st = hsState.get(stop.id);
  if (!st || st.status !== "done" || st.key !== hsKey(stop)) return null;
  const birds = data.species.filter((s) => s.p > 0 || s.recent);
  const value = new Map(birds.map((b) => [b.code, birdValue(b)]));
  const byCode = new Map(birds.map((b) => [b.code, b]));
  const cands = st.candidates;
  const listOf = (c) => hsLists.get(c.locId) || new Set();
  const combined = prefs.hsMode === "combined";
  const covered = new Set();
  let steps;
  if (combined) {
    const k = Math.min(stop.hotspots || 2, cands.length);
    let best = null, bestScore = -1;
    for (const combo of combos(cands.length, k)) {
      const seen = new Set();
      let score = 0;
      for (const ci of combo) for (const code of listOf(cands[ci])) {
        if (!seen.has(code) && value.has(code)) { seen.add(code); score += value.get(code); }
      }
      score -= combo.reduce((a, ci) => a + cands[ci].dist, 0) * 1e-6; // tie-break: closer wins
      if (score > bestScore) { bestScore = score; best = combo; }
    }
    // Present them in the order that adds the most first, with what each adds.
    const remaining = best.slice();
    steps = [];
    while (remaining.length) {
      let pick = 0, pickGain = -1;
      remaining.forEach((ci, idx) => {
        let g = 0;
        for (const code of listOf(cands[ci])) if (!covered.has(code) && value.has(code)) g += value.get(code);
        if (g > pickGain) { pickGain = g; pick = idx; }
      });
      const ci = remaining.splice(pick, 1)[0];
      const adds = [];
      for (const code of listOf(cands[ci])) if (!covered.has(code) && byCode.has(code)) { covered.add(code); adds.push(byCode.get(code)); }
      adds.sort((a, b) => birdValue(b) - birdValue(a));
      steps.push({ hotspot: cands[ci], adds });
    }
  } else {
    steps = cands.map((c) => {
      const adds = [];
      for (const code of listOf(c)) if (byCode.has(code)) { adds.push(byCode.get(code)); covered.add(code); }
      adds.sort((a, b) => birdValue(b) - birdValue(a));
      const score = adds.reduce((a, b) => a + value.get(b.code), 0) * (longWay(c) ? LONG_WAY_FACTOR : 1);
      return { hotspot: c, adds, score };
    });
    if (prefs.hsSort === "drive") steps.sort((a, b) => driveMin(a.hotspot) - driveMin(b.hotspot) || a.hotspot.dist - b.hotspot.dist);
    else steps.sort((a, b) => b.score - a.score || a.hotspot.dist - b.hotspot.dist);
  }
  const starred = birds.filter(isStarred);
  const lifers = birds.filter(isLifer);
  const missedStarred = starred.filter((b) => !covered.has(b.code)).map((b) => ({
    bird: b, elsewhere: cands.filter((c) => listOf(c).has(b.code)).map((c) => c.name),
  }));
  return {
    combined, steps, covered,
    starredTotal: starred.length, starredCovered: starred.length - missedStarred.length,
    liferTotal: lifers.length, liferCovered: lifers.filter((b) => covered.has(b.code)).length,
    speciesTotal: birds.length, missedStarred, candidates: cands.length,
  };
}

function namesList(list, max = 6) {
  const names = list.slice(0, max).map((b) => (isStarred(b) ? "★ " : "") + esc(b.com));
  return names.join(", ") + (list.length > max ? `, +${list.length - max} more` : "");
}

/* What one hotspot reported, day by day, around the stop's date in the most recent year
   whose window has passed (this year if it's already over, otherwise last year). */
function windowYear(dateStr, n) {
  const base = parseISO(dateStr), today = parseISO(todayISO());
  for (let y = today.getFullYear(); ; y--) {
    if (addDays(new Date(y, base.getMonth(), base.getDate()), n) < today) return y;
  }
}
function daysKey(stop, locId) { return `${locId}|${stopDate(stop)}|${state.trip.window}`; }

async function loadHotspotDays(stop, h) {
  const date = stopDate(stop);
  if (!date) return;
  const key = daysKey(stop, h.locId);
  const prev = hsDays.get(key);
  if (prev && (prev.status === "loading" || (prev.status === "done" && !prev.failed))) return;
  const n = state.trip.window, year = windowYear(date, n), base = parseISO(date);
  const center = new Date(year, base.getMonth(), base.getDate());
  const days = [];
  for (let k = -n; k <= n; k++) days.push(addDays(center, k));
  const d = { status: "loading", year, from: iso(days[0]), to: iso(days[days.length - 1]), total: days.length, done: 0, withLists: 0, failed: 0, counts: new Map(), error: null };
  hsDays.set(key, d);
  hsVersion++;
  render();
  let authErr = null;
  await Promise.all(days.map((day) => limiter(async () => {
    try {
      if (authErr) throw authErr;
      const obs = await api(`/api/ebird/data/obs/${encodeURIComponent(h.locId)}/historic/${day.getFullYear()}/${day.getMonth() + 1}/${day.getDate()}?cat=species&detail=simple`);
      if (Array.isArray(obs) && obs.length) {
        d.withLists++;
        const seen = new Set();
        for (const o of obs) {
          if (!o.speciesCode || seen.has(o.speciesCode)) continue;
          seen.add(o.speciesCode);
          const c = d.counts.get(o.speciesCode) || { code: o.speciesCode, com: o.comName, sci: o.sciName, n: 0, p: 0 };
          c.n++;
          d.counts.set(o.speciesCode, c);
        }
      }
    } catch (e) {
      d.failed++;
      if (e.status === 401 || e.status === 400) authErr = authErr || e;
    } finally {
      d.done++;
      hsVersion++;
      render();
    }
  })));
  for (const c of d.counts.values()) c.p = d.withLists ? c.n / d.withLists : 0;
  d.status = authErr ? "error" : "done";
  if (authErr) d.error = authErr.message;
  hsVersion++;
  render();
}

function hsDaysHTML(stop, h) {
  const d = hsDays.get(daysKey(stop, h.locId));
  if (!d) { setTimeout(() => loadHotspotDays(stop, h)); return `<div class="hs-days fine">Loading…</div>`; }
  const range = `${niceDate(d.from)} – ${niceDate(d.to)}, ${d.year}`;
  if (d.status === "loading") {
    return `<div class="hs-days fine">Checking ${d.total} days at this hotspot (${range})… ${d.done}/${d.total}<div class="progress"><i style="width:${Math.round((d.done / d.total) * 100)}%"></i></div></div>`;
  }
  const retry = `<a data-hs-days-retry="${esc(stop.id)}|${esc(h.locId)}">try again</a>`;
  if (d.status === "error") return `<div class="hs-days msg bad">${esc(d.error)} ${retry}</div>`;
  const miss = d.failed ? ` ${d.failed} day${d.failed === 1 ? "" : "s"} couldn't be loaded from eBird (${retry}).` : "";
  if (!d.withLists) return `<div class="hs-days fine">No checklists at this hotspot between ${range}.${miss}</div>`;
  const f = state.filters;
  let list = Array.from(d.counts.values());
  if (f.lifers) list = list.filter(isLifer);
  if (f.starred) list = list.filter(isStarred);
  if (f.q) { const q = f.q.toLowerCase(); list = list.filter((s) => (s.com || "").toLowerCase().includes(q) || (s.sci || "").toLowerCase().includes(q)); }
  list.sort((a, b) => b.n - a.n || a.com.localeCompare(b.com));
  const narrowed = f.lifers || f.starred || f.q ? ` (${list.length} match your filters)` : "";
  return `<div class="hs-days">
    <p class="fine">${d.counts.size} species reported here on the <b>${d.withLists}</b> of ${d.total} days that had checklists, ${range}${narrowed}. The count is how many of those days each bird was reported.${miss}</p>
    ${list.length ? `<ul class="hd-list">${list.map((s) => `<li class="${isLifer(s) ? "lifer" : ""} ${isStarred(s) ? "starred" : ""}">
      <span class="hd-n">${s.n}/${d.withLists}</span><span class="bar"><i style="width:${Math.max(3, Math.round(s.p * 100))}%"></i></span>
      <span class="hd-name"><button class="star-btn ${isStarred(s) ? "on" : ""}" data-star="${esc(s.code)}" title="Star as a target">${isStarred(s) ? "★" : "☆"}</button>${esc(s.com)}${liferTagHTML(s)}</span></li>`).join("")}</ul>`
    : `<p class="fine">No birds here match your filters.</p>`}
  </div>`;
}

function hotspotBoxHTML(stop, data) {
  const st = hsState.get(stop.id);
  const fresh = st && st.key === hsKey(stop);
  const radius = radiusOf(stop.hsRadius);
  const lim = limitOf(stop);
  const limVal = lim.min ? `min:${lim.min}` : `km:${radius}`;
  const limOpts = `<optgroup label="Distance">${RADII.map((v) => `<option value="km:${v}" ${limVal === "km:" + v ? "selected" : ""}>${v} km</option>`).join("")}</optgroup>` +
    `<optgroup label="Drive time">${DRIVE_MINS.map((m) => `<option value="min:${m}" ${limVal === "min:" + m ? "selected" : ""}>${m} min drive</option>`).join("")}</optgroup>`;
  const opts = (vals, cur, fmt) => vals.map((v) => `<option value="${v}" ${v === cur ? "selected" : ""}>${fmt(v)}</option>`).join("");
  const combined = prefs.hsMode === "combined";
  let html = `<div class="hs-box">
    <div class="hs-head">
      <b>Best hotspots</b>
      <span>within <select data-hs-limit="${stop.id}" title="Straight-line distance, or how long the drive is">${limOpts}</select></span>
      ${fresh && st.status !== "error" ? "" : `<button class="primary small" data-hs-run="${stop.id}">Find best hotspots</button>`}
    </div>
    <div class="hs-modes">
      <span class="seg" role="group" aria-label="How to rank hotspots">
        <button type="button" data-hs-mode="each" class="${combined ? "" : "on"}" aria-pressed="${!combined}">Each on its own</button><button type="button" data-hs-mode="combined" class="${combined ? "on" : ""}" aria-pressed="${combined}">Best combination</button>
      </span>
      ${combined
        ? `<span>Visit <select data-hs-count="${stop.id}">${opts([1, 2, 3, 4, 5], stop.hotspots || 2, (v) => v)}</select></span>`
        : `<span>Sort <select data-hs-sort>${opts(["birds", "drive"], prefs.hsSort, (v) => (v === "birds" ? "Best birds" : "Shortest drive"))}</select></span>`}
    </div>`;
  if (!fresh) {
    const nStar = data.species.filter(isStarred).length;
    html += `<p class="fine">Ranks the eBird hotspots within ${limitText(stop)} by the ${lifeOn() ? `lifers${liferWho()}` : "species"} on their lists${nStar ? `, with your <b>${nStar} starred</b> bird${nStar === 1 ? "" : "s"} first` : ". Star (☆) the birds you want most and they'll count first"}, and shows the driving time to each. Uses about ${MAX_CANDIDATES} eBird requests the first time, saved for 30 days.</p>`;
  } else if (st.status === "loading") {
    html += `<p class="fine">Reading hotspot species lists… ${st.done}/${st.total || "?"}</p>`;
  } else if (st.status === "error") {
    html += `<p class="msg bad">${esc(st.error)}</p>`;
  } else {
    const plan = planHotspots(stop, data);
    if (st.candidates.some((c) => c.drive === undefined) && st.driveStatus !== "loading") setTimeout(() => fetchDrive(stop));
    const parts = [];
    if (plan.starredTotal) parts.push(`<b>★ ${plan.starredCovered} of ${plan.starredTotal}</b> starred`);
    if (lifeOn()) parts.push(`<b>${plan.liferCovered} of ${plan.liferTotal}</b> possible lifers${liferWho()}`);
    else parts.push(`<b>${plan.covered.size} of ${plan.speciesTotal}</b> species`);
    html += combined
      ? `<p class="hs-sum">${plan.steps.length === 1 ? "This hotspot covers" : `These ${plan.steps.length} together cover`} ${parts.join(" and ")} at this stop.</p>`
      : `<p class="hs-sum">${plan.steps.length} hotspot${plan.steps.length === 1 ? "" : "s"} within ${limitText(stop)}, each judged on its own list, ${prefs.hsSort === "drive" ? "nearest drive first" : "best first"}. Between them they have ${parts.join(" and ")} at this stop.</p>`;
    if (st.note) html += `<p class="fine">${esc(st.note)}</p>`;
    if (st.driveStatus === "loading") html += `<p class="fine">Working out driving times…</p>`;
    if (st.driveStatus === "error") html += `<p class="fine">Driving times aren't available right now (${esc(st.driveError)}). Straight-line distances are shown instead.</p>`;
    html += `<ol class="hs-list">`;
    const party = partyLists();
    // Which past dates "what's been reported" looks at: the trip's dates in the latest year already over.
    const lookRange = (() => {
      const date = stopDate(stop);
      if (!date) return "around your dates";
      const n = state.trip.window, y = windowYear(date, n), base = parseISO(date);
      const c = new Date(y, base.getMonth(), base.getDate());
      return `${niceDate(iso(addDays(c, -n)))} – ${niceDate(iso(addDays(c, n)))}, ${y}`;
    })();
    plan.steps.forEach((step, i) => {
      const h = step.hotspot;
      const starAdds = step.adds.filter(isStarred);
      const liferAdds = lifeOn() ? step.adds.filter((b) => isLifer(b) && !isStarred(b)) : [];
      const other = step.adds.length - starAdds.length - liferAdds.length;
      const bits = [];
      if (starAdds.length) bits.push(`<span class="hs-star">${namesList(starAdds)}</span>`);
      if (liferAdds.length) bits.push(`${liferAdds.length} lifer${liferAdds.length === 1 ? "" : "s"}${liferWho()}: ${namesList(liferAdds)}`);
      if (other > 0) bits.push(`+${other} other species`);
      const verb = combined ? (i ? "Adds " : "Covers ") : "Has ";
      const who = party.length > 1 ? `<div class="hs-who">Lifers ${combined && i ? "added " : ""}by person: ${party.map((l) => `${esc(l.name)} <b>${step.adds.filter((b) => lacks(l, b)).length}</b>`).join(" · ")}</div>` : "";
      const openKey = `${stop.id}|${h.locId}`;
      const open = hsOpen.has(openKey);
      html += `<li><span class="hs-letter">${LETTERS[i]}</span><div>
        <a href="https://ebird.org/hotspot/${encodeURIComponent(h.locId)}" target="_blank" rel="noopener"><b>${esc(h.name)}</b></a>
        <span class="fine">${h.dist.toFixed(1)} km away${driveHTML(h)} · ${h.n} species all-time</span>
        ${longWay(h) ? `<div class="hs-long" title="Ranked a little lower in Best birds">⚠ Long way round: ${h.drive.km} km by road to get ${h.dist.toFixed(1)} km away${h.drive.approx ? ". No mapped road reaches it, so it may be closer than this" : ""}.</div>` : ""}
        <div class="hs-adds">${verb}${bits.join(" · ") || "nothing new"}</div>${who}
        <button type="button" class="link-btn" data-hs-open="${esc(openKey)}" aria-expanded="${open}">${open ? "▾ Hide" : "▸ Show"} what's been reported here ${lookRange}</button>
        ${open ? hsDaysHTML(stop, h) : ""}</div></li>`;
    });
    html += `</ol>`;
    if (lim.min && st.maybe && st.maybe.length) {
      html += `<div class="hs-maybe"><p class="fine">Left out, but maybe closer than they look: these are within ${lim.km} km and over ${lim.min} min only by the nearest mapped road, which doesn't reach them. A track or trail missing from the map may get you there faster.</p><ul>${st.maybe.map((h) => `<li><a href="https://ebird.org/hotspot/${encodeURIComponent(h.locId)}" target="_blank" rel="noopener">${esc(h.name)}</a> <span class="fine">${h.dist.toFixed(1)} km away${driveHTML(h)} · ${h.n} species all-time</span></li>`).join("")}</ul></div>`;
    }
    if (plan.missedStarred.length) {
      html += `<p class="hs-miss">Not covered: ${plan.missedStarred.map((m) => `★ ${esc(m.bird.com)}${m.elsewhere.length ? ` (reported at ${esc(m.elsewhere[0])}${m.elsewhere.length > 1 ? ` and ${m.elsewhere.length - 1} more` : ""}; try visiting more hotspots)` : ` (not on any hotspot list within ${limitText(stop)})`}`).join("; ")}.</p>`;
    }
    html += `<p class="fine">From the ${plan.candidates} hotspots with the most species within ${limitText(stop)}, using each hotspot's all-time eBird list weighted by how likely each bird is around your date. Starred birds count most, then lifers${party.length > 1 ? (priorityList() ? ` (${esc(priorityList().name)}'s first)` : " (birds that are lifers for more of the party count more)") : ""}.${combined ? "" : " Switch to <b>Best combination</b> to plan several hotspots together."}</p>`;
  }
  return html + `</div>`;
}

const hotspotLayer = L.layerGroup().addTo(map);
let hotspotLayerKey = "";
function renderHotspotLayer() {
  const stop = stopById(state.selected);
  const r = stop && state.results.get(stop.id);
  let plan = null;
  if (stop && r && r.status === "done" && state.tab === "stop") plan = planHotspots(stop, r.data);
  const key = plan ? stop.id + hsVersion + lifeKey() + JSON.stringify(prefs) + plan.steps.map((s) => s.hotspot.locId).join(",") + JSON.stringify(state.trip.stars) : "";
  if (key === hotspotLayerKey) return;
  hotspotLayerKey = key;
  hotspotLayer.clearLayers();
  if (!plan) return;
  plan.steps.forEach((step, i) => {
    const h = step.hotspot;
    const icon = L.divIcon({ className: "pin-wrap", html: `<div class="hs-pin">${LETTERS[i]}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
    const starAdds = step.adds.filter(isStarred).length;
    const lif = step.adds.filter(isLifer).length;
    L.marker([h.lat, h.lng], { icon, zIndexOffset: -100 })
      .bindTooltip(`<b>${LETTERS[i]}. ${esc(h.name)}</b><br>${starAdds ? `★ ${starAdds} starred · ` : ""}${lifeOn() ? `${lif} lifers` : `${step.adds.length} species`}${h.drive ? ` · ${h.drive.approx ? "~" : ""}${Math.round(h.drive.min)} min drive` : ""}`, { direction: "top", offset: [0, -10] })
      .bindPopup(`<b>${esc(h.name)}</b><br><a href="https://ebird.org/hotspot/${encodeURIComponent(h.locId)}" target="_blank" rel="noopener">Open on eBird ↗</a> · <a href="https://www.google.com/maps/dir/?api=1&origin=${stop.lat.toFixed(5)},${stop.lng.toFixed(5)}&destination=${(+h.lat).toFixed(5)},${(+h.lng).toFixed(5)}" target="_blank" rel="noopener">Directions ↗</a>`)
      .addTo(hotspotLayer);
  });
}

document.addEventListener("click", (e) => {
  const mode = e.target.closest("[data-hs-mode]");
  if (mode) { prefs.hsMode = mode.dataset.hsMode; savePrefs(); hsVersion++; render(); return; }
  const open = e.target.closest("[data-hs-open]");
  if (open) {
    const k = open.dataset.hsOpen;
    if (hsOpen.has(k)) hsOpen.delete(k);
    else {
      hsOpen.add(k);
      const [sid, loc] = k.split("|");
      const stop = stopById(sid), h = hsState.get(sid)?.candidates.find((c) => c.locId === loc);
      if (stop && h) loadHotspotDays(stop, h);
    }
    hsVersion++;
    render();
    return;
  }
  const again = e.target.closest("[data-hs-days-retry]");
  if (again) {
    const [sid, loc] = again.dataset.hsDaysRetry.split("|");
    const stop = stopById(sid), h = hsState.get(sid)?.candidates.find((c) => c.locId === loc);
    if (stop && h) loadHotspotDays(stop, h);
  }
});
document.addEventListener("change", (e) => {
  if (e.target.matches("[data-hs-sort]")) { prefs.hsSort = e.target.value; savePrefs(); hsVersion++; render(); }
});

// ------------------------------------------------------------------ previous / next stop
function stepStop(dir) {
  const stops = state.trip.stops;
  if (!stops.length) return;
  const i = Math.max(0, stopIndex(state.selected));
  const j = Math.min(stops.length - 1, Math.max(0, i + dir));
  if (j === i && stopIndex(state.selected) >= 0) return;
  selectStop(stops[j].id, true);
  map.panTo([stops[j].lat, stops[j].lng]);
  $("#tab-stop").scrollTop = 0;
}
document.addEventListener("keydown", (e) => {
  if (state.tab !== "stop" || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest("input, select, textarea, [contenteditable]") || document.querySelector("dialog[open]")) return;
  if (e.key === "ArrowLeft") { e.preventDefault(); stepStop(-1); }
  if (e.key === "ArrowRight") { e.preventDefault(); stepStop(1); }
});

function renderFindAll() {
  const bar = $("#findAll");
  const todo = state.trip.stops.filter(needsSearch);
  bar.hidden = !todo.length;
  if (!todo.length) return;
  const label = todo.length === state.trip.stops.length ? `all ${todo.length} stop${todo.length === 1 ? "" : "s"}` : `${todo.length} stop${todo.length === 1 ? "" : "s"} not yet searched`;
  const html = `<button class="primary" data-find-all>🔍 Find birds for ${label}</button><span class="fine">about ${todo.length * 25} eBird requests, fewer for anything looked up before</span>`;
  if (bar.dataset.html !== html) { bar.innerHTML = html; bar.dataset.html = html; }
}
