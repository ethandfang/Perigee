import {
  AU_PER_LD, makeOrbit, positionAt, samplePath,
  PLANET_NAMES, planetPosition, planetOrbit,
  jdFromDate, dateFromJd,
} from './kepler.js';
import {
  Renderer, mat4Perspective, mat4LookAt, mat4Multiply, projectPoint,
} from './gl.js';

const $ = (id) => document.getElementById(id);

const CLASS_NAMES = {
  AMO: 'Amor', APO: 'Apollo', ATE: 'Aten', IEO: 'Atira', ATI: 'Atira',
};

const TL_MIN = jdFromDate(new Date(Date.UTC(2026, 0, 1)));
const TL_MAX = jdFromDate(new Date(Date.UTC(2034, 0, 1)));

const SPEEDS = [
  { label: '1 d/s', dps: 1 },
  { label: '1 wk/s', dps: 7 },
  { label: '1 mo/s', dps: 30.437 },
  { label: '6 mo/s', dps: 182.62 },
];

const ORBIT_SEG = 72;      // segments per asteroid orbit ring
const PLANET_SEG = 220;

// ---------- state ----------
const state = {
  simJd: jdFromDate(new Date()),
  playing: true,
  speedIdx: 1,
  scrubbing: false,
  tween: null,           // { from, to, t0, dur }
  orbitMode: 'all',      // all | pha | none
  frame: 'sun',          // sun | earth
  frameMix: 0,           // 0 = sun-centered, 1 = earth-centered
  hoverIdx: -1,
  selectedIdx: -1,
  selectedPath: null,
  cam: { yaw: 1.05, pitch: 0.44, dist: 4.7, targetDist: 4.7 },
  dragging: false,
  lastDomUpdate: 0,
};

// ---------- load data ----------
const [neos, cadData, meta] = await Promise.all([
  fetch('data/neos.json').then((r) => r.json()),
  fetch('data/cad.json').then((r) => r.json()),
  fetch('data/meta.json').then((r) => r.json()),
]);

const objects = neos.objects;
const N = objects.length;
const orbits = objects.map(makeOrbit);
let nPha = 0;
while (nPha < N && objects[nPha].pha) nPha++;
const desIndex = new Map(objects.map((o, i) => [o.pdes, i]));

// ---------- header numbers from the snapshot ----------
const fmtInt = (n) => n.toLocaleString('en-US');
$('ledePha').textContent = `${fmtInt(meta.phaCount)} known potentially hazardous asteroids`;
$('ledeOther').textContent = fmtInt(meta.otherCount);
$('chipPlotted').textContent = `${fmtInt(meta.plotted)} plotted`;
$('chipPha').textContent = `${fmtInt(meta.phaCount)} PHAs — all of them`;
$('chipTotal').textContent = `of ${fmtInt(meta.totalNEOs)} known NEOs`;
$('chipCad').textContent = `${fmtInt(meta.closeApproaches)} close passes to 2033`;
$('apMeta').innerHTML = `${meta.closeApproaches} known ·<br>&lt;0.02 au`;

// ---------- canvases ----------
const glCanvas = $('gl');
const overlay = $('overlay');
const octx = overlay.getContext('2d');
const renderer = new Renderer(glCanvas);
let W = 0, H = 0, DPR = 1;

function resize() {
  W = window.innerWidth;
  H = window.innerHeight;
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  renderer.resize(W, H, DPR);
  overlay.width = Math.round(W * DPR);
  overlay.height = Math.round(H * DPR);
  octx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);
resize();

// ---------- static geometry ----------
function buildStars() {
  const COUNT = 2300;
  const pos = new Float32Array(COUNT * 3);
  const col = new Uint8Array(COUNT * 4);
  const size = new Float32Array(COUNT);
  for (let s = 0; s < COUNT; s++) {
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const r = 360 + Math.random() * 60;
    const rr = Math.sqrt(1 - u * u);
    pos[s * 3] = r * rr * Math.cos(th);
    pos[s * 3 + 1] = r * rr * Math.sin(th);
    pos[s * 3 + 2] = r * u;
    const t = Math.random();
    let cr, cg, cb;
    if (t < 0.62) { cr = 235; cg = 240; cb = 250; }        // white
    else if (t < 0.92) { cr = 165; cg = 205; cb = 250; }   // pale blue
    else { cr = 250; cg = 215; cb = 175; }                 // rare warm
    const bright = 105 + Math.random() * 150;
    col[s * 4] = cr; col[s * 4 + 1] = cg; col[s * 4 + 2] = cb;
    col[s * 4 + 3] = bright;
    size[s] = 1.2 + Math.random() * Math.random() * 3.1;
  }
  renderer.createGeometry('stars', { pos, col, size });
}

