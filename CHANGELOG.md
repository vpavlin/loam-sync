# Changelog

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
