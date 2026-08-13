# 6. Crypto and transport are out of scope

- **Status:** accepted
- **Date:** 2026-08-13

## Context

It is tempting to fold encryption and the Waku node into "the sync library" — they
always travel together. But the apps do **not** agree on either: Scala seals with
**AES-256-GCM** (`nonce ‖ tag ‖ ciphertext`, no AAD), while KYM/Qaku/Perun use
**ChaCha20-Poly1305** with the topic as AAD; and node bring-up already has a home in
[`logos-transport`](https://github.com/vpavlin/logos-transport).

## Decision

logos-sync handles **plaintext events only**. It never encrypts, never derives a
topic, never opens a socket.

- **Crypto stays app-side.** The app seals the plaintext bytes logos-sync produces
  (`eventToJson`) and opens sealed bytes before handing them back. Different ciphers
  per app are therefore a non-issue — the library never sees a key.
- **Transport stays in logos-transport.** logos-sync returns "publish these events" /
  "you're missing these ids"; the app's transport adapter seals and calls
  `publishSealed`. Receiving is the mirror.

The clean seam is: **logos-transport moves bytes · logos-sync decides which bytes ·
the app owns the keys and the meaning.**

## Alternatives rejected

- **Bundle a canonical cipher.** Would force Scala off AES-GCM (a migration with no
  benefit) or force a cipher-negotiation layer nobody needs.
- **Bundle the node.** Duplicates logos-transport and drags Waku/JNI/Qt lifecycle
  concerns into a pure-logic library, killing its testability (it currently needs no
  network to test at all).

## Consequences

- logos-sync is **pure and offline-testable** — the convergence and parity suites run
  with no node and no keys.
- The eventual **MLS** membership-security upgrade (forward secrecy, re-key on member
  removal) slots in at the *crypto* seam in the app, not inside logos-sync — it is a
  seal/open concern, orthogonal to reconciliation.
