import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { CronCommands } from "../cli/commands/cron.js";
import { TriggersCommands } from "../cli/commands/triggers.js";
import { dbCreateCronJob, dbGetCronJob, dbListCronJobs } from "../cron/cron-db.js";
import type { ContextCapability } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbListTriggers } from "../triggers/index.js";
import { assertShellAutomationAuthorized } from "./shell-automation.js";

setDefaultTimeout(20_000);

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-shell-automation-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function ctx(capabilities: string[]): ToolContext {
  const caps: ContextCapability[] = capabilities.map((value) => {
    const [permission, objectType, objectId] = value.split(":");
    return { permission: permission!, objectType: objectType!, objectId: objectId!, source: "test" };
  });
  return {
    contextId: "ctx_ops",
    agentId: "ops",
    sessionKey: "agent:ops:main",
    sessionName: "ops-main",
    context: {
      contextId: "ctx_ops",
      contextKey: "rctx_ops",
      kind: "agent-runtime",
      agentId: "ops",
      sessionKey: "agent:ops:main",
      sessionName: "ops-main",
      capabilities: caps,
      createdAt: 0,
    },
  };
}

const AUTOMATION_ONLY = ctx(["use:tool:Bash", "mutate:cron:*", "mutate:triggers:*"]);

async function expectDenied(fn: () => unknown): Promise<void> {
  let error: unknown;
  try {
    await fn();
  } catch (err) {
    error = err;
  }
  expect(error).toMatchObject({ code: "PERMISSION_DENIED" });
}

describe("shell automations need host-execution authority", () => {
  it("refuses cron add --shell for a context that only holds cron authority", async () => {
    await runWithContext(AUTOMATION_ONLY, () =>
      expectDenied(() =>
        new CronCommands().add("probe", undefined, "1m", undefined, undefined, undefined, "id > /dev/null"),
      ),
    );
    expect(dbListCronJobs()).toEqual([]);
  });

  it("refuses triggers add --shell and switching a cron job to shell", async () => {
    await runWithContext(AUTOMATION_ONLY, async () => {
      await expectDenied(() =>
        new TriggersCommands().add(
          "probe",
          "ravi.session.*.prompt",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "id > /dev/null",
        ),
      );
    });
    expect(dbListTriggers()).toEqual([]);

    const job = dbCreateCronJob({
      agentId: "ops",
      name: "digest",
      schedule: { type: "every", every: 3_600_000 },
      message: "send the digest",
      ownerPrincipal: "operator",
    });
    await runWithContext(AUTOMATION_ONLY, () => expectDenied(() => new CronCommands().set(job.id, "shell", "id")));
    expect(dbGetCronJob(job.id)?.executionType ?? "agent").toBe("agent");
  });

  it("allows contexts holding execute:executable:* or admin, and the terminal", () => {
    for (const allowed of [ctx(["execute:executable:*"]), ctx(["admin:system:*"])]) {
      expect(() => runWithContext(allowed, () => assertShellAutomationAuthorized("cron add"))).not.toThrow();
    }
    expect(() => runWithContext(AUTOMATION_ONLY, () => assertShellAutomationAuthorized("cron add"))).toThrow();
    expect(() => assertShellAutomationAuthorized("cron add")).not.toThrow();
  });
});
