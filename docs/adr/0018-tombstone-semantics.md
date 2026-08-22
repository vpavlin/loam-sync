# ADR 0018: Tombstone semantics for shared kith/scala fold

- **Status:** Proposed
- **Date:** 2026-08-21
- **Owner of the product-intent decision:** vpavlin (flagged below)

## Context

`logos-sync` merge is deliberately neutral about deletes. `mergeEvents` /
`mergeOne` in `basecamp/logos_sync/merge.hpp` (parity: `src/merge.ts`) only
**union by id and sort by HLC** — "no concurrent write is ever overwritten; the
HLC sort then gives a total order identical on every replica" — and the header
is explicit that "edits/deletes/LWW/tombstones are all expressed as events the
fold interprets, never as mutations here." So the merge layer already converges
losslessly; **the question this ADR settles is purely how the app fold that
consumes the ordered output interprets a delete relative to a concurrent edit.**

This matters for the two apps that consume `logos-sync` today and share a fold
contract — kith (contacts / address book) and scala (calendar / editors). Both
model a delete as a **tombstone event** (`contact.del` / entry delete) folded
over the HLC-ordered log. The 2026-08 sync review (`docs/sync-review-2026-08.md`)
lists this under "ADRs to write" and, more sharply, as the open question:

> Tombstone product intent (kith/scala): is delete-wins the desired product
> behavior for shared books/calendars, or is a causally-newer edit expected to
> survive a concurrent delete? The answer decides whether we ship a UI signal or
> change fold semantics.

The two candidate fold interpretations, both convergent (they read the same
ordered log identically on every replica — the merge guarantees that), differ
only in outcome:

1. **Delete-wins (terminal tombstone) — current v1 behavior.** Once a
   `del` event exists for an entity, the fold treats that entity as gone,
   regardless of the HLC order of a concurrent edit. Convergent and dead simple,
   but it **silently drops a causally-newer concurrent edit**: device A edits a
   contact offline while device B deletes it; on merge the edit is discarded and
   A is never told.

2. **Causally-newer-edit-wins (HLC-comparison).** The fold compares the HLC of
   the latest `del` against the HLC of the latest field-setting edit for the same
   entity. A `set` whose HLC is greater than the latest `del` **resurrects** the
   entity (with the newer field values); a `del` that is HLC-greater than every
   `set` keeps it tombstoned. Preserves the offline edit at the cost of a more
   subtle fold and a "deleted thing came back" surprise for the deleter.

