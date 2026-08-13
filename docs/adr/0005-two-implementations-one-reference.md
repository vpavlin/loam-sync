# 5. Two implementations, one reference, golden vectors

- **Status:** accepted
- **Date:** 2026-08-13

## Context

The Basecamp cores are C++; the mobile apps are TypeScript. They must produce
**identical** results — a phone and a desktop that fold the same log to different
state, or compute a different range fingerprint, silently fail to converge, and it
looks exactly like "the network is down." We cannot ship one language and shim the
other: both run the real algorithm on their own platform.

## Decision

Maintain **two implementations of one specification**, and guard them with
**golden-vector parity tests**:

- The **specification** is the behaviour, written once in prose (`docs/SYNC_SPEC.md`)
  and mirrored in `basecamp/` (C++) and `src/` (TS). Neither language is "the source";
  the *spec* is.
- **Golden vectors** (`test/golden/`) are fixed inputs with their expected outputs —
  merge results, and especially RBSR **fingerprints** and reconcile diffs. Both the
  C++ and the TS test load the *same* vectors and must reproduce them byte-for-byte.
- The fingerprint's byte layout (XOR of `SHA-256(id)` over 32 bytes, then
  `SHA-256(acc ‖ uint32_be(count))[0..16]`, hex) is **frozen** by these vectors. A
  change to it is a breaking wire change and needs a new ADR.

## Alternatives rejected

- **One implementation + FFI/WASM the other side.** Ships a native blob into Hermes
  (fragile on arm64) or a JS engine into a C++ core; both are heavier and less
  debuggable than 150 lines of mirrored code with a parity test.
- **"Just keep them in sync by hand."** Precisely how the four apps diverged in the
  first place (0000). Parity has to be *enforced*, not intended.

## Consequences

- Any drift fails CI at the vector, not in the field at 2 a.m.
- Porting a fifth language later means one more implementation checked against the
  same vectors — cheap and safe.
- The parity test is the definition of done for a change to merge/reconcile.
