import "reflect-metadata";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Command, CommandAccess, Group, Option } from "../decorators.js";
import { fail, getContext } from "../context.js";
import {
  applyDeterministicGuard,
  DEFAULT_MEMORY_CAP_CHARS,
  DEFAULT_MEMORY_FILE_CAP_CHARS,
  provisionAgentMemory,
  commitCurationWatermark,
} from "../../memory/index.js";
import type { MemoryStoreKind } from "../../memory/index.js";
import { resolveAuthorizedMemoryGuardTarget } from "../../memory/guard-target.js";
import { getAgent, getAllAgents } from "../../router/index.js";
import { dbResolveActiveTaskBindingForSession } from "../../tasks/task-db.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { declareCommandReturns } from "./operational-return-schemas.js";

const CURATOR_PROFILE_ID = "curador-memoria";
const DEFAULT_ENROLL_CADENCE = 10;

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
    @Option({
      flags: "--agent <id>",
      description: "Authenticated curator agent assertion (must match the execution identity); also used in telemetry",
    })
    agentId?: string,
    @Option({
      flags: "--cadence-turn <n>",
      description: "Cadence turn that triggered this cycle (uint) — carried in telemetry",
    })
    cadenceTurn?: string,
    @Option({
      flags: "--cap-chars <n>",
      description: `Hard character cap for the target FILE (memory store defaults to ${DEFAULT_MEMORY_FILE_CAP_CHARS}; the prompt-injection budget is the separate read cap ${DEFAULT_MEMORY_CAP_CHARS})`,
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
      flags: "--processed-through-message-id <n>",
      description:
        "R27: highest messages.id (src/db.ts) the curator read through this cycle. On a successful write, advances the session's incremental-read watermark so the NEXT cycle's CURATOR_TRANSCRIPT.md only contains rows added after it, instead of re-reading the whole session. Requires --session-key.",
    })
    processedThroughMessageId?: string,
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

    const identity = requireAuthenticatedMemoryCurator(agentId, taskId);
    let targetPath: string;
    try {
      targetPath = resolveAuthorizedMemoryGuardTarget({
        agentCwd: identity.agentCwd,
        targetPath: target!.trim(),
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
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
        agentId: identity.agentId,
        cadenceTurn: parsedCadence,
        ...(sessionKey?.trim() ? { sessionKey: sessionKey.trim() } : {}),
        ...(sessionName?.trim() ? { sessionName: sessionName.trim() } : {}),
        ...(hadUserCorrection ? { hadUserCorrection: true } : {}),
        taskId: identity.taskId,
        ...(hookId?.trim() ? { hookId: hookId.trim() } : {}),
        ...(dryRun ? { dryRun: true } : {}),
      },
    });

    // R27/P1: the LLM-reported watermark is now a NO-OP-SAFE FALLBACK. The
    // authoritative advance happens in the runtime when the curator task
    // completes (advanceWatermarkForCompletedCuratorTask via completeTask), so
    // a proposto=0 cycle over a non-empty delta still moves the cursor. This
    // path only nudges the watermark forward on a successful write; because the
    // commit is monotonic (Math.max), a double-advance with the completion path
    // is harmless. Never advances on rejected/drift.
    const parsedProcessedMessageId = parsePositiveInt(processedThroughMessageId, "--processed-through-message-id");
    if (
      result.decision.outcome === "written" &&
      !dryRun &&
      parsedProcessedMessageId !== undefined &&
      sessionKey?.trim()
    ) {
      commitCurationWatermark(sessionKey.trim(), parsedCadence || 1, parsedProcessedMessageId);
    }

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

  @Command({
    name: "enroll",
    description:
      "Provision automatic memory curation for an agent (or all agents): create MEMORY.md cold-start file + register the global `memory-curator` Stop hook that dispatches curador-memoria on cadence. Idempotent — safe to re-run after every deploy.",
  })
  @CommandAccess({ kind: "mutate", resource: "memory", action: "enroll", risk: "medium" })
  async enroll(
    @Option({
      flags: "--agent <id>",
      description: "Enroll a single agent id (mutually exclusive with --all)",
    })
    agent?: string,
    @Option({
      flags: "--all",
      description: "Enroll every registered agent",
    })
    all?: boolean,
    @Option({
      flags: "--cadence-turns <n>",
      description: `Turn cadence for the curator hook (default ${DEFAULT_ENROLL_CADENCE})`,
    })
    cadenceTurns?: string,
    @Option({
      flags: "--skip-hook",
      description: "Only provision MEMORY.md files; skip creating the memory-curator hook",
    })
    skipHook?: boolean,
    @Option({
      flags: "--json",
      description: "Print raw JSON result",
    })
    asJson?: boolean,
  ) {
    if (agent && all) {
      fail("--agent and --all are mutually exclusive");
    }
    if (!agent && !all) {
      fail("provide --agent <id> or --all");
    }

    const cadence = parsePositiveInt(cadenceTurns, "--cadence-turns") ?? DEFAULT_ENROLL_CADENCE;
    if (cadence < 2) {
      fail("--cadence-turns must be >= 2 (curator reentrancy protection)");
    }

    const targets = all ? getAllAgents() : [getAgent(agent!)].filter(Boolean);
    if (targets.length === 0) {
      fail(agent ? `Agent not found: ${agent}` : "No agents registered");
    }

    const enrolled: Array<{
      agentId: string;
      cwd: string;
      memoryPath: string;
      memoryFileCreated: boolean;
      memoryDirCreated: boolean;
    }> = [];

    for (const agentConfig of targets) {
      if (!agentConfig?.cwd) continue;
      const provision = provisionAgentMemory(agentConfig.id, agentConfig.cwd);
      enrolled.push({
        agentId: agentConfig.id,
        cwd: agentConfig.cwd,
        memoryPath: provision.memoryPath,
        memoryFileCreated: provision.memoryFileCreated,
        memoryDirCreated: provision.memoryDirCreated,
      });
    }

    const payload = {
      enrolled,
      cadence: {
        mode: "runtime-terminal-turn" as const,
        profileId: CURATOR_PROFILE_ID,
        cadenceTurns: cadence,
        skipped: Boolean(skipHook),
      },
    };

    if (asJson === false) {
      printEnrollSummary(payload);
    } else {
      console.log(JSON.stringify(payload, null, 2));
    }
    return payload;
  }

  @Command({
    name: "list",
    description:
      "List every agent's memory footprint (index size, topic count, last modified). Useful for the operator: 'quem tem memória, quanto, quando foi última curadoria?'",
  })
  @CommandAccess({ kind: "read", resource: "memory", action: "list", risk: "low" })
  list(
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching agents to skip (default: 0)" }) offset?: string,
  ) {
    const rowsAll = getAllAgents()
      .filter((a) => a?.cwd)
      .map((a) => {
        const cwd = a.cwd.replace("~", homedir());
        const memoryPath = join(cwd, "MEMORY.md");
        const memoryDir = join(cwd, "memory");
        let memoryChars = 0;
        let memoryLastModified: number | null = null;
        if (existsSync(memoryPath)) {
          const stat = statSync(memoryPath);
          memoryChars = stat.size;
          memoryLastModified = stat.mtimeMs;
        }
        let topicCount = 0;
        if (existsSync(memoryDir)) {
          const entries = readdirSync(memoryDir, { withFileTypes: true });
          topicCount = entries.filter((e) => e.isFile() && e.name.endsWith(".md")).length;
        }
        return {
          agentId: a.id,
          cwd,
          memoryPath,
          exists: existsSync(memoryPath),
          memoryChars,
          topicCount,
          memoryLastModified,
        };
      });

    const page = paginateCliItems(rowsAll, { limit, offset });
    const rows = page.items;
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "memory", "list"],
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      returned: rows.length,
    });

    if (asJson) {
      console.log(JSON.stringify({ agents: rows, pagination }, null, 2));
    } else {
      console.log(`${page.total} agent(s) — showing ${rows.length} (offset ${page.offset}, limit ${page.limit}):`);
      for (const row of rows) {
        const modified = row.memoryLastModified ? new Date(row.memoryLastModified).toISOString() : "never";
        const mark = row.exists ? `${row.memoryChars}c/${row.topicCount}t` : "(no MEMORY.md)";
        console.log(`  · ${row.agentId.padEnd(32)} ${mark.padEnd(16)} last-modified ${modified}`);
      }
      if (pagination.nextCommand) {
        console.log(`Next: ${pagination.nextCommand}`);
      }
    }
    return { agents: rows, pagination };
  }

  @Command({
    name: "show",
    description: "Print an agent's MEMORY.md to stdout (raw file). Fails if the agent is unknown or unenrolled.",
  })
  @CommandAccess({ kind: "read", resource: "memory", action: "show", risk: "low" })
  show(
    @Option({ flags: "--agent <id>", description: "Agent id to show memory for" }) agentId?: string,
    @Option({ flags: "--topic <slug>", description: "Show a specific topic file under memory/ instead of the index" })
    topic?: string,
    @Option({ flags: "--json", description: "Wrap the file content in JSON" }) asJson?: boolean,
  ) {
    if (!agentId?.trim()) {
      fail("--agent is required");
    }
    const agentConfig = getAgent(agentId!.trim());
    if (!agentConfig?.cwd) {
      fail(`Agent not found or missing cwd: ${agentId}`);
    }
    const cwd = agentConfig.cwd.replace("~", homedir());
    const target = topic?.trim()
      ? join(cwd, "memory", topic.trim().endsWith(".md") ? topic.trim() : `${topic.trim()}.md`)
      : join(cwd, "MEMORY.md");
    if (!existsSync(target)) {
      fail(`Not found: ${target}`);
    }
    const content = readFileSync(target, "utf-8");
    if (asJson) {
      console.log(JSON.stringify({ agentId, path: target, content }, null, 2));
    } else {
      process.stdout.write(content);
    }
    return { agentId, path: target, content };
  }

  @Command({
    name: "curate",
    description:
      "Force one curator cycle NOW for an agent, without waiting for cadence. Creates a task with profile curador-memoria and dispatches it. Useful for first-run seeding, debugging, and manual audits.",
  })
  @CommandAccess({ kind: "mutate", resource: "memory", action: "curate", risk: "medium" })
  async curate(
    @Option({ flags: "--agent <id>", description: "Agent id to curate memory for" }) agentId?: string,
    @Option({
      flags: "--transcript <path>",
      description: "Path to the transcript to feed the curator (defaults to <agentCwd>/CURATOR_TRANSCRIPT.md)",
    })
    transcript?: string,
    @Option({ flags: "--dry-run", description: "Task instructs the curator to propose but not persist" })
    dryRun?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!agentId?.trim()) {
      fail("--agent is required");
    }
    const agentConfig = getAgent(agentId!.trim());
    if (!agentConfig?.cwd) {
      fail(`Agent not found or missing cwd: ${agentId}`);
    }
    const cwd = agentConfig.cwd.replace("~", homedir());
    const memoryPath = join(cwd, "MEMORY.md");
    const memoryDir = join(cwd, "memory");
    const transcriptPath = transcript?.trim() || join(cwd, "CURATOR_TRANSCRIPT.md");
    if (!existsSync(transcriptPath)) {
      fail(`Transcript not found: ${transcriptPath}`);
    }

    const { createTask, queueOrDispatchTask } = await import("../../tasks/index.js");
    const created = createTask({
      title: `Manual curation for ${agentConfig.id} @ ${new Date().toISOString()}`,
      instructions: "Manual curation dispatched by `ravi memory curate` — no cadence gate applies.",
      profileId: CURATOR_PROFILE_ID,
      createdBy: "ravi memory curate",
      profileInput: {
        agent_id: agentConfig.id,
        transcript_path: transcriptPath,
        memory_path: memoryPath,
        memory_dir: memoryDir,
        cadence_turn: "0",
        originator: "manual-curate",
        originator_session: "cli",
        ...(dryRun ? { dry_run: "true" } : {}),
      },
    });
    await queueOrDispatchTask(created.task.id, {
      agentId: agentConfig.id,
      sessionName: `${created.task.id}-curator`,
      assignedBy: "ravi memory curate",
    });

    const payload = { taskId: created.task.id, agentId: agentConfig.id, dryRun: Boolean(dryRun), transcriptPath };
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`✓ Curator dispatched: task ${created.task.id} → ${agentConfig.id}${dryRun ? " (dry-run)" : ""}`);
      console.log(`  transcript: ${transcriptPath}`);
      console.log(`  follow: ravi tasks show ${created.task.id}`);
    }
    return payload;
  }
}

