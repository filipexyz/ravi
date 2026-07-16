import { nats } from "../nats.js";
import { redactJson } from "../utils/redaction.js";

const MAX_OUTPUT_LENGTH = 1000;
const MAX_PAYLOAD_BYTES = 60000;

export function sanitizeRuntimeEventPayload(data: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactJson(data).value;
  return redacted && typeof redacted === "object" && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : { type: data.type ?? data.event ?? "unknown" };
}

/** Emit to NATS, truncating oversized payloads without dropping the event. */
export async function safeEmit(topic: string, data: Record<string, unknown>): Promise<void> {
  const safeData = sanitizeRuntimeEventPayload(data);
  let json = JSON.stringify(safeData);
  if (json.length <= MAX_PAYLOAD_BYTES) {
    await nats.emit(topic, safeData);
    return;
  }

  const truncated: Record<string, unknown> = { ...safeData, _truncated: true };
  for (const key of Object.keys(truncated)) {
    const val = truncated[key];
    if (typeof val === "string" && val.length > MAX_OUTPUT_LENGTH) {
      truncated[key] = `${val.slice(0, MAX_OUTPUT_LENGTH)}... [truncated]`;
    } else if (typeof val === "object" && val !== null) {
      const serialized = JSON.stringify(val);
      if (serialized.length > MAX_OUTPUT_LENGTH) {
        truncated[key] = `${serialized.slice(0, MAX_OUTPUT_LENGTH)}... [truncated]`;
      }
    }
  }

  json = JSON.stringify(truncated);
  if (json.length > MAX_PAYLOAD_BYTES) {
    await nats.emit(topic, { _truncated: true, type: safeData.type ?? safeData.event ?? "unknown" });
    return;
  }

  await nats.emit(topic, truncated);
}
