export interface Identity {
    secret: Uint8Array;
    K: Uint8Array;
    Ke: Uint8Array;
    fpBytes: Uint8Array;
}
/** Derive the household identity from a 32-byte secret, for an app `domain`. Pure.
 *  Byte-identical to each app's legacy deriveIdentity when domain is that app's name. */
export declare function deriveIdentity(secret: Uint8Array, domain: string): Identity;
export declare function topicFor(id: Identity, domain: string, epoch?: number): string;
/** Deterministic per-event nonce (ADR 0011). */
export declare function nonceFor(id: Identity, domain: string, eventId: string): Uint8Array;
/** Seal with the DETERMINISTIC id-derived nonce. Re-sealing the same event ↦ identical bytes. */
export declare function seal(id: Identity, domain: string, eventId: string, plaintext: Uint8Array, topic: string): Uint8Array;
/** Inverse of seal(). Throws if the tag doesn't verify. The nonce still travels on the wire,
 *  so a legacy (random-nonce) message opens unchanged — fully backward-compatible. */
export declare function open(id: Identity, sealed: Uint8Array, topic: string): Uint8Array;
