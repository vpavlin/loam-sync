# Example: Scala (shared calendar) on logos-sync

Scala is the first consumer. It's a good reference because its envelope was *already*
identical to the library's — adopting logos-sync was mostly **deleting** code.

## Before → after

| concern | before (bespoke) | after (logos-sync) |
|---|---|---|
| `Event`, `HLC`, `compareHlc`, `mergeEvents` | hand-written in `scala_engine.hpp` | `#include <logos_sync.hpp>`; alias into `scala::` |
| catch-up request | `sendSyncReq()` — a bare `SYNC_REQ`, **once** at `onReady` | `catchup::buildRequest(log)`, published on a **0/3/10/25 s** retry |
| catch-up serve | `serveLog()` — re-broadcast the **whole** log | `catchup::answerRequest(log, req).serve` — **only the delta** |
| convergence test | none | inherits the library's + a scala-fold test |

The fold (`foldCalendar`), the event types (`cal.meta` / `event.put` / `event.del`),
storage (sqlite), and AES-256-GCM seal/open **stay in scala** (ADR 0006, 0007).

## The type alias

```cpp
// scala_engine.hpp
#include <logos_sync.hpp>
namespace scala {
  using logos_sync::Event;
  using logos_sync::HLC;
  using logos_sync::compareHlc;
  using logos_sync::mergeEvents;
  using logos_sync::eventToJson;
  using logos_sync::eventFromJson;
  // scala keeps its own: ET:: constants, foldCalendar(...)
}
```

Everything downstream (`CalendarSync`, `ScalaImpl`) keeps compiling against `scala::Event`.

## The catch-up wiring (`ScalaImpl`)

```cpp
// SYNC_REQ carries the id-summary now (was empty).
void ScalaImpl::sendSyncReq(const std::string& calId) {
  auto req = logos_sync::catchup::buildRequest(m_store->log(calId));
  Event e = mkEvent(ET::SYNC_REQ, req);          // {have:[...]}
  m_sync->sendEvent(calId, eventToJson(e).dump());
}

// On receiving a SYNC_REQ: serve only the delta, and pull if we're behind.
void ScalaImpl::onSyncReq(const std::string& calId, const json& reqPayload) {
  auto ans = logos_sync::catchup::answerRequest(m_store->log(calId), reqPayload);
  if (rateOk(calId)) for (auto& ev : ans.serve) m_sync->sendEvent(calId, eventToJson(ev).dump());
  if (!ans.iLack.empty()) sendSyncReq(calId);     // converge our side too
}

// Reliable trigger: onReady fires it, then a QTimer retries.
onReady = [this]{
  for (auto& c : m_store->calendars()) sendSyncReq(c.id);
  for (int ms : {3000, 10000, 25000}) scheduleOnce(ms, [this]{ for (auto& c : m_store->calendars()) sendSyncReq(c.id); });
};
```

No periodic full re-broadcast; the hub needs no self-drive tick (ADR 0003, 0004).

## Result

- Fresh Basecamp joins → one `SYNC_REQ(have:[])` → hub serves the whole calendar, once.
- Basecamp offline two minutes → `SYNC_REQ(have:[most ids])` → hub serves only the few
  missed events.
- Steady state → zero backfill traffic.
