# Cross-language parity

The C++ (`basecamp/`) and TypeScript (`src/`) sides run the *same* algorithm on
different platforms. If they disagree — a different merge order, a different range
fingerprint — a phone and a desktop silently fail to converge, and it looks exactly
like a dead network. So parity is **enforced**, not assumed (ADR 0005).

## What must match, byte-for-byte

1. **Merge order** — `mergeEvents` output for the same input log.
2. **HLC comparison** — `compareHlc`.
3. **RBSR fingerprint** — `SHA-256(id)` XOR-fold, then `SHA-256(acc ‖ uint32_be(count))[0..16]`.
4. **reconcile diff** — `aNeeds` / `bNeeds` for the same two sets.
5. **catch-up** — `respond().serve` / `replies` for the same log + message.
6. **signing (ADR 0008)** — `canonicalMessage`, `address`, and `digest` for the same
   event byte-for-byte. The **signature itself is NOT byte-compared**: OpenSSL uses a
   random nonce `k`, @noble deterministic RFC-6979, so their sigs differ legitimately.
   Parity is **cross-verify** — each side must *verify* the other's signature.

## How it's checked

- **Golden vectors** in `test/golden/` — fixed inputs with expected outputs. Both the
  C++ smoke/parity test and the TS test load the same vectors and must reproduce them.
- **The fingerprint anchor:** `fingerprint(ids {"a","b"}) = 03e804547dd32e9b71f0d2c78a1279a6`.
  This exact hex is produced by both sides and by KYM's proven `reconcile.mjs` (the
  reference this library was extracted from). If your change moves it, it's a breaking
  wire change and needs a new ADR.
- **The signing anchor** (`vectors.json.signing`): fixed scalar `priv=1` → pub = the
  secp256k1 generator `G`, `address = 0x29e562f7…0554`, over a fixed event. Both langs
  reproduce pub/address/canonical/digest; C++ (OpenSSL) verifies the frozen @noble sig
  and vice-versa; 4 tamper cases (payload, type, wrong domain, forged dev) rejected on
  each side. Regenerate with `node test/gen-signing-vectors.mjs` (TS is the source of
  truth — @noble is deterministic).

## Running the checks

```sh
# C++ side
c++ -std=c++17 -I<nlohmann-include> test/smoke.cpp -lcrypto -o /tmp/smoke && /tmp/smoke

# TS side (once packaged): node --test, or the convergence harness
node test/convergence.test.mjs
node test/signing.test.mjs

# Or the whole suite (C++ smoke + both TS tests):
bash test/run.sh
```

## The provenance of parity

The C++ `reconcile.hpp` is lifted verbatim (namespace aside) from KYM's
`kym_reconcile_std.hpp`, and the TS `reconcile.ts` from KYM's `reconcile.mjs`. Those
two were already parity-tested against each other (24/24) in KYM's suite, so this
extraction *inherits* their parity — the anchor value above re-confirms it. New code
(the catch-up protocol) is covered by the smoke test on both sides.
