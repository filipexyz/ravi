import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
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

  it("gives the post a deadline, so a hung Slack host cannot hold the caller", async () => {
    let signal: AbortSignal | null | undefined;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      signal = init?.signal;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch);
    try {
      await respondToSlackInteraction({ responseUrlId: handle(), payload: { text: "x" } });

      expect(signal).toBeInstanceOf(AbortSignal);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
