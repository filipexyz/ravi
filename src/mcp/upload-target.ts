/**
 * Upload targets of the MCP files extension (spec mcp, File Uploads).
 *
 * After the person confirmed a call, a server that takes files answers
 * `upload_required` with one target per file (`fileId`, `url`, `method`,
 * `headers`, `credentials`, `expiresAt`) and a `requestState`. The target is a
 * storage host, not the MCP server, so it gets nothing of Ravi's: no bearer,
 * no cookie, no Ravi header, only the headers the target lists.
 *
 * A target is used only when:
 * - its `fileId` names one file of this call, once;
 * - it is an absolute `https` URL without user info, whose host is a name
 *   (never an IP literal) that resolves only to public addresses; the
 *   connection is pinned to the address that was checked, so a second lookup
 *   cannot move it to a private one;
 * - `credentials` is `omit` (Ravi never sends the MCP server's credentials);
 * - the method is `PUT` (raw bytes) or `POST` with a `form` (multipart);
 * - it lists no credential or routing header (`authorization`, `cookie`,
 *   `proxy-authorization`, `forwarded`, `x-forwarded-*`, method overrides);
 *   headers the HTTP client sets itself (`host`, `content-length`,
 *   connection headers) are left out, every other listed header is sent as
 *   listed (so signed `x-amz-meta-*` headers pass);
 * - its `expiresAt`, when given, is still ahead.
 * A redirect is never followed: anything but a 2xx answer fails the upload.
 * Targets, headers and the request state never reach the model, the trace or
 * a log line; failure texts name the file, not the target.
 */

import { randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import type { McpStagedFile } from "./files.js";

/** The longest one upload may take. */
export const MCP_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_HEADERS = 32;
const MAX_HEADER_VALUE = 8 * 1024;
const MAX_FORM_FIELDS = 64;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const BAD_HEADER_VALUE = /[\r\n\0]/;
/** Headers that carry a credential or reroute a request: a target that lists one is refused. */
const REFUSED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "cookie2",
  "forwarded",
  "x-original-url",
  "x-rewrite-url",
  "x-http-method-override",
  "x-http-method",
  "x-method-override",
]);
/** Headers the HTTP client owns: never sent as the target lists them. */
const CLIENT_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "expect",
  "via",
  "date",
]);
/** A form upload sets its own body headers; a target that lists one of these with a form is refused. */
const FORM_BODY_HEADERS = new Set([
  "content-type",
  "content-encoding",
  "content-range",
  "content-digest",
  "repr-digest",
]);

export interface McpUploadForm {
  fields: Array<{ name: string; value: string }>;
  fileField: string;
}

export interface McpUploadTarget {
  fileId: string;
  url: URL;
  method: "PUT" | "POST";
  /** Lowercased names, as listed minus the client's own headers. */
  headers: Record<string, string>;
  form: McpUploadForm | null;
  /** Epoch ms, or null when the target gives none. */
  expiresAt: number | null;
}

export interface McpUploadPlan {
  file: McpStagedFile;
  target: McpUploadTarget;
}

export type McpUploadRefusal =
  | "invalid_target"
  | "unknown_file"
  | "not_https"
  | "userinfo"
  | "ip_literal"
  | "credentials"
  | "header"
  | "expired"
  | "private_address"
  | "unresolvable";

