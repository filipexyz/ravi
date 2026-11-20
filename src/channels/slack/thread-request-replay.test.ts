import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDb } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { runThreadMutation } from "../../threads/schema-fence.js";
import {
  createSlackThreadLifecycle,
  findRecentSlackThreadRequest,
  getSlackThreadLifecycle,
} from "./thread-lifecycle-store.js";
import {
  SLACK_THREAD_REPLAY_WINDOW_MS,
  slackThreadRequestIdForKey,
  slackThreadRequestMatches,
} from "./thread-request-identity.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-slack-thread-replay-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const PARENT = "agent:main:slack:ravi-slack:D1";
const ASKER = "agent:main:slack:ravi-slack:D1";

function request(
  requestId: string,
  overrides: Partial<Parameters<typeof createSlackThreadLifecycle>[0]> = {},
): ReturnType<typeof createSlackThreadLifecycle> {
  return createSlackThreadLifecycle({
    requestId,
    parentSessionKey: PARENT,
    parentSessionName: "main-slack",
    initiatorSessionKey: ASKER,
    initiatorSessionName: "main-slack",
    accountId: "ravi-slack",
    instanceId: "ravi-slack",
    platformChatId: "D1",
    rootCanonicalChatId: "chat_root",
    initialPrompt: "Investigate the branch",
    ...overrides,
  });
}

describe("slackThreadRequestIdForKey", () => {
  it("is the same id for the same parent and key, and a different one for another parent or key", () => {
    const id = slackThreadRequestIdForKey(PARENT, "fix-origin");
    expect(slackThreadRequestIdForKey(PARENT, "fix-origin")).toBe(id);
    expect(slackThreadRequestIdForKey("agent:main:slack:ravi-slack:C2", "fix-origin")).not.toBe(id);
    expect(slackThreadRequestIdForKey(PARENT, "fix-origin-2")).not.toBe(id);
  });

  it("turns any text into an id that is safe as a lifecycle row and outbound job key", () => {
    for (const key of ["a b", "with:colons:and/slashes", "'quoted' \"text\"", "ação — 修复", "x".repeat(200)]) {
      expect(slackThreadRequestIdForKey(PARENT, key)).toMatch(/^slack-thread:key-[0-9a-f]{32}$/);
    }
  });

  it("does not let a key borrow another parent's prefix", () => {
    expect(slackThreadRequestIdForKey("a", "b\0c")).not.toBe(slackThreadRequestIdForKey("a\0b", "c"));
  });
});

describe("slackThreadRequestMatches", () => {
  const stored = {
    initialPrompt: "Investigate the branch",
    modelOverride: "gpt-5.6",
    providerOverride: "codex",
    effortOverride: "high",
    thinkingLevel: "normal",
  };

  it("matches the same request, ignoring surrounding whitespace and treating empty as unset", () => {
    expect(
      slackThreadRequestMatches(stored, {
        initialPrompt: "  Investigate the branch\n",
        modelOverride: " gpt-5.6 ",
        providerOverride: "codex",
        effortOverride: "high",
        thinkingLevel: "normal",
      }),
    ).toBe(true);
    expect(slackThreadRequestMatches({ initialPrompt: "x" }, { initialPrompt: "x", modelOverride: "  " })).toBe(true);
  });

  it.each([
    ["message", { initialPrompt: "Investigate another branch" }],
    ["model", { modelOverride: "gpt-6-astra" }],
    ["provider", { providerOverride: "claude" }],
    ["effort", { effortOverride: "ultra" }],
    ["thinking", { thinkingLevel: "verbose" }],
  ])("does not match when the %s differs", (_name, change) => {
    expect(slackThreadRequestMatches(stored, { ...stored, ...change })).toBe(false);
  });

  it("does not match an option that is set against one that was never set", () => {
    expect(slackThreadRequestMatches({ initialPrompt: "x" }, { initialPrompt: "x", modelOverride: "gpt-5.6" })).toBe(
      false,
    );
    expect(slackThreadRequestMatches({ initialPrompt: "x", modelOverride: "gpt-5.6" }, { initialPrompt: "x" })).toBe(
      false,
    );
  });
});