Because both interpretations are computed by the fold over the identical merged
log, **the choice is a product-intent decision, not a correctness one** — but
once chosen it is load-bearing for convergence in a different sense: kith and
scala (and any future `logos-sync` consumer that shares the contract) MUST fold
tombstones **identically on both platforms** (TS reference + C++ mirror). A
delete-wins mobile and an HLC-compare desktop would diverge on exactly the
concurrent-delete-vs-edit case while both "converging" internally — the worst
class of bug, invisible until two users hit the race. This is the same
two-implementations-drift failure mode the review documents across the signing
contract (fixes #14/#15) and the fold parity notes (fix #1, fix #9).

## Decision

**This is a product-intent decision reserved for vpavlin.** The engineering
contract below binds whichever intent is chosen; it does not pre-empt the
choice.

1. **Pick one tombstone intent, explicitly, per shared entity class.** The
   default carried forward if no change is made is **delete-wins (terminal
   tombstone), v1**, because it is what kith/scala ship today and it is the
   simplest convergent rule. The alternative on the table is
   **causally-newer-edit-wins (HLC-comparison)**. The decision is recorded here
   once made; until then this ADR stays *Proposed* and delete-wins remains in
   effect by default.

2. **Whatever is chosen, the fold implements it identically on both platforms.**
   The tombstone rule lives in the app fold (not in `merge.hpp`, which stays
   neutral) and MUST be byte-for-outcome identical between the TS reference and
   the C++ mirror for kith and scala. This is enforced the same way the signing
   contract is (ADR
   [0008 — cross-language signing contract](0008-cross-language-signing-contract.md)):
   **shared golden vectors** feeding a concurrent `{edit, del}` pair (in both HLC
   orders, and same-ms concurrency) to both engines, asserting the same visible
   set. The vector suite gates CI; drift becomes a build failure, not a field
   bug.

3. **If delete-wins is kept, the fold surfaces the drop to the authoring
   device.** A user whose causally-newer edit was tombstoned MUST be able to
   learn it happened (e.g. the fold exposes "your edit to X was superseded by a
   delete" to the UI). Silent data loss with no signal is not acceptable even
   when it is the intended convergent outcome. This is the "ship a UI signal"
   arm of the review's open question.

4. **If HLC-comparison is chosen, it is a coordinated fold change shared by kith
   and scala.** It is not a wire-format change (tombstones are already events on
   the wire; the merge is unchanged), but it changes the *interpretation* of the
   existing log, so both apps and both platforms of each must ship the new fold
   before either enables it in a shared book/calendar — otherwise a mixed fleet
   diverges on the concurrent case. Sequence it like the STRICT-fold rollout
   (fix #9): every writer (mobile + desktop + hub) ships the new fold before the
   behavior is switched on.

## Consequences

- **Convergence is unaffected by the choice; only the visible outcome changes.**
  `merge.hpp` guarantees every replica sees the same ordered log; both
  interpretations are deterministic functions of that log, so replicas stay
  bit-identical in their *fold output* as long as they run the *same*
  interpretation. The risk is entirely cross-implementation/cross-app skew,
  which the golden vectors close.
- **Rollout / compat.** Delete-wins (default) is a no-op to keep — v1 already
  does it; the only added work is the authoring-device signal (item 3), which is
  UI/fold-surface only and non-wire. HLC-comparison is a coordinated fold change
  across kith + scala + both platforms + hub; no wire change, but a
  flag-day-style behavior switch that must land everywhere before it is enabled
  in any shared container.
- **Product risk of delete-wins:** a real offline edit can be silently discarded;
  mitigated (not eliminated) by the UI signal. Acceptable only if "a delete is
  final" is genuinely the product's mental model for contacts/entries.
- **Product risk of HLC-comparison:** a deleted contact/entry can *reappear*
  after a concurrent edit, which is surprising to the deleter and can resurrect
  something deleted for a good reason (e.g. a removed member's entry). Needs its
  own UI framing ("this entry was re-added by an edit from <device>").
- **Parity risk (both options):** the review already found the kym C++ fold had
  dropped `account.edit closed` and the qaku C++ fold skips signature
  verification — hand-mirrored folds have drifted before. Tombstone handling is
  exactly the kind of subtle branch that drifts silently; the golden-vector CI
  gate is the mitigation and is a hard requirement of this ADR regardless of
  which intent wins.
- **Scope:** this ADR governs the shared kith/scala fold consuming `logos-sync`.
  kym/qaku carry their own (soon-to-be-retired) mirrors (fix #13); when they
  converge onto `logos-sync`, they inherit the tombstone contract decided here
  rather than defining their own.

## Related fixes

- **Open question — Tombstone product intent (kith/scala)** in
  `docs/sync-review-2026-08.md`: the product decision this ADR frames and
  reserves for vpavlin.
- **ADRs-to-write — Tombstone semantics for shared kith/scala fold**: the review
  entry this ADR fulfills.
- **#1** — Seed HLC from the log and `clock.receive()` on every ingest: HLC
  discipline is a precondition for HLC-comparison tombstones to order edits vs
  deletes correctly; the same fix's "restore `account.edit closed`" note is the
  same fold-parity hazard this ADR guards against.
- **#9** — Signature-verifying fold + coordinated STRICT flip: the rollout
  template for an HLC-comparison fold switch (every writer ships before enable).
- **#13** — Converge kym + qaku onto `logos-sync`: they inherit this tombstone
  contract on convergence rather than keeping bespoke delete semantics.
- Builds on ADR
  [0001 — event-log CRDT, not state replication](0001-event-log-crdt-not-state-replication.md)
  (merge is union + HLC order; deletes are events the fold interprets) and the
  golden-vector enforcement pattern of ADR
  [0008 — cross-language signing contract](0008-cross-language-signing-contract.md).
