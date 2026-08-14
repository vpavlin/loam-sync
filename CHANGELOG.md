# Changelog

## 0.3.0 — 2026-08-14
- **event authenticity (signing) landed — ADR 0008, was design-only.** Optional
  secp256k1 layer proving WHO authored an event; verification is public-key only and
  the library never holds a private key — signing is delegated through an injected
  `Signer` seam (a `SoftwareSigner` today, a `KeycardSigner` tomorrow — same digest,
  same code path). C++ (OpenSSL) + TS (@noble/curves v1, the Hermes-proven stack).
- **event** — optional `pub`/`sig` fields added to the envelope (unsigned events stay
  first-class). Reconciles the drift where Scala's vendored copy had run ahead.
- **signing** — new `signing.hpp` / `signing.ts`: `canonicalMessage(domain, ev)`,
  `address(pub33)` = `0x`+sha256(pub)[24:64], `signEvent` / `verifyEvent` / `isSigned`,
  parameterised by a per-app `domain` tag (no hardcoded `scala-`).
- **parity** — signing anchors frozen in `test/golden/vectors.json` (priv→pub/address,
  canonical, digest, deterministic sig). Cross-verified both ways: OpenSSL verifies
  @noble's frozen sig and vice-versa, plus 4 tamper cases rejected on each side. sig is
  NOT byte-compared (OpenSSL uses random k, @noble RFC-6979) — the gate is verify.
- Depends on `@noble/curves ^1.9.7` (matches Scala mobile; v2 needs `{prehash:false}`
  and misbehaves on Hermes — ADR 0008).

## 0.2.0 — 2026-08-13
- **catchup rewritten to v2 — recursive Range-Based Set Reconciliation on the wire.**
  v1 (ship the whole id-list, serve the complement) segmented for even ~15 events and
  the delivery module can't encrypt multi-segment channel sends. v2 exchanges bounded
  fingerprint/id range statements: every message is a single segment, and the transfer
  is the id-EXACT delta. Verified: a 200-event log with a 3-event delta converges with
  a max message of 375 bytes (ADR 0004). API: `buildInitial` / `respond` (was
  `buildRequest` / `answerRequest`). C++ + TS mirrors.

## 0.1.0 — 2026-08-13
- Initial extraction from KYM's proven sync core.
- **event** — `{v,id,hlc,dev,type,payload}` envelope + HLC `Clock` (C++ + TS).
- **merge** — `mergeEvents` union-by-id + HLC order (idempotent/commutative/associative).
- **reconcile** — Range-Based Set Reconciliation (lifted verbatim from KYM's
  parity-tested mirror; fingerprint byte-parity C++↔TS confirmed).
- **catchup** — v1 catch-up protocol: id-summary request → serve-only-the-delta,
  bidirectional. Replaces periodic full re-broadcast (ADR 0003, 0004).
- Docs: README, SYNC_SPEC, PARITY, ADRs 0000–0007. Convergence suite 200/200.
- First consumer: scala.
