# 0. Record architecture decisions

- **Status:** accepted
- **Date:** 2026-08-13

## Context

logos-sync exists because four apps (Perun, KYM, Qaku, Scala) each grew their own
copy of "the sync bit," and the copies **diverged** — Scala ended up re-broadcasting
its whole log while KYM had efficient set reconciliation, purely because nobody
wrote down *why* KYM did it that way. A shared library only stops the drift if the
**reasoning** travels with the code, not just the code.

## Decision

We keep a numbered log of Architecture Decision Records (ADRs) in `docs/adr/`. Each
records one decision: the context, the choice, the alternatives rejected, and the
consequences. They are immutable once accepted — a later ADR supersedes an earlier
one rather than editing it. Format is lightweight (this file's shape); the point is
the *why*, not ceremony.

A change that alters the wire contract, the merge semantics, or the parity rules
**must** land with an ADR. Reviewers can then reject "clever" changes that quietly
break a property (idempotent merge, cross-language fingerprint parity) by pointing
at the ADR that property lives in.

## Consequences

- The library is legible to someone who has never seen it — start at ADR 0001.
- "Why is it like this?" has a durable answer, so the next port doesn't re-diverge.
- Small overhead per real decision; none for routine code.

## The log

- [0001](0001-event-log-crdt-not-state-replication.md) — Event-log CRDT, not state replication
- [0002](0002-hlc-total-order.md) — HLC for a deterministic, replica-identical order
- [0003](0003-set-reconciliation-over-resend-all.md) — Set reconciliation, not resend-all
- [0004](0004-catch-up-protocol.md) — The catch-up protocol: summarise, serve the delta
- [0005](0005-two-implementations-one-reference.md) — Two implementations, one reference, golden vectors
- [0006](0006-crypto-and-transport-are-out-of-scope.md) — Crypto and transport are out of scope
- [0007](0007-app-owns-storage-schema-and-fold.md) — The app owns storage, schema, and the fold