function buildHaze() {
  // Soft rust fog sampled along real PHA orbits — the stylized density field.
  const COUNT = 5400;
  const pos = new Float32Array(COUNT * 3);
  const col = new Uint8Array(COUNT * 4);
  const size = new Float32Array(COUNT);
  const p = [0, 0, 0];
  for (let s = 0; s < COUNT; s++) {
    const warm = Math.random() < 0.85;
    const oi = warm ? (Math.random() * nPha) | 0 : nPha + ((Math.random() * (N - nPha)) | 0);
    const o = orbits[Math.min(oi, N - 1)];
    // rejection-sample toward small heliocentric distance so the fog
    // burns hottest inside Earth's orbit, like the real density peak
    let x = 0, y = 0, r = 1;
    for (let tries = 0; tries < 8; tries++) {
      const E = Math.random() * Math.PI * 2;
      x = o.a * (Math.cos(E) - o.e); y = o.b * Math.sin(E);
      r = Math.hypot(x, y);
      if (Math.random() < Math.min(1, Math.pow(0.85 / r, 2))) break;
    }
    const j = 0.10 + Math.random() * 0.26;
    // a slice of the fog is pushed outward for the wide background glow
    const spread = Math.random() < 0.10 ? 1.4 + Math.random() * 1.1 : 1;
    p[0] = (x * o.Px + y * o.Qx) * spread + (Math.random() - 0.5) * j;
    p[1] = (x * o.Py + y * o.Qy) * spread + (Math.random() - 0.5) * j;
    p[2] = (x * o.Pz + y * o.Qz) * spread + (Math.random() - 0.5) * j * 0.5;
    pos.set(p, s * 3);
    if (warm) { col[s * 4] = 238; col[s * 4 + 1] = 110; col[s * 4 + 2] = 66; }
    else { col[s * 4] = 96; col[s * 4 + 1] = 150; col[s * 4 + 2] = 205; }
    col[s * 4 + 3] = (spread > 1 ? 3 : 6) + Math.random() * 7;
    size[s] = 12 + Math.random() * 32;
  }
  renderer.createGeometry('haze', { pos, col, size });
}

function buildOrbitLines() {
  // Layout: [PHA orbits][other orbits] so modes can draw sub-ranges.
  const verts = N * ORBIT_SEG * 2;
  const pos = new Float32Array(verts * 3);
  const col = new Uint8Array(verts * 4);
  const ring = new Float32Array(ORBIT_SEG * 3);
  let v = 0;
  for (let oi = 0; oi < N; oi++) {
    const o = orbits[oi];
    const pha = oi < nPha;
    samplePath(o, ORBIT_SEG, ring);
    let cr, cg, cb, ca;
    if (pha) { cr = 255; cg = 116; cb = 74; ca = 15; }
    else { cr = 108; cg = 168; cb = 220; ca = 9; }
    for (let s = 0; s < ORBIT_SEG; s++) {
      const s2 = (s + 1) % ORBIT_SEG;
      pos[v * 3] = ring[s * 3]; pos[v * 3 + 1] = ring[s * 3 + 1]; pos[v * 3 + 2] = ring[s * 3 + 2];
      col[v * 4] = cr; col[v * 4 + 1] = cg; col[v * 4 + 2] = cb; col[v * 4 + 3] = ca;
      v++;
      pos[v * 3] = ring[s2 * 3]; pos[v * 3 + 1] = ring[s2 * 3 + 1]; pos[v * 3 + 2] = ring[s2 * 3 + 2];
      col[v * 4] = cr; col[v * 4 + 1] = cg; col[v * 4 + 2] = cb; col[v * 4 + 3] = ca;
      v++;
    }
  }
  renderer.createGeometry('orbits', { pos, col });
}

