import { getTriggerTopicDiagnostic } from "./topic-catalog.js";

/**
 * The subjects that carry one person's answer to an MCP elicitation (the Slack
 * modal in ravi-channels to the waiting daemon). Answer values travel only
 * there, so no trigger is created on them or fires on them.
 */
const MCP_ELICITATION_TOPIC_PREFIX = "ravi.mcp.elicitation.";

const BLOCKED_TRIGGER_TOPIC_PREFIXES = ["ravi.session.", MCP_ELICITATION_TOPIC_PREFIX];

export function isBlockedTriggerTopic(topic: string): boolean {
  return BLOCKED_TRIGGER_TOPIC_PREFIXES.some((prefix) => topic.startsWith(prefix));
}

/**
 * Subjects that are the bus's own transport: session streams, request replies,
 * remote worker pipes, and the private answers of MCP elicitation.
 */
const INTERNAL_EVENT_TOPIC_PREFIXES = ["ravi.session.", "ravi._reply.", "ravi.worker.", MCP_ELICITATION_TOPIC_PREFIX];

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
  if (topic.startsWith(MCP_ELICITATION_TOPIC_PREFIX)) {
    return `Topic '${topic}' carries a person's private answer to an MCP elicitation. No trigger fires on ravi.mcp.elicitation.* subjects.`;
  }
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
