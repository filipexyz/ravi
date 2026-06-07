import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { UNTYPED_PUBLIC_RETURN_COMMANDS_BASELINE } from "../../sdk/client-codegen/return-schema-baseline.js";
import { SdkReturnsCommands } from "./sdk-returns.js";

let stateDir: string | null = null;
let originalConsoleLog: typeof console.log;

setDefaultTimeout(20_000);

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-sdk-returns-cli-");
  originalConsoleLog = console.log;
  console.log = () => {};
});

afterEach(async () => {
  console.log = originalConsoleLog;
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("sdk returns CLI", () => {
  it("syncs, lists, assigns, and validates typed payloads", () => {
    const cli = new SdkReturnsCommands();

    const summary = cli.status(true);
    expect(summary.missingPublic).toBe(UNTYPED_PUBLIC_RETURN_COMMANDS_BASELINE.length);
    expect(summary.newlyUntyped).toEqual([]);

    const list = cli.list(undefined, "missing", undefined, undefined, "2", undefined, true);
    expect(list.total).toBe(UNTYPED_PUBLIC_RETURN_COMMANDS_BASELINE.length);
    expect(list.items).toHaveLength(Math.min(2, UNTYPED_PUBLIC_RETURN_COMMANDS_BASELINE.length));

    const typedList = cli.list(undefined, "json", undefined, undefined, "1", undefined, true);
    expect(typedList.items.length).toBeGreaterThan(0);

    const firstTyped = typedList.items[0];
    if (!firstTyped) throw new Error("Expected at least one typed return-schema command");
    const assignGroup = firstTyped.groupPath.split(".")[0];
    const assigned = cli.assign(
      "task-test",
      assignGroup,
      "json",
      "validated",
      undefined,
      "test batch",
      undefined,
      true,
    );
    expect(assigned.updated).toBeGreaterThan(0);
    expect(assigned.commands.every((name) => name.startsWith(`${assignGroup}.`))).toBe(true);

    const validation = cli.validate(false, true);
    expect(validation.ok).toBe(true);

    const strictValidation = cli.validate(true, true);
    expect(strictValidation.ok).toBe(false);
    expect(strictValidation.issues.some((issue) => issue.code === "CLI_ONLY_COMMAND")).toBe(true);
    process.exitCode = 0;
  });
});
