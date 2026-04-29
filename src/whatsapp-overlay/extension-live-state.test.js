import { describe, expect, it } from "bun:test";

import {
  applyGatewayTopicEvent,
  isBusyLiveActivity,
  normalizeLiveState,
  parseLiveTopic,
} from "../../extensions/whatsapp-overlay/lib/live-state-model.js";
import { getLiveForSession } from "../../extensions/whatsapp-overlay/lib/live-state.js";

describe("whatsapp overlay extension live-state model", () => {
  it("parses session topics without assuming the session name has no dots", () => {
    expect(parseLiveTopic("ravi.session.dev.runtime")).toEqual({
      sessionName: "dev",
      kind: "runtime",
    });
    expect(parseLiveTopic("ravi.session.team.dev.runtime")).toEqual({
      sessionName: "team.dev",
      kind: "runtime",
    });
  });

  it("marks runtime prompt and terminal events as busy then idle", () => {
    const prompt = applyGatewayTopicEvent(undefined, {
      topic: "ravi.session.dev.runtime",
      timestamp: "2026-04-29T18:00:00.000Z",
      data: { type: "prompt.received", prompt: "revisa tudo" },
    });

    expect(prompt?.sessionName).toBe("dev");
    expect(prompt?.live.activity).toBe("thinking");
    expect(prompt?.live.summary).toBe("revisa tudo");
    expect(isBusyLiveActivity(prompt?.live.activity)).toBe(true);

    const terminal = applyGatewayTopicEvent(prompt?.live, {
      topic: "ravi.session.dev.runtime",
      timestamp: "2026-04-29T18:00:04.000Z",
      data: { type: "turn.complete" },
    });

    expect(terminal?.live.activity).toBe("idle");
    expect(terminal?.live.busySince).toBeUndefined();
  });

  it("uses response and tool events to drive the badge activity", () => {
    const tool = applyGatewayTopicEvent(undefined, {
      topic: "ravi.session.dev.tool",
      timestamp: "2026-04-29T18:00:00.000Z",
      data: { event: "start", toolName: "exec_command" },
    });
    expect(tool?.live.activity).toBe("thinking");
    expect(tool?.live.summary).toBe("exec_command running");

    const response = applyGatewayTopicEvent(tool?.live, {
      topic: "ravi.session.dev.response",
      timestamp: "2026-04-29T18:00:02.000Z",
      data: { response: "feito" },
    });
    expect(response?.live.activity).toBe("streaming");
    expect(response?.live.summary).toBe("feito");
    expect(response?.live.events?.[0]).toMatchObject({ kind: "response", detail: "feito" });
  });

  it("expires stale busy state back to idle", () => {
    const live = normalizeLiveState(
      {
        activity: "thinking",
        summary: "old event",
        updatedAt: 1_000,
        busySince: 1_000,
        events: [],
      },
      {},
      1_000 + 3 * 60 * 1000,
    );

    expect(live.activity).toBe("idle");
    expect(live.busySince).toBeUndefined();
  });

  it("uses the live snapshot returned by sessions list", () => {
    const now = Date.now();
    const live = getLiveForSession({
      name: "dev",
      updatedAt: now - 1_000,
      live: {
        activity: "thinking",
        summary: "runtime active",
        updatedAt: now,
        busySince: now,
      },
    });

    expect(live).toMatchObject({
      activity: "thinking",
      summary: "runtime active",
      updatedAt: now,
    });
  });
});
