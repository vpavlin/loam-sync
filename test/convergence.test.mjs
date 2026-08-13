// convergence.test.mjs — the property that justifies the whole design (ADR 0001):
// N devices author events offline; folding the union in MANY shuffled arrival
// orders (with duplicates) always yields the IDENTICAL merged log. Pure algorithm
// check — no transport, no crypto. Run: `node test/convergence.test.mjs`.
//
// Reimplements compareHlc + mergeEvents inline so this runs with zero deps and
// pins the SPEC behaviour the C++/TS implementations must match (docs/SYNC_SPEC.md).
import assert from "node:assert";

function compareHlc(a, b) {
  if (a.wall !== b.wall) return a.wall < b.wall ? -1 : 1;
  if (a.ctr !== b.ctr) return a.ctr < b.ctr ? -1 : 1;
  if (a.dev !== b.dev) return a.dev < b.dev ? -1 : 1;
  return 0;
}
function mergeEvents(...logs) {
  const byId = new Map();
  for (const log of logs) for (const e of log) if (e.id && !byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => compareHlc(a.hlc, b.hlc));
}

// Deterministic PRNG so the test is reproducible (no Math.random / Date).
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const rnd = mulberry32(1234567);
const DEVICES = 4, EVENTS_PER = 15, TRIALS = 200;

// Each device authors a stream of events (unique ids, its own dev id, rising HLC).
const streams = [];
let gid = 0;
for (let d = 0; d < DEVICES; d++) {
  const dev = `dev${d}`;
  const s = [];
  for (let i = 0; i < EVENTS_PER; i++) {
    s.push({ v: 1, id: `${dev}-${gid++}`, type: "t", hlc: { wall: i * 10 + d, ctr: 0, dev }, dev, payload: {} });
  }
  streams.push(s);
}
const all = streams.flat();

// Canonical result: merge everything once.
const canonical = mergeEvents(all).map((e) => e.id).join(",");

let ok = 0;
for (let t = 0; t < TRIALS; t++) {
  // Shuffle arrival order across all devices, sprinkle in duplicate redeliveries.
  const arrival = shuffle(all, rnd);
  const withDupes = arrival.concat(shuffle(arrival.slice(0, 5), rnd)); // Waku redelivers
  const result = mergeEvents(shuffle(withDupes, rnd)).map((e) => e.id).join(",");
  assert.strictEqual(result, canonical, `trial ${t}: divergent merge`);
  ok++;
}

console.log(`convergence: ${ok}/${TRIALS} trials × ${DEVICES} devices, shuffled + duplicated → identical merged log ✓`);
