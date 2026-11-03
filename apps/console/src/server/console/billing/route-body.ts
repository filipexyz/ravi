import { type NextRequest, NextResponse } from "next/server";

const MAX_BODY_BYTES = 32_768;

/**
 * The body as text, read until it passes `maxBytes`: null when it is larger.
 * A declared Content-Length over the limit is refused before reading.
 */
export async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** The request's JSON body, or the error response to send instead. */
export async function readBillingJson(request: NextRequest): Promise<unknown> {
  let raw: string | null;
  try {
    raw = await readBoundedText(request, MAX_BODY_BYTES);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (raw === null) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  try {
    return raw.trim() ? (JSON.parse(raw) as unknown) : {};
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
}

export function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "no-store");
  return response;
}
