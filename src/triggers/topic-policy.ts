const BLOCKED_TRIGGER_TOPIC_PREFIXES = ["ravi.session."];

export function isBlockedTriggerTopic(topic: string): boolean {
  return BLOCKED_TRIGGER_TOPIC_PREFIXES.some((prefix) => topic.startsWith(prefix));
}

export function getBlockedTriggerTopicReason(topic: string): string | undefined {
  if (!isBlockedTriggerTopic(topic)) return undefined;
  return `Triggers cannot subscribe to '${topic}' because ravi.session.* topics are reserved and skipped by the trigger runner to prevent loops`;
}