describe("createSlackThreadLifecycle with a request id that already exists", () => {
  it("keeps the stored request and returns it, so a repeat cannot rewrite what was accepted", () => {
    const id = slackThreadRequestIdForKey(PARENT, "k1");
    const first = request(id, { initialPrompt: "First message", requestedBy: "Luís", modelOverride: "gpt-5.6" });
    const repeat = request(id, { initialPrompt: "Another message", requestedBy: "Someone", modelOverride: "other" });

    expect(repeat).toEqual(first);
    expect(repeat).toMatchObject({ initialPrompt: "First message", requestedBy: "Luís", modelOverride: "gpt-5.6" });
    const rows = getDb().prepare("SELECT COUNT(*) AS n FROM slack_thread_lifecycle").get() as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe("findRecentSlackThreadRequest", () => {
  const now = 1_800_000_000_000;
  const since = now - SLACK_THREAD_REPLAY_WINDOW_MS;
  const identity = { initialPrompt: "Investigate the branch" };
  const find = (override: Partial<Parameters<typeof findRecentSlackThreadRequest>[0]> = {}) =>
    findRecentSlackThreadRequest({
      parentSessionKey: PARENT,
      initiatorSessionKey: ASKER,
      identity,
      since,
      ...override,
    });

  it("finds the request the same asker made for the same parent with the same content inside the window", () => {
    request("slack-thread:a", { createdAt: now - 5_000 });
    expect(find()?.requestId).toBe("slack-thread:a");
  });

  it("returns the newest of several matching requests", () => {
    request("slack-thread:old", { createdAt: now - 60_000 });
    request("slack-thread:new", { createdAt: now - 10_000 });
    expect(find()?.requestId).toBe("slack-thread:new");
  });

  it("does not return a request older than the window", () => {
    request("slack-thread:old", { createdAt: since - 1 });
    expect(find()).toBeNull();
    request("slack-thread:edge", { createdAt: since });
    expect(find()?.requestId).toBe("slack-thread:edge");
  });

  it.each([
    ["another parent", { parentSessionKey: "agent:main:slack:ravi-slack:C2" }],
    ["another asker", { initiatorSessionKey: "agent:main:slack:ravi-slack:C9" }],
    ["another message", { identity: { initialPrompt: "Something else" } }],
    ["another model", { identity: { initialPrompt: "Investigate the branch", modelOverride: "gpt-5.6" } }],
    ["another provider", { identity: { initialPrompt: "Investigate the branch", providerOverride: "codex" } }],
    ["another effort", { identity: { initialPrompt: "Investigate the branch", effortOverride: "high" } }],
    ["another thinking level", { identity: { initialPrompt: "Investigate the branch", thinkingLevel: "verbose" } }],
  ])("does not return a request for %s", (_name, override) => {
    request("slack-thread:a", { createdAt: now - 5_000 });
    expect(find(override)).toBeNull();
  });

  it("matches options exactly: a request with a model is not the one asked for without it", () => {
    request("slack-thread:model", { createdAt: now - 5_000, modelOverride: "gpt-5.6", providerOverride: "codex" });
    expect(find()).toBeNull();
    expect(
      find({
        identity: { initialPrompt: "Investigate the branch", modelOverride: "gpt-5.6", providerOverride: "codex" },
      })?.requestId,
    ).toBe("slack-thread:model");
  });

  it.each([
    ["queued", true],
    ["root_delivered", true],
    ["starting", true],
    ["open", true],
    ["closed", false],
    ["failed", false],
  ])("a thread in status %s is returned: %p", (status, returned) => {
    request("slack-thread:a", { createdAt: now - 5_000 });
    runThreadMutation(
      getDb(),
      "UPDATE slack_thread_lifecycle SET status = ? WHERE request_id = ?",
      status,
      "slack-thread:a",
    );
    expect(find()?.requestId ?? null).toBe(returned ? "slack-thread:a" : null);
  });

  it("finds a request created by a key the same way, and a later repeat of it is the same row", () => {
    const id = slackThreadRequestIdForKey(PARENT, "k1");
    request(id, { createdAt: now - 5_000 });
    expect(find()?.requestId).toBe(id);
    expect(getSlackThreadLifecycle(id)?.requestId).toBe(id);
  });
});
