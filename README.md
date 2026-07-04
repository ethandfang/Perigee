# The Near-Earth Swarm

A full-screen visualizer of near-Earth asteroids: every known potentially hazardous
asteroid plus the largest other NEOs, each moving on its real orbit via two-body
Keplerian propagation computed live in the browser from JPL's full-precision
orbital elements.

## Run locally

Any static file server works (ES modules require http, not file://):

```sh
python3 -m http.server 8137
# then open http://localhost:8137
```

## Deploy

Everything is static — push the repo to GitHub and enable GitHub Pages on the
repo root. No build step.

## Data

One-time snapshot pulled 2026-07-04 from NASA/JPL public APIs, committed as
static JSON in `data/`:

- `neos.json` — orbital elements + physical parameters for all PHAs and the
  largest other NEOs (Small-Body Database Query API)
- `cad.json` — all known close approaches within 0.02 au through 2033
  (CNEOS Close-Approach Data API)
- `meta.json` — catalog counts used by the header

To refresh the snapshot, re-run the pull (server-side only — NASA's terms
prohibit calling these APIs from a live website) and re-commit:

```sh
node scripts/fetch_data.mjs
```

## Structure

- `js/kepler.js` — Kepler solver, element→position propagation, planet ephemeris
- `js/gl.js` — raw WebGL renderer (additive orbit lines, soft point sprites)
- `js/main.js` — simulation loop, camera, picking, UI
- `css/style.css` — dark theme, SF Pro system font stack

## Deep links

Query params: `?date=2029-04-13&sel=99942&frame=earth&mode=pha&paused=1`
