import { describe, expect, it } from "bun:test";
import {
  buildPromotedCommand,
  decideJobPromotion,
  DEFAULT_JOB_PROMOTION_CONFIG,
  maxSleepMs,
  resolveJobPromotionConfig,
} from "./promotion.js";

const CONFIG = DEFAULT_JOB_PROMOTION_CONFIG;

describe("job promotion decision", () => {
  it("promotes when the command declares a long timeout", () => {
    const decision = decideJobPromotion({ command: "bun run build", declaredTimeoutMs: 900_000 }, CONFIG);
    expect(decision).toMatchObject({ promote: true, reason: "declared_timeout" });
  });

  it("promotes when the command sleeps past the threshold", () => {
    // O caso real: nohup em background e depois sleep 100 no mesmo comando, que
    // anula o background e prende o turno por 100 segundos.
    const decision = decideJobPromotion({ command: "nohup python3 job.py > log & sleep 100; cat log" }, CONFIG);
    expect(decision).toMatchObject({ promote: true, reason: "sleep" });
  });

  it("promotes a background wait even without a long sleep", () => {
    const decision = decideJobPromotion({ command: "nohup ./worker.sh > /tmp/w.log 2>&1 & wait" }, CONFIG);
    expect(decision).toMatchObject({ promote: true, reason: "background_wait" });
  });

  it("leaves quick commands alone", () => {
    for (const command of ["git status", "ls -la", "sleep 2", "bun test src/watch/"]) {
      expect(decideJobPromotion({ command }, CONFIG).promote).toBe(false);
    }
  });

  it("does not promote a short declared timeout", () => {
    expect(decideJobPromotion({ command: "bun run build", declaredTimeoutMs: 5_000 }, CONFIG).promote).toBe(false);
  });

  it("never promotes a command that is already a job", () => {
    const decision = decideJobPromotion(
      { command: "ravi jobs run -- bun run build", declaredTimeoutMs: 600_000 },
      CONFIG,
    );
    expect(decision).toMatchObject({ promote: false, reason: "already_background" });
  });

  it("honours the kill switch", () => {
    const decision = decideJobPromotion({ command: "sleep 300" }, CONFIG, {
      RAVI_JOBS_PROMOTE: "0",
    } as NodeJS.ProcessEnv);
    expect(decision).toMatchObject({ promote: false, reason: "disabled" });
  });

  it("ignores an empty command", () => {
    expect(decideJobPromotion({ command: "   " }, CONFIG).promote).toBe(false);
  });
});

describe("sleep detection", () => {
  it("takes the largest sleep in the command", () => {
    expect(maxSleepMs("sleep 5 && sleep 45 && echo ok")).toBe(45_000);
  });

  it("ignores substring matches", () => {
    // `sleep` precisa ser o comando, não parte de outra palavra.
    expect(maxSleepMs("echo sleepless 100")).toBe(0);
  });

  it("accepts fractional seconds", () => {
    expect(maxSleepMs("sleep 1.5")).toBe(1_500);
  });

  it("returns zero when there is no sleep", () => {
    expect(maxSleepMs("bun run build")).toBe(0);
  });
});

describe("promoted command", () => {
  it("quotes the original command as a single argument", () => {
    const promoted = buildPromotedCommand({
      command: "nohup job.sh & sleep 100",
      sessionName: "dev",
      cwd: "/tmp/work",
    });
    expect(promoted).toContain("ravi jobs run");
    expect(promoted).toContain("--session 'dev'");
    expect(promoted).toContain("--cwd '/tmp/work'");
    expect(promoted.endsWith("-- 'nohup job.sh & sleep 100'")).toBe(true);
  });

  it("quotes the command so `&` and `;` do not leak to the outer shell", () => {
    // Sem as aspas, o shell externo separaria em `ravi jobs run -- nohup job.sh`
    // (em background) e `sleep 100` rodando na hora, no shell do provider — de
    // volta ao bloqueio que a promoção existe para eliminar.
    const promoted = buildPromotedCommand({ command: "echo a; sleep 100 && echo b" });
    expect(promoted).toBe("ravi jobs run -- 'echo a; sleep 100 && echo b'");
  });

  it("escapes single quotes in the session name instead of breaking the shell", () => {
    const promoted = buildPromotedCommand({ command: "sleep 100", sessionName: "o'brien" });
    expect(promoted).toContain("--session 'o'\\''brien'");
  });

  it("omits flags that are not known", () => {
    const promoted = buildPromotedCommand({ command: "sleep 100" });
    expect(promoted).toBe("ravi jobs run -- 'sleep 100'");
  });
});

describe("promotion config", () => {
  it("uses the defaults", () => {
    expect(resolveJobPromotionConfig({})).toEqual(DEFAULT_JOB_PROMOTION_CONFIG);
  });

  it("honours the environment and ignores invalid values", () => {
    expect(
      resolveJobPromotionConfig({ RAVI_JOBS_PROMOTE_TIMEOUT_MS: "90000" } as NodeJS.ProcessEnv).declaredTimeoutMs,
    ).toBe(90_000);
    expect(resolveJobPromotionConfig({ RAVI_JOBS_PROMOTE_SLEEP_MS: "abc" } as NodeJS.ProcessEnv).sleepMs).toBe(
      DEFAULT_JOB_PROMOTION_CONFIG.sleepMs,
    );
  });
});
