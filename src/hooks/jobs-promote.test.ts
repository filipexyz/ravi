import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createJobPromotionHook } from "./jobs-promote.js";

const ORIGINAL_PROMOTE_ENV = process.env.RAVI_JOBS_PROMOTE;
const ORIGINAL_WRAP_ENV = process.env.RAVI_JOBS_WRAP;

const SCRIPT_PATH = "/tmp/ravi-detach-test/ravi-jobs-exec.sh";

beforeEach(() => {
  delete process.env.RAVI_JOBS_PROMOTE;
  delete process.env.RAVI_JOBS_WRAP;
});

afterEach(() => {
  if (ORIGINAL_PROMOTE_ENV === undefined) delete process.env.RAVI_JOBS_PROMOTE;
  else process.env.RAVI_JOBS_PROMOTE = ORIGINAL_PROMOTE_ENV;
  if (ORIGINAL_WRAP_ENV === undefined) delete process.env.RAVI_JOBS_WRAP;
  else process.env.RAVI_JOBS_WRAP = ORIGINAL_WRAP_ENV;
});

function runHook(
  toolInput: Record<string, unknown>,
  options: Parameters<typeof createJobPromotionHook>[0] = {},
): Promise<Record<string, unknown>> {
  const hook = createJobPromotionHook({ scriptPath: SCRIPT_PATH, ...options });
  const callback = hook.hooks?.[0] as unknown as (
    input: unknown,
    toolUseId: unknown,
    context: unknown,
  ) => Promise<Record<string, unknown>>;
  return callback({ tool_input: toolInput }, null, null);
}

function rewrittenCommand(result: Record<string, unknown>): string | undefined {
  const output = result.hookSpecificOutput as { updatedInput?: { command?: string } } | undefined;
  return output?.updatedInput?.command;
}

describe("long-tool detach hook (default)", () => {
  it("sends every Bash command through the wrapper, without guessing the duration", async () => {
    const result = await runHook({ command: "git status" }, { sessionName: "dev", agentId: "dev" });

    expect(rewrittenCommand(result)).toBe(`'${SCRIPT_PATH}' --session 'dev' --agent 'dev' -- 'git status'`);
  });

  it("rewrites the command the model declared long, quoting it as a single argument", async () => {
    const result = await runHook({ command: "bun run build", timeout: 300 });

    expect(rewrittenCommand(result)).toBe(`'${SCRIPT_PATH}' -- 'bun run build'`);
  });

  it("moves provider run_in_background into a Ravi job that detaches at once", async () => {
    const result = await runHook(
      { command: "nba sql 'select 1'", run_in_background: true, description: "query" },
      { sessionName: "dm-session", agentId: "nba" },
    );
    const updated = (result.hookSpecificOutput as { updatedInput?: Record<string, unknown> } | undefined)?.updatedInput;

    // The provider's own background task dies with its process on idle
    // eviction; the Ravi job survives and wakes the session (bug 081dac32).
    expect(updated?.run_in_background).toBe(false);
    expect(updated?.command).toBe(
      `RAVI_JOBS_DETACH_AFTER_MS=200 '${SCRIPT_PATH}' --session 'dm-session' --agent 'nba' -- 'nba sql '\\''select 1'\\'''`,
    );
    expect(updated?.description).toBe("query");
  });

  it("leaves run_in_background alone when there is no session to deliver to", async () => {
    const result = await runHook({ command: "sleep 30", run_in_background: true });
    const updated = (result.hookSpecificOutput as { updatedInput?: Record<string, unknown> } | undefined)?.updatedInput;
    expect(updated?.run_in_background).toBe(true);
  });

  it("keeps the rest of the tool input intact", async () => {
    const result = await runHook({ command: "bun test src/watch/", timeout: 300, description: "build" });
    const updated = (result.hookSpecificOutput as { updatedInput?: Record<string, unknown> } | undefined)?.updatedInput;
    expect(updated?.description).toBe("build");
    expect(updated?.timeout).toBe(300);
  });

  it("does not wrap a command that is already a job request", async () => {
    expect(await runHook({ command: "ravi jobs run -- sleep 100", timeout: 600 })).toEqual({});
  });

  it("does not wrap a command that already passes through the wrapper", async () => {
    expect(await runHook({ command: `${SCRIPT_PATH} -- 'sleep 100'` })).toEqual({});
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

describe("long-tool detach hook (rollback to syntax promotion)", () => {
  it("promotes a command that sleeps past the threshold", async () => {
    process.env.RAVI_JOBS_WRAP = "0";
    const result = await runHook(
      { command: "nohup python3 job.py > log & sleep 100; head log" },
      { sessionName: "dev" },
    );

    const command = rewrittenCommand(result);
    expect(command).toContain("ravi jobs run");
    expect(command).toContain("--session 'dev'");
    expect(command).toContain("'nohup python3 job.py > log & sleep 100; head log'");
  });

  it("promotes a command that declares a long timeout", async () => {
    process.env.RAVI_JOBS_WRAP = "0";
    const command = rewrittenCommand(await runHook({ command: "bun run build", timeout: 300 }));
    expect(command).toContain("ravi jobs run");
    expect(command).toContain("'bun run build'");
  });

  it("leaves a quick command alone", async () => {
    process.env.RAVI_JOBS_WRAP = "0";
    expect(await runHook({ command: "git status" })).toEqual({});
  });

  it("leaves a command alone when no timeout is declared, even if it could be long", async () => {
    process.env.RAVI_JOBS_WRAP = "0";
    expect(await runHook({ command: "bun test src/watch/" })).toEqual({});
  });
});
