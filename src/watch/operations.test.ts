import { describe, expect, it } from "bun:test";
import { listWatchConnectors, resolveEventTypes } from "./connectors.js";
import { capabilityBlocker } from "./operations.js";

describe("watch operations", () => {
  it("blocks Console-reported unsupported event types before create", () => {
    const blocker = capabilityBlocker(
      {
        provider: "github",
        supportedEventTypes: ["watch.github.push.branch"],
        unsupportedEventTypes: ["watch.github.release.published"],
      },
      ["release.published"],
    );

    expect(blocker?.code).toBe("WATCH_UNSUPPORTED_EVENT");
    expect(blocker?.message).toContain("release.published");
    expect(blocker?.details).toMatchObject({
      requestedEventTypes: ["release.published"],
      unsupportedEventTypes: ["watch.github.release.published"],
    });
  });

  it("marks GitHub catalog support as current Console subset vs roadmap", () => {
    const github = listWatchConnectors("github")[0];
    expect(github?.defaultEventTypes).toEqual(["push.default_branch"]);
    expect(resolveEventTypes("github", undefined)).toEqual(["push.default_branch"]);

    const push = github?.eventTypes.find((eventType) => eventType.eventType === "push.default_branch");
    const release = github?.eventTypes.find((eventType) => eventType.eventType === "release.published");
    expect(push?.consoleSupport).toBe("supported");
    expect(release?.consoleSupport).toBe("roadmap");
  });
});
