import { afterEach, describe, expect, it } from "bun:test";
import { startKnowledgeCuratorRunner, stopKnowledgeCuratorRunner } from "./curator/runner.js";
import {
  DEFAULT_KNOWLEDGE_LEADER_RUNNERS,
  knowledgeLeaderRunnersStarted,
  startKnowledgeLeaderRunners,
  stopKnowledgeLeaderRunners,
  type KnowledgeLeaderRunner,
} from "./runners.js";

afterEach(() => {
  stopKnowledgeLeaderRunners();
});

function fakeRunners(log: string[], failing?: string): KnowledgeLeaderRunner[] {
  return ["index", "curator", "mirror", "digest"].map((name) => ({
    name,
    start: () => {
      log.push(`start:${name}`);
      if (name === failing) throw new Error("boom");
    },
    stop: () => {
      log.push(`stop:${name}`);
    },
  }));
}

describe("knowledge leader runners", () => {
  it("groups the index, curator, mirror and digest runners", () => {
    expect(DEFAULT_KNOWLEDGE_LEADER_RUNNERS.map((runner) => runner.name)).toEqual([
      "index",
      "curator",
      "mirror",
      "digest",
    ]);
  });

  it("starts and stops the nightly curator through the curator runner", () => {
    const curator = DEFAULT_KNOWLEDGE_LEADER_RUNNERS.find((runner) => runner.name === "curator");
    expect(curator?.start).toBe(startKnowledgeCuratorRunner);
    expect(curator?.stop).toBe(stopKnowledgeCuratorRunner);
  });

  it("starts the four runners once; a second call is a no-op; stop stops them", () => {
    const log: string[] = [];
    const runners = fakeRunners(log);
    startKnowledgeLeaderRunners(runners);
    startKnowledgeLeaderRunners(runners);
    expect(log).toEqual(["start:index", "start:curator", "start:mirror", "start:digest"]);
    expect(knowledgeLeaderRunnersStarted()).toBe(true);

    stopKnowledgeLeaderRunners();
    stopKnowledgeLeaderRunners();
    expect(log.slice(4)).toEqual(["stop:index", "stop:curator", "stop:mirror", "stop:digest"]);
    expect(knowledgeLeaderRunnersStarted()).toBe(false);
  });

  it("keeps starting the others when one runner throws", () => {
    const log: string[] = [];
    startKnowledgeLeaderRunners(fakeRunners(log, "curator"));
    expect(log).toEqual(["start:index", "start:curator", "start:mirror", "start:digest"]);
  });
});
