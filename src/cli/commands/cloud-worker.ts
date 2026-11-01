/**
 * `ravi cloud worker list|enable|disable|session` and `ravi cloud worker key
 * set|remove`: this machine as the executor of cloud agents placed on it
 * (`"placement": "installation"`, F4). The provider runs the model; the tools
 * (bash, files) run here, in `~/.ravi/cloud-workers/<agentId>/work`, through
 * the daemon's worker runner. The runner stays off until `enable --execute`.
 * Environment keys are typed in from stdin, stored 0600 and go to the
 * provider only, never to the Console.
 *
 * `session` is the sandbox side of the Ravi provider prototype: the Console
 * starts it inside an E2B sandbox with RAVI_SESSION_CALLBACK_URL and
 * RAVI_SESSION_TOKEN.
 *
 * spec: cloud/agents, cli
 */

import "reflect-metadata";
import { z } from "zod";

import { listCloudWorkers } from "../../cloud-agents/client-product.js";
import { CLOUD_WORKER_HEARTBEAT_MS } from "../../cloud-agents/worker-runner.js";
import { runWorkerSession, WorkerSessionError, type WorkerSessionDeps } from "../../cloud-agents/worker-session.js";
import {
  cloudWorkerWorkdir,
  getCloudWorkersDir,
  isCloudWorkerId,
  isCloudWorkerKey,
  listCloudWorkerKeyIds,
  readCloudWorkerKey,
  readCloudWorkerRuntime,
  readCloudWorkerState,
  removeCloudWorkerKey,
  writeCloudWorkerKey,
  writeCloudWorkerState,
} from "../../cloud-agents/worker-store.js";
import { CONTRACT_EXIT_USAGE, contractDryRun, contractFail } from "../agent-contract.js";
import {
  cloudPaginationReturnSchema,
  pageCloudList,
  usageError,
  withCloudAgentsContract,
} from "../cloud-agents-contract.js";
import {
  type CloudProductCommandDeps,
  cloudWorkerReturnSchema,
  printJson,
  productDefaults,
  productSession,
  refuseInAgentRuntime,
  requireArg,
} from "../cloud-product-contract.js";
import { Arg, CliOnly, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";

const ENABLE_HELP_AFTER = `
MUTATE (BRAKED) — lets the daemon run the tools of cloud agents placed on this
machine ("placement": "installation" in the agent's cloud block). The provider
runs the model; every bash command and file edit those agents make runs HERE,
as this user, in ~/.ravi/cloud-workers/<agent>/work. Only agents an owner or
admin approved are placed on an installation.

STEPS
  1. ravi cloud worker enable --execute
  2. ravi cloud worker list                                    # the workers waiting for a key
  3. ravi cloud worker key set <workerId> --stdin < <file-with-the-environment-key>

The daemon checks every 30 s, heartbeats each worker and restarts a failed one
with a backoff. 'ravi cloud worker disable' stops them all.

EXAMPLES
  ravi cloud worker enable                 # plan (exit 3)
  ravi cloud worker enable --execute
`;

const KEY_SET_HELP_AFTER = `
Stores the environment key of one worker (the provider shows it once, when the
self-hosted environment is created) in ~/.ravi/cloud-workers/keys/<workerId>.key,
mode 0600. The daemon's runner uses it to claim the environment's work. The key
is never sent to the Ravi Console, logged or printed.

RULES
  • The key is read from redirected stdin only; never pass it as an argument.
  • Agents do not set keys (CLOUD_AGENT_CANNOT_SET_SECRET, exit 3).

EXAMPLES
  ravi cloud worker key set wrk_123 --stdin < ~/keys/triage-env
`;

const SESSION_HELP_AFTER = `
Runs inside the sandbox the Console starts for an agent on the Ravi provider
(prototype). It reads RAVI_SESSION_CALLBACK_URL and RAVI_SESSION_TOKEN, takes
the session's instructions and messages from the Console, runs the agent with
the Claude Agent SDK (the Console MCP mounted as 'ravi'), waits for a person
before each write, reports its events and uploads /mnt/session/outputs. It
exits when the Console ends the session. Not for terminals.
`;

const workerEntrySchema = cloudWorkerReturnSchema
  .extend({
    localKey: z.boolean(),
    thisMachine: z.boolean(),
    workdir: z.string(),
    /** What the daemon's runner did with it on its last tick (null when the daemon has not reported lately). */
    local: z
      .object({
        state: z.enum(["running", "waiting_key", "backoff"]),
        error: z.string().nullable(),
        restartAt: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

/** The runner writes its state every 30 s; older than this, the daemon is not running it. */
const RUNTIME_FRESH_MS = 2 * 60_000;

const workerListSchema = z
  .object({
    success: z.literal(true),
    enabled: z.boolean(),
    enabledAt: z.string().nullable(),
    workers: z.array(workerEntrySchema),
    orphanKeys: z.array(z.string()),
    pagination: cloudPaginationReturnSchema,
  })
  .strict();

const workerStateSchema = z
  .object({ success: z.literal(true), enabled: z.boolean(), enabledAt: z.string().nullable(), changed: z.boolean() })
  .strict();

export interface CloudWorkerCommandDeps extends CloudProductCommandDeps {
  /** Runs the sandbox session (tests replace it). */
  runSession?: (deps: WorkerSessionDeps) => ReturnType<typeof runWorkerSession>;
}

@Group({
  name: "cloud.worker",
  description: "This machine as the executor of cloud agents placed on it (self-hosted environments)",
  scope: "open",
})
export class CloudWorkerCommands {
  constructor(private readonly deps: CloudWorkerCommandDeps = {}) {}

  @Command({
    name: "list",
    description: "List the workers assigned to this installation, with their key and the daemon's state",
  })
  @CommandAccess({ kind: "read", resource: "cloud.agents", action: "worker.list", risk: "low" })
  @Returns(workerListSchema)
  async list(
    @Option({ flags: "--limit <n>", description: "Page size (1-200, default 50)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Skip this many (default 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "cloud worker list";
    const env = productDefaults(this.deps).env;
    return withCloudAgentsContract(op, asJson, async () => {
      const session = await productSession(this.deps, undefined, false);
      const state = readCloudWorkerState(env);
      const keys = new Set(listCloudWorkerKeyIds(env));
      const runtime = readCloudWorkerRuntime(env);
      const fresh = runtime !== null && Date.now() - Date.parse(runtime.updatedAt) <= RUNTIME_FRESH_MS;
      const all = await listCloudWorkers(session.client);
      const page = pageCloudList(op, all, { limit, offset, command: "ravi cloud worker list" }, asJson);
      const workers = page.items.map((worker) => ({
        ...worker,
        localKey: keys.has(worker.id),
        thisMachine: !worker.installationId || worker.installationId === session.installationId,
        workdir: cloudWorkerWorkdir(worker.agentId || worker.id, env),
        local: fresh ? (runtime.workers[worker.id] ?? null) : null,
      }));
      const known = new Set(all.map((worker) => worker.id));
      const payload = {
        success: true as const,
        enabled: state.enabled,
        enabledAt: state.enabledAt,
        workers,
        orphanKeys: [...keys].filter((id) => !known.has(id)),
        pagination: page.pagination,
      };
      if (asJson) {
        printJson(payload);
        return payload;
      }
      console.log(
        state.enabled
          ? `Worker runner: enabled${state.enabledAt ? ` since ${state.enabledAt}` : ""}`
          : "Worker runner: disabled (ravi cloud worker enable --execute)",
      );
      if (workers.length === 0) console.log("No cloud agent is placed on this installation.");
      if (state.enabled && !fresh && workers.length > 0) {
        console.log("  The daemon has not run the workers lately: ravi daemon status");
      }
      for (const worker of workers) {
        const key = worker.thisMachine ? (worker.localKey ? "key set" : "no key") : "other machine";
        const local = worker.local
          ? `  here: ${worker.local.state}${worker.local.restartAt ? ` until ${worker.local.restartAt}` : ""}`
          : "";
        const lastError = worker.local?.error ?? worker.lastError;
        const error = lastError ? `  error: ${lastError}` : "";
        console.log(
          `  ${worker.id.padEnd(16)} ${worker.agentName.padEnd(24)} ${worker.status.padEnd(11)} ${key}  seen ${worker.lastSeenAt ?? "-"}${local}${error}`,
        );
      }
      const missing = workers.filter(
        (worker) => worker.thisMachine && !worker.localKey && worker.status !== "disabled",
      );
      if (missing.length > 0) {
        console.log(
          `Set a key with: ravi cloud worker key set ${missing[0]!.id} --stdin < <file-with-the-environment-key>`,
        );
      }
      for (const id of payload.orphanKeys) console.log(`  (a key for ${id} is stored but no worker has that id)`);
      return payload;
    });
  }

  @Command({
    name: "enable",
    description: "Let the daemon run the tools of cloud agents placed on this machine. Requires --execute.",
    helpAfter: ENABLE_HELP_AFTER,
  })
  @CliOnly()
  @CommandAccess({
    kind: "mutate",
    resource: "cloud.agents",
    action: "worker.enable",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(workerStateSchema)
  async enable(
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Enable the runner (without it, print the plan and exit 3)" })
    execute?: boolean,
  ) {
    const op = "cloud worker enable";
    refuseInAgentRuntime(op, this.deps, {
      code: "CLOUD_AGENT_CANNOT_ENABLE_WORKER",
      message: "Agents do not enable the cloud worker runner.",
      suggestedAction: "Ask the operator to run in a terminal: ravi cloud worker enable --execute",
      asJson,
    });
    const env = productDefaults(this.deps).env;
    const current = readCloudWorkerState(env);
    if (current.enabled) {
      const payload = { success: true as const, enabled: true, enabledAt: current.enabledAt, changed: false };
      if (asJson) printJson(payload);
      else console.log(`Worker runner already enabled${current.enabledAt ? ` since ${current.enabledAt}` : ""}.`);
      return payload;
    }
    if (execute !== true) {
      contractDryRun(
        op,
        {
          machine: "this machine (the Ravi daemon's user)",
          effect:
            "bash commands and file edits of cloud agents placed on this machine will run here, as this user, in their workdirs",
          workdirs: `${getCloudWorkersDir(env)}/<agentId>/work`,
          heartbeatSeconds: CLOUD_WORKER_HEARTBEAT_MS / 1000,
          keysStored: listCloudWorkerKeyIds(env).length,
          disableWith: "ravi cloud worker disable",
        },
        { asJson },
      );
    }
    const enabledAt = new Date().toISOString();
    writeCloudWorkerState({ enabled: true, enabledAt }, env);
    const payload = { success: true as const, enabled: true, enabledAt, changed: true };
    if (asJson) {
      printJson(payload);
    } else {
      console.log("✓ Worker runner enabled. Bash from cloud agents placed on this machine will run here.");
      console.log("  The daemon picks it up within 30 s. Next: ravi cloud worker list");
    }
    return payload;
  }

  @Command({ name: "disable", description: "Stop running cloud agents' tools on this machine (applies at once)" })
  @CommandAccess({ kind: "mutate", resource: "cloud.agents", action: "worker.disable", risk: "low" })
  @Returns(workerStateSchema)
  async disable(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const env = productDefaults(this.deps).env;
    const current = readCloudWorkerState(env);
    if (current.enabled) writeCloudWorkerState({ enabled: false, enabledAt: null }, env);
    const payload = { success: true as const, enabled: false, enabledAt: null, changed: current.enabled };
    if (asJson) printJson(payload);
    else
      console.log(
        current.enabled
          ? "✓ Worker runner disabled. The daemon stops the running workers within 30 s; their runs are refused."
          : "Worker runner already disabled.",
      );
    return payload;
  }

  @Command({
    name: "session",
    description: "Run one Ravi provider session inside its sandbox (started by the Console)",
    helpAfter: SESSION_HELP_AFTER,
  })
  @CliOnly()
  @CommandAccess({ kind: "mutate", resource: "cloud.agents", action: "worker.session", risk: "high" })
  @Returns(
    z
      .object({
        success: z.literal(true),
        status: z.literal("terminated"),
        turns: z.number(),
        eventsPosted: z.number(),
        outputsUploaded: z.number(),
      })
      .strict(),
  )
  async session(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const op = "cloud worker session";
    refuseInAgentRuntime(op, this.deps, {
      code: "CLOUD_WORKER_SESSION_SANDBOX_ONLY",
      message: "A Ravi provider session runs only in the sandbox the Console starts.",
      suggestedAction: 'Start a run of an agent on the Ravi provider: ravi cloud agents run <agent> "<prompt>"',
      asJson,
    });
    const env = productDefaults(this.deps).env;
    const run = this.deps.runSession ?? runWorkerSession;
    try {
      const result = await run({ env });
      const payload = { success: true as const, ...result };
      if (asJson) printJson(payload);
      else console.log(`Session ended after ${result.turns} turn(s); ${result.outputsUploaded} file(s) uploaded.`);
      return payload;
    } catch (error) {
      if (error instanceof WorkerSessionError) {
        contractFail(op, error.code, error.message, {
          asJson,
          exitCode: error.code === "SESSION_UNAUTHORIZED" ? 1 : CONTRACT_EXIT_USAGE,
        });
      }
      throw error;
    }
  }
}

@Group({
  name: "cloud.worker.key",
  description: "Environment keys of the workers on this machine (stored 0600, never sent to the Console)",
  scope: "open",
})
export class CloudWorkerKeyCommands {
  constructor(private readonly deps: CloudProductCommandDeps = {}) {}

  @Command({
    name: "set",
    description: "Store a worker's environment key from stdin (0600; never sent to the Console)",
    helpAfter: KEY_SET_HELP_AFTER,
  })
  @CliOnly()
  @CommandAccess({ kind: "mutate", resource: "cloud.agents", action: "worker.key_set", risk: "high" })
  @Returns(
    z
      .object({
        success: z.literal(true),
        workerId: z.string(),
        agentName: z.string(),
        stored: z.literal(true),
        replaced: z.boolean(),
        runnerEnabled: z.boolean(),
      })
      .strict(),
  )
  async set(
    @Arg("workerId", { description: "Worker id (ravi cloud worker list)" }) workerArg: string,
    @Option({ flags: "--stdin", description: "Read the key from redirected stdin (the only way to pass it)" })
    stdin?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "cloud worker key set";
    const d = productDefaults(this.deps);
    refuseInAgentRuntime(op, this.deps, {
      code: "CLOUD_AGENT_CANNOT_SET_SECRET",
      message: "Agents do not set environment keys.",
      suggestedAction: "Ask the operator to run: ravi cloud worker key set <workerId> --stdin < <file>",
      asJson,
    });
    const workerId = requireArg(op, "<workerId>", workerArg, asJson);
    if (!isCloudWorkerId(workerId)) usageError(op, "<workerId> is a worker id from 'ravi cloud worker list'.", asJson);
    if (stdin !== true) {
      usageError(
        op,
        "The key is read from stdin only: pass --stdin and redirect the file that holds it.",
        asJson,
        `ravi cloud worker key set ${workerId} --stdin < <file>`,
      );
    }
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await productSession(this.deps, undefined, false);
        const worker = (await listCloudWorkers(session.client)).find((entry) => entry.id === workerId);
        if (!worker) {
          contractFail(op, "CLOUD_WORKER_NOT_FOUND", `No cloud worker '${workerId}'.`, {
            asJson,
            details: { suggestedAction: "List them with: ravi cloud worker list" },
          });
        }
        if (worker.installationId && worker.installationId !== session.installationId) {
          contractFail(op, "CLOUD_WORKER_OTHER_INSTALLATION", `Worker ${workerId} is placed on another installation.`, {
            asJson,
            exitCode: CONTRACT_EXIT_USAGE,
            details: { suggestedAction: "Set the key on the machine the agent is placed on." },
          });
        }
        const key = (await d.readSecret()).trim();
        if (!isCloudWorkerKey(key))
          usageError(op, "stdin held no key (one token, no spaces, up to 4096 characters).", asJson);
        const replaced = readCloudWorkerKey(workerId, d.env) !== null;
        writeCloudWorkerKey(workerId, key, d.env);
        const runnerEnabled = readCloudWorkerState(d.env).enabled;
        const payload = {
          success: true as const,
          workerId,
          agentName: worker.agentName,
          stored: true as const,
          replaced,
          runnerEnabled,
        };
        if (asJson) {
          printJson(payload);
        } else {
          console.log(`✓ Key ${replaced ? "replaced" : "stored"} for ${workerId} (${worker.agentName}), mode 0600.`);
          console.log(
            runnerEnabled
              ? "  The daemon starts this worker within 30 s."
              : "  The runner is disabled: ravi cloud worker enable --execute",
          );
        }
        return payload;
      },
      { notFoundCode: "CLOUD_WORKER_NOT_FOUND" },
    );
  }

  @Command({ name: "remove", description: "Delete a worker's stored environment key (its worker stops)" })
  @CommandAccess({ kind: "mutate", resource: "cloud.agents", action: "worker.key_remove", risk: "low" })
  @Returns(z.object({ success: z.literal(true), workerId: z.string(), removed: z.boolean() }).strict())
  async remove(
    @Arg("workerId", { description: "Worker id" }) workerArg: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "cloud worker key remove";
    const workerId = requireArg(op, "<workerId>", workerArg, asJson);
    if (!isCloudWorkerId(workerId)) usageError(op, "<workerId> is a worker id from 'ravi cloud worker list'.", asJson);
    const removed = removeCloudWorkerKey(workerId, productDefaults(this.deps).env);
    const payload = { success: true as const, workerId, removed };
    if (asJson) printJson(payload);
    else
      console.log(
        removed ? `✓ Removed the key of ${workerId}; its worker stops within 30 s.` : `No key stored for ${workerId}.`,
      );
    return payload;
  }
}