function buildPlanetOrbits() {
  const midJd = (TL_MIN + TL_MAX) / 2;
  const verts = PLANET_NAMES.length * PLANET_SEG * 2;
  const pos = new Float32Array(verts * 3);
  const col = new Uint8Array(verts * 4);
  const ring = new Float32Array(PLANET_SEG * 3);
  let v = 0;
  for (const name of PLANET_NAMES) {
    const o = planetOrbit(name, midJd);
    samplePath(o, PLANET_SEG, ring);
    const earth = name === 'Earth';
    const cr = earth ? 175 : 150, cg = earth ? 208 : 168, cb = earth ? 255 : 195;
    const ca = earth ? 160 : 55;
    for (let s = 0; s < PLANET_SEG; s++) {
      const s2 = (s + 1) % PLANET_SEG;
      pos[v * 3] = ring[s * 3]; pos[v * 3 + 1] = ring[s * 3 + 1]; pos[v * 3 + 2] = ring[s * 3 + 2];
      col[v * 4] = cr; col[v * 4 + 1] = cg; col[v * 4 + 2] = cb; col[v * 4 + 3] = ca;
      v++;
      pos[v * 3] = ring[s2 * 3]; pos[v * 3 + 1] = ring[s2 * 3 + 1]; pos[v * 3 + 2] = ring[s2 * 3 + 2];
      col[v * 4] = cr; col[v * 4 + 1] = cg; col[v * 4 + 2] = cb; col[v * 4 + 3] = ca;
      v++;
    }
  }
  renderer.createGeometry('planetOrbits', { pos, col });
}

function buildAsteroidPoints() {
  const pos = new Float32Array(N * 3);
  const col = new Uint8Array(N * 4);
  const size = new Float32Array(N);
  for (let oi = 0; oi < N; oi++) {
    const o = objects[oi];
    const pha = oi < nPha;
    if (pha) { col[oi * 4] = 255; col[oi * 4 + 1] = 138; col[oi * 4 + 2] = 90; col[oi * 4 + 3] = 240; }
    else { col[oi * 4] = 118; col[oi * 4 + 1] = 202; col[oi * 4 + 2] = 252; col[oi * 4 + 3] = 225; }
    const h = o.H == null ? 22 : o.H;
    size[oi] = Math.max(2.1, Math.min(5.6, 2.9 + (18 - h) * 0.18));
  }
  renderer.createGeometry('asteroids', { pos, col, size }, true);
}

function buildPlanetPoints() {
  const M = PLANET_NAMES.length;
  const pos = new Float32Array(M * 3);
  const col = new Uint8Array(M * 4);
  const size = new Float32Array(M);
  const colors = {
    Mercury: [205, 205, 210, 245, 5.5],
    Venus: [248, 222, 182, 250, 6.5],
    Earth: [135, 195, 255, 255, 8],
    Mars: [238, 148, 102, 250, 6],
  };
  PLANET_NAMES.forEach((name, i) => {
    const c = colors[name];
    col[i * 4] = c[0]; col[i * 4 + 1] = c[1]; col[i * 4 + 2] = c[2]; col[i * 4 + 3] = c[3];
    size[i] = c[4];
  });
  renderer.createGeometry('planets', { pos, col, size }, true);
}

buildStars();
buildHaze();
buildOrbitLines();
buildPlanetOrbits();
buildAsteroidPoints();
buildPlanetPoints();

// ---------- per-frame arrays ----------
const astPos = new Float32Array(N * 3);
const planetPos = new Float32Array(PLANET_NAMES.length * 3);
const earthIdx = PLANET_NAMES.indexOf('Earth');
const proj = mat4Perspective(new Float32Array(16), 40 * Math.PI / 180, 1, 0.01, 2000);
const view = new Float32Array(16);
const mvp = new Float32Array(16);
const scratch2 = [0, 0];

