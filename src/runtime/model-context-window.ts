import {
  type PricingCatalogSnapshot,
  readCachedPricingCatalog,
  resolveModelContextWindowFromCatalog,
} from "../costs/pricing-catalog.js";

/**
 * Where a context window came from:
 * - `runtime-session`: reported by the provider for this session (Pi today).
 * - `pricing-catalog`: LiteLLM `max_input_tokens` from the locally cached
 *   pricing catalog (never fetched on this read path).
 */
export type ModelContextWindowSource = "runtime-session" | "pricing-catalog";

export interface ModelContextWindowResolution {
  tokens: number;
  source: ModelContextWindowSource;
}

export interface ResolveModelContextWindowInput {
  model?: string | null;
  runtimeSessionParams?: Record<string, unknown> | null;
}

export interface ResolveModelContextWindowOptions {
  /** Explicit catalog snapshot; `null` disables the catalog lookup. Defaults to the cached catalog. */
  catalog?: PricingCatalogSnapshot | null;
  env?: NodeJS.ProcessEnv;
}

/** One shared resolver for the context window of a model, or null when it is not known. */
export function resolveModelContextWindow(
  input: ResolveModelContextWindowInput,
  options: ResolveModelContextWindowOptions = {},
): ModelContextWindowResolution | null {
  const reported = readRuntimeSessionContextWindow(input.runtimeSessionParams);
  if (reported !== null) return { tokens: reported, source: "runtime-session" };

  const model = input.model?.trim();
  if (!model) return null;
  // `[1m]` selects an extended window; the catalog entry describes the base model.
  if (/\[1m\]/i.test(model)) return null;

  const catalog = options.catalog !== undefined ? options.catalog : readCachedPricingCatalog({ env: options.env });
  if (!catalog) return null;
  const match = resolveModelContextWindowFromCatalog(model, catalog);
  return match ? { tokens: match.contextWindow, source: "pricing-catalog" } : null;
}

/** Context window the provider reported for a session (`contextWindow` or `model.contextWindow`). */
export function readRuntimeSessionContextWindow(params: Record<string, unknown> | null | undefined): number | null {
  if (!params) return null;
  const direct = positiveNumber(params.contextWindow);
  if (direct !== null) return direct;
  const model = params.model;
  if (model && typeof model === "object" && !Array.isArray(model)) {
    return positiveNumber((model as Record<string, unknown>).contextWindow);
  }
  return null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
