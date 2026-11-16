import { TrackedWorkDrain, type WorkDrainStatus } from "./work-drain.js";

export interface RuntimeShutdownStep {
  name: string;
  stop: () => unknown | Promise<unknown>;
}

export interface RuntimeShutdownFailure {
  name: string;
  cause: unknown;
}

/** Attempt every component stop; a failed drain never becomes a clean process exit. */
export async function stopRuntimeComponents(
  components: readonly RuntimeShutdownStep[],
  sharedResources: readonly RuntimeShutdownStep[],
  exitCode = 0,
  onFailure?: (failure: RuntimeShutdownFailure) => void,
): Promise<{ exitCode: number; failures: RuntimeShutdownFailure[]; drain: WorkDrainStatus }> {
  const failures: RuntimeShutdownFailure[] = [];
  const drain = new TrackedWorkDrain("runtime-shutdown");
  const stop = async (step: RuntimeShutdownStep) => {
    try {
      await drain.run(step.name, step.stop);
    } catch (cause) {
      const failure = { name: step.name, cause };
      failures.push(failure);
      try {
        onFailure?.(failure);
      } catch (reportCause) {
        drain.recordFailure(`${step.name}.diagnostic`);
        failures.push({ name: `${step.name}.diagnostic`, cause: reportCause });
      }
    }
  };
  for (const component of components) await stop(component);
  // A timeout/failure may leave accepted work using NATS or SQLite. Keep those
  // handles until process exit, and leave maintenance completion unproven.
  if (failures.length === 0) {
    for (const resource of sharedResources) await stop(resource);
  }
  drain.beginDrain();
  return { exitCode: failures.length ? exitCode || 1 : exitCode, failures, drain: drain.status() };
}
