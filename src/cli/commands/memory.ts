import "reflect-metadata";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { Command, CommandAccess, Group, Option } from "../decorators.js";
import { fail } from "../context.js";
import { applyDeterministicGuard, DEFAULT_MEMORY_CAP_CHARS } from "../../memory/index.js";
import type { MemoryStoreKind } from "../../memory/index.js";
import { declareCommandReturns } from "./operational-return-schemas.js";

@Group({
  name: "memory",
  description: "Deterministic memory curation guard (spec memory/curation/deterministic-loop)",
  scope: "open",
})
export class MemoryCommands {
  @Command({
    name: "guard",
    description:
      "Route a curator write through the deterministic guard (R9/R9b scan + R3 cap + R10 atomic + R22 telemetry). The curator LLM MUST call this instead of Write for every proposed entry — it is the enforcement layer that keeps the LLM honest.",
  })
  @CommandAccess({ kind: "mutate", resource: "memory", action: "guard", risk: "medium" })
  async guard(
    @Option({ flags: "--target <path>", description: "Absolute path of the target store (e.g. /path/MEMORY.md)" })
    target?: string,
    @Option({
      flags: "--candidate-file <path>",
      description: "Absolute path of the file containing the candidate content to append",
    })
    candidateFile?: string,
    @Option({
      flags: "--candidate <text>",
      description: "Inline candidate content (alternative to --candidate-file); useful for short entries",
    })
    candidate?: string,
    @Option({ flags: "--agent <id>", description: "Agent id whose memory this write belongs to (for telemetry)" })
    agentId?: string,
    @Option({
      flags: "--cadence-turn <n>",
      description: "Cadence turn that triggered this cycle (uint) — carried in telemetry",
    })
    cadenceTurn?: string,
    @Option({
      flags: "--cap-chars <n>",
      description: `Hard character cap for the target store (default ${DEFAULT_MEMORY_CAP_CHARS})`,
    })
    capChars?: string,
    @Option({
      flags: "--store <kind>",
      description: "'memory' | 'user' — governs telemetry buckets; default 'memory'",
    })
    store?: string,
    @Option({
      flags: "--session-key <key>",
      description: "Session key that originated the write; goes into telemetry for R23 audit",
    })
    sessionKey?: string,
    @Option({
      flags: "--session-name <name>",
      description: "Human session name (for cross-referencing in the telemetry stream)",
    })
    sessionName?: string,
    @Option({
      flags: "--had-user-correction",
      description: "Flag on when the session had a clear user correction — R23 marks recallMiss if saved=0",
    })
    hadUserCorrection?: boolean,
    @Option({
      flags: "--task-id <id>",
      description: "Curator task id for telemetry cross-reference",
    })
    taskId?: string,
    @Option({
      flags: "--hook-id <id>",
      description: "Originating hook id (when dispatched from a dispatch_task hook)",
    })
    hookId?: string,
    @Option({
      flags: "--consolidation-attempt <n>",
      description: "1-indexed attempt within the current turn; guard rejects at max (default 3)",
    })
    consolidationAttempt?: string,
    @Option({
      flags: "--consolidation-max-attempts <n>",
      description: "Override the anti-thrash max (default 3)",
    })
    consolidationMaxAttempts?: string,
    @Option({
      flags: "--expected-prior <path>",
      description: "Path with content the caller last observed (R10 drift check)",
    })
    expectedPriorPath?: string,
    @Option({
      flags: "--dry-run",
      description: "Return the projected write outcome WITHOUT touching disk",
    })
    dryRun?: boolean,
    @Option({ flags: "--json", description: "Print structured JSON (default). Text mode is human summary." })
    asJson?: boolean,
  ) {
    if (!target?.trim()) {
      fail("--target is required");
    }
    if (!candidateFile?.trim() && !candidate?.trim()) {
      fail("provide either --candidate-file <path> or --candidate <text>");
    }
    if (candidateFile?.trim() && candidate?.trim()) {
      fail("--candidate-file and --candidate are mutually exclusive");
    }

    let candidateContent: string;
    if (candidateFile?.trim()) {
      const path = candidateFile.trim();
      if (!existsSync(path)) {
        fail(`--candidate-file not found: ${path}`);
      }
      candidateContent = readFileSync(path, "utf-8");
    } else {
      candidateContent = candidate!.trim();
    }

    const targetPath = target!.trim();
    const currentContent = existsSync(targetPath) ? readFileSync(targetPath, "utf-8") : "";
    const expectedPriorContent = resolveExpectedPrior(expectedPriorPath, targetPath, currentContent);

    const parsedCadence = parsePositiveInt(cadenceTurn, "--cadence-turn") ?? 0;
    const parsedCap = parsePositiveInt(capChars, "--cap-chars");
    const parsedAttempt = parsePositiveInt(consolidationAttempt, "--consolidation-attempt");
    const parsedMaxAttempts = parsePositiveInt(consolidationMaxAttempts, "--consolidation-max-attempts");
    const normalizedStore = normalizeStore(store);

    const result = await applyDeterministicGuard({
      targetPath,
      ...(expectedPriorContent !== undefined ? { expectedPriorContent } : {}),
      candidate: { content: candidateContent },
      currentContent,
      ...(parsedCap !== undefined ? { capChars: parsedCap } : {}),
      ...(normalizedStore ? { store: normalizedStore } : {}),
      ...(parsedAttempt !== undefined ? { consolidationAttempt: parsedAttempt } : {}),
      ...(parsedMaxAttempts !== undefined ? { consolidationMaxAttempts: parsedMaxAttempts } : {}),
      telemetry: {
        agentId: agentId?.trim() || "unknown",
        cadenceTurn: parsedCadence,
        ...(sessionKey?.trim() ? { sessionKey: sessionKey.trim() } : {}),
        ...(sessionName?.trim() ? { sessionName: sessionName.trim() } : {}),
        ...(hadUserCorrection ? { hadUserCorrection: true } : {}),
        ...(taskId?.trim() ? { taskId: taskId.trim() } : {}),
        ...(hookId?.trim() ? { hookId: hookId.trim() } : {}),
        ...(dryRun ? { dryRun: true } : {}),
      },
    });

    const payload = {
      outcome: result.decision.outcome,
      ...("reason" in result.decision ? { reason: result.decision.reason } : {}),
      ...("detail" in result.decision ? { detail: result.decision.detail } : {}),
      ...("finalChars" in result.decision ? { finalChars: result.decision.finalChars } : {}),
      ...("backupPath" in result.decision ? { backupPath: result.decision.backupPath } : {}),
      target: targetPath,
      store: normalizedStore ?? "memory",
      scans: result.scans,
      cap: result.cap,
      dryRun: Boolean(dryRun),
    };

    if (asJson === false) {
      printHumanSummary(payload);
    } else {
      console.log(JSON.stringify(payload, null, 2));
    }
    return payload;
  }
}