// ---------- formatting ----------
function fmtDate(jd) {
  return dateFromJd(jd).toLocaleDateString('en-US', {
    month: 'short', day: '2-digit', year: 'numeric', timeZone: 'UTC',
  });
}
function fmtCadDate(cd) {
  // "2026-Jul-05 11:39" → "Jul 05, 2026"
  const [ymd] = cd.split(' ');
  const [y, m, d] = ymd.split('-');
  return `${m} ${d}, ${y}`;
}
function className(o) {
  return CLASS_NAMES[o.class] || o.class;
}
function fmt(v, dp) {
  return v == null ? '—' : v.toFixed(dp);
}

// ---------- close approach list ----------
const approaches = cadData.approaches;
const apRows = [];
{
  const list = $('apList');
  const frag = document.createDocumentFragment();
  approaches.forEach((ap, i) => {
    const row = document.createElement('div');
    row.className = 'ap-row';
    const oi = desIndex.get(ap.des);
    const isPha = oi !== undefined && objects[oi].pha;
    const ld = ap.dist / AU_PER_LD;
    row.innerHTML =
      `<span class="ap-date">${fmtCadDate(ap.cd)}</span>` +
      `<span class="ap-dot${isPha ? ' pha' : ''}"></span>` +
      `<span class="ap-des">${ap.des}</span>` +
      `<span class="ap-ld${ld < 1 ? ' very-close' : ''}">${ld.toFixed(1)} LD</span>`;
    row.addEventListener('click', () => {
      animateSimTo(ap.jd);
      if (oi !== undefined) select(oi);
    });
    frag.appendChild(row);
    apRows.push({ el: row, jd: ap.jd });
  });
  list.appendChild(frag);
}
let bracketIdx = -1;
function updateBracket() {
  let lo = 0, hi = apRows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (apRows[mid].jd < state.simJd) lo = mid + 1; else hi = mid;
  }
  if (lo === bracketIdx) return;
  if (bracketIdx >= 0 && bracketIdx < apRows.length) apRows[bracketIdx].el.classList.remove('next');
  bracketIdx = lo;
  if (lo < apRows.length) {
    apRows[lo].el.classList.add('next');
    if (!$('apList').matches(':hover')) {
      apRows[lo].el.scrollIntoView({ block: 'nearest' });
    }
  }
}

// ---------- detail panel ----------
const panel = $('detailPanel');
function kvRow(k, v) {
  return `<div class="kv-row"><span class="kv-k">${k}</span><span class="kv-v">${v}</span></div>`;
}
function select(oi) {
  state.selectedIdx = oi;
  if (oi < 0) {
    panel.classList.add('hidden');
    state.selectedPath = null;
    return;
  }
  const o = objects[oi];
  const orb = orbits[oi];
  state.selectedPath = new Float32Array(240 * 3);
  samplePath(orb, 240, state.selectedPath);

  $('dTitle').textContent = o.name || o.pdes;
  $('dSub').textContent = `${className(o)} · designation ${o.pdes}`;
  let tags = `<span class="tag">NEO</span><span class="tag">${o.class}</span>`;
  if (o.pha) tags = `<span class="tag tag-pha">PHA</span>` + tags;
  $('dTags').innerHTML = tags;

  const epochDate = dateFromJd(o.epoch).toLocaleDateString('en-US', {
    month: 'short', day: '2-digit', year: 'numeric', timeZone: 'UTC',
  }).toUpperCase().replace(',', ',');
  $('dElemLabel').innerHTML =
    `OSCULATING ELEMENTS · EPOCH JD<br>${o.epoch} (${epochDate} TDB)`;

  const moidLd = o.moid_ld != null ? Math.round(o.moid_ld) : (o.moid != null ? Math.round(o.moid / AU_PER_LD) : null);
  $('dElems').innerHTML =
    kvRow('Semi-major axis a', `${fmt(o.a, 6)} <span class="unit">au</span>`) +
    kvRow('Eccentricity e', fmt(o.e, 6)) +
    kvRow('Inclination i', `${fmt(o.i, 4)}°`) +
    kvRow('Asc. node Ω', `${fmt(o.om, 4)}°`) +
    kvRow('Arg. perihelion ω', `${fmt(o.w, 4)}°`) +
    kvRow('Mean anomaly M', `${fmt(o.ma, 4)}°`) +
    kvRow('Perihelion q', `${fmt(o.q, 4)} <span class="unit">au</span>`) +
    kvRow('Period', `${fmt(o.per / 365.25, 2)} <span class="unit">yr</span>`) +
    kvRow('Earth MOID', `${fmt(o.moid, 6)} <span class="unit">au</span>&nbsp;·&nbsp;${moidLd == null ? '—' : moidLd} <span class="unit">LD</span>`);

  $('dPhys').innerHTML =
    kvRow('Abs. magnitude H', fmt(o.H, 2)) +
    (o.diameter != null ? kvRow('Diameter', `${fmt(o.diameter, 2)} <span class="unit">km</span>`) : '');

  updateNowSection();
  panel.classList.remove('hidden');
  panel.classList.remove('collapsed');
}

