// Two-body Keplerian propagation in heliocentric ecliptic J2000 coordinates.

export const AU_PER_LD = 0.002569;
export const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;

// Solve Kepler's equation M = E - e sin E via Newton–Raphson.
export function solveKepler(M, e) {
  M = M % TWO_PI;
  if (M < 0) M += TWO_PI;
  let E = e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 14; k++) {
    const f = E - e * Math.sin(E) - M;
    const d = f / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-10) break;
  }
  return E;
}

// Precompute the perifocal→ecliptic rotation (columns P and Q) so per-frame
// propagation is just a Kepler solve plus one 2D→3D transform.
export function makeOrbit(el) {
  const i = el.i * DEG, om = el.om * DEG, w = el.w * DEG;
  const cO = Math.cos(om), sO = Math.sin(om);
  const ci = Math.cos(i), si = Math.sin(i);
  const cw = Math.cos(w), sw = Math.sin(w);
  return {
    a: el.a,
    e: el.e,
    b: el.a * Math.sqrt(1 - el.e * el.e),
    epoch: el.epoch,
    M0: el.ma * DEG,
    n: TWO_PI / el.per, // mean motion, rad/day
    Px: cO * cw - sO * sw * ci, Py: sO * cw + cO * sw * ci, Pz: sw * si,
    Qx: -cO * sw - sO * cw * ci, Qy: -sO * sw + cO * cw * ci, Qz: cw * si,
  };
}

// Heliocentric position (au) at Julian date jd, written into out[k..k+2].
export function positionAt(o, jd, out, k) {
  const E = solveKepler(o.M0 + o.n * (jd - o.epoch), o.e);
  const x = o.a * (Math.cos(E) - o.e);
  const y = o.b * Math.sin(E);
  out[k] = x * o.Px + y * o.Qx;
  out[k + 1] = x * o.Py + y * o.Qy;
  out[k + 2] = x * o.Pz + y * o.Qz;
}

// Sample the full orbit path (uniform in eccentric anomaly) into out (n*3 floats).
export function samplePath(o, n, out, offset = 0) {
  for (let s = 0; s < n; s++) {
    const E = (s / n) * TWO_PI;
    const x = o.a * (Math.cos(E) - o.e);
    const y = o.b * Math.sin(E);
    const j = offset + s * 3;
    out[j] = x * o.Px + y * o.Qx;
    out[j + 1] = x * o.Py + y * o.Qy;
    out[j + 2] = x * o.Pz + y * o.Qz;
  }
}

// ---- Planets: JPL approximate mean elements, valid 1800–2050 ----
// [a, e, I, L, long.peri, node] + rates per Julian century.
const PLANET_ELEMENTS = {
  Mercury: [[0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
            [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.11614092]],
  Venus:   [[0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
            [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418]],
  Earth:   [[1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
            [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0]],
  Mars:    [[1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
            [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]],
};

export const PLANET_NAMES = Object.keys(PLANET_ELEMENTS);

export function planetPosition(name, jd, out, k) {
  const [e0, r] = PLANET_ELEMENTS[name];
  const T = (jd - 2451545.0) / 36525.0;
  const a = e0[0] + r[0] * T;
  const e = e0[1] + r[1] * T;
  const i = (e0[2] + r[2] * T) * DEG;
  const L = e0[3] + r[3] * T;
  const lp = e0[4] + r[4] * T;
  const om = (e0[5] + r[5] * T) * DEG;
  const w = lp * DEG - om;
  let M = (L - lp) * DEG;
  const E = solveKepler(M, e);
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cO = Math.cos(om), sO = Math.sin(om);
  const ci = Math.cos(i), si = Math.sin(i);
  const cw = Math.cos(w), sw = Math.sin(w);
  out[k] = (cO * cw - sO * sw * ci) * xp + (-cO * sw - sO * cw * ci) * yp;
  out[k + 1] = (sO * cw + cO * sw * ci) * xp + (-sO * sw + cO * cw * ci) * yp;
  out[k + 2] = (sw * si) * xp + (cw * si) * yp;
}

// Orbit-shaped object for sampling a planet's path at a given jd.
export function planetOrbit(name, jd) {
  const [e0, r] = PLANET_ELEMENTS[name];
  const T = (jd - 2451545.0) / 36525.0;
  const a = e0[0] + r[0] * T;
  const e = e0[1] + r[1] * T;
  const lp = e0[4] + r[4] * T;
  const om = e0[5] + r[5] * T;
  return makeOrbit({
    a, e,
    i: e0[2] + r[2] * T,
    om,
    w: lp - om,
    ma: 0,
    epoch: jd,
    per: 365.25 * Math.pow(a, 1.5),
  });
}

// ---- Julian date helpers ----
export function jdFromDate(d) {
  return d.getTime() / 86400000 + 2440587.5;
}
export function dateFromJd(jd) {
  return new Date((jd - 2440587.5) * 86400000);
}
