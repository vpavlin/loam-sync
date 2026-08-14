// logos-sync (TypeScript / mobile side) — the sync spine shared with the C++
// Basecamp cores. Bring your own event `type`/`payload`, your fold, and your
// seal/open crypto (docs/adr/0006-0007); this gives you the envelope, the CRDT
// merge, reconciliation, and the catch-up protocol.
export { type HLC, type Event, compareHlc, Clock } from "./event.js";
export { mergeEvents, mergeOne } from "./merge.js";
export { type Item, type Diff, toItems, reconcile, fingerprintIds } from "./reconcile.js";
export { type CatchupMsg, type Step, buildInitial, respond } from "./catchup.js";
// Optional authenticity layer (docs/adr/0008) — off unless you sign. The app owns key
// storage + RNG and injects a Signer; the library never holds a private key.
export {
  type Signer, SoftwareSigner, signEvent, verifyEvent, isSigned,
  canonicalMessage, address, hex, fromHex, utf8Bytes,
} from "./signing.js";
