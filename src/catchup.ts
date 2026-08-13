// catchup.ts — the catch-up (backfill) protocol. Mirror of
// basecamp/logos_sync/catchup.hpp. See that file for the full rationale
// (docs/adr/0004): SDS heals live drops, not cold-start history, so a joining or
// returning peer publishes an id-summary and gets served ONLY the delta.
import { Event } from "./event.js";

/** The id-set a requester publishes: "here's what I have; send me the rest."
 *  A fresh peer sends `have: []` and receives the whole log. */
export function buildRequest(have: Event[]): { have: string[] } {
  return { have: have.map((e) => e.id).filter(Boolean) };
}

export interface Answer {
  serve: Event[]; // events to publish back (the requester lacks these)
  iLack: string[]; // ids the requester has that WE lack → fire our own request
}

/** Response to a SYNC_REQ summary: serve = myLog \ have; iLack = have \ myLog-ids.
 *  Serving `serve` catches the requester up; a non-empty `iLack` means we should
 *  send our OWN request, which converges both peers from one exchange. */
export function answerRequest(myLog: Event[], req: { have?: string[] }): Answer {
  const have = new Set(req.have ?? []);
  const mine = new Set(myLog.map((e) => e.id));
  return {
    serve: myLog.filter((e) => !have.has(e.id)),
    iLack: [...have].filter((id) => !mine.has(id)),
  };
}
