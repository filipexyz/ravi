import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { CliApiError, cliApiError, cliErrorPayload } from "./errors";

type ReadJsonBodyOptions = {
  maxBytes?: number;
};

export function requestIdFrom(request: Request) {
  return request.headers.get("x-request-id") ?? randomUUID();
}

export async function readJsonBody(request: Request, requestId: string, options: ReadJsonBodyOptions = {}) {
  const maxBytes = options.maxBytes;
  const contentLength = request.headers.get("content-length");
  if (maxBytes && contentLength && Number(contentLength) > maxBytes) {
    throw cliApiError(413, "PAYLOAD_INVALID", "Request body is too large.");
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    throw cliApiError(400, "PAYLOAD_INVALID", "Request body must be valid JSON.");
  }

  if (maxBytes && new TextEncoder().encode(text).byteLength > maxBytes) {
    throw cliApiError(413, "PAYLOAD_INVALID", "Request body is too large.");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw cliApiError(400, "PAYLOAD_INVALID", "Request body must be valid JSON.");
  }
}

export function cliSuccess<T>(payload: T, init?: ResponseInit) {
  return NextResponse.json(payload, init);
}

export function cliNoContent() {
  return new NextResponse(null, { status: 204 });
}

export function cliFailure(error: unknown, requestId: string) {
  if (error instanceof CliApiError) {
    return NextResponse.json(cliErrorPayload(error, requestId), { status: error.status });
  }

  const fallback = cliApiError(500, "SERVER_UNAVAILABLE", "CLI API is temporarily unavailable.");
  console.error("CLI API failed", {
    requestId,
    name: error instanceof Error ? error.name : "unknown",
    message: error instanceof Error ? error.message : "unknown",
  });
  return NextResponse.json(cliErrorPayload(fallback, requestId), { status: fallback.status });
}
