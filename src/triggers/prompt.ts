import { findTriggerTopicCatalogEntry } from "./topic-catalog.js";
import { resolveTemplate } from "./template.js";
import type { Trigger } from "./types.js";

export interface TriggerPromptEvent {
  topic: string;
  data: unknown;
}

type TriggerPromptSource = Pick<Trigger, "name" | "topic" | "message" | "messageSource" | "messageTemplateId">;

function getTemplateData(eventData: unknown): Record<string, unknown> {
  const data = eventData as Record<string, unknown> | undefined;
  return (data?.data as Record<string, unknown> | undefined) ?? data ?? {};
}

export function usesCatalogMessageTemplate(
  trigger: Pick<Trigger, "topic" | "message" | "messageSource" | "messageTemplateId">,
): boolean {
  if (trigger.messageSource === "catalog") return true;

  const entry = findTriggerTopicCatalogEntry(trigger.topic);
  const template = entry?.messageTemplate?.template;
  return !!template && trigger.message.trim() === template.trim();
}

/** A debounced fire: every event of the burst, oldest first (see debounce.ts). */
export interface TriggerPromptBatch {
  events: TriggerPromptEvent[];
  omitted: number;
}

/** A value longer than this is cut in the compact rendering. */
const COMPACT_VALUE_MAX = 500;
/** Lines of compact data per event; the rest is summarized as one line. */
const COMPACT_MAX_LINES = 40;
/** Nested objects deeper than this are rendered as JSON on one line. */
const COMPACT_MAX_DEPTH = 3;
/** `{{data}}` alone (not `{{data.<path>}}`) asks for the full event. */
const FULL_EVENT_PLACEHOLDER = /\{\{\s*data\s*\}\}/g;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A watch event (`ravi.watch.*`): the useful part is its `payload`, the rest is envelope. */
function isWatchEnvelope(data: unknown): data is Record<string, unknown> & {
  subject: string;
  payload: Record<string, unknown>;
} {
  return (
    isPlainObject(data) &&
    data.version === 1 &&
    typeof data.subject === "string" &&
    typeof data.eventId === "string" &&
    isPlainObject(data.payload)
  );
}

/**
 * Every line break a reader could take for a new line (`\n`, `\r`, vertical tab,
 * form feed, NEL, U+2028, U+2029), with the blanks around it.
 */
const LINE_BREAKS = /\s*[\n\r\v\f\u0085\u2028\u2029]+\s*/g;
/** Other control characters: they carry nothing a reader needs and can redraw a terminal. */
const OTHER_CONTROLS = /[\u0000-\u0008\u000e-\u001f\u007f]/g;

/**
 * Text from the event on one line, cut at the value cap. Keys and values both
 * go through here: event data must never start a line of its own in the
 * prompt, where it could pass for a header such as `[System] ...`.
 */
function compactScalar(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  const oneLine = text.replace(LINE_BREAKS, " ⏎ ").replace(OTHER_CONTROLS, "");
  return oneLine.length > COMPACT_VALUE_MAX ? `${oneLine.slice(0, COMPACT_VALUE_MAX)}…` : oneLine;
}

function flattenLines(value: unknown, prefix: string, depth: number, out: string[]): void {
  if (value === undefined || value === null || value === "") return;
  if (isPlainObject(value) && depth < COMPACT_MAX_DEPTH) {
    for (const [key, child] of Object.entries(value)) {
      const safeKey = compactScalar(key);
      flattenLines(child, prefix ? `${prefix}.${safeKey}` : safeKey, depth + 1, out);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return;
    const scalars = value.every((item) => item === null || typeof item !== "object");
    out.push(`${prefix}: ${scalars ? compactScalar(value.join(", ")) : compactScalar(value)}`);
    return;
  }
  out.push(`${prefix || "value"}: ${compactScalar(value)}`);
}

/**
 * One event as `key: value` lines.
 *
 * A watch event shows its subject, when it happened, its payload and its links;
 * ids, dedupe key, source and delivery stay out (they repeat the payload or matter
 * to nobody reading the turn). Any other event is its data, flattened.
 */
export function compactEventLines(data: unknown): string[] {
  const lines: string[] = [];
  if (isWatchEnvelope(data)) {
    const watchName = typeof data.watchName === "string" ? data.watchName : undefined;
    lines.push(`subject: ${compactScalar(watchName ? `${data.subject} (${watchName})` : data.subject)}`);
    const when = typeof data.occurredAt === "string" ? data.occurredAt : undefined;
    if (when) lines.push(`at: ${compactScalar(when)}`);
    flattenLines(data.payload, "", 0, lines);
    if (Array.isArray(data.links)) {
      for (const link of data.links) {
        if (isPlainObject(link) && typeof link.url === "string" && link.url) {
          const label = typeof link.label === "string" && link.label ? `${link.label} ` : "";
          lines.push(`link: ${compactScalar(`${label}${link.url}`)}`);
        }
      }
    }
  } else {
    flattenLines(data, "", 0, lines);
  }
  if (lines.length > COMPACT_MAX_LINES) {
    const omitted = lines.length - COMPACT_MAX_LINES;
    return [
      ...lines.slice(0, COMPACT_MAX_LINES),
      `(${omitted} more lines; use {{data}} in the message for the full event)`,
    ];
  }
  return lines;
}

function indent(lines: string[]): string[] {
  return lines.map((line) => `  ${line}`);
}

/**
 * The message template resolves against `event` (the burst's last event for a
 * debounced fire); a batch of more than one event lists all of them.
 *
 * The event goes in as compact `key: value` lines. A message that writes
 * `{{data}}` gets the full event as JSON in that place instead, and then the
 * prompt carries no other copy of it.
 */
export function buildTriggerPrompt(
  trigger: TriggerPromptSource,
  event: TriggerPromptEvent,
  batch?: TriggerPromptBatch,
): string {
  const context = { topic: event.topic, data: getTemplateData(event.data) };
  // Resolve each piece of the message around `{{data}}`, then join them with the
  // event JSON: text inside the event (a comment that writes `{{topic}}`) is never
  // read as a placeholder.
  const pieces = trigger.message.split(FULL_EVENT_PLACEHOLDER);
  const wantsFullEvent = pieces.length > 1;
  const resolvedMessage = pieces
    .map((piece) => resolveTemplate(piece, context))
    .join(wantsFullEvent ? JSON.stringify(event.data, null, 2) : "");

  const header = [`[Trigger: ${trigger.name}]`, `Event: ${event.topic}`];
  const batched = batch && batch.events.length + batch.omitted > 1;

  if (batched) {
    const total = batch.events.length + batch.omitted;
    header.push(
      `Batch: ${total} events debounced into this fire${batch.omitted ? ` (oldest ${batch.omitted} omitted)` : ""}`,
    );
  }

  if (usesCatalogMessageTemplate(trigger) && !batched) {
    return [...header, "", resolvedMessage].join("\n");
  }
  if (wantsFullEvent && !batched) {
    return [...header, "", resolvedMessage].join("\n");
  }

  const data = batched
    ? [
        "Events:",
        ...batch.events.flatMap((item, index) => {
          const entry = `- ${index + 1}. ${compactScalar(item.topic)}`;
          // With `{{data}}` the last event is in the message as JSON: list it once.
          if (wantsFullEvent && index === batch.events.length - 1)
            return [`${entry} (full event below, in the message)`];
          return [entry, ...indent(compactEventLines(item.data))];
        }),
      ]
    : ["Data:", ...indent(compactEventLines(event.data))];
  return [...header, ...data, "", resolvedMessage].join("\n");
}
