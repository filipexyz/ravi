import { describe, expect, it } from "bun:test";
import {
  buildSlowToolNoticeText,
  decideSlowToolNotice,
  initialSlowToolNoticeState,
  resolveSlowToolNoticeConfig,
  SLOW_TOOL_TICK_MS,
} from "./slow-tool-notice.js";

const CONFIG = { noticeAfterMs: 90_000, repeatEveryMs: 180_000, maxNotices: 3, tickMs: 30_000 };

describe("slow tool notice config", () => {
  it("uses the defaults when nothing is configured", () => {
    const config = resolveSlowToolNoticeConfig({});
    expect(config.noticeAfterMs).toBe(90_000);
    expect(config.repeatEveryMs).toBe(180_000);
    expect(config.maxNotices).toBe(5);
  });

  it("honours the environment and keeps the tick short", () => {
    const config = resolveSlowToolNoticeConfig({
      RAVI_RUNTIME_SLOW_TOOL_NOTICE_MS: "45000",
      RAVI_RUNTIME_SLOW_TOOL_REPEAT_MS: "60000",
      RAVI_RUNTIME_SLOW_TOOL_MAX_NOTICES: "2",
    } as NodeJS.ProcessEnv);

    expect(config.noticeAfterMs).toBe(45_000);
    expect(config.tickMs).toBe(30_000);
    // Tick nunca passa do limiar: senão o primeiro aviso chegaria atrasado.
    expect(resolveSlowToolNoticeConfig({ RAVI_RUNTIME_SLOW_TOOL_NOTICE_MS: "5000" } as NodeJS.ProcessEnv).tickMs).toBe(
      5_000,
    );
  });

  it("ignores invalid values instead of disabling the notice", () => {
    const config = resolveSlowToolNoticeConfig({
      RAVI_RUNTIME_SLOW_TOOL_NOTICE_MS: "abc",
      RAVI_RUNTIME_SLOW_TOOL_MAX_NOTICES: "-1",
    } as NodeJS.ProcessEnv);

    expect(config.noticeAfterMs).toBe(90_000);
    expect(config.maxNotices).toBe(5);
  });
});

describe("slow tool notice decision", () => {
  it("stays quiet until the threshold", () => {
    const state = initialSlowToolNoticeState(0, CONFIG);
    expect(decideSlowToolNotice(state, 30_000, CONFIG).notify).toBe(false);
    expect(decideSlowToolNotice(state, 89_999, CONFIG).notify).toBe(false);
  });

  it("notifies at the threshold and then only after the repeat window", () => {
    const first = decideSlowToolNotice(initialSlowToolNoticeState(0, CONFIG), 90_000, CONFIG);
    expect(first.notify).toBe(true);
    expect(first.state.noticesSent).toBe(1);

    // Um tick logo depois não repete o aviso.
    expect(decideSlowToolNotice(first.state, 120_000, CONFIG).notify).toBe(false);

    const second = decideSlowToolNotice(first.state, 270_000, CONFIG);
    expect(second.notify).toBe(true);
    expect(second.state.noticesSent).toBe(2);
  });

  it("stops at the cap instead of warning forever", () => {
    let state = initialSlowToolNoticeState(0, CONFIG);
    let sent = 0;
    for (let now = 90_000; now < 2_000_000; now += 30_000) {
      const decision = decideSlowToolNotice(state, now, CONFIG);
      state = decision.state;
      if (decision.notify) sent += 1;
    }

    expect(sent).toBe(CONFIG.maxNotices);
  });
});

describe("slow tool notice text", () => {
  it("names the tool and the elapsed minutes", () => {
    expect(buildSlowToolNoticeText("bash", 90_000, 0)).toBe("ainda rodando: bash há 2 min.");
    expect(buildSlowToolNoticeText("bash", 60_000, 0)).toBe("ainda rodando: bash há 1 min.");
  });

  it("tells the user their messages are queued", () => {
    expect(buildSlowToolNoticeText("bash", 180_000, 1)).toBe("ainda rodando: bash há 3 min. 1 mensagem na fila.");
    expect(buildSlowToolNoticeText("bash", 180_000, 4)).toBe("ainda rodando: bash há 3 min. 4 mensagens na fila.");
  });

  it("never claims zero minutes", () => {
    expect(buildSlowToolNoticeText("bash", 500, 0)).toBe("ainda rodando: bash há 1 min.");
  });

  it("falls back when the tool name is missing", () => {
    expect(buildSlowToolNoticeText("", 60_000, 0)).toBe("ainda rodando: uma tool há 1 min.");
  });
});

describe("slow tool tick cadence", () => {
  it("is short enough to keep the presence alive", () => {
    // A presença de digitando expira em 2 min sem atividade: o tick precisa ser menor.
    expect(SLOW_TOOL_TICK_MS).toBeLessThan(2 * 60_000);
  });

  it("keeps the presence pitch as the notice horizon", () => {
    const config = resolveSlowToolNoticeConfig({});
    expect(config.tickMs).toBeLessThanOrEqual(config.noticeAfterMs);
  });
});
