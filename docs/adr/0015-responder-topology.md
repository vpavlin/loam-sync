# ADR 0015: Responder topology and always-on store-backed hub

- **Status:** Proposed
- **Date:** 2026-08-21

## Context

logos-sync bootstraps a joining node's history from two complementary paths: a
**store-query** pull of the fleet/hub store, and **recursive RBSR catchup** that
closes the residual delta against a live peer (per the cold-start bootstrap
contract). Both paths assume *someone* is durably holding the log and is awake to
serve it. The 2026-08 sync review found that assumption is not reliably met, for
two structural reasons.

**No node except the public fleet can actually serve history.**

- **Phones are Edge.** The mobile delivery node runs in Edge mode (filter +
  lightpush, client-only — see the delivery edge-mode note): it does not relay a
  shard and **cannot answer a store query**. It can re-serve events it holds over
  catchup while online, but it is never a durable store responder.
- **Desktop cores have no store at all.** The desktop `delivery_module` /
  `loam_core` exposes `createNode` / `send` / `subscribe` but no
  `waku_store_query`, so a fresh desktop join gets history only if a peer happens
  to be live inside the one-shot retry window (fix #17 tracks bridging this).
- **Shared-node phones have a stubbed `storeSync`.** A phone syncing through the
  shared Loam node currently gets `service-node.storeSync` returning `{0,0}`, so
  it is a cold-start regression versus an embedded phone (fix #5 tracks proxying
  `storeQuery` over AIDL).

The net effect: durable backfill hinges entirely on **public-fleet retention** or
on **a peer being awake at the right moment**. Fleet retention is finite and the
per-topic store-pull truncates at the **2500-msg/topic cap** (ADR 0011), so once
an offline window exceeds retention, history is simply gone.

**When peers *do* serve, they all serve at once.** Catchup fan-out is
`O(M·delta)`: every holder independently answers `buildInitial` and broadcasts its
serves to the whole topic. In a topic with several online phones this is a
redundant broadcast storm — each phone re-emits overlapping ranges to everyone
(fix #10).

The mechanism is topological, not a wire-format defect: the protocol works, but
the *set of nodes* participating has no member that is both durable and always
awake, and the *coordination* among responders has no election.

## Decision

**Every household/topic has at least one always-on Core node — the canonical
responder.** For vpavlin's deployment this is the OptiPlex crib-hub (see the Loam
home-server and shared-multi-app-hub notes). The hub:

- runs the delivery node in **Core mode**, subscribed to the topic's shard, so it
  **relays** the shard and **answers store queries** — unlike any phone;
- publishes and re-serves **data events non-ephemerally** (per ADR 0012 only
  durable events are stored; control traffic stays ephemeral), so it is a real
  durable store, not just a live relay;
- has **retention that exceeds the expected offline window** — it, not the public
  fleet, is the retention contract a topic can depend on.

"A topic needs at least one always-on Core member" is an **explicit deployment
requirement**, documented as such. It is ops/deployment work: no wire-protocol
change is required to stand the hub up.

**Catchup gains responder election so the hub answers and phones stay quiet.**
The shared catchup adds two behaviours:

- **Randomized respond delay (jitter)** — a holder waits a small random interval
  before answering `buildInitial`, so responders do not all fire simultaneously.
- **Suppress-if-already-served** — during a short window a holder that observes
  another peer already serving the requested range **cancels its own pending
  serve**.

In a hub topic the always-on Core node is effectively the fastest, most-complete,
lowest-jitter responder, so it wins the race and the phones fall silent — the
common case becomes hub-answers, phones-quiet. Crucially, **phone-to-phone
catchup still works when no hub is present**: with no Core member, an online phone
that holds the delta is still elected and serves it. This is the key advantage of
catchup over store-query, which only a Core node (fleet or hub) can ever answer.

Election is a **timing/behaviour change in the shared catchup, not a wire-format
change**. Mixed old/new peers still converge: an un-elected old peer simply
serves eagerly as it does today (redundant but correct).

## Consequences

**Durability.** Backfill no longer depends on public-fleet retention or on a peer
being awake. The hub is a known, sized, always-awake store per shard; the offline
window a topic can tolerate becomes an explicit function of hub retention rather
than an accident of fleet behaviour.

**Bandwidth.** Responder election collapses catchup fan-out from `O(M·delta)`
toward `O(delta)` in hub topics — one responder answers instead of every holder
broadcasting overlapping ranges. Phone battery and radio are spared the redundant
serves.

**Rollout / compatibility.**

- The hub is **additive** — standing up an always-on Core node changes no client
  and needs no coordinated flag-day. It can be deployed before any client ships
  election.
- Responder election is **backward-compatible**: new peers jitter and suppress;
  old peers serve eagerly. The worst case in a mixed fleet is today's
  redundant-but-correct behaviour, so election can be rolled out per app/platform
  at leisure.
- Election composes with the ephemeral control plane (ADR 0012): serves and
  catchup rounds are ephemeral, and the hub is the canonical *live* responder for
  its shard, so suppression never leaves a topic with no answerer.

**Risks.**

- **Single point of dependence.** A topic that relies on one hub is exposed if
  that hub goes down — and the shared delivery node has a known peer-drop bug
  (silent drop to 0 peers with no watchdog; see the node peer-drop note). Mitigate
  with ≥1 Core node per topic where availability matters, hub health monitoring,
  and the fact that phone-to-phone catchup remains a fallback while any holder is
  online.
- **Over-suppression / silent topic.** If jitter and the suppression window are
  mistuned, a genuine requester could see a serve start, suppress its own
  potential responders, and then have the elected serve stall — leaving the delta
  unfilled. Self-healing catchup (fix #4: re-trigger on peer-up/reconnect and
  while `behind > 0`) is the companion mechanism that recovers a dropped or
  stalled serve; election must not be shipped without it.
- **Election is not addressed delivery.** Jitter + suppression reduce fan-out but
  serves are still broadcast to the whole channel. Unicast-style addressed serves
  (open question in the review) would cut fan-out further; election is the
  no-wire-change step that lands first.
- **Retention sizing is a live decision.** The hub's retention must exceed the
  real offline window, and the 2500-msg/topic pull cap needs re-evaluation once
  deterministic-nonce dedup (ADR 0011) lands — newest-first paging or a persisted
  per-topic high-watermark may still be needed for very long topics.

## Related fixes

From the 2026-08 sync review (`docs/sync-review-2026-08.md`):

- **#6** *(M/low)* — Stand up an always-on store-backed hub per shard as the
  canonical backfill responder. The topology half of this decision; ops work, no
  protocol change.
- **#10** *(M/medium/WIRE-timing)* — Add responder election to catchup
  (randomized respond delay + suppress-if-already-served). The coordination half;
  a timing/behaviour change in the shared catchup, coordinated so mixed peers
  still converge.

Supporting / adjacent:

- **#4** *(M/low)* — Self-healing catchup (re-trigger on peer-up/reconnect and
  while `behind > 0`). The recovery mechanism that makes suppression safe against
  a stalled serve.
- **#5** *(M/medium)* — Implement `service-node.storeSync` by proxying
  `storeQuery` over AIDL to the shared Loam node, so shared-node phones can pull
  the hub/fleet store instead of relying on finite live catchup.
- **#17** *(L/medium)* — Bridge `waku_store_query` into the desktop
  `delivery_module` / `loam_core` so a desktop can pull the store on cold start;
  partly obviated operationally by the hub, so sequence it after the hub exists.
- **#11** *(S/low/WIRE)* — Ephemeral control plane (ADR 0012): the hub publishes
  *data events* non-ephemerally while catchup/serve control traffic stays
  ephemeral.

See also ADR 0012 (ephemeral control plane) for the store/relay distinction the
hub relies on, and ADR 0013 (HLC clock discipline) for the ordering guarantee that
makes a served backfill converge correctly.
