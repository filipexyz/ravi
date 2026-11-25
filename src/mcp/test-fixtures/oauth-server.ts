/**
 * An OAuth-protected MCP server for the login tests, after SDK probe d1: a
 * fake authorization server (metadata, dynamic registration, an authorize
 * endpoint that approves at once, a token endpoint for codes and refresh
 * tokens, an optional RFC 7009 revocation endpoint) and a resource server built with `@modelcontextprotocol/server`
 * 2.4.0 (protected resource metadata, bearer check, one tool that needs a
 * wider scope).
 *
 * Test-only: no product code imports this module.
 */

import { serve } from "bun";

import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  McpServer,
  OAuthError,
  OAuthErrorCode,
  oauthMetadataResponse,
  requireBearerAuth,
  requireScopes,
} from "@modelcontextprotocol/server";
import { z } from "zod";

export interface OAuthFixtureOptions {
  /** `dcr`: the server offers dynamic registration; `cimd`: it accepts a client metadata document URL as client id. */
  variant?: "dcr" | "cimd";
  /** Lifetime of an access token, in seconds. */
  expiresIn?: number;
  /** Hand out refresh tokens (default true). */
  refreshTokens?: boolean;
  /** Delay of a refresh-token answer (to hold two refreshers in contention). */
  refreshDelayMs?: number;
  /** The `iss` the authorize endpoint puts in its redirect (default: the real issuer). */
  callbackIssuer?: string;
  /** The `state` the authorize endpoint puts in its redirect (default: the one it was given). */
  callbackState?: string;
  /** The `authorization_endpoint` the metadata names (default: the fixture's own `/authorize`). */
  authorizationEndpoint?: string;
  /** Offer a revocation endpoint: `ok` revokes and answers 200, `fail` answers 503 (default: none offered). */
  revocation?: "ok" | "fail";
  /** The `revocation_endpoint` the metadata names (default: the fixture's own `/revoke`). */
  revocationEndpoint?: string;
}

export interface RevocationRequest {
  hint: string | null;
  clientId: string | null;
  contentType: string | null;
  /** Whether the token was one this server issued and still knew. */
  known: boolean;
}

export interface TokenRequest {
  grant: string;
  clientId: string;
  resource: string | null;
}

export interface OAuthFixture {
  /** The MCP endpoint. */
  url: string;
  issuer: string;
  /** Requests to the token endpoint, in order. */
  tokenRequests: TokenRequest[];
  /** Requests to the revocation endpoint, in order (no token in them). */
  revocations: RevocationRequest[];
  /** Tokens the revocation endpoint revoked. */
  revokedTokens: string[];
  registrations: number;
  /** Query parameters of each authorize request. */
  authorizations: Record<string, string>[];
  /** Bearer tokens the resource server saw. */
  bearers: string[];
  /** Issued access tokens (the test checks none leaks). */
  issuedTokens(): string[];
  /** An access token issued outside any flow (a bearer token for `auth bearer` rows). */
  mintAccessToken(scopes?: string[]): string;
  /** Forget every access token, as if they expired on the server. */
  revokeAccessTokens(): void;
  /** Refuse every refresh token from now on (invalid_grant). */
  revokeRefreshTokens(): void;
  setOptions(options: Partial<OAuthFixtureOptions>): void;
  /**
   * Act as the browser: open the authorization URL and return the redirect
   * location it answers with (the loopback callback with code and state).
   */
  approve(authorizationUrl: string): Promise<string>;
  close(): Promise<void>;
}

