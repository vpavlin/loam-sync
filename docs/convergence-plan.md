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

## Per-app migration (coordinated breaking cutover (ADR 0019); verify new↔new + device check)
**kym / qaku (the ports):**
- Replace `packages/contract/hlc` with logos-sync `Clock` (adds primeFrom/receive — the #1 fix, already stopgapped in kym).
- Replace `packages/sync` reconcile/wire/node with logos-sync `reconcile`/`catchup` + the sealed-Event wire; retire the `{type:EVENT}` envelope + whole-log `SYNC_REQ`.
- Retire the hand-ported C++ mirror; kym_core/qaku_core fold consumes logos-sync `basecamp/logos_sync/*`. App-specific FOLD stays per-app but single-sourced.
- No dual-read (ADR 0019): retire the old wire outright; rebuild all peers incl. the crib-hub together.

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

## kym port — concrete steps + a blocker found (2026-08-21)

Dependency shape: loam-sync is a real package (`name: loam-sync`, `main: src/index.ts`). kym is an
npm workspace; `@kym/sync` would add `loam-sync: file:../loam-sync` (TS) + a git submodule of
`basecamp/logos_sync/` for kym_core (C++), replacing the bespoke copies. No vendoring (ADR 0010).

**BLOCKER — @noble version split:** `@kym/sync` depends on `@noble/hashes`/`@noble/ciphers` **^2.2.0**
(v2); loam-sync is on **v1** (`@noble/curves ^1.9.7`), deliberately — v1 is Hermes-safe, "v2 needs
`{prehash:false}` and misbehaves on Hermes" (signing work). Decide before porting:
- (a) move loam-sync to @noble v2 (re-verify Hermes on a real phone — v2 was avoided for a reason), or
- (b) keep loam-sync on v1 and pin kym to v1 too (kym currently ships v2 — re-verify kym mobile).
One @noble major across the ecosystem is the goal; needs a device check either way.

**Steps once the @noble decision is made:**
1. `@kym/sync`: delete `crypto.mjs` → re-export loam-sync `crypto` (shared seal + deterministic nonce).
   Update call sites (`mobile/delivery.ts` `seal(id,pt,topic)` → `seal(id,domain,eventId,pt,topic)`) —
   the event id is the dedup key (ADR 0011).
2. `packages/contract/hlc.mjs` → loam-sync `Clock` (has primeFrom; retires the kym stopgap).
3. `packages/sync/reconcile.mjs` → loam-sync `reconcile`/`catchup` (loam-sync's reconcile was lifted
   from kym's `kym_reconcile_std.hpp`, so likely already equivalent — diff to confirm).
4. Wire: drop the `{type:EVENT}` envelope + whole-log `SYNC_REQ` (ADR 0019) → sealed-Event + RBSR only.
5. kym_core: submodule loam-sync `basecamp/logos_sync/`, delete the C++ mirror; the FOLD stays kym's.
6. Verify: kym JS tests (convergence/sync) + golden gate + load kym_core on the crib-hub + a two-device check.

qaku mirrors this. scala/kith: move to ChaCha (delete AES-GCM) + updated loam-sync.

## PROGRESS — 2026-08-22 (kym crypto convergence DONE + verified)

The @noble blocker is resolved (loam-sync moved to @noble v2, matching kym). Step 1 (crypto) is
**complete and verified byte-identical across all five surfaces**, on branch `sync-hardening`:
- `packages/sync/crypto.mjs` → thin wrapper over loam-sync `crypto` (domain="kym"), `seal(id,eventId,pt,topic)`;
  `node.mjs` threads `event.id`. Verified: 4/4 sync + 44/44 engine tests; same-id seals byte-identical,
  distinct-id differ, roundtrips; **backward-compatible** (loam-sync `deriveIdentity("kym")` derives the
  SAME topic/keys as the old crypto, cross-open both ways — old hub reads new msgs, new reads old).
- `mobile/src/lib/identity.ts` → deterministic id-nonce (Metro can't bundle out-of-tree loam-sync on an
  Expo export, so the phone keeps an algorithm-identical vendored copy); `delivery.ts` threads `event.id`,
  ephemeral SYNC_REQ gets a fresh random seed. Verified mobile seal == packages seal byte-for-byte.
- `kym_core/src/kym_crypto.hpp` gains `nonceFor(id,eventId)`; `sealAndSend()` uses it. Verified: a C++
  harness compiling kym_crypto.hpp emits the exact same topic + sealed bytes (`2d1d6c0b…507b0a71`) as the
  loam-sync TS seal → kym_core == phone == packages == loam-sync (TS + C++) all seal identically.

**HUB DEPLOY BLOCKED by an orthogonal migration (found 2026-08-22):** rebuilt kym_core 0.7.5 cleanly
(my crypto change compiles in the full module build), but it **won't load in the crib-hub**: the current
kym_core SOURCE declares `dependencies: ["loam_core"]` (migrated to the loam_core facade), whereas the
deployed hub runs the pre-migration **0.7.4** (`dependencies: ["delivery_module"]`) and the crib profile
loads `delivery_module` directly (one shared node for kym+qaku+scala), NOT `loam_core`. So `logos-hub`
returns `MODULE_LOAD_FAILED` (unresolved dep) — NOT a fault of the crypto change (dlopen succeeds, hashes
match once repacked via the `install-portable` nix output). qaku_core + scala are still on `delivery_module`
too. Rolled the hub back to the working 0.7.4. Deploying the new crypto to the hub is gated on the
**loam_core hub migration** (add loam_core to the crib profile while preserving ONE shared node + version-
align it with what kym_core 0.7.5 was built against) — a separate task. And since the deterministic-nonce
dedup only pays off when ALL publishers use it, the hub + phone must be redeployed together anyway.
Rebuild recipe for later: `nix build .#packages.x86_64-linux.install-portable` → deploy the whole
`modules/kym_core/` dir (so+manifest+variant+bundled libs; the manifest carries the Merkle hashes).

**Not yet a full delete of the mirror:** kym_crypto.hpp is now algorithm-identical to loam-sync
crypto.hpp but still a separate file (submoduling the header into the nix module build = step 5, deferred).
**Still ahead:** steps 2 (HLC Clock), 3 (reconcile), 4 (wire retirement), 5 (C++ submodule), then qaku +
scala/kith. Deploy: rebuild kym_core .lgx → crib-hub + rebuild mobile APK, then new↔new + device check.

**Step-3 reconcile VERIFIED EQUIVALENT (2026-08-22) — retirement is a safe pure dedup:** proved kym's
`packages/sync/reconcile.mjs` == loam-sync's `reconcile` with zero drift: identical fingerprint anchor
`03e804547dd32e9b71f0d2c78a1279a6` and identical `aNeeds`/`bNeeds`/`rounds`/`controlBytes` across 2000
random trials (only kym adds a cosmetic `comparisons` counter). The C++ `kym_reconcile_std.hpp` produces the
same anchor too → reconcile is byte-identical across kym-JS / loam-sync-JS / C++. So the actual file-
retirement carries no behavioral risk; it's deferred only because it needs (a) loam-sync node packaging (a
`dist` build — raw-TS consumption breaks in node: modules with sibling `./x.js` imports like reconcile/
event/merge don't resolve under node's type-stripping, unlike crypto which imports no siblings) for the JS
side, and (b) the C++ submodule step. Note `packages/sync` is largely a reference/test impl (the real
runtimes are mobile's vendored copy + kym_core C++), so its convergence is lower-impact than crypto's.

**Step-2 nuance found (2026-08-22):** loam-sync's `Clock.receive()` is already observe-only (take max,
NO +1 bump) — i.e. it IS kym's `primeFrom` semantics; loam-sync guarantees "next local event sorts after
the received one" via `send()`'s `ctr+=1` instead. kym's model differs: kym's `receive()` bumps +1 and it
carries a SEPARATE `primeFrom()`. So the HLC port is a **design reconciliation** (adopt loam-sync's
receive-based discipline, delete kym's `primeFrom` + the receive bump, rely on `send`), NOT an add-to-loam.
loam-sync's Clock needs no change. Do it as its own pass gated on kym's convergence tests (the ordering
change is behavioral). Also reconcile the API: loam-sync `send(nowMs)` injects the clock; kym injects `now`
in the ctor.