function updateNowSection() {
  const oi = state.selectedIdx;
  if (oi < 0) return;
  const x = astPos[oi * 3], y = astPos[oi * 3 + 1], z = astPos[oi * 3 + 2];
  const ex = planetPos[earthIdx * 3], ey = planetPos[earthIdx * 3 + 1], ez = planetPos[earthIdx * 3 + 2];
  const dSun = Math.hypot(x, y, z);
  const dEarth = Math.hypot(x - ex, y - ey, z - ez);
  $('dNow').innerHTML =
    kvRow('Dist. from Sun', `${dSun.toFixed(4)} <span class="unit">au</span>`) +
    kvRow('Dist. from Earth', `${dEarth.toFixed(4)} <span class="unit">au</span>&nbsp;·&nbsp;${Math.round(dEarth / AU_PER_LD)} <span class="unit">LD</span>`);
}

$('panelChevron').addEventListener('click', () => panel.classList.toggle('collapsed'));

// ---------- top-right controls ----------
$('orbitMode').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  state.orbitMode = btn.dataset.mode;
  for (const b of document.querySelectorAll('.seg-btn')) b.classList.toggle('active', b === btn);
});
$('frameToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('.frame-btn');
  if (!btn) return;
  state.frame = btn.dataset.frame;
  state.cam.targetDist = state.frame === 'earth' ? 0.45 : 4.7;
  for (const b of document.querySelectorAll('.frame-btn')) b.classList.toggle('active', b === btn);
});
$('btnMethod').addEventListener('click', () => $('methodModal').classList.remove('hidden'));
$('modalClose').addEventListener('click', () => $('methodModal').classList.add('hidden'));
$('methodModal').addEventListener('click', (e) => {
  if (e.target === $('methodModal')) $('methodModal').classList.add('hidden');
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('methodModal').classList.add('hidden');
  if (e.key === ' ' && e.target === document.body) { e.preventDefault(); togglePlay(); }
});

// ---------- bottom bar ----------
function togglePlay() {
  state.playing = !state.playing;
  $('iconPause').style.display = state.playing ? '' : 'none';
  $('iconPlay').style.display = state.playing ? 'none' : '';
}
$('btnPlay').addEventListener('click', togglePlay);
$('btnSpeed').addEventListener('click', () => {
  state.speedIdx = (state.speedIdx + 1) % SPEEDS.length;
  $('btnSpeed').textContent = `▸ ${SPEEDS[state.speedIdx].label}`;
});

const timeline = $('timeline');
timeline.addEventListener('input', () => {
  state.scrubbing = true;
  state.tween = null;
  state.simJd = TL_MIN + (timeline.value / 10000) * (TL_MAX - TL_MIN);
  updateTimelineUI(true);
});
timeline.addEventListener('change', () => { state.scrubbing = false; });

function animateSimTo(jd) {
  state.tween = {
    from: state.simJd,
    to: Math.max(TL_MIN, Math.min(TL_MAX, jd)),
    t0: performance.now(),
    dur: 1400,
  };
}
$('btnToday').addEventListener('click', () => animateSimTo(jdFromDate(new Date())));
$('btnApophis').addEventListener('click', () => {
  const ap = approaches.find((a) => a.des === '99942');
  animateSimTo(ap ? ap.jd : jdFromDate(new Date(Date.UTC(2029, 3, 13))));
  const oi = desIndex.get('99942');
  if (oi !== undefined) select(oi);
});
$('btnYR4').addEventListener('click', () => {
  const ap = approaches.find((a) => a.des === '2024 YR4');
  animateSimTo(ap ? ap.jd : jdFromDate(new Date(Date.UTC(2032, 11, 22))));
  const oi = desIndex.get('2024 YR4');
  if (oi !== undefined) select(oi);
});

