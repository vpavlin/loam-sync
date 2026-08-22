# Convergence plan — one sync brain (logos-sync) for all apps

**Directive (vpavlin, 2026-08-21):** port kym + qaku onto logos-sync; add anything missing *to
logos-sync*; retire per-app implementations. This is ADR-0010, now primary.

## Where each app stands
| App | Sync brain today | Transport |
|-----|------------------|-----------|
| scala | **logos-sync** (`src/logos_sync/*`) | loam shared node |
| kith  | **logos-sync** (`src/logos_sync/*`) | loam shared node |
| kym   | bespoke `packages/sync` + `packages/contract` + C++ mirror (`kym_engine.hpp`, `kym_reconcile_std.hpp`) | loam shared node |
| qaku  | bespoke `packages/sync` + `packages/contract` + C++ (`qaku_engine.hpp`) | loam shared node |

## Gaps to fill IN logos-sync first (so it can host kym/qaku) — ADR 0017/0016
1. **Delegation-cert layer in C++ `signing.hpp`** — TS has it; C++ drops it. Round-trip the `cert` field through Event JSON. (Keycard custody parity.)
2. **`canonicalMessage` TS↔C++ byte-parity** — drop the TS `payload||{}` coercion; pin one number-encoding rule; golden vectors for null/empty/float/large-int/cert as a cross-repo CI gate.
3. **Signature verification in the fold** — port into the reference fold so every consumer gates gated events (`ecdsaVerify` AND `address(pub)==signer`); qaku C++ currently skips it (spoofable).
4. **Wire helpers** — recursive RBSR catchup (buildInitial/respond/serve) + the sealed-Event envelope as the single wire family; deterministic id-derived nonce (ADR 0011).

## Per-app migration (each behind version negotiation; device convergence check before flip)
**kym / qaku (the ports):**
- Replace `packages/contract/hlc` with logos-sync `Clock` (adds primeFrom/receive — the #1 fix, already stopgapped in kym).
- Replace `packages/sync` reconcile/wire/node with logos-sync `reconcile`/`catchup` + the sealed-Event wire; retire the `{type:EVENT}` envelope + whole-log `SYNC_REQ`.
- Retire the hand-ported C++ mirror; kym_core/qaku_core fold consumes logos-sync `basecamp/logos_sync/*`. App-specific FOLD stays per-app but single-sourced.
- Keep dual-read for one release: accept both old and new wire; advertise a version; flip once peers (incl. the crib-hub) understand v2.

**scala / kith (the alignment):** bump to the updated logos-sync; regenerate golden vectors; no wire change beyond the nonce (backward-compatible).

## Verification gates (no live flip without these)
1. Cross-impl **golden vectors** pass (TS fold == C++ fold, byte-identical canonicalMessage) in CI.
2. `logos-sync` unit + property tests (convergence over shuffled/duplicated/concurrent logs).
3. Headless **crib-hub** runs the new cores + old cores side-by-side and converges (dual-read).
4. **Device check**: a phone on v2 + a phone on v1 converge, then both on v2.

## Rollout order (safe → risky)
1. logos-sync gap-fills (1–4 above) + golden vectors — no app change, no wire change.
2. Ship the safe non-wire fixes already identified (HLC discipline, deterministic nonce, ephemeral CP guard, self-healing catchup) via logos-sync where they belong.
3. Port kym onto logos-sync (reference port) behind version negotiation; verify on the hub.
4. Port qaku; align scala/kith.
5. Coordinated wire v2 flip after the device convergence check.
