export interface HLC {
    wall: number;
    ctr: number;
    dev: string;
}
export interface Event {
    v: number;
    id: string;
    type: string;
    hlc: HLC;
    dev: string;
    payload: unknown;
    pub?: string;
    sig?: string;
}
/** Total order: wall → ctr → dev. Identical on every replica. */
export declare function compareHlc(a: HLC, b: HLC): number;
/** Stamps local events and advances past ingested ones. Prime it from your whole
 *  log on load, and call receive() for every event you ingest (docs/adr/0002).
 *
 *  send() takes the wall time explicitly (`send(nowMs)`) OR uses the clock's own
 *  time source when called with no argument (`send()`) — the source is injectable
 *  via the constructor (default Date.now), which keeps tests deterministic. */
export declare class Clock {
    private readonly dev;
    private readonly now;
    private wall;
    private ctr;
    constructor(dev: string, now?: () => number);
    send(nowMs?: number): HLC;
    /** Observe a received event's HLC (no counter bump — send() owns the bump). */
    receive(h: HLC): void;
    /** Prime from an existing log at boot/join so the next send() sorts after every
     *  event already held. Observe-only (take the max), equivalent to receive() over
     *  each event's HLC. Call once after loading the persisted log. */
    primeFrom(log: Array<{
        hlc?: HLC;
    }>): this;
}
