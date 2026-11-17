import "reflect-metadata";
import { join } from "node:path";
import { z } from "zod";
import { runPm2 } from "../../pm2.js";
import {
  type AdoptionHost,
  planThreadFenceAdoption,
  prepareThreadFenceAdoption,
  readThreadFenceAdoption,
  recoverThreadFenceAdoption,
} from "../../threads/fence-adoption.js";
import {
  liveBootIdentity,
  liveBundleDigest,
  liveRegistrations,
  liveResidue,
  liveStop,
} from "../../threads/fence-adoption-live.js";
import { errorDiagnostic } from "../../utils/error-diagnostic.js";
import { getRaviStateDir } from "../../utils/paths.js";
import { CONTRACT_EXIT_USAGE, ContractError, contractDryRun, contractFail } from "../agent-contract.js";
import { CliOnly, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { resolveDaemonRuntimeTarget } from "./daemon.js";

const SUCCESSOR_WAIT_MS = 180_000;
const ADOPT = "maintenance thread-fence-adopt";
const RECOVER = "maintenance thread-fence-recover";
const RECOVERY_MODES = ["release", "retry", "abandon"] as const;
type RecoveryMode = (typeof RECOVERY_MODES)[number];

export const threadFenceAdoptReturnSchema = z.object({
  action: z.literal("thread-fence-adopt"),
  executed: z.literal(true),
  maintenanceId: z.string(),
  adopted: z.literal(true),
  detail: z.string(),
});

export const threadFenceRecoverReturnSchema = z.object({
  action: z.literal("thread-fence-recover"),
  mode: z.enum(RECOVERY_MODES),
  executed: z.literal(true),
  result: z.enum(["released", "reauthorized", "abandoned"]),
  adopted: z.boolean().optional(),
  detail: z.string().optional(),
});

function liveHost(stateDir: string): AdoptionHost {
  const databasePath = join(stateDir, "ravi.db");
  return {
    stateDir,
    databasePath,
    registry: liveRegistrations,
    bootIdentity: (registration) => liveBootIdentity(registration, stateDir),
    bundleDigest: liveBundleDigest,
    stop: liveStop,
    residue: () => liveResidue(databasePath),
  };
}

function targetBundlePath(): string {
  const target = resolveDaemonRuntimeTarget();
  if (!target) throw new Error("THREAD_FENCE_ADOPTION_BLOCKED: the installed Ravi bundle cannot be resolved");
  return target.bundlePath;
}

/** Domain refusals carry their code as the message prefix (`CODE: detail`). */
async function runMaintenance<T>(op: string, asJson: boolean | undefined, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ContractError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const code = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1] ?? "THREAD_FENCE_ADOPTION_FAILED";
    contractFail(op, code, message, { asJson, diagnostic: errorDiagnostic(error, { operation: op }) });
  }
}

function print(payload: Record<string, unknown>, asJson: boolean | undefined, human: string): void {
  console.log(asJson ? JSON.stringify(payload, null, 2) : human);
}

/**
 * Starts the existing `ravi` registration (same script, same environment) and
 * waits until the successor adopted the fence and released the interlock.
 * Channels start only after that, through their ordinary guarded entry.
 */