function requireAuthenticatedMemoryCurator(
  assertedAgentId?: string,
  assertedTaskId?: string,
): { agentId: string; agentCwd: string; taskId: string } {
  const ctx = getContext();
  const runtime = ctx?.context;
  const agentId = runtime?.agentId?.trim();
  const sessionName = runtime?.sessionName?.trim() || ctx?.sessionName?.trim();
  const metadata = runtime?.metadata ?? {};
  const taskId = typeof metadata.taskSelfTaskId === "string" ? metadata.taskSelfTaskId.trim() : "";

  if (!runtime || runtime.kind !== "turn-runtime" || metadata.authorityMode !== "agent-identity") {
    fail("memory guard requires an authenticated agent-identity turn context");
  }
  if (!agentId || !sessionName || !taskId) {
    fail("memory guard requires an authenticated active curator task binding");
  }
  if (assertedAgentId?.trim() && assertedAgentId.trim() !== agentId) {
    fail(`--agent must match the authenticated execution identity (${agentId})`);
  }
  if (assertedTaskId?.trim() && assertedTaskId.trim() !== taskId) {
    fail(`--task-id must match the authenticated curator task (${taskId})`);
  }

  const binding = dbResolveActiveTaskBindingForSession(sessionName, taskId);
  const task = binding?.task;
  if (
    !binding ||
    !task ||
    !["dispatched", "in_progress"].includes(task.status) ||
    task.profileId !== CURATOR_PROFILE_ID ||
    task.createdBy !== "runtime:memory-nudge" ||
    task.assigneeAgentId !== agentId ||
    binding.assignment.agentId !== agentId ||
    task.profileInput?.agent_id !== agentId
  ) {
    fail("memory guard is limited to the authenticated runtime memory-curator task for this agent");
  }

  const agentCwd = getAgent(agentId)?.cwd;
  if (!agentCwd) {
    fail(`authenticated agent has no registered cwd: ${agentId}`);
  }
  return { agentId, agentCwd, taskId };
}

