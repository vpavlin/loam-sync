# ADR 0011: Deterministic id-derived AEAD nonce

- **Status:** Proposed
- **Date:** 2026-08-21

## Context

Data events are sealed app-side (per ADR 0015, logos-sync never sees a key) before
they go on the wire. Today the seal draws a **fresh random nonce on every
serialization** — in `crypto.mjs` / `crypto.ts` and the C++ ports
(`qaku_crypto.hpp` and the kym equivalent). An event is immutable once authored, but
it gets **re-serialized and re-published repeatedly**: on retransmit, on catchup
serve, on whole-log re-serve, on cross-platform re-seal. Each re-seal produces a new
ciphertext, hence a **new Waku message hash**, so the fleet store treats every
re-serve of the *same* event as a *new* message.

Two concrete failures follow, both flagged in the 2026-08 sync review as top-priority:

- **Store bloat.** The fleet store accumulates unbounded duplicate copies of the same
  logical event, one per re-serve, because it can only dedup by message hash and the
  hash changes every time.
- **Cold-start truncation.** Store-pull on cold start is capped at **2500
  messages/topic**. When most of those slots are random-nonce duplicates of a small
  set of real events, the cap is hit on redundant copies and **genuine history is
  dropped** — a joining device never sees events that exist in the store.

The root cause is that the message hash is derived from ciphertext, and identical
plaintext currently yields different ciphertext. If re-serving an immutable event
produced **byte-identical** ciphertext, the store's existing hash-dedup would collapse
all the duplicates for free, no protocol change required.

## Decision

Derive the AEAD nonce **deterministically from the event id** instead of at random:

```
nonce = HMAC-SHA256(K, "<app>/nonce/v1|" + event.id)[0:12]
```

- **`K`** is the same symmetric key already used for the seal.
- **`"<app>/nonce/v1|"`** is a per-app, versioned domain-separation prefix (`v1`
  leaves room to rotate the derivation without ambiguity).
- **`event.id`** is the event's stable identity, and the nonce is the first 12 bytes
  of the HMAC output — the standard 96-bit AEAD nonce width for both AES-GCM and
  ChaC20-Poly1305.

Because the nonce is a pure function of `(K, event.id)`, **re-serving an immutable
event yields byte-identical ciphertext**, which yields an identical Waku message hash,
which the fleet store dedups. Store bloat stops; the 2500-msg cold-start pull stops
filling with duplicates and truncating real history.

**No nonce-reuse risk.** AEAD's safety requirement is that a given `(key, nonce)` pair
never encrypts *two different plaintexts*. Here one `event.id` maps to exactly one
immutable plaintext, so the same nonce only ever re-encrypts the *same* bytes —
which is precisely the property we want, not the misuse case.

**The event id must be the true idempotency key everywhere.** This decision only holds
if a single id never corresponds to two distinct plaintexts. Authoring must assign a
stable, collision-resistant id at creation and never mutate an event's payload under a
fixed id. Any code path that would re-issue content under an existing id is a
correctness bug under this scheme.

Apply the derivation uniformly across all four apps' crypto ports — `crypto.mjs` /
`crypto.ts` and `qaku_crypto.hpp` plus the kym equivalent — so a re-seal on any
platform reproduces the same ciphertext.

## Consequences

**Backward-compatible — no flag-day.** The nonce still travels on the wire exactly as
before (prepended to the ciphertext). Readers open a message using the nonce they
receive; they neither know nor care whether it was drawn at random or derived. Old
readers open new messages unchanged, and new readers open old (random-nonce) messages
unchanged. Senders can adopt the derivation independently, per app, at their own pace.

**Rollout.** Ship the derivation change to writers app by app. Dedup benefit accrues
incrementally: each writer that adopts it stops minting fresh duplicates. Pre-existing
random-nonce duplicates already in the store are not retroactively collapsed — they
age out with normal store retention (and are worth re-evaluating against the 2500-msg
cap once dedup has reduced steady-state volume; see the review's open question on
retention sizing).

**Benefits.**
- Fleet store stops growing without bound from re-serves of immutable events.
- Cold-start store-pull stops truncating real history on duplicate copies.
- Free win from the store's existing hash-dedup — no wire-format or protocol change.

**Risks.**
- **Idempotency-key discipline is now load-bearing.** If any app ever re-uses an id
  for different plaintext, that *would* be genuine nonce reuse and break AEAD
  confidentiality/integrity for those two messages. This raises the id contract from a
  convenience to a security invariant — hence the review rates this fix medium risk
  purely on that dependency. Mitigation: assert id/plaintext immutability at the seal
  boundary and cover it with a parity test.
- **Metadata leak.** Deterministic nonces make re-serves of the same event
  byte-identical on the wire, so a passive network observer can see the
  re-serve/duplicate pattern (the plaintext and id stay encrypted). Whether this
  observable duplication pattern is acceptable versus the store-dedup benefit is an
  open question carried in the review; the decision here treats it as acceptable given
  the cold-start severity, and the `v1` domain tag leaves room to revisit.

## Related fixes

From the 2026-08 sync review (`docs/sync-review-2026-08.md`):

- **Fix #2 — Derive the AEAD nonce deterministically from event id (all four apps).**
  This ADR is the decision record for that fix.
- **Fix #7 — Batch cold-start ingest with an O(1) in-memory id set.** Reinforces the
  same id-as-idempotency-key invariant this decision depends on.
- **Fixes #3 and #11 — EVENT-only pull guard and ephemeral control plane.** Complementary
  cold-start / bandwidth fixes: together with this nonce change they resolve the
  store-bloat and cold-start-truncation pain before any wire-protocol change.
- **ADR 0015 (Crypto and transport are out of scope).** The seal itself stays app-side;
  this ADR standardizes *how* each app derives its nonce, not where sealing happens.

## Note

This brings the seal INTO loam-sync (`crypto.ts`/`crypto.hpp`), partially **superseding ADR 0006** ("crypto out of scope") — the seal was duplicated per app and the deterministic nonce must be single-sourced. Transport remains out of scope.
