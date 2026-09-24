// gen-snapshot-vectors.mjs — freeze a cross-language snapshot parity vector (docs/adr/0020).
// Emits test/golden/snapshot.json: a log + epoch params + the EXACT serialized bytes the TS
// serializeSnapshot produces. Both the TS test and the C++ smoke fold the same log through
// selectCut → serializeSnapshot and assert byte-identical output — the property that makes a C++
// writer and a TS writer of the same cut hash to the same Storage CID. Run:
//   node test/gen-snapshot-vectors.mjs   (then commit test/golden/snapshot.json)
import { writeFileSync } from "node:fs";
import { epochBoundary, boundaryHlc, selectCut, serializeSnapshot } from "../dist/index.js";

// Fixed events with deliberately UNSORTED payload keys + varied JSON types (nested/array/number/
// bool/null/string), some signed (pub/sig), one unsigned — to exercise cjson identically both sides.
// serializeSnapshot does not verify, so fixed dummy pub/sig strings are fine here.
const log = [
  { v: 1, id: "e3", type: "note.put", hlc: { wall: 300, ctr: 0, dev: "0xA" }, dev: "0xA", payload: { title: "third", nested: { b: 2, a: 1 }, arr: [3, 1, 2] }, pub: "02aa", sig: "cc33" },
  { v: 1, id: "e1", type: "note.put", hlc: { wall: 10, ctr: 0, dev: "0xA" }, dev: "0xA", payload: { title: "first", n: 1, flag: true }, pub: "02aa", sig: "aa11" },
  { v: 1, id: "e2", type: "note.put", hlc: { wall: 120, ctr: 0, dev: "0xB" }, dev: "0xB", payload: { z: null, title: "second" }, pub: "03bb", sig: "bb22" },
  { v: 1, id: "e4", type: "note.del", hlc: { wall: 999, ctr: 0, dev: "0xB" }, dev: "0xB", payload: { id: "e1" } }, // unsigned (no pub/sig)
  { v: 1, id: "e5", type: "note.put", hlc: { wall: 1000, ctr: 0, dev: "0xA" }, dev: "0xA", payload: { title: "excluded-on-boundary" }, pub: "02aa", sig: "dd44" },
];
const epochSizeMs = 1000;
const now = 1500; // → boundary 1000; cut = e1,e2,e3,e4 (wall<1000); e5 excluded
const boundary = epochBoundary(now, epochSizeMs);
const cut = selectCut(log, boundary);
const serialized = serializeSnapshot(cut, boundaryHlc(boundary));

writeFileSync(
  new URL("./golden/snapshot.json", import.meta.url),
  JSON.stringify({ log, epochSizeMs, now, boundary, cutIds: cut.map((e) => e.id), serialized: new TextDecoder().decode(serialized) }, null, 2) + "\n",
);
console.error(`wrote golden/snapshot.json — cut [${cut.map((e) => e.id).join(",")}], ${serialized.length} bytes`);
