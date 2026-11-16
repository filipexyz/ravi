import { getTriggerTopicDiagnostic } from "./topic-catalog.js";

const BLOCKED_TRIGGER_TOPIC_PREFIXES = ["ravi.session."];

export function isBlockedTriggerTopic(topic: string): boolean {
  return BLOCKED_TRIGGER_TOPIC_PREFIXES.some((prefix) => topic.startsWith(prefix));
}

/** Subjects that are the bus's own transport: session streams, request replies and remote worker pipes. */
const INTERNAL_EVENT_TOPIC_PREFIXES = ["ravi.session.", "ravi._reply.", "ravi.worker."];

/**
 * True for an event no trigger fires on, whatever pattern delivered it. A
 * wildcard pattern such as `ravi.>` is not a blocked topic, so the pattern
 * check alone would hand a trigger the text a session streams.
 */
export function isInternalEventTopic(topic: string): boolean {
  return INTERNAL_EVENT_TOPIC_PREFIXES.some((prefix) => topic.startsWith(prefix));
}

export function getBlockedTriggerTopicReason(topic: string): string | undefined {
  if (!isBlockedTriggerTopic(topic)) return undefined;
  return `Topic '${topic}' is an internal session subject. The trigger runner skips ravi.session.* subscriptions to prevent loops.`;
}

export function getTriggerTopicWarnings(topic: string): string[] {
  const warnings: string[] = [];
  const blockedReason = getBlockedTriggerTopicReason(topic);
  if (blockedReason) warnings.push(blockedReason);

  const diagnostic = getTriggerTopicDiagnostic(topic);
  if (diagnostic) warnings.push(diagnostic.message);

  return warnings;
}