function updateTimelineUI(force) {
  const now = performance.now();
  if (!force && now - state.lastDomUpdate < 200) return;
  state.lastDomUpdate = now;
  $('simDate').textContent = fmtDate(state.simJd);
  const frac = (state.simJd - TL_MIN) / (TL_MAX - TL_MIN);
  if (!state.scrubbing) timeline.value = Math.round(frac * 10000);
  const pct = (frac * 100).toFixed(2);
  timeline.style.background =
    `linear-gradient(to right, #5ea0eb 0%, #5ea0eb ${pct}%, rgba(120,150,185,.25) ${pct}%)`;
  updateNowSection();
  updateBracket();
}

// ---------- camera interaction ----------
let downX = 0, downY = 0, moved = false;
glCanvas.addEventListener('pointerdown', (e) => {
  state.dragging = true;
  moved = false;
  downX = e.clientX; downY = e.clientY;
  glCanvas.setPointerCapture(e.pointerId);
});
glCanvas.addEventListener('pointermove', (e) => {
  if (state.dragging) {
    const dx = e.clientX - downX, dy = e.clientY - downY;
    if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) moved = true;
    if (moved) {
      state.cam.yaw -= e.movementX * 0.0045;
      state.cam.pitch = Math.max(0.06, Math.min(1.5, state.cam.pitch + e.movementY * 0.0045));
      hideTooltip();
    }
  } else {
    pick(e.clientX, e.clientY);
  }
});
glCanvas.addEventListener('pointerup', (e) => {
  state.dragging = false;
  if (!moved) {
    const idx = pick(e.clientX, e.clientY);
    select(idx);
  }
});
glCanvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  state.cam.targetDist = Math.max(0.06, Math.min(30, state.cam.targetDist * Math.exp(e.deltaY * 0.0012)));
}, { passive: false });

// ---------- picking / tooltip ----------
const tooltip = $('tooltip');
function hideTooltip() {
  state.hoverIdx = -1;
  tooltip.classList.add('hidden');
  glCanvas.style.cursor = 'default';
}
function pick(mx, my) {
  let best = -1, bestD = 13 * 13;
  for (let oi = 0; oi < N; oi++) {
    if (state.orbitMode === 'pha' && oi >= nPha) continue;
    const w = projectPoint(mvp, astPos[oi * 3], astPos[oi * 3 + 1], astPos[oi * 3 + 2], W, H, scratch2);
    if (w <= 0) continue;
    const dx = scratch2[0] - mx, dy = scratch2[1] - my;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = oi; }
  }
  state.hoverIdx = best;
  if (best >= 0) {
    const o = objects[best];
    const ex = planetPos[earthIdx * 3], ey = planetPos[earthIdx * 3 + 1], ez = planetPos[earthIdx * 3 + 2];
    const dE = Math.hypot(astPos[best * 3] - ex, astPos[best * 3 + 1] - ey, astPos[best * 3 + 2] - ez);
    $('ttDes').textContent = o.name || o.pdes;
    $('ttTags').textContent = `${o.pha ? 'PHA' : 'NEO'} · ${className(o)}`;
    $('ttDelta').textContent = `Δ⊕ ${dE.toFixed(2)} au`;
    tooltip.style.left = `${Math.min(mx + 16, W - 200)}px`;
    tooltip.style.top = `${Math.min(my + 16, H - 90)}px`;
    tooltip.classList.remove('hidden');
    glCanvas.style.cursor = 'pointer';
  } else {
    hideTooltip();
  }
  return best;
}

