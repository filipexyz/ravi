import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import * as allCommands from "./index.js";
import { getCommandsMetadata, getGroupMetadata, getOptionsMetadata } from "../decorators.js";

type CommandClass = new () => object;

const JSON_ALLOWLIST = new Set([
  // Foreground process hosts. They do not return domain data; they own a live process.
  "daemon run",
  "daemon dev",
]);

function hasJsonOption(options: Array<{ flags: string }>): boolean {
  return options.some((option) => /(^|[, ])--json(\s|,|$|<|\[)/.test(option.flags));
}

function commandClasses(): CommandClass[] {
  return (Object.values(allCommands) as unknown[]).filter((value): value is CommandClass => {
    if (typeof value !== "function") return false;
    return Boolean(getGroupMetadata(value));
  });
}

describe("CLI JSON coverage", () => {
  it("keeps finite decorated commands JSON-addressable", () => {
    const commands = commandClasses().flatMap((CommandClass) => {
      const group = getGroupMetadata(CommandClass);
      if (!group) return [];

      const instance = new CommandClass();
      return getCommandsMetadata(CommandClass).map((command) => {
        const options = getOptionsMetadata(instance, command.method);
        return {
          key: `${group.name} ${command.name}`,
          group: group.name,
          command: command.name,
          hasJson: hasJsonOption(options),
        };
      });
    });

    const missing = commands
      .filter((command) => !command.hasJson && !JSON_ALLOWLIST.has(command.key))
      .map((command) => command.key)
      .sort();

    expect(missing).toEqual([]);

    const allowlistedMissing = commands
      .filter((command) => !command.hasJson && JSON_ALLOWLIST.has(command.key))
      .map((command) => command.key)
      .sort();

    expect(allowlistedMissing).toEqual([...JSON_ALLOWLIST].sort());
  });
});
