// logos-sync (TypeScript / mobile side) — the sync spine shared with the C++
// Basecamp cores. Bring your own event `type`/`payload`, your fold, and your
// seal/open crypto (docs/adr/0006-0007); this gives you the envelope, the CRDT
// merge, reconciliation, and the catch-up protocol.
export { compareHlc, Clock } from "./event.js";
export { mergeEvents, mergeOne } from "./merge.js";
export { toItems, reconcile, fingerprintIds } from "./reconcile.js";
export { buildInitial, respond } from "./catchup.js";
// Optional authenticity layer (docs/adr/0008) — off unless you sign. The app owns key
// storage + RNG and injects a Signer; the library never holds a private key.
export { SoftwareSigner, signEvent, signEventAsync, verifyEvent, isSigned, canonicalMessage, address, hex, fromHex, utf8Bytes, } from "./signing.js";
// Optional Keycard-custody layer (docs/adr/0009) — a card identity delegates bounded off-card
// signing to an ephemeral key via an on-card cert; verify chains delegate→cert→identity. The
// concrete hardware signer lives in loam-keycard; this is the wire + verify spine (C++ parity).
export { canonicalCert, verifyCert, issueCert, issueCertAsync, } from "./signing.js";
