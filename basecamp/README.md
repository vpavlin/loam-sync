# logos-sync — C++ (Basecamp core) side

Header-only. This is the side a Basecamp **core** module links (`scala_core`,
`kym_core`, `qaku_core`, the Perun module). It pairs with the desktop half of
[`logos-transport`](https://github.com/vpavlin/logos-transport).

## Install

Vendor as a submodule (as apps already do for logos-transport) and add the include
dir:

```cmake
target_include_directories(your_core PRIVATE ${CMAKE_SOURCE_DIR}/third_party/logos-sync/basecamp)
```

Dependencies you already have in a core: **nlohmann/json** and **OpenSSL**
(`-lcrypto`, for the RBSR fingerprint).

```cpp
#include <logos_sync.hpp>   // event + merge + reconcile + catchup
using namespace logos_sync;
```

## The five things you touch

```cpp
// 1. Author locally: stamp with your Clock, merge into your log, seal+publish.
Event e; e.id = uuid(); e.type = "event.put"; e.hlc = clock.send(nowMs()); e.dev = myId;
e.payload = {...};
mergeOne(myLog, e);                              // dedup + HLC-ordered insert
transport.publish(topic, seal(eventToJson(e)));  // your crypto + logos-transport

// 2. Ingest a peer event: open, decode, merge (idempotent), advance the clock.
Event in = eventFromJson(open(sealedBytes));
if (mergeOne(myLog, in)) clock.receive(in.hlc);  // true == new → persist + fold

// 3. Fold to state (YOUR code): computeState(myLog) → whatever your view needs.

// 4. Catch-up: on join/reconnect (retried 0/3/10/25s), publish an initial
//    reconciliation message (bounded, single-segment):
transport.publish(topic, seal(syncEnvelope(catchup::buildInitial(myLog, myId))));

// 5. On receiving a SYNC message, step the state machine: serve exact events +
//    publish the reply reconciliation messages (all single-segment).
auto step = catchup::respond(myLog, msg, myId);
for (auto& e : step.serve)   transport.publish(topic, seal(eventToJson(e)));
for (auto& r : step.replies) transport.publish(topic, seal(syncEnvelope(r)));
```

`SYNC_REQ` is a control envelope — route it to `answerRequest`, never into your fold.

## What stays yours

- event `type` + `payload` schemas, and the fold `computeState` (ADR 0007);
- `seal` / `open` (ADR 0006) — logos-sync only handles plaintext `eventToJson` bytes;
- the catch-up **trigger** timing and the transport calls.

See [`../examples/scala.md`](../examples/scala.md) for a complete, real integration and
[`../docs/adr/`](../docs/adr/) for why it's shaped this way.
