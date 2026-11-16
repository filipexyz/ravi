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
): Promise<{ exitCode: number; failures: RuntimeShutdownFailure[] }> {
  const failures: RuntimeShutdownFailure[] = [];
  const stop = async (step: RuntimeShutdownStep) => {
    try {
      await step.stop();
    } catch (cause) {
      const failure = { name: step.name, cause };
      failures.push(failure);
      try {
        onFailure?.(failure);
      } catch (reportCause) {
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
  return { exitCode: failures.length ? exitCode || 1 : exitCode, failures };
}
