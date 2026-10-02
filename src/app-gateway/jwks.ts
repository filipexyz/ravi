/**
 * Console JWKS client for the Pages app gateway executor.
 *
 * Rules (Console `pages/app-gateway/relay` SPEC, Signing Keys And JWKS):
 * keep the last set fetched successfully; refresh it when older than 300 s;
 * on an unknown `kid` refetch at most once per 30 s; time out each fetch after
 * 5 s; when a refresh fails keep using the last good set for at most 3600 s
 * after its fetch, then fail closed. jose `createRemoteJWKSet` drops its set on
 * a failed reload, so the cached set is fed to `createLocalJWKSet` instead.
 */

import {
  createLocalJWKSet,
  errors as joseErrors,
  type FlattenedJWSInput,
  type JSONWebKeySet,
  type JWSHeaderParameters,
} from "jose";
import {
  JWKS_FETCH_TIMEOUT_MS,
  JWKS_MAX_BYTES,
  JWKS_REFRESH_AFTER_MS,
  JWKS_STALE_IF_ERROR_MS,
  JWKS_UNKNOWN_KID_COOLDOWN_MS,
} from "./constants.js";

export type JwksFetch = (url: string, init?: RequestInit) => Promise<Response>;

type LocalKeySet = ReturnType<typeof createLocalJWKSet>;

/** No usable key set, or an unknown `kid` whose refetch failed: `app_gateway_unavailable`. */
export class AppGatewayJwksUnavailableError extends Error {
  constructor(message = "Console JWKS is unavailable.") {
    super(message);
    this.name = "AppGatewayJwksUnavailableError";
  }
}

export interface AppGatewayJwksClientOptions {
  url: string;
  fetch?: JwksFetch;
  now?: () => number;
  fetchTimeoutMs?: number;
}

export class AppGatewayJwksClient {
  readonly url: string;
  private readonly fetchImpl: JwksFetch;
  private readonly now: () => number;
  private readonly fetchTimeoutMs: number;
  private keySet: LocalKeySet | null = null;
  private fetchedAt = 0;
  private lastFailedRefreshAt: number | null = null;
  private lastUnknownKidRefetchAt: number | null = null;
  private inflight: Promise<void> | null = null;

  constructor(options: AppGatewayJwksClientOptions) {
    this.url = options.url;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? JWKS_FETCH_TIMEOUT_MS;
  }

  /**
   * Key resolver for `jwtVerify`. Throws `AppGatewayJwksUnavailableError` when
   * no usable set exists, and jose's `JWKSNoMatchingKey` for a token whose
   * `kid` is not on the (refetched) set.
   */
  readonly resolveKey = async (header: JWSHeaderParameters, token: FlattenedJWSInput): Promise<CryptoKey> => {
    const keySet = await this.usableKeySet();
    try {
      return await keySet(header, token);
    } catch (error) {
      if (!(error instanceof joseErrors.JWKSNoMatchingKey)) throw error;
      const now = this.now();
      if (this.lastUnknownKidRefetchAt !== null && now - this.lastUnknownKidRefetchAt < JWKS_UNKNOWN_KID_COOLDOWN_MS) {
        throw error;
      }
      this.lastUnknownKidRefetchAt = now;
      try {
        await this.refresh();
      } catch {
        throw new AppGatewayJwksUnavailableError("Console JWKS refetch for an unknown key id failed.");
      }
      return (this.keySet ?? keySet)(header, token);
    }
  };

  private async usableKeySet(): Promise<LocalKeySet> {
    const now = this.now();
    if (this.keySet && now - this.fetchedAt < JWKS_REFRESH_AFTER_MS) return this.keySet;

    const staleUsable = this.keySet !== null && now - this.fetchedAt <= JWKS_STALE_IF_ERROR_MS;
    // While a stale set is still usable, do not hammer a failing Console on
    // every invoke: one refresh attempt per unknown-kid cooldown window.
    if (
      staleUsable &&
      this.lastFailedRefreshAt !== null &&
      now - this.lastFailedRefreshAt < JWKS_UNKNOWN_KID_COOLDOWN_MS
    ) {
      return this.keySet!;
    }
    try {
      await this.refresh();
      return this.keySet!;
    } catch {
      this.lastFailedRefreshAt = this.now();
      if (this.keySet && this.now() - this.fetchedAt <= JWKS_STALE_IF_ERROR_MS) return this.keySet;
      throw new AppGatewayJwksUnavailableError();
    }
  }

  private refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    const current = (async () => {
      try {
        const jwks = await this.fetchJwks();
        this.keySet = createLocalJWKSet(jwks);
        this.fetchedAt = this.now();
        this.lastFailedRefreshAt = null;
      } finally {
        this.inflight = null;
      }
    })();
    this.inflight = current;
    return current;
  }

  private async fetchJwks(): Promise<JSONWebKeySet> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) throw new Error(`JWKS fetch failed with HTTP ${response.status}.`);
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > JWKS_MAX_BYTES) throw new Error("JWKS response is too large.");
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > JWKS_MAX_BYTES) throw new Error("JWKS response is too large.");
      const parsed = JSON.parse(text) as unknown;
      const keys = (parsed as { keys?: unknown } | null)?.keys;
      if (!Array.isArray(keys) || !keys.every((key) => key && typeof key === "object" && !Array.isArray(key))) {
        throw new Error("JWKS response has no keys array.");
      }
      return { keys } as JSONWebKeySet;
    } finally {
      clearTimeout(timer);
    }
  }
}
