# Changelog

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
