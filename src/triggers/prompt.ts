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

/**
 * The message template resolves against `event` (the burst's last event for a
 * debounced fire); a batch of more than one event lists all of them.
 */
export function buildTriggerPrompt(
  trigger: TriggerPromptSource,
  event: TriggerPromptEvent,
  batch?: TriggerPromptBatch,
): string {
  const resolvedMessage = resolveTemplate(trigger.message, {
    topic: event.topic,
    data: getTemplateData(event.data),
  });

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

  const data = batched
    ? `Events: ${JSON.stringify(
        batch.events.map((item) => ({ topic: item.topic, data: item.data })),
        null,
        2,
      )}`
    : `Data: ${JSON.stringify(event.data, null, 2)}`;
  return [...header, data, "", resolvedMessage].join("\n");
}
