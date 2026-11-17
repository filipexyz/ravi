/** Hashes the canonical UTF-8 bytes using the platform's SHA-256 implementation. */
export declare function digestSha256(bytes: Uint8Array): Promise<ArrayBuffer>;