export type McpUploadValidation =
  | { ok: true; plans: McpUploadPlan[] }
  | { ok: false; code: McpUploadRefusal; reason: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function bad(code: McpUploadRefusal, reason: string): { ok: false; code: McpUploadRefusal; reason: string } {
  return { ok: false, code, reason };
}

function parseHeaders(
  raw: unknown,
  label: string,
): { ok: true; headers: Record<string, string> } | { ok: false; code: McpUploadRefusal; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, headers: {} };
  const record = asRecord(raw);
  if (!record) return bad("header", `The upload target of ${label} lists its headers in an unreadable shape.`);
  const entries = Object.entries(record);
  if (entries.length > MAX_HEADERS) return bad("header", `The upload target of ${label} lists too many headers.`);
  const headers: Record<string, string> = {};
  for (const [name, value] of entries) {
    const key = name.toLowerCase();
    if (!HEADER_NAME.test(name) || typeof value !== "string" || value.length > MAX_HEADER_VALUE) {
      return bad("header", `The upload target of ${label} lists a header Ravi cannot send.`);
    }
    if (BAD_HEADER_VALUE.test(value))
      return bad("header", `The upload target of ${label} lists a header Ravi cannot send.`);
    if (REFUSED_HEADERS.has(key) || key.startsWith("x-forwarded-")) {
      return bad(
        "credentials",
        `The upload target of ${label} asks for a credential or routing header; Ravi refuses it.`,
      );
    }
    if (CLIENT_HEADERS.has(key) || key.startsWith("proxy-") || key.startsWith("sec-")) continue;
    if (Object.hasOwn(headers, key)) return bad("header", `The upload target of ${label} lists a header twice.`);
    headers[key] = value;
  }
  return { ok: true, headers };
}

function parseForm(
  raw: unknown,
  label: string,
): { ok: true; form: McpUploadForm | null } | { ok: false; code: McpUploadRefusal; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, form: null };
  const record = asRecord(raw);
  const fields = record?.fields;
  const fileField = record?.fileField;
  if (!record || !Array.isArray(fields) || typeof fileField !== "string" || !fileField || fileField.length > 256) {
    return bad("invalid_target", `The upload target of ${label} describes its form in an unreadable shape.`);
  }
  if (fields.length > MAX_FORM_FIELDS) return bad("invalid_target", `The upload form of ${label} has too many fields.`);
  const out: McpUploadForm["fields"] = [];
  for (const field of fields) {
    const entry = asRecord(field);
    if (
      !entry ||
      typeof entry.name !== "string" ||
      typeof entry.value !== "string" ||
      !entry.name ||
      entry.name.length > 256 ||
      entry.value.length > MAX_HEADER_VALUE ||
      BAD_HEADER_VALUE.test(entry.name) ||
      entry.name.includes('"')
    ) {
      return bad("invalid_target", `The upload form of ${label} has a field Ravi cannot send.`);
    }
    out.push({ name: entry.name, value: entry.value });
  }
  if (BAD_HEADER_VALUE.test(fileField) || fileField.includes('"')) {
    return bad("invalid_target", `The upload form of ${label} names a file field Ravi cannot send.`);
  }
  return { ok: true, form: { fields: out, fileField } };
}

/**
 * Validate the targets of one `upload_required` answer against the files of
 * this call, before any byte leaves. The whole answer is refused when one
 * target is: no file is sent for a half-valid answer.
 */
