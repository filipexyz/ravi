import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");

function sourceLines(path: string, marker: string): string[] {
  return readFileSync(join(repoRoot, path), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.includes(marker));
}

type ExecuteConsumer = {
  readonly name: string;
  readonly path: string;
  readonly marker: string;
  readonly expected: string;
  readonly matches: number;
};

const executeConsumers: readonly ExecuteConsumer[] = [
  {
    name: "task dispatch status hint",
    path: "src/cli/commands/tasks.ts",
    marker: "ravi tasks dispatch",
    expected: "--execute",
    matches: 1,
  },
  {
    name: "task profile dispatch hints",
    path: "src/tasks/profiles.ts",
    marker: "ravi tasks dispatch",
    expected: "--execute",
    matches: 3,
  },
  {
    name: "generated audio delivery hint",
    path: "src/cli/commands/audio.ts",
    marker: "ravi media send",
    expected: "--execute",
    matches: 1,
  },
  {
    name: "generated image delivery hints",
    path: "src/cli/commands/image.ts",
    marker: "ravi media send",
    expected: "--execute",
    matches: 2,
  },
  {
    name: "sentinel WhatsApp DM reply hint",
    path: "src/omni/consumer.ts",
    marker: "use whatsapp dm send",
    expected: "--execute",
    matches: 1,
  },
];

const executeInstructions = [
  {
    name: "session reset documentation",
    path: "README.md",
    instruction: "ravi sessions reset main --execute",
  },
  {
    name: "session delete documentation",
    path: "docs/cli/overview.mdx",
    instruction: "ravi sessions delete <nameOrKey> --execute",
  },
  {
    name: "session message deletion tool",
    path: "src/cli/commands/sessions.ts",
    instruction: "ravi sessions delete-message <message-id> --execute",
  },
  {
    name: "sticker send conversational tool",
    path: "src/cli/commands/sessions.ts",
    instruction: "ravi stickers send <sticker-id> --execute",
  },
  {
    name: "media send conversational tool",
    path: "src/cli/commands/sessions.ts",
    instruction: 'ravi media send "<file-path>" --execute',
  },
  {
    name: "context revoke rotation hint",
    path: "src/cli/commands/daemon.ts",
    instruction: "ravi context revoke <id> --execute",
  },
] as const;

const obsoleteExecuteConsumers = [
  {
    name: "contact block help",
    path: "src/cli/commands/contacts.ts",
    obsolete: "ravi contacts block <id> --execute",
    current: "ravi contacts block <id>",
  },
  {
    name: "CLI overview contact block example",
    path: "docs/cli/overview.mdx",
    obsolete: "ravi contacts block <contact> --execute",
    current: "ravi contacts block <contact>",
  },
  {
    name: "CLI overview instance delete example",
    path: "docs/cli/overview.mdx",
    obsolete: "ravi instances delete <name> --execute",
    current: "ravi instances delete <name>",
  },
  {
    name: "CLI overview route removal example",
    path: "docs/cli/overview.mdx",
    obsolete: "ravi instances routes remove <name> <pattern> --execute",
    current: "ravi instances routes remove <name> <pattern>",
  },
] as const;

describe("command consumer contracts", () => {
  it("keeps every consumer of a braked command executable", () => {
    for (const consumer of executeConsumers) {
      const lines = sourceLines(consumer.path, consumer.marker);

      expect(lines, consumer.name).toHaveLength(consumer.matches);
      for (const line of lines) expect(line, consumer.name).toContain(consumer.expected);
    }
  });

  it("keeps explicit braked command instructions executable", () => {
    for (const consumer of executeInstructions) {
      const source = readFileSync(join(repoRoot, consumer.path), "utf8");

      expect(source, consumer.name).toContain(consumer.instruction);
    }
  });

  it("does not teach obsolete execute flags for immediate commands", () => {
    for (const consumer of obsoleteExecuteConsumers) {
      const source = readFileSync(join(repoRoot, consumer.path), "utf8");

      expect(source, consumer.name).not.toContain(consumer.obsolete);
      expect(source, consumer.name).toContain(consumer.current);
    }
  });
});
