import { Event } from "./event.js";
export interface Item {
    wall: number;
    id: string;
}
/** Project events into the canonical reconciliation order. */
export declare function toItems(events: Event[]): Item[];
export interface Diff {
    aNeeds: string[];
    bNeeds: string[];
    rounds: number;
    controlBytes: number;
}
/** Reconcile two event sets → exact symmetric difference. aNeeds = ids A lacks
 *  (B has); bNeeds = ids B lacks (A has). See reconcile.hpp for the algorithm. */
export declare function reconcile(eventsA: Event[], eventsB: Event[], { threshold, buckets }?: {
    threshold?: number;
    buckets?: number;
}): Diff;
/** The range fingerprint of a set of ids — exposed so the parity test can check
 *  it byte-for-byte against the C++ mirror. */
export declare function fingerprintIds(ids: string[]): string;
