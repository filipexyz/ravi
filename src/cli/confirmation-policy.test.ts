import "reflect-metadata";
import { describe, expect, it } from "bun:test";

import { getRegistry } from "./registry-snapshot.js";

function executeOption(command: ReturnType<typeof getRegistry>["commands"][number]) {
  return command.options.find((option) => option.name === "execute" || option.flags.includes("--execute"));
}

describe("global confirmation policy metadata", () => {
  const commands = getRegistry().commands;

  it("authorizes every command exposing --execute as a mutation", () => {
    const invalid = commands
      .filter((command) => executeOption(command))
      .filter((command) => {
        const access = command.access;
        return access === undefined || access.kind !== "mutate";
      })
      .map((command) => ({
        command: command.fullName,
        kind: command.access?.kind ?? null,
        risk: command.access?.risk ?? null,
      }));

    expect(invalid).toEqual([]);
  });

  it("keeps --execute as the final declared command option", () => {
    const invalid = commands
      .map((command) => ({ command, execute: executeOption(command) }))
      .filter(({ execute }) => execute !== undefined)
      .filter(
        ({ command, execute }) => execute?.index !== Math.max(...command.options.map((option) => option.index)),
      )
      .map(({ command }) => command.fullName);

    expect(invalid).toEqual([]);
  });

  it("backs unconditional confirmation metadata with an executable mutation brake", () => {
    const invalid = commands
      .filter((command) => command.access?.requiresConfirmation === true)
      .filter(
        (command) =>
          command.access?.kind !== "mutate" || executeOption(command) === undefined,
      )
      .map((command) => command.fullName);

    expect(invalid).toEqual([]);
  });
});