// ---------- overlay drawing ----------
function drawOverlay(camDist, eye) {
  octx.clearRect(0, 0, W, H);

  // Sun glow
  const wSun = projectPoint(mvp, 0, 0, 0, W, H, scratch2);
  if (wSun > 0) {
    const sx = scratch2[0], sy = scratch2[1];
    const d = Math.hypot(eye[0], eye[1], eye[2]);
    const rHalo = Math.min(760, 1150 / d);
    const rCore = Math.min(96, 210 / d);
    octx.save();
    octx.globalCompositeOperation = 'lighter';
    let g = octx.createRadialGradient(sx, sy, 0, sx, sy, rHalo);
    g.addColorStop(0, 'rgba(255,214,150,0.28)');
    g.addColorStop(0.35, 'rgba(255,170,110,0.07)');
    g.addColorStop(1, 'rgba(255,150,90,0)');
    octx.fillStyle = g;
    octx.fillRect(sx - rHalo, sy - rHalo, rHalo * 2, rHalo * 2);
    g = octx.createRadialGradient(sx, sy, 0, sx, sy, rCore);
    g.addColorStop(0, 'rgba(255,252,240,1)');
    g.addColorStop(0.4, 'rgba(255,232,180,0.55)');
    g.addColorStop(1, 'rgba(255,200,130,0)');
    octx.fillStyle = g;
    octx.fillRect(sx - rCore, sy - rCore, rCore * 2, rCore * 2);
    octx.restore();
  }
  const sunScreen = wSun > 0 ? [scratch2[0], scratch2[1]] : null;

  // Selected orbit + Sun→object ray + ring marker
  if (state.selectedIdx >= 0 && state.selectedPath) {
    const path = state.selectedPath;
    octx.save();
    octx.beginPath();
    let started = false;
    for (let s = 0; s <= 240; s++) {
      const j = (s % 240) * 3;
      const w = projectPoint(mvp, path[j], path[j + 1], path[j + 2], W, H, scratch2);
      if (w <= 0) { started = false; continue; }
      if (!started) { octx.moveTo(scratch2[0], scratch2[1]); started = true; }
      else octx.lineTo(scratch2[0], scratch2[1]);
    }
    octx.strokeStyle = 'rgba(140,180,235,0.16)';
    octx.lineWidth = 4;
    octx.stroke();
    octx.strokeStyle = 'rgba(205,225,250,0.75)';
    octx.lineWidth = 1.3;
    octx.stroke();

    const oi = state.selectedIdx;
    const wa = projectPoint(mvp, astPos[oi * 3], astPos[oi * 3 + 1], astPos[oi * 3 + 2], W, H, scratch2);
    if (wa > 0) {
      const ax = scratch2[0], ay = scratch2[1];
      if (sunScreen) {
        const dx = ax - sunScreen[0], dy = ay - sunScreen[1];
        octx.beginPath();
        octx.moveTo(sunScreen[0], sunScreen[1]);
        octx.lineTo(sunScreen[0] + dx * 8, sunScreen[1] + dy * 8);
        octx.strokeStyle = 'rgba(225,238,255,0.5)';
        octx.lineWidth = 1;
        octx.stroke();
      }
      octx.beginPath();
      octx.arc(ax, ay, 8, 0, Math.PI * 2);
      octx.strokeStyle = 'rgba(255,255,255,0.9)';
      octx.lineWidth = 1.5;
      octx.stroke();
    }
    octx.restore();
  }

  // Hover ring
  if (state.hoverIdx >= 0 && state.hoverIdx !== state.selectedIdx) {
    const oi = state.hoverIdx;
    const w = projectPoint(mvp, astPos[oi * 3], astPos[oi * 3 + 1], astPos[oi * 3 + 2], W, H, scratch2);
    if (w > 0) {
      octx.beginPath();
      octx.arc(scratch2[0], scratch2[1], 7, 0, Math.PI * 2);
      octx.strokeStyle = 'rgba(255,255,255,0.6)';
      octx.lineWidth = 1.2;
      octx.stroke();
    }
  }

  // Planet labels
  octx.font = '600 12px "SF Mono", ui-monospace, Menlo, monospace';
  octx.shadowColor = 'rgba(0,0,0,0.9)';
  octx.shadowBlur = 4;
  for (let i = 0; i < PLANET_NAMES.length; i++) {
    const w = projectPoint(mvp, planetPos[i * 3], planetPos[i * 3 + 1], planetPos[i * 3 + 2], W, H, scratch2);
    if (w <= 0) continue;
    const name = PLANET_NAMES[i];
    octx.fillStyle = name === 'Earth' ? 'rgba(158,202,255,1)' : 'rgba(158,178,200,0.85)';
    octx.fillText(name, scratch2[0] + 10, scratch2[1] + 4);
  }
  octx.shadowBlur = 0;
}