export function validateMcpUploadTargets(
  uploads: readonly unknown[],
  files: readonly McpStagedFile[],
  now: number = Date.now(),
): McpUploadValidation {
  if (!Array.isArray(uploads) || uploads.length === 0) {
    return bad("invalid_target", "The MCP server asked for an upload without naming any target.");
  }
  if (uploads.length > files.length) {
    return bad("unknown_file", "The MCP server asked for more uploads than this call sends files.");
  }
  const byId = new Map(files.map((file) => [file.fileId, file]));
  const seen = new Set<string>();
  const plans: McpUploadPlan[] = [];
  for (const raw of uploads) {
    const record = asRecord(raw);
    if (!record) return bad("invalid_target", "The MCP server sent an upload target Ravi cannot read.");
    const fileId = record.fileId;
    const file = typeof fileId === "string" ? byId.get(fileId) : undefined;
    if (!file || seen.has(file.fileId)) {
      return bad("unknown_file", "The MCP server asked for an upload of a file this call does not send.");
    }
    seen.add(file.fileId);
    const label = JSON.stringify(file.name);
    if (record.path !== undefined) {
      return bad(
        "invalid_target",
        `The upload target of ${label} is a path on the MCP server; Ravi uploads only to an https URL.`,
      );
    }
    if (typeof record.url !== "string" || record.url.length > 8192) {
      return bad("invalid_target", `The upload target of ${label} has no URL.`);
    }
    let url: URL;
    try {
      url = new URL(record.url);
    } catch {
      // no-cause: the parser error would quote the target URL.
      return bad("invalid_target", `The upload target of ${label} is not a valid URL.`);
    }
    if (url.protocol !== "https:")
      return bad("not_https", `The upload target of ${label} is not https; Ravi refuses it.`);
    if (url.username || url.password) {
      return bad("userinfo", `The upload target of ${label} carries user info in its URL; Ravi refuses it.`);
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!host || isIP(host) !== 0) {
      return bad("ip_literal", `The upload target of ${label} names an IP address instead of a host; Ravi refuses it.`);
    }
    if (record.credentials !== "omit") {
      return bad(
        "credentials",
        `The upload target of ${label} does not say credentials "omit"; Ravi never sends the MCP server's credentials to storage.`,
      );
    }
    const method = record.method === undefined ? "PUT" : record.method;
    if (method !== "PUT" && method !== "POST") {
      return bad("invalid_target", `The upload target of ${label} asks for a method Ravi does not use.`);
    }
    const headers = parseHeaders(record.headers, label);
    if (!headers.ok) return headers;
    const form = parseForm(record.form, label);
    if (!form.ok) return form;
    if ((method === "POST") !== (form.form !== null)) {
      return bad("invalid_target", `The upload target of ${label} must pair POST with a form and PUT without one.`);
    }
    if (form.form && Object.keys(headers.headers).some((name) => FORM_BODY_HEADERS.has(name))) {
      return bad("header", `The upload form of ${label} lists a body header the form sets itself.`);
    }
    let expiresAt: number | null = null;
    if (record.expiresAt !== undefined && record.expiresAt !== null) {
      const at = typeof record.expiresAt === "string" ? Date.parse(record.expiresAt) : Number.NaN;
      if (!Number.isFinite(at)) return bad("invalid_target", `The upload target of ${label} has an unreadable expiry.`);
      if (at <= now) return bad("expired", `The upload target of ${label} has expired.`);
      expiresAt = at;
    }
    plans.push({
      file,
      target: { fileId: file.fileId, url, method, headers: headers.headers, form: form.form, expiresAt },
    });
  }
  return { ok: true, plans };
}

// ============================================================================
// Addresses
// ============================================================================

function ipv4Parts(address: string): number[] | null {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function publicIpv4(address: string): boolean {
  const p = ipv4Parts(address);
  if (!p) return false;
  const [a, b, c] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false; // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // shared address space (CGNAT)
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF assignments, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function expandIpv6(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) return null; // a scoped address is link-local by nature
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const dotted = text.slice(lastColon + 1);
  if (dotted.includes(".")) {
    const v4 = ipv4Parts(dotted);
    if (!v4) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest].map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN,
  );
  if (groups.length !== 8 || groups.some((group) => !Number.isFinite(group))) return null;
  if (tail.length) groups.splice(6, 2, ...tail);
  return groups;
}

function publicIpv6(address: string): boolean {
  const g = expandIpv6(address);
  if (!g) return false;
  if (g.every((part) => part === 0)) return false; // unspecified
  if (g.slice(0, 7).every((part) => part === 0) && g[7] === 1) return false; // loopback
  // IPv4-mapped and IPv4-compatible: judged as the IPv4 address they carry.
  if (g.slice(0, 5).every((part) => part === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return publicIpv4(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return false; // NAT64
  if ((g[0]! & 0xfe00) === 0xfc00) return false; // unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return false; // link-local
  if ((g[0]! & 0xffc0) === 0xfec0) return false; // site-local (deprecated)
  if ((g[0]! & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1]! < 0x0200) return false; // IETF protocol assignments (Teredo, benchmarking, ORCHID)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2002) return false; // 6to4
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false; // discard-only
  return true;
}

/** Whether an address is a public unicast address (no private, loopback, link-local or special-purpose range). */
export function isPublicMcpUploadAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return publicIpv4(address);
  if (family === 6) return publicIpv6(address);
  return false;
}

export interface McpResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type McpUploadLookup = (host: string) => Promise<McpResolvedAddress[]>;

/** The system resolver, every address of the name. */
export const systemMcpUploadLookup: McpUploadLookup = (host) =>
  new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 })));
    });
  });

