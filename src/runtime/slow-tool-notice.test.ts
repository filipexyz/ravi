import { describe, expect, it } from "bun:test";
import {
  buildSlowToolLivePatch,
  buildSlowToolStatusText,
  DEFAULT_SLOW_TOOL_ANNOUNCE_MS,
  resolveSlowToolWatchConfig,
  shouldPublishSlowToolLiveState,
  SLOW_TOOL_LIVE_ACTIVITY,
  SLOW_TOOL_TICK_MS,
} from "./slow-tool-notice.js";

describe("slow tool watch config", () => {
  it("uses the defaults when nothing is configured", () => {
    const config = resolveSlowToolWatchConfig({});
    expect(config.announceAfterMs).toBe(DEFAULT_SLOW_TOOL_ANNOUNCE_MS);
    expect(config.tickMs).toBe(SLOW_TOOL_TICK_MS);
  });

  it("honours the environment", () => {
    const config = resolveSlowToolWatchConfig({ RAVI_RUNTIME_SLOW_TOOL_NOTICE_MS: "45000" } as NodeJS.ProcessEnv);
    expect(config.announceAfterMs).toBe(45_000);
  });

  it("keeps the tick short enough to hold the presence alive", () => {
    // A presença de digitando expira em 2 min sem atividade.
    expect(SLOW_TOOL_TICK_MS).toBeLessThan(2 * 60_000);
  });

  it("never lets the tick outrun the announce horizon", () => {
    const config = resolveSlowToolWatchConfig({ RAVI_RUNTIME_SLOW_TOOL_NOTICE_MS: "5000" } as NodeJS.ProcessEnv);
    expect(config.tickMs).toBe(5_000);
  });

  it("ignores invalid values instead of disabling the watch", () => {
    expect(
      resolveSlowToolWatchConfig({ RAVI_RUNTIME_SLOW_TOOL_NOTICE_MS: "abc" } as NodeJS.ProcessEnv).announceAfterMs,
    ).toBe(DEFAULT_SLOW_TOOL_ANNOUNCE_MS);
    expect(
      resolveSlowToolWatchConfig({ RAVI_RUNTIME_SLOW_TOOL_NOTICE_MS: "-5" } as NodeJS.ProcessEnv).announceAfterMs,
    ).toBe(DEFAULT_SLOW_TOOL_ANNOUNCE_MS);
  });
});

describe("slow tool status text", () => {
  it("names the tool and the elapsed minutes", () => {
    expect(buildSlowToolStatusText("bash", 90_000, 0)).toBe("bash rodando há 2 min");
    expect(buildSlowToolStatusText("bash", 60_000, 0)).toBe("bash rodando há 1 min");
  });

  it("reports the queue without becoming a chat message", () => {
    expect(buildSlowToolStatusText("bash", 180_000, 1)).toBe("bash rodando há 3 min · 1 mensagem na fila");
    expect(buildSlowToolStatusText("bash", 180_000, 4)).toBe("bash rodando há 3 min · 4 mensagens na fila");
  });

  it("never claims zero minutes", () => {
    expect(buildSlowToolStatusText("bash", 500, 0)).toBe("bash rodando há 1 min");
  });

  it("falls back when the tool name is missing", () => {
    expect(buildSlowToolStatusText("", 60_000, 0)).toBe("uma tool rodando há 1 min");
  });
});

describe("slow tool live-state", () => {
  it("announces a healthy slow tool as thinking, never blocked", () => {
    expect(SLOW_TOOL_LIVE_ACTIVITY).toBe("thinking");
    expect(buildSlowToolLivePatch("bash", 90_000, 0)).toEqual({
      activity: "thinking",
      toolName: "bash",
      summary: "bash rodando há 2 min",
    });
  });

  it("publishes only while the same tool is still running on an active turn", () => {
    const active = {
      toolRunning: true,
      currentToolId: "tool-1",
      armedToolId: "tool-1",
      elapsedMs: 20_000,
      announceAfterMs: 15_000,
      turnActive: true,
    };
    expect(shouldPublishSlowToolLiveState(active)).toBe(true);
    expect(shouldPublishSlowToolLiveState({ ...active, elapsedMs: 5_000 })).toBe(false);
    expect(shouldPublishSlowToolLiveState({ ...active, toolRunning: false })).toBe(false);
    expect(shouldPublishSlowToolLiveState({ ...active, turnActive: false })).toBe(false);
    expect(shouldPublishSlowToolLiveState({ ...active, sessionDone: true })).toBe(false);
    expect(shouldPublishSlowToolLiveState({ ...active, currentToolId: "tool-2" })).toBe(false);
  });
});
