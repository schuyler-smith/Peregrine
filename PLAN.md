# PLAN — Bird Trip Planner

## What it is
A web app that runs locally in your browser. You plot a trip as several stops on a map with a date, and it tells you which birds are likely at each stop and across the whole trip. Your eBird life list is used to flag possible lifers.

## Who it's for
Just me. It runs locally and isn't public. I use it to plan birding trips, and to check what I might see on non-birding trips (family visits, work travel).

## The 3 must-do things
1. **Build a trip on a map.** Pick a date and add stops by clicking the map or searching for a place. Save, name, reopen and delete trips ("My trips"), and export or import a trip as a file for backup.
2. **Show likely birds.** For each stop, find its county and pull eBird historic checklists for **date ± N days** (N = 3, 5, 7, 10 or 15, my choice) across the **last 5 years**. Likelihood = the share of those days a species was reported. If the trip is within 30 days, add recent sightings within about 25 km. Show a list for each stop and a combined list for the whole trip.
3. **Mark life birds.** Import my eBird life list CSV. Species not on it get a gold "★ Lifer" tag, and there's a "lifers only" toggle.

## How it looks
- Map on the left, about 2/3 of the screen (OpenStreetMap). Numbered pins in trip order, joined by a line, each with a **lifer-count badge**.
- Side panel on the right with tabs: **Trip** (date, window, stops, save/load), **This stop**, **Whole trip**.
- Species rows show the name, a likelihood bar and the ★ Lifer tag, with a link to the species page on eBird.
- Calm field-guide feel: off-white background, earthy greens, clean type.
- eBird API key pasted once in Settings and stored only on this computer.

## Out for today
- eBird account login. Life list comes from the CSV import.
- Merlin's exact model. It isn't available through the public API.
- Driving routes and travel times.
- Photos and sounds, weather and tides, Status & Trends maps.
- Offline use, since eBird and the map tiles need internet.

## The smile moment
I click a pin and see "**7 possible lifers here**", and the Whole trip tab says "**142 species possible, 11 lifers**".

## Done means 4 of 4
1. **Plan first.** Claude interviewed me, then wrote this one-page PLAN.md before building anything.
2. **It works.** Someone else can open it in one step: double-click `start.bat`, as explained in the README.
3. **Claude checked it.** One review before I show it. The fixes are listed in REVIEW.md, and they're done.
4. **Show it.** A 2-minute demo. DEMO.md lists the 3 things to show.
