import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Assets } from "./storage";
import { UsageOutbox } from "./outbox";
import { canonicalProxyRequest } from "./server";
import { CaptureBrowser } from "./browser";
import type { PagesUsageQueueMessage } from "../src/index";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

test("S3 adapter uses signed private path-style requests, preserves streaming bytes and metadata", async () => {
  const seen: Request[] = [];
  const objects = new Map<string, { bytes: ArrayBuffer; headers: Headers }>();
  const storage = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    seen.push(request);
    expect(request.headers.get("authorization")).toStartWith("AWS4-HMAC-SHA256 ");
    expect(request.headers.get("x-amz-date")).not.toBeNull();
    const key = new URL(request.url).pathname;
    if (request.method === "PUT") {
      const bytes = await request.arrayBuffer();
      expect(request.headers.get("content-length")).toBe(String(bytes.byteLength));
      objects.set(key, { bytes, headers: request.headers });
      return new Response(null, { status: 200 });
    }
    const object = objects.get(key);
    return object ? new Response(object.bytes, { headers: object.headers }) : new Response(null, { status: 404 });
  } });
  cleanups.push(() => { void storage.stop(true); });
  const assets = new S3Assets({ endpoint: storage.url.toString(), bucket: "pages-assets", accessKeyId: "synthetic-access", secretAccessKey: "synthetic-secret", region: "us-east-1" });
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("published bytes ç")); controller.close(); } });
  await assets.put("org/test/version/test/a b.html", stream, { httpMetadata: { contentType: "text/html; charset=utf-8", cacheControl: "private, no-store" }, customMetadata: { sha256: "synthetic-hash" } });
  const result = await assets.get("org/test/version/test/a b.html");
  expect(await new Response(result?.body).text()).toBe("published bytes ç");
  expect(result?.httpMetadata).toMatchObject({ contentType: "text/html; charset=utf-8", cacheControl: "private, no-store" });
  expect(result?.customMetadata?.sha256).toBe("synthetic-hash");
  expect(new URL(seen[0]!.url).pathname).toBe("/pages-assets/org/test/version/test/a%20b.html");
  expect(await assets.get("org/not-found")).toBeNull();
  await expect(assets.get("../escape")).rejects.toThrow("pages_storage_key_invalid");
});

test("S3 adapter never follows redirects with signed credentials and distinguishes denied from missing", async () => {
  const storage = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    return new URL(request.url).pathname.endsWith("denied") ? new Response(null, { status: 403 }) : Response.redirect("https://untrusted.invalid/", 302);
  } });
  cleanups.push(() => { void storage.stop(true); });
  const assets = new S3Assets({ endpoint: storage.url.toString(), bucket: "pages-assets", accessKeyId: "synthetic", secretAccessKey: "synthetic" });
  await expect(assets.get("denied")).rejects.toThrow("pages_storage_get_403");
  await expect(assets.get("redirect")).rejects.toThrow();
});

test("metering outbox survives process/database reopen and retries without changing idempotency", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pages-outbox-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true }));
  const path = join(dir, "outbox.sqlite");
  let now = 1000;
  let db = new Database(path);
  let deliveries = 0;
  const delivered: PagesUsageQueueMessage[] = [];
  const message: PagesUsageQueueMessage = { schemaVersion: 1, source: "pages_worker", requestId: "request-1", enqueuedAt: new Date(now).toISOString(), events: [] };
  const first = new UsageOutbox(db, async () => { deliveries++; throw new Error("Console unavailable"); }, () => now);
  await first.send(message);
  await first.flush();
  expect(first.counts()).toEqual({ pending: 1, failed: 0 });
  db.close();
  db = new Database(path);
  cleanups.push(() => db.close());
  const second = new UsageOutbox(db, async (messages) => { deliveries++; delivered.push(...messages); }, () => now);
  await second.flush();
  expect(deliveries).toBe(1); // backoff persisted too
  now += 3000;
  await second.flush();
  expect(delivered).toEqual([message]);
  expect(second.counts()).toEqual({ pending: 0, failed: 0 });
  await second.flush();
  expect(deliveries).toBe(2);
});

test("outbox exhausted retries are retained, not acknowledged/deleted", async () => {
  const db = new Database(":memory:");
  cleanups.push(() => db.close());
  const queue = new UsageOutbox(db, async () => { throw new Error("unavailable"); }, () => 1000);
  await queue.send({ schemaVersion: 1, source: "pages_worker", requestId: "request", enqueuedAt: new Date().toISOString(), events: [] });
  db.exec("UPDATE pages_usage_outbox SET attempts=99");
  await queue.flush();
  expect(queue.counts()).toEqual({ pending: 0, failed: 1 });
});

test("trusted proxy reconstruction retains canonical origin/body and discards CF hints", async () => {
  const request = new Request("http://pages:8787/_ravi/connectors/exec", { method: "POST", headers: { host: "site.pages.nba-console.localhost", "x-forwarded-proto": "https", "cf-visitor": '{"scheme":"http"}', "cf-connecting-ip": "untrusted", origin: "https://site.pages.nba-console.localhost" }, body: "synthetic" });
  const result = canonicalProxyRequest(request);
  expect(result).toBeInstanceOf(Request);
  const canonical = result as Request;
  expect(canonical.url).toBe("https://site.pages.nba-console.localhost/_ravi/connectors/exec");
  expect(canonical.headers.get("origin")).toBe("https://site.pages.nba-console.localhost");
  expect(canonical.headers.get("cf-visitor")).toBeNull();
  expect(canonical.headers.get("cf-connecting-ip")).toBeNull();
  expect(await canonical.text()).toBe("synthetic");
  expect((canonicalProxyRequest(new Request("http://pages/", { headers: { host: "site.pages.local" } })) as Response).status).toBe(400);
});

test("capture rejects broad/invalid TLS exceptions", () => {
  expect(() => new CaptureBrowser({ tlsSpki: "*" })).toThrow("pages_capture_tls_pin_invalid");
  expect(() => new CaptureBrowser({ tlsSpki: "a".repeat(43) + "=" })).not.toThrow();
});
