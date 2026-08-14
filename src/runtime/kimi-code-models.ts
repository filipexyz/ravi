import type { RuntimeEffort } from "./effort.js";

export const KIMI_CODE_PROVIDER_ID = "kimi-code" as const;
export const KIMI_CODE_CREDENTIAL_ENV_KEY = "KIMI_API_KEY" as const;

export interface KimiCodeModel {
  id: "k3" | "k3-256k" | "kimi-for-coding" | "kimi-for-coding-highspeed";
  name: string;
  description: string;
  priority: number;
}

export const KIMI_CODE_MODELS: readonly KimiCodeModel[] = [
  {
    id: "k3",
    name: "K3",
    description: "Kimi Code K3 membership model with up to 1M context when entitled.",
    priority: 0,
  },
  {
    id: "k3-256k",
    name: "K3 256K",
    description: "Kimi Code K3 membership model with 256K context.",
    priority: 1,
  },
  {
    id: "kimi-for-coding",
    name: "Kimi for Coding",
    description: "Kimi Code membership model with fixed thinking.",
    priority: 2,
  },
  {
    id: "kimi-for-coding-highspeed",
    name: "Kimi for Coding HighSpeed",
    description: "High-speed Kimi Code membership model with fixed thinking.",
    priority: 3,
  },
];

const K3_MODELS = new Set<KimiCodeModel["id"]>(["k3", "k3-256k"]);
const KIMI_CODE_MODEL_IDS = new Set<string>(KIMI_CODE_MODELS.map((model) => model.id));

export function isKimiCodeModel(model: string): model is KimiCodeModel["id"] {
  return KIMI_CODE_MODEL_IDS.has(model);
}

export function resolveKimiCodeEffort(
  model: KimiCodeModel["id"],
  effort?: RuntimeEffort,
): "low" | "high" | "max" | undefined {
  if (!isKimiCodeModel(model)) {
    throw new Error(`Unknown Kimi Code model '${model}'`);
  }
  if (!K3_MODELS.has(model)) {
    return undefined;
  }

  switch (effort) {
    case undefined:
    case "medium":
    case "high":
      return "high";
    case "minimal":
    case "low":
      return "low";
    case "xhigh":
    case "max":
    case "ultra":
      return "max";
    case "none":
      throw new Error(`Kimi Code model '${model}' does not support effort 'none'`);
  }
}
