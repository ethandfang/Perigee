// One-time snapshot pull from NASA/JPL public APIs (run server-side only).
// Usage: node scripts/fetch_data.mjs
// Writes: data/neos.json, data/cad.json, data/meta.json

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = '2026-07-04';
const OTHER_NEO_COUNT = 1510; // largest (brightest H) non-PHA NEOs to keep

const FIELDS = [
  'pdes', 'name', 'class', 'pha', 'H', 'diameter', 'epoch',
  'e', 'a', 'q', 'i', 'om', 'w', 'ma', 'per', 'moid', 'moid_ld',
];

async function getJSON(url) {
  console.log('GET', url);
  const res = await fetch(url, { headers: { 'User-Agent': 'near-earth-swarm-snapshot/1.0' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---- 1. Full NEO asteroid catalog (orbital elements + physical) ----
const sbdbURL =
  'https://ssd-api.jpl.nasa.gov/sbdb_query.api' +
  `?fields=${FIELDS.join(',')}` +
  '&sb-group=neo&sb-kind=a&full-prec=1';

const sbdb = await getJSON(sbdbURL);
const idx = Object.fromEntries(sbdb.fields.map((f, i) => [f, i]));
console.log(`SBDB returned ${sbdb.count} NEO asteroids`);

function toObj(row) {
  return {
    pdes: row[idx.pdes],
    name: row[idx.name] || null,
    class: row[idx.class],
    pha: row[idx.pha] === 'Y',
    H: num(row[idx.H]),
    diameter: num(row[idx.diameter]),
    epoch: num(row[idx.epoch]),
    e: num(row[idx.e]),
    a: num(row[idx.a]),
    q: num(row[idx.q]),
    i: num(row[idx.i]),
    om: num(row[idx.om]),
    w: num(row[idx.w]),
    ma: num(row[idx.ma]),
    per: num(row[idx.per]),
    moid: num(row[idx.moid]),
    moid_ld: num(row[idx.moid_ld]),
  };
}

const all = sbdb.data.map(toObj).filter(
  (o) => o.a !== null && o.e !== null && o.e < 0.995 && o.a > 0 &&
         o.i !== null && o.om !== null && o.w !== null && o.ma !== null &&
         o.epoch !== null && o.per !== null && o.per > 0
);

const phas = all.filter((o) => o.pha);
const nonPhas = all
  .filter((o) => !o.pha && o.H !== null)
  .sort((x, y) => x.H - y.H)
  .slice(0, OTHER_NEO_COUNT);

// ---- 2. Force-include named story objects even if not PHA / not large ----
const required = ['2024 YR4'];
const have = new Set([...phas, ...nonPhas].map((o) => o.pdes));
for (const des of required) {
  if (have.has(des)) continue;
  const found = all.find((o) => o.pdes === des);
  if (found) {
    nonPhas.push(found);
    console.log(`Force-included ${des} from catalog`);
  } else {
    console.warn(`WARNING: required object ${des} not found in catalog`);
  }
}

const objects = [...phas, ...nonPhas];
console.log(`Keeping ${objects.length} objects (${phas.length} PHAs + ${objects.length - phas.length} others)`);

// ---- 3. Close approaches to end of 2033 (CNEOS CAD API) ----
const cadURL =
  'https://ssd-api.jpl.nasa.gov/cad.api' +
  `?date-min=${SNAPSHOT}&date-max=2034-01-01&dist-max=0.02&sort=date`;
const cad = await getJSON(cadURL);
const cidx = Object.fromEntries(cad.fields.map((f, i) => [f, i]));
const approaches = (cad.data || []).map((r) => ({
  des: r[cidx.des],
  cd: r[cidx.cd],           // "YYYY-MMM-DD HH:MM"
  jd: num(r[cidx.jd]),
  dist: num(r[cidx.dist]),  // au
  h: num(r[cidx.h]),
}));
console.log(`CAD returned ${approaches.length} close approaches (<0.02 au) through 2033`);

// ---- 4. Write ----
mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(join(ROOT, 'data', 'neos.json'), JSON.stringify({ snapshot: SNAPSHOT, objects }));
writeFileSync(join(ROOT, 'data', 'cad.json'), JSON.stringify({ snapshot: SNAPSHOT, approaches }));
writeFileSync(join(ROOT, 'data', 'meta.json'), JSON.stringify({
  snapshot: SNAPSHOT,
  totalNEOs: sbdb.count,
  phaCount: phas.length,
  otherCount: objects.length - phas.length,
  plotted: objects.length,
  closeApproaches: approaches.length,
}, null, 2));

console.log('Wrote data/neos.json, data/cad.json, data/meta.json');
