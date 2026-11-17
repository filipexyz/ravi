import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { runWithContext, type ToolContext } from "../context.js";
import { dbCreateAgent } from "../../router/router-db.js";
import { createTask } from "../../tasks/index.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { TaskCommands } from "./tasks.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-tasks-cloud-authz-");
  dbCreateAgent({ id: "crm", cwd: join(stateDir, "agent-crm") });
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const CRM: ToolContext = {
  contextId: "ctx_crm",
  agentId: "crm",
  sessionKey: "agent:crm:main",
  sessionName: "agent:crm:main",
  context: {
    contextId: "ctx_crm",
    contextKey: "rctx_crm",
    kind: "agent-runtime",
    agentId: "crm",
    sessionKey: "agent:crm:main",
    sessionName: "agent:crm:main",
    capabilities: [{ permission: "execute", objectType: "group", objectId: "tasks", source: "test" }],
    createdAt: 0,
  },
};

describe("tasks dispatch --cloud", () => {
  it("needs the cloud runs start authority, not only the tasks group", async () => {
    const { task } = createTask({
      title: "Cloud work",
      instructions: "Run this in the cloud",
      createdBy: "crm",
      createdByAgentId: "crm",
    });
    const dispatch = new TaskCommands().dispatch as (...values: unknown[]) => Promise<unknown>;
    const args: unknown[] = [task.id, "crm"];
    args[6] = true; // --json
    args[11] = true; // --cloud

    const error = await runWithContext(CRM, () => dispatch.apply(new TaskCommands(), args)).then(
      () => null,
      (err: unknown) => err as { exitCode?: number; envelope?: () => { error: { code: string } } },
    );
    expect(error?.envelope?.().error.code).toBe("PERMISSION_DENIED");
    expect(error?.exitCode).toBe(1);
  });
});
