import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import * as allCommands from "./index.js";
import { getCommandsMetadata, getGroupMetadata, getOptionsMetadata } from "../decorators.js";

type CommandClass = new () => object;

function commandClasses(): CommandClass[] {
  return (Object.values(allCommands) as unknown[]).filter((value): value is CommandClass => {
    if (typeof value !== "function") return false;
    return Boolean(getGroupMetadata(value));
  });
}

function hasOption(options: Array<{ flags: string }>, flag: string): boolean {
  return options.some((option) => option.flags.includes(flag));
}

describe("CLI pagination coverage", () => {
  it("keeps list commands paginated for agent consumption", () => {
    const missing = commandClasses()
      .flatMap((CommandClass) => {
        const group = getGroupMetadata(CommandClass);
        if (!group) return [];
        const instance = new CommandClass();
        return getCommandsMetadata(CommandClass).map((command) => ({
          key: `${group.name}.${command.name}`,
          command: command.name,
          options: getOptionsMetadata(instance, command.method),
        }));
      })
      .filter((entry) => entry.command === "list" || entry.command === "ls")
      .filter((entry) => {
        const hasOffsetPagination = hasOption(entry.options, "--limit") && hasOption(entry.options, "--offset");
        const hasCursorPagination = hasOption(entry.options, "--cursor");
        return !hasOffsetPagination && !hasCursorPagination;
      })
      .map((entry) => entry.key)
      .sort();

    expect(missing).toEqual([]);
  });
});
