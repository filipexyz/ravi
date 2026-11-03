// Node-only IdP fixture. Credentials arrive through stdin, never argv/env/stdout.
import Provider from "oidc-provider";
import { createServer } from "node:https";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";

let input = "";
for await (const chunk of process.stdin) { input += String(chunk); if (input.length > 8192) throw new Error("Fixture input bound"); }
const { root, password, clientSecret, callbackOrigin, email = "owner@example.invalid" } = JSON.parse(input) as { root: string; password: string; clientSecret: string; callbackOrigin?: string; email?: string }; input = "";
if (!/^[a-zA-Z0-9-]+@example\.invalid$/.test(email)) throw new Error("Synthetic email required");
if (!root.includes("/fleet-idp-test-") || password.length < 24 || clientSecret.length < 32) throw new Error("Fixture input rejected");
if (callbackOrigin && !/^https:\/\/127\.0\.0\.1:\d+$/.test(callbackOrigin)) throw new Error("Fixture callback must remain isolated");
const key = await readFile(join(root, "key.pem")), cert = await readFile(join(root, "cert.pem"));
let provider: Provider; let origin = ""; let logins = 0;
const server = createServer({ key, cert }, (request, response) => {
  void (async () => {
    const url = new URL(request.url!, origin);
    if (url.pathname === "/fixture/status") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ logins })); return; }
    if (["/callback/fleet", "/callback/setup"].includes(url.pathname)) { response.setHeader("Content-Type", "text/html"); response.setHeader("Referrer-Policy", "no-referrer"); response.end("<h1>Callback received</h1>"); return; }
    if (url.pathname.startsWith("/interaction/")) {
      const details = await provider.interactionDetails(request, response);
      if (details.prompt.name === "consent") {
        const grant = details.grantId ? await provider.Grant.find(details.grantId) : new provider.Grant({ accountId: details.session!.accountId, clientId: String(details.params.client_id) });
        if (!grant) throw new Error("Missing test grant");
        const missing = details.prompt.details.missingOIDCScope as string[] | undefined;
        if (missing?.length) grant.addOIDCScope(missing.join(" "));
        const claims = details.prompt.details.missingOIDCClaims as string[] | undefined;
        if (claims?.length) grant.addOIDCClaims(claims);
        await provider.interactionFinished(request, response, { consent: { grantId: await grant.save() } }, { mergeWithLastSubmission: true }); return;
      }
      if (request.method === "POST") {
        let body = ""; for await (const chunk of request) { body += String(chunk); if (body.length > 4096) throw new Error("Fixture input bound"); }
        const fields = new URLSearchParams(body);
        if (fields.get("email") !== email || fields.get("password") !== password) { response.statusCode = 403; response.end("Denied"); return; }
        logins++;
        await provider.interactionFinished(request, response, { login: { accountId: "local-owner" } }, { mergeWithLastSubmission: false }); return;
      }
      response.setHeader("Content-Type", "text/html");
      response.end('<!doctype html><html lang="en"><h1>Local test identity</h1><form method="post"><label>Email<input name="email" type="email" required></label><label>Password<input name="password" type="password" required></label><button>Sign in</button></form></html>'); return;
    }
    provider.callback()(request, response);
  })().catch(() => { if (!response.headersSent) response.statusCode = 500; response.end("Local IdP fixture failed"); });
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture listen failed");
origin = `https://127.0.0.1:${address.port}`;
try {
  const signing = await generateKeyPair("RS256", { extractable: true });
  provider = new Provider(origin, {
    clients: [{ client_id: "local-fleet", client_secret: clientSecret, redirect_uris: [`${callbackOrigin ?? origin}/callback/fleet`, `${callbackOrigin ?? origin}/callback/setup`, `${callbackOrigin ?? origin}/callback`],
      response_types: ["code"], grant_types: ["authorization_code"], token_endpoint_auth_method: "client_secret_post" }],
    jwks: { keys: [{ ...await exportJWK(signing.privateKey), use: "sig", alg: "RS256", kid: "local-test" }] },
    cookies: { keys: [randomBytes(32).toString("base64url")] },
    features: { devInteractions: { enabled: false } }, conformIdTokenClaims: false,
    claims: { openid: ["sub", "groups"], profile: ["name"], email: ["email", "email_verified"] },
    interactions: { url: (_context, interaction) => `/interaction/${interaction.uid}` },
    async findAccount(_context, id) { return id === "local-owner" ? { accountId: id, async claims() {
      return { sub: id, email, email_verified: true, name: "Local owner", groups: ["fleet-admins"] };
    } } : undefined; },
  });
  process.stdout.write(`${JSON.stringify({ origin })}\n`);
} catch { server.closeAllConnections(); server.close(); process.exitCode = 1; }
process.on("SIGTERM", () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
