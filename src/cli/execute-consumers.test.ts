import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");

function sourceLines(path: string, marker: string): string[] {
  return readFileSync(join(repoRoot, path), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.includes(marker));
}

function normalizedSource(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8").replace(/\s+/g, " ").trim();
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
  {
    name: "trigger test root instructions",
    path: "AGENTS.md",
    instruction: "ravi triggers test <id> --execute",
  },
  {
    name: "trigger test skill",
    path: "src/plugins/internal/ravi-system/skills/triggers/SKILL.md",
    instruction: "ravi triggers test <id> --execute",
  },
  {
    name: "audio direct-send documentation",
    path: "docs/reference/media.mdx",
    instruction: 'ravi audio generate "Voice message content" --send --execute',
  },
  {
    name: "audio captioned-send documentation",
    path: "docs/reference/media.mdx",
    instruction: 'ravi audio generate "Important update" --send --caption "Listen to this" --execute',
  },
  {
    name: "image direct-send documentation",
    path: "docs/reference/media.mdx",
    instruction: 'ravi image generate "coffee shop interior" --send --execute',
  },
  {
    name: "heartbeat root instructions",
    path: "AGENTS.md",
    instruction: "ravi heartbeat trigger <id> --execute",
  },
  {
    name: "heartbeat skill",
    path: "src/plugins/internal/ravi-system/skills/heartbeat/SKILL.md",
    instruction: "ravi heartbeat trigger <agent> --execute",
  },
  {
    name: "heartbeat feature guide",
    path: "docs/features/overview.mdx",
    instruction: "ravi heartbeat trigger main --execute",
  },
  {
    name: "heartbeat CLI overview",
    path: "docs/cli/overview.mdx",
    instruction: "ravi heartbeat trigger <id> --execute",
  },
  {
    name: "Pages create root instructions",
    path: "AGENTS.md",
    instruction: "ravi pages create <project-ref> <site-slug> --visibility public --execute",
  },
  {
    name: "Pages create artifact skill",
    path: "src/plugins/internal/ravi-system/skills/artifacts/SKILL.md",
    instruction: "ravi pages create <project-ref> <site-slug> --visibility public --execute",
  },
  {
    name: "Pages create artifact runbook",
    path: ".ravi/specs/artifacts/RUNBOOK.md",
    instruction: "ravi pages create <project-ref> <site-slug> --visibility public --execute",
  },
  {
    name: "Pages publish artifact spec",
    path: ".ravi/specs/artifacts/SPEC.md",
    instruction:
      "ravi pages publish <project-ref> <site-slug> ./site --route / --visibility public --entrypoint index.html --execute",
  },
  {
    name: "Pages create Console-scope acceptance",
    path: ".ravi/specs/cli/console-scope/SPEC.md",
    instruction: "ravi pages create <slug> --json --execute",
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
  {
    name: "agent permission containment hint",
    path: "src/cli/commands/agents.ts",
    obsolete: "ravi agents permissions ${id} none --execute",
    current: "ravi agents permissions ${id} none",
  },
  {
    name: "agent permission containment instructions",
    path: "AGENTS.md",
    obsolete: "ravi agents permissions dev none --execute",
    current: "ravi agents permissions dev none",
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

  it("teaches immediate CRM writes without an execute brake", () => {
    const source = normalizedSource("src/plugins/internal/ravi-system/skills/crm/SKILL.md");

    expect(source).toContain(
      "`crm pipeline create`, `crm opportunity create` e `crm opportunity move` executam imediatamente sem `--execute`.",
    );
    expect(source).not.toContain(
      "**Onde o freio existe hoje:** somente `crm pipeline create`, `crm opportunity create` e `crm opportunity move`",
    );
    expect(source).not.toContain(
      "Use o dry-run (exit 3) para conferir o `plan` antes de `--execute`.",
    );
  });

  it("teaches the conditional heartbeat trigger brake without contradictions", () => {
    const source = normalizedSource("src/plugins/internal/ravi-system/skills/heartbeat/SKILL.md");

    expect(source).toContain(
      "Com trabalho pendente, `heartbeat trigger` retorna dry-run (exit 3) e exige `--execute`.",
    );
    expect(source).not.toContain("`3` NÃO acontece neste domínio");
    expect(source).not.toContain("nenhum comando aceita `--execute`");
    expect(source).not.toContain("aqui NÃO existe `--execute`");
  });
});
