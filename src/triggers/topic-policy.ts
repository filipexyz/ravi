import { getTriggerTopicDiagnostic } from "./topic-catalog.js";

const BLOCKED_TRIGGER_TOPIC_PREFIXES = ["ravi.session."];

export function isBlockedTriggerTopic(topic: string): boolean {
  return BLOCKED_TRIGGER_TOPIC_PREFIXES.some((prefix) => topic.startsWith(prefix));
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
