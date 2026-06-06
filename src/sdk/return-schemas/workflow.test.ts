import "reflect-metadata";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { CliOnly, Command, Group, Returns } from "../../cli/decorators.js";
import { buildRegistry } from "../../cli/registry-snapshot.js";
import {
  assignReturnSchemaCommands,
  buildReturnSchemaTaskPlan,
  getReturnSchemaCommand,
  listReturnSchemaCommands,
  markReturnSchemaCommand,
  syncReturnSchemaWorkflow,
  validateReturnSchemaWorkflow,
} from "./workflow.js";

@Group({ name: "demo", description: "Demo", scope: "open" })
class DemoCommandsV1 {
  @Command({ name: "typed", description: "Typed" })
  @Returns(z.object({ ok: z.boolean() }))
  typed() {
    return { ok: true };
  }

  @Command({ name: "missing", description: "Missing" })
  missing() {
    return { ok: true };
  }

  @Command({ name: "loose", description: "Loose" })
  @Returns(z.object({}).passthrough())
  loose() {
    return { ok: true };
  }

  @Command({ name: "blob", description: "Blob" })
  @Returns.binary()
  blob() {
    return new Response("ok");
  }

  @Command({ name: "local", description: "Local" })
  @CliOnly()
  local() {
    return { ok: true };
  }
}

@Group({ name: "demo", description: "Demo", scope: "open" })
class DemoCommandsV2 {
  @Command({ name: "typed", description: "Typed" })
  @Returns(z.object({ ok: z.boolean(), value: z.string() }))
  typed() {
    return { ok: true, value: "changed" };
  }

  @Command({ name: "missing", description: "Missing" })
  missing() {
    return { ok: true };
  }
}

function withDbPath<T>(fn: (dbPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ravi-return-schemas-"));
  try {
    return fn(join(dir, "returns.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("return schema workflow", () => {
  it("syncs typed, binary, missing, and cli-only commands into local state", () => {
    withDbPath((dbPath) => {
      const registry = buildRegistry([DemoCommandsV1]);
      const result = syncReturnSchemaWorkflow({ dbPath, registry, now: new Date("2026-01-01T00:00:00.000Z") });

      expect(result.inserted).toBe(5);
      expect(result.summary.publicCommands).toBe(4);
      expect(result.summary.typedPublic).toBe(2);
      expect(result.summary.binaryPublic).toBe(1);
      expect(result.summary.missingPublic).toBe(1);
      expect(result.summary.weakPublic).toBe(1);
      expect(result.summary.newlyWeak).toEqual(["demo.loose"]);
      expect(result.summary.cliOnlyCommands).toEqual(["demo.local"]);

      expect(getReturnSchemaCommand("demo.typed", { dbPath })?.status).toBe("typed");
      expect(getReturnSchemaCommand("demo.loose", { dbPath })?.status).toBe("typed");
      expect(getReturnSchemaCommand("demo.blob", { dbPath })?.returnKind).toBe("binary");
      expect(getReturnSchemaCommand("demo.missing", { dbPath })?.status).toBe("discovered");
      expect(getReturnSchemaCommand("demo.local", { dbPath })?.status).toBe("not_applicable");
    });
  });

  it("preserves manual in-progress state for missing commands", () => {
    withDbPath((dbPath) => {
      const registry = buildRegistry([DemoCommandsV1]);
      syncReturnSchemaWorkflow({ dbPath, registry });
      markReturnSchemaCommand({ fullName: "demo.missing", status: "in_progress", taskId: "task-1" }, { dbPath });

      syncReturnSchemaWorkflow({ dbPath, registry });
      const row = getReturnSchemaCommand("demo.missing", { dbPath });
      expect(row?.status).toBe("in_progress");
      expect(row?.taskId).toBe("task-1");
    });
  });

  it("keeps reviewed status when schema hash is stable and resets to typed on schema drift", () => {
    withDbPath((dbPath) => {
      const registryV1 = buildRegistry([DemoCommandsV1]);
      syncReturnSchemaWorkflow({ dbPath, registry: registryV1 });
      const reviewed = markReturnSchemaCommand({ fullName: "demo.typed", status: "reviewed" }, { dbPath });

      syncReturnSchemaWorkflow({ dbPath, registry: registryV1 });
      expect(getReturnSchemaCommand("demo.typed", { dbPath })?.status).toBe("reviewed");

      const registryV2 = buildRegistry([DemoCommandsV2]);
      syncReturnSchemaWorkflow({ dbPath, registry: registryV2 });
      const drifted = getReturnSchemaCommand("demo.typed", { dbPath });
      expect(drifted?.status).toBe("typed");
      expect(drifted?.schemaHash).not.toBe(reviewed.schemaHash);
      expect(drifted?.reviewedAt).toBeNull();
    });
  });

  it("validates tracking rows and produces a migration task plan", () => {
    withDbPath((dbPath) => {
      const registry = buildRegistry([DemoCommandsV1]);
      syncReturnSchemaWorkflow({ dbPath, registry });

      const validation = validateReturnSchemaWorkflow({ dbPath, registry });
      expect(validation.ok).toBe(false);
      expect(validation.issues.some((issue) => issue.code === "NEW_UNTYPED_PUBLIC_COMMAND")).toBe(true);
      expect(validation.issues.some((issue) => issue.code === "NEW_WEAK_PUBLIC_RETURN_SCHEMA")).toBe(true);
      expect(validation.issues.some((issue) => issue.code === "CLI_ONLY_COMMAND")).toBe(false);

      const missing = listReturnSchemaCommands({ dbPath, kind: "missing" });
      expect(missing.items.map((item) => item.fullName)).toEqual(["demo.missing"]);

      const plan = buildReturnSchemaTaskPlan({ dbPath, registry });
      expect(plan.totalMissingPublic).toBe(1);
      expect(plan.tasks.at(-1)?.commands).toContain("demo.missing");
    });
  });

  it("strict validation requires reviewed public return schemas", () => {
    withDbPath((dbPath) => {
      const registry = buildRegistry([DemoCommandsV1]);
      syncReturnSchemaWorkflow({ dbPath, registry });

      const validation = validateReturnSchemaWorkflow({ dbPath, registry, strict: true });
      expect(validation.strict).toBe(true);
      expect(validation.ok).toBe(false);
      expect(validation.issues.some((issue) => issue.code === "CLI_ONLY_COMMAND")).toBe(true);
      expect(validation.issues.some((issue) => issue.code === "UNREVIEWED_PUBLIC_RETURN_SCHEMA")).toBe(true);
    });
  });

  it("assigns matching rows to a task without touching already assigned rows by default", () => {
    withDbPath((dbPath) => {
      const registry = buildRegistry([DemoCommandsV1]);
      syncReturnSchemaWorkflow({ dbPath, registry });

      const first = assignReturnSchemaCommands(
        {
          taskId: "task-one",
          groups: ["demo"],
          kind: "missing",
          status: "in_progress",
        },
        { dbPath },
      );
      expect(first.updated).toBe(1);
      expect(first.commands).toEqual(["demo.missing"]);
      expect(getReturnSchemaCommand("demo.missing", { dbPath })?.taskId).toBe("task-one");

      const second = assignReturnSchemaCommands(
        {
          taskId: "task-two",
          groups: ["demo"],
          kind: "missing",
          status: "blocked",
        },
        { dbPath },
      );
      expect(second.updated).toBe(0);
      expect(getReturnSchemaCommand("demo.missing", { dbPath })?.taskId).toBe("task-one");
    });
  });
});
