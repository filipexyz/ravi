/**
 * Store apps are invisible to agents until the operator exposes them
 * (spec apps/store, "Exposure"). Broad grants such as `full-access` or
 * `use:app:*` do not reach a store app: installing it must not hand it to
 * every agent that already had a wildcard.
 */

import { readReceipt } from "./receipts.js";

export type StoreExposureDecision = "not-store" | "exposed" | "hidden";

export function storeExposureFor(
  appId: string,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): StoreExposureDecision {
  let receipt: ReturnType<typeof readReceipt>;
  try {
    receipt = readReceipt(appId, env);
  } catch {
    // no-cause: an unreadable receipt fails closed; the app stays hidden from agents.
    return "hidden";
  }
  if (!receipt) return "not-store";
  if (receipt.state !== "active") return "hidden";
  return receipt.exposedTo.includes(agentId) ? "exposed" : "hidden";
}
