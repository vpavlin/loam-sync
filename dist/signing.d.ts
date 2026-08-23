import type { Event } from "./event.js";
export declare function hex(b: Uint8Array): string;
export declare function fromHex(s: string): Uint8Array;
export declare function utf8Bytes(s: string): Uint8Array;
export declare function address(pubCompressed: Uint8Array): string;
export declare function canonicalMessage(domain: string, ev: any): string;
export interface Signer {
    publicKey(): Uint8Array;
    signDigest(digest32: Uint8Array): Uint8Array;
}
export declare class SoftwareSigner implements Signer {
    private readonly priv;
    private readonly pub;
    constructor(priv32: Uint8Array);
    publicKey(): Uint8Array;
    signDigest(d: Uint8Array): Uint8Array;
}
export interface AsyncSigner {
    publicKey(): Uint8Array;
    signDigest(digest32: Uint8Array): Promise<Uint8Array>;
}
export type CustodyMode = "tap-per-sign" | "delegated" | "exported";
export interface CustodyPolicy {
    mode: CustodyMode;
    ttlMinutes?: number;
    maxSigs?: number;
}
export interface DelegationCert {
    delegatePub: string;
    idPub: string;
    notAfter: number;
    maxSigs: number;
    scope: string;
    idSig: string;
}
export declare function canonicalCert(domain: string, c: DelegationCert): string;
export declare function verifyCert(domain: string, c: DelegationCert, atMs: number): boolean;
export declare function issueCert(idSigner: Signer, domain: string, delegatePub: string, opts?: {
    notAfter?: number;
    maxSigs?: number;
    scope?: string;
}): DelegationCert;
export declare function issueCertAsync(idSigner: AsyncSigner, domain: string, delegatePub: string, opts?: {
    notAfter?: number;
    maxSigs?: number;
    scope?: string;
}): Promise<DelegationCert>;
export declare function signEvent(signer: Signer, domain: string, ev: any, cert?: DelegationCert): Event;
export declare function signEventAsync(signer: AsyncSigner, domain: string, ev: any, cert?: DelegationCert): Promise<Event>;
export declare function verifyEvent(domain: string, ev: any): boolean;
export declare function isSigned(ev: any): boolean;
