# The Near-Earth Swarm

A full-screen visualizer of near-Earth asteroids: every known potentially hazardous
asteroid plus the largest other NEOs, each moving on its real orbit via two-body
Keplerian propagation computed live in the browser from JPL's full-precision
orbital elements.

## Structure

- `js/kepler.js` — Kepler solver, element→position propagation, planet ephemeris
- `js/gl.js` — raw WebGL renderer (additive orbit lines, soft point sprites)
- `js/main.js` — simulation loop, camera, picking, UI
- `css/style.css` — dark theme, SF Pro system font stack