export function startOAuthFixture(initial: OAuthFixtureOptions = {}): OAuthFixture {
  let options: OAuthFixtureOptions = { variant: "dcr", expiresIn: 3600, refreshTokens: true, ...initial };
  const accessTokens = new Map<string, { scopes: string[]; clientId: string; exp: number }>();
  const refreshTokens = new Map<string, { scopes: string[]; clientId: string }>();
  const issued: string[] = [];
  const codeScopes = new Map<string, string[]>();
  const tokenRequests: TokenRequest[] = [];
  const revocations: RevocationRequest[] = [];
  const revokedTokens: string[] = [];
  const authorizations: Record<string, string>[] = [];
  const bearers: string[] = [];
  let registrations = 0;
  let counter = 0;

  let authPort = 0;
  const authServer = serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      const issuer = `http://127.0.0.1:${authPort}`;
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer,
          authorization_endpoint: options.authorizationEndpoint ?? `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          ...(options.revocation ? { revocation_endpoint: options.revocationEndpoint ?? `${issuer}/revoke` } : {}),
          ...(options.variant === "dcr"
            ? { registration_endpoint: `${issuer}/register` }
            : { client_id_metadata_document_supported: true }),
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          authorization_response_iss_parameter_supported: true,
        });
      }
      if (url.pathname === "/register" && request.method === "POST") {
        registrations++;
        const body = (await request.json()) as Record<string, unknown>;
        return Response.json({ ...body, client_id: `dcr-client-${registrations}` }, { status: 201 });
      }
      if (url.pathname === "/authorize") {
        const params = Object.fromEntries(url.searchParams);
        authorizations.push(params);
        const to = new URL(params.redirect_uri ?? "");
        const code = `code-${params.code_challenge?.slice(0, 12)}`;
        codeScopes.set(code, (params.scope ?? "mcp:read").split(" ").filter(Boolean));
        to.searchParams.set("code", code);
        to.searchParams.set("state", options.callbackState ?? params.state ?? "");
        to.searchParams.set("iss", options.callbackIssuer ?? issuer);
        return Response.redirect(to.toString(), 302);
      }
      if (url.pathname === "/revoke" && request.method === "POST") {
        const contentType = request.headers.get("content-type");
        const form = await request.formData();
        const token = String(form.get("token") ?? "");
        const known = accessTokens.has(token) || refreshTokens.has(token);
        revocations.push({
          hint: form.get("token_type_hint") ? String(form.get("token_type_hint")) : null,
          clientId: form.get("client_id") ? String(form.get("client_id")) : null,
          contentType,
          known,
        });
        if (options.revocation !== "ok") return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
        if (known) revokedTokens.push(token);
        accessTokens.delete(token);
        refreshTokens.delete(token);
        return new Response(null, { status: 200 });
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const form = await request.formData();
        const grant = String(form.get("grant_type"));
        const clientId = String(form.get("client_id") ?? "");
        tokenRequests.push({ grant, clientId, resource: form.get("resource") ? String(form.get("resource")) : null });
        let scopes = ["mcp:read"];
        if (grant === "refresh_token") {
          if (options.refreshDelayMs) await new Promise((resolve) => setTimeout(resolve, options.refreshDelayMs));
          const known = refreshTokens.get(String(form.get("refresh_token")));
          if (!known) return Response.json({ error: "invalid_grant" }, { status: 400 });
          scopes = known.scopes;
        } else if (grant !== "authorization_code") {
          return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
        } else {
          scopes = codeScopes.get(String(form.get("code"))) ?? scopes;
        }
        counter++;
        const access = `at-${counter}-${crypto.randomUUID()}`;
        accessTokens.set(access, { scopes, clientId, exp: Math.floor(Date.now() / 1000) + 3600 });
        issued.push(access);
        const body: Record<string, unknown> = {
          access_token: access,
          token_type: "Bearer",
          expires_in: options.expiresIn,
          scope: scopes.join(" "),
        };
        if (options.refreshTokens !== false) {
          const refresh = `rt-${counter}-${crypto.randomUUID()}`;
          refreshTokens.set(refresh, { scopes, clientId });
          issued.push(refresh);
          body.refresh_token = refresh;
        }
        return Response.json(body);
      }
      return new Response("not found", { status: 404 });
    },
  });
  authPort = authServer.port as number;
  const issuer = `http://127.0.0.1:${authPort}`;

  const handler = createMcpHandler(
    () => {
      const mcp = new McpServer({ name: "oauth-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
      mcp.registerTool("whoami", { inputSchema: z.object({}) }, async (_args, ctx) => ({
        content: [{ type: "text", text: JSON.stringify({ clientId: ctx.http?.authInfo?.clientId }) }],
      }));
      mcp.registerTool(
        "admin",
        { inputSchema: z.object({}), scopeChallenge: requireScopes("mcp:admin") },
        async () => ({ content: [{ type: "text", text: "admin ok" }] }),
      );
      return mcp;
    },
    { onerror: () => {} },
  );
  let resourcePort = 0;
  const resourceServer = serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const resourceUrl = new URL(`http://127.0.0.1:${resourcePort}/mcp`);
      const metadata = oauthMetadataResponse(request, {
        oauthMetadata: {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          response_types_supported: ["code"],
        } as never,
        resourceServerUrl: resourceUrl,
        scopesSupported: ["mcp:read", "mcp:admin"],
        dangerouslyAllowInsecureIssuerUrl: true,
      });
      if (metadata) return metadata;
      const header = request.headers.get("authorization");
      if (header) bearers.push(header.replace(/^Bearer\s+/i, ""));
      const gate = requireBearerAuth({
        verifier: {
          async verifyAccessToken(token) {
            const known = accessTokens.get(token);
            if (!known) throw new OAuthError(OAuthErrorCode.InvalidToken, "unknown token");
            return {
              token,
              clientId: known.clientId,
              scopes: known.scopes,
              expiresAt: known.exp,
              resource: resourceUrl,
            };
          },
        },
        requiredScopes: ["mcp:read"],
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
        expectedResource: resourceUrl,
      });
      const auth = await gate(request);
      if (auth instanceof Response) return auth;
      return handler.fetch(request, { authInfo: auth });
    },
  });
  resourcePort = resourceServer.port as number;

  return {
    url: `http://127.0.0.1:${resourcePort}/mcp`,
    issuer,
    tokenRequests,
    revocations,
    revokedTokens,
    get registrations() {
      return registrations;
    },
    authorizations,
    bearers,
    issuedTokens: () => [...issued],
    mintAccessToken(scopes = ["mcp:read"]) {
      counter++;
      const access = `minted-${counter}-${crypto.randomUUID()}`;
      accessTokens.set(access, { scopes, clientId: "minted", exp: Math.floor(Date.now() / 1000) + 3600 });
      issued.push(access);
      return access;
    },
    revokeAccessTokens() {
      accessTokens.clear();
    },
    revokeRefreshTokens() {
      refreshTokens.clear();
    },
    setOptions(next) {
      options = { ...options, ...next };
    },
    async approve(authorizationUrl) {
      const response = await fetch(authorizationUrl, { redirect: "manual" });
      const location = response.headers.get("location");
      if (!location) throw new Error(`authorize answered ${response.status} without a redirect`);
      return location;
    },
    async close() {
      await handler.close();
      authServer.stop(true);
      resourceServer.stop(true);
    },
  };
}
