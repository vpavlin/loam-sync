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
 *  log on load, and call receive() for every event you ingest (docs/adr/0002). */
export declare class Clock {
    private readonly dev;
    private wall;
    private ctr;
    constructor(dev: string);
    send(nowMs: number): HLC;
    receive(h: HLC): void;
}
