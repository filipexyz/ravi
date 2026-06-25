import { describe, expect, it } from "bun:test";
import { getTriggerTopicCatalog } from "../triggers/topic-catalog.js";
import { RAVI_EVENTS_SUBJECTS } from "./audit-stream.js";
import { getEventTopicRegistry } from "./topic-registry.js";

function topicPatternCovers(pattern: string, topic: string): boolean {
  const patternParts = pattern.split(".");
  const topicParts = topic.split(".");

  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    const topicPart = topicParts[index];
    if (patternPart === ">") return true;
    if (topicPart === undefined) return false;
    if (patternPart === "*") continue;
    if (patternPart !== topicPart) return false;
  }

  return patternParts.length === topicParts.length;
}

function topicPatternsOverlap(left: string, right: string): boolean {
  const leftTokens = left.split(".");
  const rightTokens = right.split(".");

  function overlaps(leftIndex: number, rightIndex: number): boolean {
    const leftToken = leftTokens[leftIndex];
    const rightToken = rightTokens[rightIndex];

    if (leftToken === undefined || rightToken === undefined) {
      return leftToken === rightToken || leftToken === ">" || rightToken === ">";
    }

    if (leftToken === ">" || rightToken === ">") return true;
    if (leftToken === "*" || rightToken === "*") return overlaps(leftIndex + 1, rightIndex + 1);
    if (leftToken !== rightToken) return false;
    return overlaps(leftIndex + 1, rightIndex + 1);
  }

  return overlaps(0, 0);
}

describe("event topic registry", () => {
  it("uses stable unique ids and patterns", () => {
    const entries = getEventTopicRegistry();

    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    expect(new Set(entries.map((entry) => entry.pattern)).size).toBe(entries.length);
    for (const entry of entries) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.owner.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it("maps every replay topic into the RAVI_EVENTS stream subjects", () => {
    for (const entry of getEventTopicRegistry().filter((candidate) => candidate.replay)) {
      expect(RAVI_EVENTS_SUBJECTS, entry.id).toContain(entry.pattern);
    }
  });

  it("maps every public trigger topic into the trigger catalog", () => {
    const catalog = getTriggerTopicCatalog();
    for (const entry of getEventTopicRegistry().filter((candidate) => candidate.triggerCatalog)) {
      expect(
        catalog.some((catalogEntry) => topicPatternsOverlap(entry.pattern, catalogEntry.pattern)),
        entry.id,
      ).toBe(true);
    }
  });

  it("classifies representative published topics", () => {
    const entries = getEventTopicRegistry();
    const publishedTopics = [
      "ravi.chats.pending",
      "ravi.tags.rule.applied",
      "ravi.inbox.mail.received",
      "ravi.console.inbox.item",
      "ravi.watch.github.release.published",
      "ravi.task.task_123.event",
      "ravi.tts",
      "ravi.tts.ready",
      "ravi.artifacts.completed",
      "ravi.meetings.artifact_generated",
      "ravi.session.prune.completed",
      "ravi.runtime.session_pool.gauge",
      "ravi.hooks.refresh",
      "ravi.rtk.rewrite",
      "ravi.work_objects.resolve",
      "omni.work_objects.resolve",
      "message.received.whatsapp-baileys.instance-1",
      "reaction.received.whatsapp-baileys.instance-1",
      "presence.typing",
      "chat.unread-updated",
      "instance.connected.whatsapp-baileys.instance-1",
    ];

    for (const topic of publishedTopics) {
      expect(
        entries.some((entry) => topicPatternCovers(entry.pattern, topic)),
        topic,
      ).toBe(true);
    }
  });
});
