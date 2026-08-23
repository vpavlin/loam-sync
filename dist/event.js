// event.ts — the immutable event envelope + hybrid logical clock.
// TypeScript mirror of basecamp/logos_sync/event.hpp. The JSON shape is the wire
// contract; keep the two byte-identical (docs/PARITY.md, docs/adr/0005).
/** Total order: wall → ctr → dev. Identical on every replica. */
export function compareHlc(a, b) {
    if (a.wall !== b.wall)
        return a.wall < b.wall ? -1 : 1;
    if (a.ctr !== b.ctr)
        return a.ctr < b.ctr ? -1 : 1;
    if (a.dev !== b.dev)
        return a.dev < b.dev ? -1 : 1;
    return 0;
}
/** Stamps local events and advances past ingested ones. Prime it from your whole
 *  log on load, and call receive() for every event you ingest (docs/adr/0002).
 *
 *  send() takes the wall time explicitly (`send(nowMs)`) OR uses the clock's own
 *  time source when called with no argument (`send()`) — the source is injectable
 *  via the constructor (default Date.now), which keeps tests deterministic. */
export class Clock {
    dev;
    now;
    wall = 0;
    ctr = 0;
    constructor(dev, now = () => Date.now()) {
        this.dev = dev;
        this.now = now;
    }
    send(nowMs = this.now()) {
        if (nowMs > this.wall) {
            this.wall = nowMs;
            this.ctr = 0;
        }
        else {
            this.ctr += 1;
        }
        return { wall: this.wall, ctr: this.ctr, dev: this.dev };
    }
    /** Observe a received event's HLC (no counter bump — send() owns the bump). */
    receive(h) {
        if (h.wall > this.wall) {
            this.wall = h.wall;
            this.ctr = h.ctr;
        }
        else if (h.wall === this.wall) {
            this.ctr = Math.max(this.ctr, h.ctr);
        }
    }
    /** Prime from an existing log at boot/join so the next send() sorts after every
     *  event already held. Observe-only (take the max), equivalent to receive() over
     *  each event's HLC. Call once after loading the persisted log. */
    primeFrom(log) {
        for (const e of log || [])
            if (e && e.hlc)
                this.receive(e.hlc);
        return this;
    }
}
