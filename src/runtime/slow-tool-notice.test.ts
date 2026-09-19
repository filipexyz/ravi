import { describe, expect, it } from "bun:test";
import {
  buildSlowToolStatusText,
  DEFAULT_SLOW_TOOL_ANNOUNCE_MS,
  resolveSlowToolWatchConfig,
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
