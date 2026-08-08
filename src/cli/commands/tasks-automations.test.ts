import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { createTaskAutomation, getTaskAutomation } from "../../tasks/index.js";
import { ContractError } from "../agent-contract.js";
import { TaskAutomationCommands } from "./tasks-automations.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-task-automations-cli-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("tasks automations agent-first contract", () => {
  it("minimizes the rm dry-run plan and leaves the automation untouched", () => {
    const automation = createTaskAutomation({
      name: "PRIVATE_AUTOMATION_NAME_8K2R",
      eventTypes: ["task.done"],
      titleTemplate: "Follow up",
      instructionsTemplate: "Review the task",
    });

    let thrown: unknown;
    try {
      new TaskAutomationCommands().remove(automation.id, true);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ContractError);
    const contractError = thrown as ContractError;
    expect(contractError.exitCode).toBe(3);
    expect(contractError.envelope().error.plan).toEqual({
      id: automation.id,
      namePresent: true,
    });
    expect(JSON.stringify(contractError.envelope().error.plan)).not.toContain("PRIVATE_AUTOMATION_NAME_8K2R");
    expect(getTaskAutomation(automation.id)).not.toBeNull();
  });
});
