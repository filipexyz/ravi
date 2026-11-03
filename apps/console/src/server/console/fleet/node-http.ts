import { FleetError } from "./contract";
export const fleetJson = (value: unknown, status = 200) => Response.json(value, { status,
  headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } });
export function fleetFailure(error: unknown) {
  return fleetJson({ error: { code: error instanceof FleetError ? error.code : "fleet_unavailable" } }, error instanceof FleetError ? error.status : 503);
}
export async function boundedJson(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") throw new FleetError("invalid_request", 400);
  const reader = request.body?.getReader();
  if (!reader) throw new FleetError("invalid_request", 400);
  const parts: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.length; if (length > 65_536) throw new FleetError("request_too_large", 413);
      parts.push(part.value);
    }
    try { return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown; }
    catch { throw new FleetError("invalid_json", 400); }
  } finally { await reader.cancel().catch(() => {}); }
}
