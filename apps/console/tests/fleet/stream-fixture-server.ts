// Test-only Node launcher. Real Next/auth/route: no module mocks or product hooks.
// Restrict outbound sockets to this cluster and the two disposable HTTPS servers.
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { writeFile } from "node:fs/promises";

const root = process.env.FLEET_STREAM_EVIDENCE;
const socket = process.env.PGHOST;
const origins = [process.env.RAVI_OIDC_ISSUER, process.env.NEXT_PUBLIC_CONSOLE_URL];
if (!root?.includes("/fleet-stream-browser-") || !socket?.includes("fleet-pg-test-") ||
    !origins.every(value => /^https:\/\/127\.0\.0\.1:\d+$/.test(value ?? ""))) throw new Error("Private stream fixture required");
const ports = origins.map(value => Number(new URL(value!).port));
const counts = { deniedSockets: 0, deniedFetches: 0, allowedSockets: 0,
  blockedFrameworkVersionChecks: 0, deniedFetchOrigins: [] as string[] };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === "object" && first !== null ? first as { path?: string; host?: string; hostname?: string; port?: number | string }
    : typeof first === "string" && !/^\d+$/.test(first) ? { path: first }
    : { port: Number(first), host: typeof args[1] === "string" ? args[1] : undefined };
  const allowed = options.path === `${socket}/.s.PGSQL.55439` ||
    ((options.host ?? options.hostname) === "127.0.0.1" && ports.includes(Number(options.port)));
  if (!allowed) { counts.deniedSockets++; throw new Error("Stream fixture outbound socket refused"); }
  counts.allowedSockets++;
  return Reflect.apply(connect, this, args);
} as typeof connect;
syncBuiltinESMExports();
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!origins.includes(url.origin)) {
    counts.deniedFetches++; counts.deniedFetchOrigins.push(url.origin);
    // Next dev's own version badge performs this metadata check. Still BLOCK it
    // before any socket; distinguish it from runtime/provider/unknown attempts.
    if (url.href === "https://registry.npmjs.org/-/package/next/dist-tags" &&
        new Error().stack?.includes("hot-reloader-shared-utils")) counts.blockedFrameworkVersionChecks++;
    throw new Error("Stream fixture outbound fetch refused");
  }
  return originalFetch(input, init);
}) as typeof fetch;
process.on("SIGTERM", () => { void writeFile(`${root}/network.json`, JSON.stringify(counts), { mode: 0o600 }); });
const launcher = new URL("./next-fixture-server.ts", import.meta.url).href;
await import(launcher);
