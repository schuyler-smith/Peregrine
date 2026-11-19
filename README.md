# Peregrine

*A bird trip planner. Peregrine is Latin for "wanderer", and it's the name of a well-traveled falcon.*

Plan a trip as a set of stops on a map and see which birds are likely at each stop around your date. You get a species list for each stop and a combined list for the whole trip, with possible **lifers** flagged from your eBird life list. It runs on your own computer, in your browser.

## Open it (one step)

**Windows:** double-click **`start.bat`**.

A small black window opens, then Peregrine opens in your browser at `http://localhost:8765`. Keep the black window open while you use the planner, and close it when you're done.

*Mac/Linux:* double-click `start.command` (or run `python3 server.py`).

**You need:** Python 3 (free from [python.org](https://www.python.org/downloads/); tick "Add python.exe to PATH" when installing) and an internet connection for eBird and the map. Nothing else needs installing.

## First time only (2 minutes)

The Settings window opens by itself the first time.

1. **eBird API key.** Get a free key at [ebird.org/api/keygen](https://ebird.org/api/keygen), paste it in and click **Save key**. The planner checks the key with eBird.
2. **Life list (optional, but it's the fun part).** On [ebird.org/lifelist](https://ebird.org/lifelist), click **Download (CSV)**, then choose that file in Settings. Re-import any time to update it. The full "Download My Data" CSV works too.

## Using it

- **Add stops:** search for a place in the Itinerary tab, or **double-click** the map and choose **＋ Add stop here**. Drag a pin to move it, and use ↑ ↓ ✕ to reorder or remove stops.
- **Import a route:** click **↥ Import a route** in the Itinerary tab, then do one of these:
  - Paste a **Google Maps directions link**: add all your stops in Google Maps, then Share → Copy link.
  - Paste a **list of places**, one per line (names, addresses, or `lat, lng`).
  - Choose a **GPX, KML or KMZ file**, for example from Google My Maps, Gaia GPS or AllTrails. A file that's just a path with no named stops gets 6 evenly spaced points.

  - Paste a **tour itinerary** with lines like `Day 3: Kruger National Park`, and set **Day 1 is** to the tour's start date. Each stop gets that day's date. Phrases like "Drive to…" or "birding en route" are stripped, "A to B" uses B (where you end up), repeated days at one place become one stop, and lines like "Fly home" are skipped. Put the country in **Add to each place search** (e.g. `South Africa`) so the right places are found.

  Places are looked up at about one per second. Anything that can't be found is listed so you can fix it.
- **Find birds (you decide when):** adding, moving or re-dating stops never contacts eBird on its own. Each stop has a **🔍 Find birds** button, and **Find birds for all stops** is at the top of the list, showing roughly how many eBird requests it will use. If you change a stop's date, the window or its location afterwards, the stop shows **↻ Update** and keeps its old results (marked as out of date) until you click it. Results and hotspot plans are saved with the trip, so reopening a trip needs no new requests.
- **Dates:** set the **Start date** at the top of the Itinerary tab (if you click Find birds without one, it asks). Stop 1 is on the start date and **each stop after it is the next day** (shown as Day 1, Day 2…). Change any stop's date and the stops after it follow on from it. **↺ auto** puts a stop back to "day after the previous one." Set the same date on two stops to visit both in one day. Reordering stops re-dates them. The window (±3, 5, 7, 10 or 15 days) sets how wide a slice of the calendar is sampled.
- **Stop tab:** click a pin or a stop to see its birds, most likely first. Use **‹ Prev / Next ›** at the top (or the ← → keys) to step through the stops in order. Use **Lifers only**, **★ Starred only**, the likelihood filter or the search box to narrow the list.
- **Star your targets:** tap **☆** next to any bird to star it for this trip (★). Stars are saved with the trip and show in every list.
- **Best hotspots:** on a stop, choose how many hotspots you'll visit (1–5) and how far you'll go (10, 25 or 50 km), then click **Find best hotspots**.
  - It picks the combination that covers the most lifers, with starred birds counting far more than the rest, and shows the hotspots as lettered markers (A, B, C…) on the map.
  - For each hotspot it lists what it adds, and it names any starred bird that isn't covered (and where else it's been reported).
  - How it works: it looks at the 10 hotspots with the most species within your distance, reads each one's all-time eBird species list, and weights each bird by how likely it is around your date. That's about 10 eBird requests the first time, saved for 30 days. After that, the stop shows its hotspots again automatically, and changing stars or the number of hotspots updates instantly.
- **Trip tab:** every species across all stops, its best chance, and numbered chips showing which stops have it (gold = best). Click a chip to jump to that stop.
- **Save:** **Save** (or Ctrl+S) names and saves the trip, and **My trips** reopens or deletes saved trips. **Export trip file** / **Import trip file** make a backup copy or move a trip to another computer.

## How "likely" is worked out

Cornell's Merlin "likely birds" model isn't available through the public eBird API, so the planner does a light version of eBird's own bar charts:

1. For each stop it finds the **county** (the eBird region of the nearest hotspot).
2. It picks **20 sample days**: 5 days spread evenly across your window (date ± N days) in each of the **last 4 years**. For each one, it asks eBird which species were reported in that county that day.
3. **Likelihood = the share of sample days a species was reported.** "60%" means it was reported on 60% of the sample days that had checklists. Days with no checklists at all are left out.
4. If the visit is within 30 days of today, birds reported **within 25 km in the last 30 days** are tagged "recent nearby" and added if they weren't already listed.

**Cost:** about **25 eBird requests per stop**, whatever the window: 20 sample days, plus finding the county, plus recent sightings. Stops load **one at a time**. Everything is saved, so reopening a trip, or another stop in the same county on the same date, costs nothing.

Keep in mind:
- It's a sample: 20 days gives a good ranking (common vs. scarce) but not precise odds. In a busy county with lots of birders, percentages run high. In a quiet county, everything looks rarer. Use it to compare stops and spot targets.
- Countries without counties use the state or province.
- If eBird asks the planner to slow down, it waits and retries on its own. A stop shows results once at least half its sample days load.

### Staying within eBird's terms
This is a personal, non-commercial tool. Your key stays on your computer, the map credits eBird, every answer is cached so nothing is fetched twice, requests are paced (one stop at a time, about 3 per second at most), and it backs off when eBird asks. Don't share your key or republish the data. The full rules are the eBird API Terms of Use, linked from [ebird.org/api/keygen](https://ebird.org/api/keygen).

## Run it on a server (Docker)

The same app runs in a Docker container, so you can reach it from any device. On the server you only need a `docker-compose.yml`. Either copy this repo's file, or use this:

```yaml
name: peregrine
services:
  peregrine:
    image: ghcr.io/schuyler-smith/peregrine:latest
    container_name: peregrine
    restart: unless-stopped
    ports:
      - "8765:8765"
    volumes:
      - peregrine-data:/app/data     # trips, life list, eBird key
      - peregrine-cache:/app/cache   # saved eBird answers
volumes:
  peregrine-data:
  peregrine-cache:
```

Start it with `docker compose up -d` and open `http://<server>:8765`. Paste your eBird key and import your life list in Settings as usual.

**Optional settings** (add them under `environment:`, or put them in a `.env` file using this repo's `docker-compose.yml`; see `.env.example`):
- `EBIRD_API_KEY`: your key, instead of pasting it in Settings.
- `PEREGRINE_PASSWORD`: makes the browser ask for a password (any username).
- `PEREGRINE_ALLOWED_HOSTS`: only answer to these addresses, e.g. `birds.example.com,192.168.1.50`.

By default there's no password and any address works. Anyone who can reach the server can then use Peregrine, including your eBird key. That's fine on a home network or a VPN like Tailscale. If it faces the internet, set a password and put HTTPS in front of it (Caddy, nginx, Traefik).

**Ready-made image:** every push to `main` builds the container (for both regular PCs/servers and ARM boards like a Raspberry Pi) and publishes it as `ghcr.io/schuyler-smith/peregrine:latest`. Pushing a tag like `v1.0.0` also publishes `:1.0.0`. To update a server: `docker compose pull && docker compose up -d`. If the package is private, either make it public on GitHub (your profile → Packages → peregrine → Package settings) or run `docker login ghcr.io` on the server first.

Day to day:
- **See what it's doing:** `docker compose logs -f`
- **Stop:** `docker compose down`. Trips, life list and cache are kept in Docker volumes.
- **Update after changing files:** `docker compose up -d --build`

**Bring over trips you already have** (run on the server, in this folder, with the container running):
```
docker compose cp ./data/. peregrine:/app/data/
docker compose exec -u root peregrine chown -R birder /app/data
docker compose restart
```

eBird's terms are for personal use, so don't share the link widely.

## Where your things are kept

Everything stays in this folder on your computer:
- `data/trips/` holds saved trips (one file each).
- `data/lifelist.json` is your imported life list.
- `data/problems.log` records anything eBird refused, which is handy if something goes wrong.
- `data/settings.json` is your eBird key.
- `cache/` holds saved eBird answers. It's safe to delete.

The planner only answers requests from this computer.

## Troubleshooting

- **"Can't reach the planner's local server"**: the black window was closed. Double-click `start.bat` again.
- **"eBird rejected the API key"**: paste the key again in Settings.
- **Map is grey**: check your internet connection.
- **Port in use**: the planner tries the next port automatically (8766, 8767, …). The black window shows the address it's using.
- **Lifer looks wrong**: species are matched by scientific name, then common name. Re-download your life list after eBird's yearly taxonomy update.

For testing without an eBird key: `set PEREGRINE_MOCK=1` then `python server.py` shows made-up sample birds with a banner saying so.