function printEnrollSummary(payload: {
  enrolled: Array<{
    agentId: string;
    memoryPath: string;
    memoryFileCreated: boolean;
    memoryDirCreated: boolean;
  }>;
  cadence: { mode: "runtime-terminal-turn"; profileId: string; cadenceTurns: number; skipped: boolean };
}): void {
  console.log(`Enrolled ${payload.enrolled.length} agent(s) in deterministic memory curation.`);
  for (const entry of payload.enrolled) {
    const marks = [
      entry.memoryFileCreated ? "MEMORY.md ✓ (new)" : "MEMORY.md · (exists)",
      entry.memoryDirCreated ? "memory/ ✓ (new)" : "memory/ · (exists)",
    ];
    console.log(`  · ${entry.agentId}: ${marks.join(", ")} — ${entry.memoryPath}`);
  }
  console.log(
    `Cadence: ${payload.cadence.skipped ? "SKIPPED (--skip-hook)" : payload.cadence.mode} (${payload.cadence.profileId}, every ${payload.cadence.cadenceTurns} terminal turns)`,
  );
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

const memoryGuardReturnSchema = z
  .object({
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
  })
  .strict();

const memoryEnrollReturnSchema = z
  .object({
    enrolled: z.array(
      z
        .object({
          agentId: z.string(),
          cwd: z.string(),
          memoryPath: z.string(),
          memoryFileCreated: z.boolean(),
          memoryDirCreated: z.boolean(),
        })
        .strict(),
    ),
    cadence: z
      .object({
        mode: z.literal("runtime-terminal-turn"),
        profileId: z.string(),
        cadenceTurns: z.number(),
        skipped: z.boolean(),
      })
      .strict(),
  })
  .strict();

const memoryListReturnSchema = z
  .object({
    agents: z.array(
      z
        .object({
          agentId: z.string(),
          cwd: z.string(),
          memoryPath: z.string(),
          exists: z.boolean(),
          memoryChars: z.number(),
          topicCount: z.number(),
          memoryLastModified: z.number().nullable(),
        })
        .strict(),
    ),
    pagination: z
      .object({
        limit: z.number(),
        offset: z.number(),
        returned: z.number(),
        total: z.number(),
        hasMore: z.boolean().optional(),
        nextOffset: z.number().nullable().optional(),
        nextCommand: z.string().nullable().optional(),
      })
      .strict(),
  })
  .strict();

const memoryShowReturnSchema = z
  .object({
    agentId: z.string(),
    path: z.string(),
    content: z.string(),
  })
  .strict();

const memoryCurateReturnSchema = z
  .object({
    taskId: z.string(),
    agentId: z.string(),
    dryRun: z.boolean(),
    transcriptPath: z.string(),
  })
  .strict();

declareCommandReturns(MemoryCommands, {
  guard: memoryGuardReturnSchema,
  enroll: memoryEnrollReturnSchema,
  list: memoryListReturnSchema,
  show: memoryShowReturnSchema,
  curate: memoryCurateReturnSchema,
});
