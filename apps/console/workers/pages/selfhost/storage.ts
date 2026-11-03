import { AwsClient } from "aws4fetch";
import type { R2BucketLike, R2ObjectBody } from "../src/index";

export type S3Config = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region?: string };

/** Private path-style S3 transport. Policy and immutable keys remain in the handler/Console. */
export class S3Assets implements R2BucketLike {
  private readonly client: AwsClient;
  private readonly endpoint: URL;
  constructor(private readonly config: S3Config) {
    this.endpoint = new URL(config.endpoint);
    if (!["https:", "http:"].includes(this.endpoint.protocol) || this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash) {
      throw new Error("pages_storage_endpoint_invalid");
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) throw new Error("pages_storage_bucket_invalid");
    this.client = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, region: config.region ?? "us-east-1", service: "s3", retries: 2 });
  }

  private url(key: string): URL {
    if (!key || key.startsWith("/") || key.includes("\\") || key.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("pages_storage_key_invalid");
    const url = new URL(this.endpoint);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(this.config.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
    return url;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const response = await this.client.fetch(this.url(key), { method: "GET", redirect: "error" });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`pages_storage_get_${response.status}`); }
    const customMetadata: Record<string, string> = {};
    response.headers.forEach((value, name) => { if (name.startsWith("x-amz-meta-")) customMetadata[name.slice(11)] = value; });
    return {
      body: response.body,
      httpMetadata: {
        contentType: response.headers.get("content-type") ?? undefined,
        cacheControl: response.headers.get("cache-control") ?? undefined,
        contentEncoding: response.headers.get("content-encoding") ?? undefined,
        contentLanguage: response.headers.get("content-language") ?? undefined,
      },
      customMetadata,
    };
  }

  async put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream | string, options?: Parameters<NonNullable<R2BucketLike["put"]>>[2]): Promise<void> {
    // Capture outputs are bounded upstream. This adapter also accepts streams with
    // a bounded buffer, since S3 signing needs a known payload length/hash.
    const body = await boundedBytes(value, 32 * 1024 * 1024);
    const headers = new Headers({ "content-length": String(body.byteLength) });
    if (options?.httpMetadata?.contentType) headers.set("content-type", options.httpMetadata.contentType);
    if (options?.httpMetadata?.cacheControl) headers.set("cache-control", options.httpMetadata.cacheControl);
    for (const [name, val] of Object.entries(options?.customMetadata ?? {})) {
      if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error("pages_storage_metadata_invalid");
      headers.set(`x-amz-meta-${name}`, val);
    }
    const response = await this.client.fetch(this.url(key), { method: "PUT", body, headers, redirect: "error" });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`pages_storage_put_${response.status}`);
  }
}

async function boundedBytes(value: ArrayBuffer | ArrayBufferView | ReadableStream | string, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof value === "string") return boundedBytes(new TextEncoder().encode(value), limit);
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    if (value.byteLength > limit) throw new Error("pages_storage_body_too_large");
    return new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = value.getReader();
  try {
    for (;;) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > limit) throw new Error("pages_storage_body_too_large");
      chunks.push(chunk);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
