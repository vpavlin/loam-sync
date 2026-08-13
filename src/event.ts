// event.ts — the immutable event envelope + hybrid logical clock.
// TypeScript mirror of basecamp/logos_sync/event.hpp. The JSON shape is the wire
// contract; keep the two byte-identical (docs/PARITY.md, docs/adr/0005).

export interface HLC {
  wall: number; // ms timestamp — ORDERING ONLY, never a quantity
  ctr: number; // causal tiebreak within the same wall
  dev: string; // author device id — final total-order tiebreak
}

export interface Event {
  v: number;
  id: string; // UUIDv4 — idempotency/dedup key
  type: string; // app-defined
  hlc: HLC;
  dev: string; // author device id (== hlc.dev)
  payload: unknown; // app-defined; the engine never inspects it
}

/** Total order: wall → ctr → dev. Identical on every replica. */
export function compareHlc(a: HLC, b: HLC): number {
  if (a.wall !== b.wall) return a.wall < b.wall ? -1 : 1;
  if (a.ctr !== b.ctr) return a.ctr < b.ctr ? -1 : 1;
  if (a.dev !== b.dev) return a.dev < b.dev ? -1 : 1;
  return 0;
}

/** Stamps local events and advances past ingested ones. Prime it from your whole
 *  log on load, and call receive() for every event you ingest (docs/adr/0002). */
export class Clock {
  private wall = 0;
  private ctr = 0;
  constructor(private readonly dev: string) {}

  send(nowMs: number): HLC {
    if (nowMs > this.wall) {
      this.wall = nowMs;
      this.ctr = 0;
    } else {
      this.ctr += 1;
    }
    return { wall: this.wall, ctr: this.ctr, dev: this.dev };
  }

  receive(h: HLC): void {
    if (h.wall > this.wall) {
      this.wall = h.wall;
      this.ctr = h.ctr;
    } else if (h.wall === this.wall) {
      this.ctr = Math.max(this.ctr, h.ctr);
    }
  }
}