async function startSuccessorAndWait(stateDir: string): Promise<{ adopted: boolean; detail: string }> {
  if (runPm2(["start", "ravi"]).status !== 0) return { adopted: false, detail: "pm2 start ravi failed" };
  const deadline = Date.now() + SUCCESSOR_WAIT_MS;
  while (Date.now() < deadline) {
    const adoption = readThreadFenceAdoption(stateDir);
    if (!adoption) {
      if (runPm2(["start", "ravi-channels"]).status !== 0)
        return { adopted: true, detail: "fence adopted; pm2 start ravi-channels failed, start channels by hand" };
      return { adopted: true, detail: "fence adopted, interlock released, channels started" };
    }
    if (adoption.phase === "blocked")
      return { adopted: false, detail: `successor blocked: ${adoption.failure ?? "no detail"}` };
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return { adopted: false, detail: "successor did not finish adoption in time; inspect before any recovery" };
}

function successorFailure(op: string, asJson: boolean | undefined, maintenanceId: string, detail: string): never {
  contractFail(op, "THREAD_FENCE_SUCCESSOR_NOT_ADOPTED", detail, {
    asJson,
    details: {
      maintenanceId,
      suggestedAction: "Inspect runtime-maintenance/adoption.json, then run 'ravi maintenance thread-fence-recover'",
    },
    diagnostic: errorDiagnostic(detail, { operation: op }),
  });
}

@Group({
  name: "maintenance",
  description: "One-time runtime maintenance run by the operator on real state",
  scope: "admin",
})
export class MaintenanceCommands {
  @Command({
    name: "thread-fence-adopt",
    description:
      "Adopt a database written by a pre-fence release: stop channels and daemon, prove residue, start the successor",
  })
  @CommandAccess({ kind: "mutate", resource: "daemon", action: "thread-fence-adopt", risk: "high" })
  @Returns(threadFenceAdoptReturnSchema)
  @CliOnly()
  async adopt(
    @Option({ flags: "--execute", description: "Stop, prove and start; without it only the read-only plan is shown" })
    execute?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runMaintenance(ADOPT, asJson, async () => {
      const stateDir = getRaviStateDir();
      const host = liveHost(stateDir);
      const target = targetBundlePath();
      const plan = planThreadFenceAdoption(host, target);
      if (!execute) contractDryRun(ADOPT, plan, { asJson });
      const adoption = await prepareThreadFenceAdoption(host, target);
      const successor = await startSuccessorAndWait(stateDir);
      if (!successor.adopted) successorFailure(ADOPT, asJson, adoption.maintenanceId, successor.detail);
      const payload = threadFenceAdoptReturnSchema.parse({
        action: "thread-fence-adopt",
        executed: true,
        maintenanceId: adoption.maintenanceId,
        adopted: true,
        detail: successor.detail,
      });
      print(payload, asJson, `Thread fence adopted (${payload.maintenanceId}): ${payload.detail}`);
      return payload;
    });
  }

  @Command({
    name: "thread-fence-recover",
    description: "Explicit recovery of an interrupted thread fence adoption: release, retry or abandon",
  })
  @CommandAccess({ kind: "mutate", resource: "daemon", action: "thread-fence-recover", risk: "high" })
  @Returns(threadFenceRecoverReturnSchema)
  @CliOnly()
  async recover(
    @Option({ flags: "--mode <mode>", description: "release | retry | abandon" }) mode?: string,
    @Option({ flags: "--execute", description: "Apply; without it only the current record is shown" })
    execute?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!RECOVERY_MODES.includes(mode as RecoveryMode)) {
      const message = "Pass --mode release, retry or abandon.";
      contractFail(RECOVER, "USAGE_ERROR", message, {
        asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        details: { suggestedAction: "Read the RUNBOOK of quality/state-boundary to choose the recovery mode" },
        diagnostic: errorDiagnostic(message, { operation: RECOVER }),
      });
    }
    const recoveryMode = mode as RecoveryMode;
    return runMaintenance(RECOVER, asJson, async () => {
      const stateDir = getRaviStateDir();
      if (!execute)
        contractDryRun(RECOVER, { mode: recoveryMode, adoption: readThreadFenceAdoption(stateDir) }, { asJson });
      const result = recoverThreadFenceAdoption({
        stateDir,
        databasePath: join(stateDir, "ravi.db"),
        mode: recoveryMode,
      });
      if (result !== "reauthorized") {
        const payload = threadFenceRecoverReturnSchema.parse({
          action: "thread-fence-recover",
          mode: recoveryMode,
          executed: true,
          result,
        });
        print(payload, asJson, `Thread fence adoption recovery: ${result}`);
        return payload;
      }
      const successor = await startSuccessorAndWait(stateDir);
      if (!successor.adopted)
        successorFailure(
          RECOVER,
          asJson,
          readThreadFenceAdoption(stateDir)?.maintenanceId ?? "unknown",
          successor.detail,
        );
      const payload = threadFenceRecoverReturnSchema.parse({
        action: "thread-fence-recover",
        mode: recoveryMode,
        executed: true,
        result,
        adopted: true,
        detail: successor.detail,
      });
      print(payload, asJson, `Thread fence adoption recovery: ${result}; ${successor.detail}`);
      return payload;
    });
  }
}
