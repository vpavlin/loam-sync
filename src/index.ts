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
  type Signer, type AsyncSigner, SoftwareSigner, signEvent, signEventAsync, verifyEvent, isSigned,
  canonicalMessage, cjson, address, hex, fromHex, utf8Bytes,
} from "./signing.js";
// Log snapshots to content-addressed Storage (docs/adr/0020): bootstrap a joining device from one
// deterministic sealed blob instead of hundreds of relayed messages; RBSR-tail the delta. Bring your
// own Storage (Codex) + a deterministic Sealer (cryptoSealer builds one from the household key).
export {
  type Storage, type Sealer, type SnapshotPointer, cryptoSealer,
  epochBoundary, boundaryHlc, selectCut, serializeSnapshot, parseSnapshot,
  writeSnapshot, readSnapshot, bestPointer,
} from "./snapshot.js";
// Optional Keycard-custody layer (docs/adr/0009) — a card identity delegates bounded off-card
// signing to an ephemeral key via an on-card cert; verify chains delegate→cert→identity. The
// concrete hardware signer lives in loam-keycard; this is the wire + verify spine (C++ parity).
export {
  type CustodyMode, type CustodyPolicy, type DelegationCert,
  canonicalCert, verifyCert, issueCert, issueCertAsync,
} from "./signing.js";
