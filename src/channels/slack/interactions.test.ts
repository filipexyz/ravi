import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { getDb } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  isAllowedSlackInteractionResponseUrl,
  respondToSlackInteraction,
  SLACK_RESPONSE_URL_MAX_USES,
  storeSlackInteractionResponseUrl,
} from "./interactions.js";

describe("Slack interaction response boundary", () => {
  it("allows only action and command response handles hosted by Slack", () => {
    expect(isAllowedSlackInteractionResponseUrl("https://hooks.slack.com/actions/T1/B1/secret")).toBe(true);
    expect(isAllowedSlackInteractionResponseUrl("https://hooks.slack.com/commands/T1/B1/secret")).toBe(true);
    expect(isAllowedSlackInteractionResponseUrl("http://hooks.slack.com/actions/T1/B1/secret")).toBe(false);
    expect(isAllowedSlackInteractionResponseUrl("https://hooks.slack.com.attacker.test/actions/T1/B1/secret")).toBe(
      false,
    );
    expect(isAllowedSlackInteractionResponseUrl("https://hooks.slack.com.attacker.test/commands/T1/B1/secret")).toBe(
      false,
    );
    expect(isAllowedSlackInteractionResponseUrl("https://hooks.slack.com/services/T1/B1/secret")).toBe(false);
    // The workspace host: Slack's Socket Mode example for a slash command shows rilke.slack.com.
    expect(
      isAllowedSlackInteractionResponseUrl(
        "https://rilke.slack.com/commands/T0SNL8S4S/37053613554/YMB2ZESDLNjNLqSFZ1quhNAh",
      ),
    ).toBe(true);
    expect(isAllowedSlackInteractionResponseUrl("https://rilke.slack.com/actions/T1/B1/secret")).toBe(true);
    expect(isAllowedSlackInteractionResponseUrl("https://slack.com/commands/T1/B1/secret")).toBe(false);
    expect(isAllowedSlackInteractionResponseUrl("https://a.b.slack.com/commands/T1/B1/secret")).toBe(false);
    expect(isAllowedSlackInteractionResponseUrl("https://-bad.slack.com/commands/T1/B1/secret")).toBe(false);
    expect(isAllowedSlackInteractionResponseUrl("https://evil-slack.com/commands/T1/B1/secret")).toBe(false);
    expect(isAllowedSlackInteractionResponseUrl("https://rilke.slack.com.attacker.test/commands/T1/B1/secret")).toBe(
      false,
    );
    expect(isAllowedSlackInteractionResponseUrl("https://rilke.slack.com:8443/commands/T1/B1/secret")).toBe(false);
    expect(isAllowedSlackInteractionResponseUrl("http://rilke.slack.com/commands/T1/B1/secret")).toBe(false);
    expect(isAllowedSlackInteractionResponseUrl("https://rilke.slack.com/api/chat.postMessage")).toBe(false);
    expect(isAllowedSlackInteractionResponseUrl("https://hooks.slack.com/commandsx/T1/B1/secret")).toBe(false);
    expect(isAllowedSlackInteractionResponseUrl("https://user:pass@hooks.slack.com/commands/T1/B1/secret")).toBe(false);
  });
});

describe("Slack response handle uses", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-slack-response-url-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  function handle(): string {
    return storeSlackInteractionResponseUrl({
      accountId: "ravi-slack",
      responseUrl: "https://hooks.slack.com/commands/T1/B1/secret",
    });
  }

  it("posts to the handle up to the five times Slack allows, and refuses the sixth before any request", async () => {
    const posted: string[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      posted.push(String(input));
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch);
    try {
      const responseUrlId = handle();

      for (let use = 1; use <= SLACK_RESPONSE_URL_MAX_USES; use += 1) {
        await expect(
          respondToSlackInteraction({ responseUrlId, payload: { text: `use ${use}` } }),
        ).resolves.toMatchObject({
          ok: true,
        });
      }
      await expect(respondToSlackInteraction({ responseUrlId, payload: { text: "one too many" } })).rejects.toThrow(
        /exhausted/,
      );

      expect(SLACK_RESPONSE_URL_MAX_USES).toBe(5);
      expect(posted).toHaveLength(5);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does not spend a use on a post Slack refused", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response("nope", { status: 500, statusText: "Server Error" })) as unknown as typeof fetch,
    );
    try {
      const responseUrlId = handle();

      for (let attempt = 0; attempt < SLACK_RESPONSE_URL_MAX_USES + 2; attempt += 1) {
        await expect(respondToSlackInteraction({ responseUrlId, payload: { text: "x" } })).rejects.toThrow(
          /failed: 500/,
        );
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });

  function usedCount(responseUrlId: string): number {
    return (
      getDb()
        .prepare("SELECT used_count AS used FROM slack_interaction_response_urls WHERE id = ?")
        .get(responseUrlId) as {
        used: number;
      }
    ).used;
  }

  it("gives the last use to one of two callers that arrive together", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    let posts = 0;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
      posts += 1;
      return new Promise<Response>((resolve) => resolvers.push(resolve));
    }) as unknown as typeof fetch);
    try {
      const responseUrlId = handle();
      getDb()
        .prepare("UPDATE slack_interaction_response_urls SET used_count = ? WHERE id = ?")
        .run(SLACK_RESPONSE_URL_MAX_USES - 1, responseUrlId);

      const first = respondToSlackInteraction({ responseUrlId, payload: { text: "first" } });
      // The first request is still in flight when the second caller arrives.
      await expect(respondToSlackInteraction({ responseUrlId, payload: { text: "second" } })).rejects.toThrow(
        /exhausted/,
      );
      resolvers[0]?.(new Response("ok", { status: 200 }));
      await expect(first).resolves.toMatchObject({ ok: true });

      expect(posts).toBe(1);
      expect(usedCount(responseUrlId)).toBe(SLACK_RESPONSE_URL_MAX_USES);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("keeps the use spent when the request fails without an answer, because Slack may have taken it", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("The operation timed out.");
    }) as unknown as typeof fetch);
    try {
      const responseUrlId = handle();

      await expect(respondToSlackInteraction({ responseUrlId, payload: { text: "x" } })).rejects.toThrow(/timed out/);

      expect(usedCount(responseUrlId)).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("gives the use back when Slack answers and refuses", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response("nope", { status: 404, statusText: "Not Found" })) as unknown as typeof fetch,
    );
    try {
      const responseUrlId = handle();

      await expect(respondToSlackInteraction({ responseUrlId, payload: { text: "x" } })).rejects.toThrow(/failed: 404/);

      expect(usedCount(responseUrlId)).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("abandons a post that never answers once its deadline passes", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      ((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          // A hung Slack host: nothing answers, and only the deadline's abort ends the request.
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted by the deadline")));
        })) as unknown as typeof fetch,
    );
    try {
      const responseUrlId = handle();

      await expect(respondToSlackInteraction({ responseUrlId, payload: { text: "x" }, timeoutMs: 30 })).rejects.toThrow(
        /aborted by the deadline/,
      );
      // Slack may have taken that post: the use stays spent.
      expect(usedCount(responseUrlId)).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
  }, 2_000);
});
