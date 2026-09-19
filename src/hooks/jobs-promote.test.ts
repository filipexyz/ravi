import { afterEach, describe, expect, it } from "bun:test";
import { createJobPromotionHook } from "./jobs-promote.js";

const ORIGINAL_PROMOTE_ENV = process.env.RAVI_JOBS_PROMOTE;

afterEach(() => {
  if (ORIGINAL_PROMOTE_ENV === undefined) delete process.env.RAVI_JOBS_PROMOTE;
  else process.env.RAVI_JOBS_PROMOTE = ORIGINAL_PROMOTE_ENV;
});

function runHook(
  toolInput: Record<string, unknown>,
  options: Parameters<typeof createJobPromotionHook>[0] = {},
): Promise<Record<string, unknown>> {
  const hook = createJobPromotionHook(options);
  const callback = hook.hooks?.[0] as unknown as (
    input: unknown,
    toolUseId: unknown,
    context: unknown,
  ) => Promise<Record<string, unknown>>;
  return callback({ tool_input: toolInput }, null, null);
}

function promotedCommand(result: Record<string, unknown>): string | undefined {
  const output = result.hookSpecificOutput as { updatedInput?: { command?: string } } | undefined;
  return output?.updatedInput?.command;
}

describe("job promotion hook", () => {
  it("rewrites a command that sleeps past the threshold", async () => {
    const result = await runHook(
      { command: "nohup python3 job.py > log & sleep 100; head log" },
      { sessionName: "dev" },
    );

    const command = promotedCommand(result);
    expect(command).toContain("ravi jobs run");
    expect(command).toContain("--session 'dev'");
    // O comando original vai citado como um argumento só.
    expect(command).toContain("'nohup python3 job.py > log & sleep 100; head log'");
  });

  it("rewrites a command that declares a long timeout", async () => {
    // `timeout` da tool é em segundos (semântica do lease de inatividade): 300 = 5min.
    const command = promotedCommand(await runHook({ command: "bun run build", timeout: 300 }));
    expect(command).toContain("ravi jobs run");
    expect(command).toContain("'bun run build'");
  });

  it("leaves a quick command alone", async () => {
    const result = await runHook({ command: "git status" });
    expect(result).toEqual({});
  });

  it("leaves a command alone when no timeout is declared, even if it could be long", async () => {
    // Um `timeout` ausente não é sinal de demora: o default do lease promoveria tudo.
    const result = await runHook({ command: "bun test src/watch/" });
    expect(result).toEqual({});
  });

  it("does not promote a command that is already a job", async () => {
    const result = await runHook({ command: "ravi jobs run -- sleep 100", timeout: 600 });
    expect(result).toEqual({});
  });

  it("keeps the rest of the tool input intact", async () => {
    const result = await runHook({ command: "sleep 100", timeout: 300, description: "build" });
    const updated = (result.hookSpecificOutput as { updatedInput?: Record<string, unknown> } | undefined)?.updatedInput;
    expect(updated?.description).toBe("build");
    expect(updated?.timeout).toBe(300);
  });

  it("honours the kill switch", async () => {
    process.env.RAVI_JOBS_PROMOTE = "0";
    expect(await runHook({ command: "sleep 300" })).toEqual({});
  });

  it("never breaks the tool call, even with no command", async () => {
    expect(await runHook({})).toEqual({});
    expect(await runHook({ command: "" })).toEqual({});
  });
});
