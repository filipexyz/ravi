import * as oidc from "openid-client";
import { z } from "zod";
import { getOidcConfig, type OidcConfig } from "./oidc-config";
import type { OidcTransaction } from "./oidc-transaction";
import { constrainedOidcFetch } from "@/server/console/fleet/oidc-network";

const claimsSchema = z.object({
  iss: z.string(), sub: z.string().min(1), email: z.string().email(),
  email_verified: z.literal(true), name: z.string().optional(),
  groups: z.array(z.string().max(200)).max(200).optional(),
});
export type OidcVerifiedIdentity = { issuer: string; subject: string; email: string; name: string; emailVerified: true; groups?: string[] };

let cached: { key: string; client: Promise<oidc.Configuration> } | undefined;

export function oidcClient(config = getOidcConfig()) {
  const cacheKey = JSON.stringify([config.issuer, config.clientId, config.clientSecret, config.generation, config.networkPolicy]);
  if (cached?.key === cacheKey) return cached.client;
  const client = oidc.discovery(new URL(config.issuer), config.clientId, config.clientSecret,
    oidc.ClientSecretPost(config.clientSecret), { timeout: 10, execute: [oidc.enableNonRepudiationChecks],
      ...(config.networkPolicy ? { [oidc.customFetch]: constrainedOidcFetch(config.issuer, config.networkPolicy.allowPrivate) } : {}) });
  cached = { key: cacheKey, client };
  client.catch(() => { if (cached?.client === client) cached = undefined; });
  return client;
}

export function verifiedOidcIdentity(claims: unknown, issuer: string): OidcVerifiedIdentity {
  const result = claimsSchema.safeParse(claims);
  if (!result.success || result.data.iss !== issuer) throw new Error("OIDC identity claims rejected.");
  return { issuer, subject: result.data.sub, email: result.data.email.trim().toLowerCase(),
    name: result.data.name?.trim() || result.data.email, emailVerified: true, groups: result.data.groups ?? [] };
}

export async function beginOidcLogin(returnTo: string, config = getOidcConfig(), callbackPath = "/callback") {
  const client = await oidcClient(config);
  const transaction: OidcTransaction = {
    verifier: oidc.randomPKCECodeVerifier(), state: oidc.randomState(), nonce: oidc.randomNonce(), returnTo,
  };
  const url = oidc.buildAuthorizationUrl(client, {
    redirect_uri: `${config.origin}${callbackPath}`, response_type: "code", scope: "openid profile email",
    code_challenge: await oidc.calculatePKCECodeChallenge(transaction.verifier),
    code_challenge_method: "S256", state: transaction.state, nonce: transaction.nonce,
  });
  if (config.networkPolicy && url.origin !== new URL(config.issuer).origin) throw new Error("OIDC authorization origin rejected.");
  return { transaction, url };
}

export async function completeOidcLogin(url: URL, transaction: OidcTransaction, config: OidcConfig, callbackPath = "/callback") {
  if (url.origin !== config.origin || url.pathname !== callbackPath) throw new Error("OIDC callback origin rejected.");
  const tokens = await oidc.authorizationCodeGrant(await oidcClient(config), url, {
    expectedState: transaction.state, expectedNonce: transaction.nonce,
    pkceCodeVerifier: transaction.verifier, idTokenExpected: true,
  });
  // openid-client validates issuer, audience, expiry, nonce, state, PKCE and signature.
  // No access, refresh or ID token is persisted or sent to UI components.
  return verifiedOidcIdentity(tokens.claims(), config.issuer);
}

export async function oidcLogoutUrl(config: OidcConfig) {
  const url = oidc.buildEndSessionUrl(await oidcClient(config), {
    client_id: config.clientId,
    post_logout_redirect_uri: `${config.origin}/login?auth=signed-out`,
  });
  if (config.networkPolicy && url.origin !== new URL(config.issuer).origin) throw new Error("OIDC logout origin rejected.");
  return url;
}
