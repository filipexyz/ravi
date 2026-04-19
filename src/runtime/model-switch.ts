import type { RuntimeSessionHandle } from "./types.js";

export type RuntimeModelSwitchStrategy = "direct-set" | "restart-next-turn";

export function resolveRuntimeModelSwitchStrategy(
  runtimeHandle: Pick<RuntimeSessionHandle, "setModel">,
): RuntimeModelSwitchStrategy {
  return typeof runtimeHandle.setModel === "function" ? "direct-set" : "restart-next-turn";
}

export async function applyDirectRuntimeModelSwitch(
  runtimeHandle: Pick<RuntimeSessionHandle, "setModel">,
  model: string,
): Promise<boolean> {
  if (resolveRuntimeModelSwitchStrategy(runtimeHandle) !== "direct-set") {
    return false;
  }

  await runtimeHandle.setModel?.(model);
  return true;
}
