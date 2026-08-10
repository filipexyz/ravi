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

  it("backs every confirmation declaration with an executable mutation brake", () => {
    const invalid = commands
      .filter((command) => command.access?.requiresConfirmation === true)
      .filter(
        (command) =>
          command.access?.kind !== "mutate" || executeOption(command) === undefined,
      )
      .map((command) => command.fullName);

    expect(invalid).toEqual([]);
  });

  it("declares every executable mutation brake in confirmation metadata", () => {
    const invalid = commands
      .filter((command) => executeOption(command) !== undefined)
      .filter(
        (command) =>
          command.access?.kind !== "mutate" || command.access.requiresConfirmation !== true,
      )
      .map((command) => ({
        command: command.fullName,
        kind: command.access?.kind ?? null,
        risk: command.access?.risk ?? null,
        requiresConfirmation: command.access?.requiresConfirmation ?? null,
      }));

    expect(invalid).toEqual([]);
  });

  it("keeps authority-reduction and containment operations immediate", () => {
    for (const fullName of ["context.revoke", "whatsapp.group.demote", "slack.canvas-access-delete"]) {
      const command = commands.find((candidate) => candidate.fullName === fullName);

      expect(command, fullName).toBeDefined();
      expect(command?.access?.kind, fullName).toBe("mutate");
      expect(command?.access?.requiresConfirmation, fullName).not.toBe(true);
      expect(command && executeOption(command), fullName).toBeUndefined();
    }
  });
});
