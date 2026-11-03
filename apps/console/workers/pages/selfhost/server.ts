import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import worker, { type PagesWorkerEnv } from "../src/index";
import { S3Assets } from "./storage";
import { UsageOutbox } from "./outbox";
import { BunChatRooms, type RoomSocketData } from "./rooms";
import { CaptureBrowser } from "./browser";
import { BunVoiceSessions } from "./voice";

function setting(name: string, required = false) {
  const file = process.env[`${name}_FILE`]?.trim();
  const value = (file ? readFileSync(file, "utf8") : process.env[name])?.trim();
  if (required && !value) throw new Error(`Missing ${name}`);
  return value;
}

/** Private proxy is the only permitted transport caller. No bearer identity is inferred here. */
export function canonicalProxyRequest(request: Request): Request | Response {
  const host = request.headers.get("host") ?? "";
  const proto = request.headers.get("x-forwarded-proto");
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) || !["https", "http"].includes(proto ?? "")) {
    return new Response("Invalid proxy request", { status: 400 });
  }
  const url = new URL(request.url);
  url.protocol = `${proto}:`;
  url.host = host;
  url.port = "";
  const headers = new Headers(request.headers);
  // Provider-specific headers are never supplied by this self-hosted proxy.
  headers.delete("cf-visitor");
  headers.delete("cf-connecting-ip");
  return new Request(url, { method: request.method, headers, body: request.body, signal: request.signal, duplex: "half" } as RequestInit);
}

export function startPagesServer() {
  if (setting("RAVI_PAGES_TRUST_PROXY") !== "1") throw new Error("Private trusted TLS proxy is required (RAVI_PAGES_TRUST_PROXY=1)");
  const consoleUrl = setting("RAVI_CONSOLE_API_URL", true)!;
  const parsedConsole = new URL(consoleUrl);
  if (parsedConsole.protocol !== "https:" || parsedConsole.username || parsedConsole.password) throw new Error("Console canonical URL must use HTTPS");
  const stateDir = setting("RAVI_PAGES_STATE_DIR") ?? "/var/lib/ravi-pages";
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const databasePath = join(stateDir, "runtime.sqlite");
  const db = new Database(databasePath, { create: true, strict: true });
  chmodSync(databasePath, 0o600);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
  const rooms = new BunChatRooms();
  const aiEnabled = setting("RAVI_PAGES_AI_ENABLED") === "1";
  const env: PagesWorkerEnv = {
    RAVI_PAGES_AI_ENABLED: aiEnabled ? "1" : "0",
    RAVI_CONSOLE_API_URL: consoleUrl,
    RAVI_PAGES_CONTROL_TOKEN: setting("RAVI_PAGES_CONTROL_TOKEN", true),
    RAVI_PAGES_HOSTED_DOMAIN: setting("RAVI_PAGES_HOSTED_DOMAIN") ?? "ravi.page",
    RAVI_PAGES_CHAT_ORIGIN: setting("RAVI_PAGES_CHAT_ORIGIN"),
    RAVI_PAGES_ASSETS: new S3Assets({
      endpoint: setting("RAVI_PAGES_R2_ENDPOINT", true)!, bucket: setting("RAVI_PAGES_R2_BUCKET", true)!,
      accessKeyId: setting("RAVI_PAGES_R2_ACCESS_KEY_ID", true)!, secretAccessKey: setting("RAVI_PAGES_R2_SECRET_ACCESS_KEY", true)!,
      region: setting("RAVI_PAGES_R2_REGION") ?? "us-east-1",
    }),
    RAVI_PAGES_CHAT_ROOMS: rooms,
    RAVI_PAGES_BROWSER: new CaptureBrowser({ executablePath: setting("RAVI_PAGES_BROWSER_EXECUTABLE"), tlsSpki: setting("RAVI_PAGES_BROWSER_TLS_SPKI"), hostResolverRules: setting("RAVI_PAGES_BROWSER_HOST_RESOLVER_RULES") }),
    OPENAI_API_KEY: aiEnabled ? setting("OPENAI_API_KEY") : undefined,
  };
  const outbox = new UsageOutbox(db, (messages) => worker.queue({ messages: messages.map((body) => ({ body })) }, env));
  env.RAVI_PAGES_USAGE_QUEUE = outbox;
  const voice = aiEnabled ? new BunVoiceSessions(db, env) : undefined;
  env.RAVI_PAGE_CHAT_SESSIONS = voice;
  const pending = new Set<Promise<unknown>>();
  const server = Bun.serve<RoomSocketData>({
    hostname: setting("RAVI_PAGES_BIND") ?? "0.0.0.0",
    port: Number(setting("PORT") ?? 8787),
    maxRequestBodySize: 8 * 1024 * 1024,
    idleTimeout: 60,
    websocket: rooms.websocket,
    async fetch(request, server) {
      const canonical = canonicalProxyRequest(request);
      if (canonical instanceof Response) return canonical;
      const scope = { request, server, upgraded: false };
      return rooms.scope.run(scope, async () => {
        const response = await worker.fetch(canonical, env, { waitUntil(promise) {
          pending.add(promise);
          void promise.catch(() => console.error("pages_background_work_failed")).finally(() => pending.delete(promise));
        } });
        return scope.upgraded ? undefined : response;
      });
    },
    error() { return Response.json({ error: "pages_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } }); },
  });
  outbox.start();
  voice?.start();
  console.info("pages_runtime_started", { port: server.port, runtime: "bun", voiceConfigured: Boolean(env.OPENAI_API_KEY) });
  const stop = async () => {
    outbox.stop(); voice?.stop(); rooms.close(); await server.stop(true);
    await Promise.allSettled([...pending]);
    // SQLite commit is synchronous; pending metering already remains on disk.
  };
  return { server, stop, outbox, db };
}

if (import.meta.main) {
  const runtime = startPagesServer();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void runtime.stop().finally(() => process.exit(0)); });
}
