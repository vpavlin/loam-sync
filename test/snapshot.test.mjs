// snapshot.test.mjs — deterministic log snapshots to Storage (docs/adr/0020).
// Proves: (1) the same cut → the same CID regardless of array order / key order (the property the whole
// design rests on); (2) the cut is HLC<boundary; (3) a reader re-verifies and drops forged events;
// (4) snapshot + RBSR-tail folds identically to the full log; (5) pointer quorum resolution.
// Run: `node test/snapshot.test.mjs`
import assert from "node:assert";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  signEvent, SoftwareSigner, mergeEvents,
  cryptoSealer, epochBoundary, selectCut, serializeSnapshot, parseSnapshot,
  writeSnapshot, readSnapshot, bestPointer,
} from "../dist/index.js";
import { deriveIdentity } from "../dist/crypto.js";

const DOMAIN = "snaptest";
const priv = (n) => { const b = new Uint8Array(32); b[31] = n; return b; };
const A = new SoftwareSigner(priv(1));
const B = new SoftwareSigner(priv(2));
const secret = new Uint8Array(32).fill(7); // shared household key
const id = deriveIdentity(secret, DOMAIN);
const sealer = cryptoSealer(id, DOMAIN);

// A tiny content-addressed store: CID = sha256(bytes) hex → identical bytes give the identical CID.
function memStore() {
  const m = new Map();
  const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return { m, async put(b) { const c = hex(sha256(b)); m.set(c, b); return c; }, async get(c) { return m.get(c); } };
}

function mk(signer, idStr, wall, payload) {
  const ev = { v: 1, id: idStr, type: "note.put", hlc: { wall, ctr: 0, dev: "" }, dev: "", payload };
  signEvent(signer, DOMAIN, ev);
  return ev;
}
// reverse key insertion order everywhere → a different in-memory shape, same canonical bytes.
function reorderKeys(v) {
  if (Array.isArray(v)) return v.map(reorderKeys);
  if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v).reverse()) o[k] = reorderKeys(v[k]); return o; }
  return v;
}
const shuffle = (a) => { const c = a.slice(); for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; } return c; };

// A log spanning two epochs (E=1000): walls 10,120,300,999 are epoch 0; 1000,1500 are epoch 1.
const log = [
  mk(A, "e1", 10, { title: "first", tags: ["x", "y"], n: 1 }),
  mk(B, "e2", 120, { title: "second", n: 2 }),
  mk(A, "e3", 300, { title: "third", nested: { a: 1, b: 2 } }),
  mk(B, "e4", 999, { title: "edge-just-before" }),
  mk(A, "e5", 1000, { title: "on-boundary-excluded" }),
  mk(B, "e6", 1500, { title: "after" }),
];
const E = 1000;

// 1) epoch grid
assert.equal(epochBoundary(1234, E), 1000);
assert.equal(epochBoundary(999, E), 0);
assert.equal(epochBoundary(1000, E), 1000);

// 2) cut = HLC strictly before the boundary, canonically ordered
const cut = selectCut(log, 1000);
assert.deepEqual(cut.map((e) => e.id), ["e1", "e2", "e3", "e4"], "cut must be wall<1000, HLC-ordered");

// 3) DETERMINISM: two independent writers of the same epoch → the same CID, despite shuffled array
//    order, reversed key order, and a separately-constructed sealer.
const store1 = memStore(), store2 = memStore();
const now = 1500; // in epoch [1000,2000) → latest completed boundary is 1000, i.e. the epoch-0 cut (e1..e4)
const p1 = await writeSnapshot({ log, epochSizeMs: E, now, sealer, storage: store1 });
const sealer2 = cryptoSealer(deriveIdentity(secret, DOMAIN), DOMAIN); // fresh instance, same secret
const p2 = await writeSnapshot({ log: shuffle(log).map(reorderKeys), epochSizeMs: E, now, sealer: sealer2, storage: store2 });
assert.ok(p1 && p2, "both writers produce a pointer");
assert.equal(p1.cid, p2.cid, "same cut ⇒ same CID (determinism)");
assert.equal(p1.epoch, 1000);
assert.equal(p1.count, 4);
assert.deepEqual(p1.coversUpToHlc, { wall: 1000, ctr: 0, dev: "" });

// 4) READ + VERIFY: the reader re-verifies and returns exactly the cut, and REQUIRES verification.
const got = await readSnapshot(p1, { sealer, storage: store1, domain: DOMAIN });
assert.deepEqual(got.map((e) => e.id).sort(), ["e1", "e2", "e3", "e4"], "reader returns the verified cut");
assert.ok(got.every((e) => e.sig && e.pub), "returned events carry pub/sig");
await assert.rejects(() => readSnapshot(p1, { sealer, storage: store1 }), /must be re-verified/, "unverified read refused");

// 5) A forged event in a snapshot is dropped on read (snapshotter can't inject state).
const forged = JSON.parse(JSON.stringify(cut[0]));
forged.payload.title = "TAMPERED"; // breaks the signature
const badStore = memStore();
const badBytes = serializeSnapshot([forged, cut[1]], p1.coversUpToHlc);
const badCid = await badStore.put(sealer.seal(badBytes));
const badGot = await readSnapshot({ v: 1, cid: badCid, epoch: 1000, coversUpToHlc: p1.coversUpToHlc, count: 2 },
  { sealer, storage: badStore, domain: DOMAIN });
assert.deepEqual(badGot.map((e) => e.id), ["e2"], "forged event dropped; honest one kept");

// 6) COMPLEMENTARITY: snapshot + RBSR-tail folds identically to the full log.
const tail = log.filter((e) => e.hlc.wall >= 1000);
const viaSnapshot = mergeEvents(got, tail).map((e) => e.id);
const full = mergeEvents(log).map((e) => e.id);
assert.deepEqual(viaSnapshot, full, "snapshot ⊕ tail == full merged log");

// 7) parse round-trips the header
const parsed = parseSnapshot(serializeSnapshot(cut, p1.coversUpToHlc));
assert.equal(parsed.count, 4);
assert.equal(parsed.events.length, 4);

// 8) empty cut → null
assert.equal(await writeSnapshot({ log, epochSizeMs: E, now: 5, sealer, storage: store1 }), null, "no events before boundary 0 → null");

// 9) pointer resolution: newest epoch, then the CID the most pointers agree on, then higher count.
const chosen = bestPointer([
  { v: 1, cid: "x", epoch: 1000, coversUpToHlc: {}, count: 5 },
  { v: 1, cid: "x", epoch: 1000, coversUpToHlc: {}, count: 5 },
  { v: 1, cid: "y", epoch: 1000, coversUpToHlc: {}, count: 6 }, // higher count but minority CID
  { v: 1, cid: "z", epoch: 0, coversUpToHlc: {}, count: 9 },    // older epoch
]);
assert.equal(chosen.cid, "x", "quorum CID in newest epoch wins over a minority higher-count CID");

console.log("snapshot.test.mjs OK — determinism, cut, verify, complementarity, resolution");