function resolveExpectedPrior(
  expectedPriorPath: string | undefined,
  targetPath: string,
  currentContent: string,
): string | undefined {
  if (expectedPriorPath?.trim()) {
    const path = expectedPriorPath.trim();
    if (!existsSync(path)) {
      fail(`--expected-prior file not found: ${path}`);
    }
    return readFileSync(path, "utf-8");
  }
  // When the target already exists but the caller did not pass --expected-prior,
  // fall back to whatever is on disk right now — R10 drift is still checked
  // between this read and the atomicWrite (the guard re-reads before writing).
  return existsSync(targetPath) ? currentContent : undefined;
}

function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    fail(`${flag} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function normalizeStore(value: string | undefined): MemoryStoreKind | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed !== "memory" && trimmed !== "user") {
    fail(`--store must be 'memory' or 'user', got ${JSON.stringify(value)}`);
  }
  return trimmed as MemoryStoreKind;
}

function printHumanSummary(payload: {
  outcome: string;
  reason?: string;
  detail?: string;
  target: string;
  store: string;
  scans: {
    secret: { hadSecret: boolean; isCredentialOnly: boolean; matchCount: number };
    injection: { hadInjection: boolean; matchCount: number };
  };
  cap: { ok: boolean; proposedChars: number; cap: number; overflowChars: number };
  dryRun: boolean;
}): void {
  console.log(`memory guard ${payload.dryRun ? "(dry-run) " : ""}→ ${payload.outcome.toUpperCase()}`);
  console.log(`  target:    ${payload.target}`);
  console.log(`  store:     ${payload.store}`);
  if (payload.reason) console.log(`  reason:    ${payload.reason}`);
  if (payload.detail) console.log(`  detail:    ${payload.detail}`);
  console.log(
    `  scans:     secret=${payload.scans.secret.matchCount}${payload.scans.secret.isCredentialOnly ? " (credential-only)" : ""}, injection=${payload.scans.injection.matchCount}`,
  );
  console.log(
    `  cap:       ${payload.cap.proposedChars}/${payload.cap.cap} chars ${payload.cap.ok ? "OK" : `(OVERFLOW +${payload.cap.overflowChars})`}`,
  );
}

const guardOutcomeSchema = z.enum(["written", "rejected", "drift"]);

const memoryGuardReturnSchema = z.object({
  outcome: guardOutcomeSchema,
  reason: z.string().optional(),
  detail: z.string().optional(),
  finalChars: z.number().optional(),
  backupPath: z.string().optional(),
  target: z.string(),
  store: z.enum(["memory", "user"]),
  scans: z.object({
    secret: z.object({
      hadSecret: z.boolean(),
      isCredentialOnly: z.boolean(),
      matchCount: z.number(),
    }),
    injection: z.object({
      hadInjection: z.boolean(),
      matchCount: z.number(),
    }),
  }),
  cap: z.object({
    ok: z.boolean(),
    proposedChars: z.number(),
    cap: z.number(),
    overflowChars: z.number(),
  }),
  dryRun: z.boolean(),
});

declareCommandReturns(MemoryCommands, {
  guard: memoryGuardReturnSchema,
});
