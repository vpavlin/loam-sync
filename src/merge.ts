// merge.ts — the CRDT merge: union event logs by id, order by HLC.
// Mirror of basecamp/logos_sync/merge.hpp. Idempotent + commutative + associative,
// so offline devices converge with no lost writes (docs/adr/0001).
import { Event, compareHlc } from "./event.js";

/** Union any number of logs by id (dedup), then sort by HLC. Pure. */
export function mergeEvents(...logs: Event[][]): Event[] {
  const byId = new Map<string, Event>();
  for (const log of logs)
    for (const e of log) if (e.id && !byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => compareHlc(a.hlc, b.hlc));
}

/** Merge one event into an already-merged log in place. Returns true if it was
 *  NEW (so the caller can skip re-persisting / re-broadcasting a duplicate). */
export function mergeOne(log: Event[], e: Event): boolean {
  if (!e.id) return false;
  if (log.some((x) => x.id === e.id)) return false; // dedup by id
  let i = log.length;
  while (i > 0 && compareHlc(log[i - 1].hlc, e.hlc) > 0) i--;
  log.splice(i, 0, e);
  return true;
}
