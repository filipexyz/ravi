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

export function buildTriggerPrompt(trigger: TriggerPromptSource, event: TriggerPromptEvent): string {
  const resolvedMessage = resolveTemplate(trigger.message, {
    topic: event.topic,
    data: getTemplateData(event.data),
  });

  const header = [`[Trigger: ${trigger.name}]`, `Event: ${event.topic}`];

  if (usesCatalogMessageTemplate(trigger)) {
    return [...header, "", resolvedMessage].join("\n");
  }

  return [...header, `Data: ${JSON.stringify(event.data, null, 2)}`, "", resolvedMessage].join("\n");
}