/** Resolve a target host: every address must be public, and the first one is used. */
export async function resolveMcpUploadHost(
  host: string,
  lookup: McpUploadLookup = systemMcpUploadLookup,
): Promise<{ ok: true; address: McpResolvedAddress } | { ok: false; code: McpUploadRefusal }> {
  let addresses: McpResolvedAddress[] = [];
  try {
    addresses = await lookup(host);
  } catch {
    // no-cause: the resolver error names the host; no address means the target could not be resolved.
    addresses = [];
  }
  if (!Array.isArray(addresses) || addresses.length === 0) return { ok: false, code: "unresolvable" };
  if (!addresses.every((entry) => entry && isPublicMcpUploadAddress(entry.address))) {
    return { ok: false, code: "private_address" };
  }
  return { ok: true, address: addresses[0]! };
}

// ============================================================================
// Sending
// ============================================================================

export interface McpUploadRequest {
  url: URL;
  method: "PUT" | "POST";
  headers: Record<string, string>;
  body: Uint8Array;
  /** The checked address the connection must use. */
  address: McpResolvedAddress;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Sends one upload and answers its HTTP status. Never follows a redirect. */
export type McpUploadTransport = (request: McpUploadRequest) => Promise<{ status: number }>;

/** Test seam: trust this certificate authority in the default transport. */
let testCa: string | null = null;
export function setMcpUploadTestCaForTests(ca: string | null): void {
  testCa = ca;
}

/**
 * The user agent of an upload: fixed, naming no runtime or version (the HTTP
 * client would otherwise name its own). A target that lists `user-agent`
 * sends its own value instead.
 */
export const MCP_UPLOAD_USER_AGENT = "Ravi";

/**
 * The default transport: one HTTPS request, the TLS name checked against the
 * URL's host, the connection pinned to the checked address, no agent (no
 * pooled connection, no proxy), and no redirect handling (Node never follows
 * one). The answer body is read and dropped, capped. Besides the listed
 * headers it sends only what the HTTP client needs: `host`,
 * `content-length`, `accept` for any type (set here, so it does not depend
 * on the runtime) and the fixed user agent; never a credential or a cookie.
 */
export const httpsMcpUploadTransport: McpUploadTransport = (request) =>
  new Promise((resolve, reject) => {
    const pinned = request.address;
    const req = httpsRequest(
      {
        protocol: "https:",
        host: request.url.hostname,
        servername: request.url.hostname.replace(/^\[|\]$/g, ""),
        port: request.url.port ? Number.parseInt(request.url.port, 10) : 443,
        path: `${request.url.pathname}${request.url.search}`,
        method: request.method,
        headers: {
          accept: "*/*",
          "user-agent": MCP_UPLOAD_USER_AGENT,
          ...request.headers,
          "content-length": String(request.body.byteLength),
        },
        agent: false,
        timeout: request.timeoutMs,
        ...(testCa ? { ca: testCa } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        lookup: ((_host: string, options: { all?: boolean } | undefined, callback: (...args: unknown[]) => void) => {
          if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
          else callback(null, pinned.address, pinned.family);
        }) as never,
      },
      (response) => {
        let read = 0;
        response.on("data", (chunk: Buffer) => {
          read += chunk.byteLength;
          if (read > 64 * 1024) response.destroy();
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0 }));
        response.on("close", () => resolve({ status: response.statusCode ?? 0 }));
        // no-cause: the answer's status is already known; a body error after it changes nothing.
        response.on("error", () => resolve({ status: response.statusCode ?? 0 }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("upload timed out")));
    req.on("error", reject);
    req.end(Buffer.from(request.body.buffer, request.body.byteOffset, request.body.byteLength));
  });

/** A multipart body (RFC 7578): fields in order, the file last. */
export function mcpUploadMultipart(
  form: McpUploadForm,
  file: Pick<McpStagedFile, "name" | "mimeType" | "bytes">,
): { body: Uint8Array; contentType: string } {
  const boundary = `ravi-${randomBytes(24).toString("hex")}`;
  const parts: Buffer[] = [];
  for (const field of form.fields) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`,
        "utf8",
      ),
    );
  }
  const filename = (file.name || "file").replace(/["\r\n\\]/g, "_");
  const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType) ? file.mimeType : "application/octet-stream";
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${form.fileField}"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
      "utf8",
    ),
  );
  parts.push(Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  return { body: new Uint8Array(Buffer.concat(parts)), contentType: `multipart/form-data; boundary=${boundary}` };
}

export interface PerformMcpUploadsDeps {
  transport?: McpUploadTransport;
  lookup?: McpUploadLookup;
  now?: () => number;
  /** When the call's budget ends (epoch ms). */
  deadline: number;
  signal?: AbortSignal;
}

export type McpUploadOutcome =
  | { ok: true; files: number; bytes: number }
  | {
      ok: false;
      code: McpUploadRefusal | "failed" | "timeout" | "cancelled";
      reason: string;
      files: number;
      bytes: number;
    };

/**
 * Send each planned file, one at a time. Stops at the first failure: the
 * caller then does not send the retry, so the server runs nothing.
 */
export async function performMcpUploads(
  plans: readonly McpUploadPlan[],
  deps: PerformMcpUploadsDeps,
): Promise<McpUploadOutcome> {
  const now = deps.now ?? Date.now;
  const transport = deps.transport ?? httpsMcpUploadTransport;
  let files = 0;
  let bytes = 0;
  for (const plan of plans) {
    const label = JSON.stringify(plan.file.name);
    const fail = (code: Exclude<McpUploadOutcome, { ok: true }>["code"], reason: string): McpUploadOutcome => ({
      ok: false,
      code,
      reason,
      files,
      bytes,
    });
    if (deps.signal?.aborted) return fail("cancelled", `The upload of ${label} was cancelled before it started.`);
    const at = now();
    if (plan.target.expiresAt !== null && plan.target.expiresAt <= at) {
      return fail("expired", `The upload target of ${label} expired before the upload started.`);
    }
    const remaining = deps.deadline - at;
    if (remaining <= 0) return fail("timeout", `No time was left to upload ${label}.`);
    const resolved = await resolveMcpUploadHost(plan.target.url.hostname, deps.lookup);
    if (!resolved.ok) {
      return fail(
        resolved.code,
        resolved.code === "private_address"
          ? `The upload target of ${label} resolves to a private or special address; Ravi refuses it.`
          : `The upload target of ${label} could not be resolved.`,
      );
    }
    let body = plan.file.bytes;
    const headers = { ...plan.target.headers };
    if (plan.target.form) {
      const multipart = mcpUploadMultipart(plan.target.form, plan.file);
      body = multipart.body;
      headers["content-type"] = multipart.contentType;
    }
    let status: number;
    try {
      ({ status } = await transport({
        url: plan.target.url,
        method: plan.target.method,
        headers,
        body,
        address: resolved.address,
        timeoutMs: Math.min(remaining, MCP_UPLOAD_TIMEOUT_MS),
        ...(deps.signal ? { signal: deps.signal } : {}),
      }));
    } catch {
      // no-cause: transport errors can quote the target URL; the file name is what the caller sees.
      if (deps.signal?.aborted) return fail("cancelled", `The upload of ${label} was cancelled.`);
      return fail("failed", `The upload of ${label} failed before the storage answered.`);
    }
    if (status < 200 || status >= 300) {
      return fail(
        "failed",
        status >= 300 && status < 400
          ? `The storage answered the upload of ${label} with a redirect (HTTP ${status}); Ravi does not follow it.`
          : `The storage refused the upload of ${label} (HTTP ${status}).`,
      );
    }
    files++;
    bytes += plan.file.size;
  }
  return { ok: true, files, bytes };
}