// ---------- main loop ----------
let lastT = performance.now();
function frame(t) {
  const dt = Math.min(0.1, (t - lastT) / 1000);
  lastT = t;

  // advance simulation
  if (state.tween) {
    const tw = state.tween;
    const p = Math.min(1, (t - tw.t0) / tw.dur);
    const ease = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    state.simJd = tw.from + (tw.to - tw.from) * ease;
    if (p >= 1) state.tween = null;
  } else if (state.playing && !state.scrubbing) {
    state.simJd += SPEEDS[state.speedIdx].dps * dt;
    if (state.simJd > TL_MAX) { state.simJd = TL_MAX; if (state.playing) togglePlay(); }
  }

  // propagate
  const jd = state.simJd;
  for (let i = 0; i < PLANET_NAMES.length; i++) {
    planetPosition(PLANET_NAMES[i], jd, planetPos, i * 3);
  }
  for (let oi = 0; oi < N; oi++) positionAt(orbits[oi], jd, astPos, oi * 3);
  renderer.updatePositions('asteroids', astPos);
  renderer.updatePositions('planets', planetPos);

  // camera
  const c = state.cam;
  c.dist += (c.targetDist - c.dist) * Math.min(1, dt * 5);
  const targetMix = state.frame === 'earth' ? 1 : 0;
  state.frameMix += (targetMix - state.frameMix) * Math.min(1, dt * 4);
  const m = state.frameMix;
  const tx = planetPos[earthIdx * 3] * m;
  const ty = planetPos[earthIdx * 3 + 1] * m;
  const tz = planetPos[earthIdx * 3 + 2] * m;
  const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
  const eye = [
    tx + c.dist * cp * Math.cos(c.yaw),
    ty + c.dist * cp * Math.sin(c.yaw),
    tz + c.dist * sp,
  ];
  mat4Perspective(proj, 40 * Math.PI / 180, W / H, 0.005, 2000);
  mat4LookAt(view, eye, [tx, ty, tz], [0, 0, 1]);
  mat4Multiply(mvp, proj, view);

  // render
  renderer.clear();
  renderer.drawPoints('stars', mvp, 1);
  renderer.drawPoints('haze', mvp, 1);
  renderer.drawLines('planetOrbits', mvp, 1);
  const phaVerts = nPha * ORBIT_SEG * 2;
  const totalVerts = N * ORBIT_SEG * 2;
  if (state.orbitMode === 'all') {
    renderer.drawLines('orbits', mvp, 1);
  } else if (state.orbitMode === 'pha') {
    renderer.drawLines('orbits', mvp, 1.4, 0, phaVerts);
  }
  if (state.orbitMode === 'pha') {
    renderer.drawPoints('asteroids', mvp, 1, 0, nPha);
    renderer.drawPoints('asteroids', mvp, 0.12, nPha, N - nPha);
  } else {
    renderer.drawPoints('asteroids', mvp, 1);
  }
  renderer.drawPoints('planets', mvp, 1);

  drawOverlay(c.dist, eye);
  updateTimelineUI(false);

  requestAnimationFrame(frame);
}

// initial selection mirrors the reference: Amor asteroid 341816
select(desIndex.get('341816') ?? 0);

// deep-link support: ?date=2029-04-13&sel=99942&frame=earth&mode=pha&paused=1
{
  const qp = new URLSearchParams(location.search);
  const mode = qp.get('mode');
  if (mode) document.querySelector(`.seg-btn[data-mode="${mode}"]`)?.click();
  if (qp.get('frame') === 'earth') document.querySelector('.frame-btn[data-frame="earth"]')?.click();
  const date = qp.get('date');
  if (date) {
    const jd = jdFromDate(new Date(`${date}T00:00:00Z`));
    if (Number.isFinite(jd)) state.simJd = Math.max(TL_MIN, Math.min(TL_MAX, jd));
  }
  const sel = qp.get('sel');
  if (sel && desIndex.has(sel)) select(desIndex.get(sel));
  if (qp.get('paused')) togglePlay();
}

updateTimelineUI(true);
requestAnimationFrame(frame);
