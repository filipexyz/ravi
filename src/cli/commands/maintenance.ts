import { join } from "node:path";
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
import { getRaviStateDir } from "../../utils/paths.js";
import { CliOnly, Command, CommandAccess, Group, Option } from "../decorators.js";
import { resolveDaemonRuntimeTarget } from "./daemon.js";

const SUCCESSOR_WAIT_MS = 180_000;

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

function print(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
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
  @CliOnly()
  async adopt(
    @Option({ flags: "--execute", description: "Stop, prove and start; without it only the read-only plan is shown" })
    execute?: boolean,
  ) {
    const stateDir = getRaviStateDir();
    const host = liveHost(stateDir);
    const target = targetBundlePath();
    if (!execute) {
      const plan = planThreadFenceAdoption(host, target);
      print({ action: "thread-fence-adopt", executed: false, plan });
      process.exitCode = 3;
      return;
    }
    const adoption = await prepareThreadFenceAdoption(host, target);
    const successor = await startSuccessorAndWait(stateDir);
    print({ action: "thread-fence-adopt", executed: true, maintenanceId: adoption.maintenanceId, ...successor });
    if (!successor.adopted) process.exitCode = 1;
  }

  @Command({
    name: "thread-fence-recover",
    description: "Explicit recovery of an interrupted thread fence adoption: release, retry or abandon",
  })
  @CommandAccess({ kind: "mutate", resource: "daemon", action: "thread-fence-recover", risk: "high" })
  @CliOnly()
  async recover(
    @Option({ flags: "--mode <mode>", description: "release | retry | abandon" }) mode?: string,
    @Option({ flags: "--execute", description: "Apply; without it only the current record is shown" })
    execute?: boolean,
  ) {
    const stateDir = getRaviStateDir();
    if (mode !== "release" && mode !== "retry" && mode !== "abandon")
      throw new Error("THREAD_FENCE_ADOPTION_BLOCKED: --mode must be release, retry or abandon");
    if (!execute) {
      print({ action: "thread-fence-recover", mode, executed: false, adoption: readThreadFenceAdoption(stateDir) });
      process.exitCode = 3;
      return;
    }
    const result = recoverThreadFenceAdoption({ stateDir, databasePath: join(stateDir, "ravi.db"), mode });
    if (result !== "reauthorized") {
      print({ action: "thread-fence-recover", mode, executed: true, result });
      return;
    }
    const successor = await startSuccessorAndWait(stateDir);
    print({ action: "thread-fence-recover", mode, executed: true, result, ...successor });
    if (!successor.adopted) process.exitCode = 1;
  }
}
