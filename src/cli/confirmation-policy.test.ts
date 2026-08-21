import "reflect-metadata";
import { describe, expect, it } from "bun:test";

import { Command, CommandAccess, Group } from "./decorators.js";
import { buildRegistry, getRegistry } from "./registry-snapshot.js";

@Group({ name: "invalid-effect", description: "Invalid effect fixture", scope: "open" })
class InvalidEffectCommands {
  @Command({ name: "send", description: "Missing required confirmation" })
  @CommandAccess({
    kind: "mutate",
    resource: "invalid-effect",
    action: "send",
    risk: "high",
    effectClass: "external",
  })
  send() {}
}

function executeOption(command: ReturnType<typeof getRegistry>["commands"][number]) {
  return command.options.find((option) => option.name === "execute" || option.flags.includes("--execute"));
}

describe("global confirmation policy metadata", () => {
  const commands = getRegistry().commands;

  it("publishes complete safety metadata matching every registered access declaration", () => {
    const invalid = commands
      .filter((command) => {
        const access = command.access;
        if (!access) return true;
        const expectedEffect = access.effectClass ?? (access.kind === "read" ? "none" : "unclassified");
        const expectedSource = access.effectClass
          ? "declared"
          : access.kind === "read"
            ? "inferred-read"
            : "legacy-unclassified";
        return (
          command.safety.operationKind !== access.kind ||
          command.safety.effectClass !== expectedEffect ||
          command.safety.risk !== access.risk ||
          command.safety.requiresConfirmation !== (access.requiresConfirmation === true) ||
          command.safety.classificationSource !== expectedSource
        );
      })
      .map((command) => ({ command: command.fullName, access: command.access, safety: command.safety }));

    expect(invalid).toEqual([]);
  });

  it("fails closed when a precise consequential effect omits confirmation", () => {
    expect(() => buildRegistry([InvalidEffectCommands])).toThrow(
      'Invalid safety metadata for invalid-effect.send: effectClass "external" requires confirmation.',
    );
  });

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
      .filter(({ command, execute }) => execute?.index !== Math.max(...command.options.map((option) => option.index)))
      .map(({ command }) => command.fullName);

    expect(invalid).toEqual([]);
  });

  it("backs every confirmation declaration with an executable mutation brake", () => {
    const invalid = commands
      .filter((command) => command.access?.requiresConfirmation === true)
      .filter((command) => command.access?.kind !== "mutate" || executeOption(command) === undefined)
      .map((command) => command.fullName);

    expect(invalid).toEqual([]);
  });

  it("declares every executable mutation brake in confirmation metadata", () => {
    const invalid = commands
      .filter((command) => executeOption(command) !== undefined)
      .filter((command) => command.access?.kind !== "mutate" || command.access.requiresConfirmation !== true)
      .map((command) => ({
        command: command.fullName,
        kind: command.access?.kind ?? null,
        risk: command.access?.risk ?? null,
        requiresConfirmation: command.access?.requiresConfirmation ?? null,
      }));

    expect(invalid).toEqual([]);
  });

  it("keeps authority-reduction and containment operations immediate", () => {
    for (const fullName of ["context.revoke", "whatsapp.group.demote"]) {
      const command = commands.find((candidate) => candidate.fullName === fullName);

      expect(command, fullName).toBeDefined();
      expect(command?.access?.kind, fullName).toBe("mutate");
      expect(command?.access?.requiresConfirmation, fullName).not.toBe(true);
      expect(command && executeOption(command), fullName).toBeUndefined();
    }
  });
});
