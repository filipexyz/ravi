import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";

export const DEFAULT_PRICING_CATALOG_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const DEFAULT_PRICING_CATALOG_SOURCE = "litellm:model_prices_and_context_window";
const DEFAULT_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 3_000;
const CACHE_FILE_NAME = "model_prices_and_context_window.json";

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface PricingMetadata {
  source: string;
  sourceUrl: string;
  sourceVersion: string | null;
  fetchedAt: number;
  model: string;
  stale: boolean;
}

export type CostPricingStatus = "priced" | "unpriced";

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  cacheCost: number;
  totalCost: number;
  pricingStatus: CostPricingStatus;
  pricing?: PricingMetadata;
  pricingError?: string;
}

interface LiteLlmPricingEntry {
  input_cost_per_token?: unknown;
  output_cost_per_token?: unknown;
  cache_read_input_token_cost?: unknown;
  cache_creation_input_token_cost?: unknown;
}

type PricingCatalogEntries = Record<string, unknown>;
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface PricingCatalogSnapshot {
  source: string;
  sourceUrl: string;
  sourceVersion: string | null;
  fetchedAt: number;
  stale: boolean;
  entries: PricingCatalogEntries;
}

interface PricingCatalogCacheFile {
  source?: unknown;
  sourceUrl?: unknown;
  sourceVersion?: unknown;
  fetchedAt?: unknown;
  entries?: unknown;
}

export interface PricingCatalogOptions {
  env?: NodeJS.ProcessEnv;
  now?: number;
  fetchImpl?: FetchLike;
  cachePath?: string;
  ttlMs?: number;
  timeoutMs?: number;
  allowStaleCache?: boolean;
}

export interface CalculateCostOptions extends PricingCatalogOptions {
  catalog?: PricingCatalogSnapshot;
}

const memoryCatalogs = new Map<string, PricingCatalogSnapshot>();
const memoryCatalogPromises = new Map<string, Promise<PricingCatalogSnapshot | null>>();

export function resetPricingCatalogForTests(): void {
  memoryCatalogs.clear();
  memoryCatalogPromises.clear();
}

export async function calculateCost(
  model: string,
  usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheCreation: number },
  options: CalculateCostOptions = {},
): Promise<CostBreakdown> {
  const resolved = await resolveModelPricing(model, options);
  if (!resolved) {
    return {
      inputCost: 0,
      outputCost: 0,
      cacheCost: 0,
      totalCost: 0,
      pricingStatus: "unpriced",
      pricingError: `No pricing entry found for model "${model}".`,
    };
  }

  const inputCost = (usage.inputTokens / 1_000_000) * resolved.pricing.input;
  const outputCost = (usage.outputTokens / 1_000_000) * resolved.pricing.output;
  const cacheCost =
    (usage.cacheRead / 1_000_000) * resolved.pricing.cacheRead +
    (usage.cacheCreation / 1_000_000) * resolved.pricing.cacheCreation;

  return {
    inputCost,
    outputCost,
    cacheCost,
    totalCost: inputCost + outputCost + cacheCost,
    pricingStatus: "priced",
    pricing: resolved.metadata,
  };
}

export async function resolveModelPricing(
  model: string,
  options: CalculateCostOptions = {},
): Promise<{ pricing: ModelPricing; metadata: PricingMetadata } | null> {
  const catalog = options.catalog ?? (await loadPricingCatalog(options));
  if (!catalog) return null;

  const match = resolveModelPricingFromCatalog(model, catalog);
  if (!match) return null;

  return {
    pricing: match.pricing,
    metadata: {
      source: catalog.source,
      sourceUrl: catalog.sourceUrl,
      sourceVersion: catalog.sourceVersion,
      fetchedAt: catalog.fetchedAt,
      model: match.model,
      stale: catalog.stale,
    },
  };
}

export function resolveModelPricingFromCatalog(
  model: string,
  catalog: PricingCatalogSnapshot,
): { model: string; pricing: ModelPricing } | null {
  for (const candidate of pricingModelCandidates(model)) {
    const pricing = parseLiteLlmPricing(catalog.entries[candidate]);
    if (pricing) return { model: candidate, pricing };
  }
  return null;
}

export function pricingModelCandidates(model: string): string[] {
  const raw = model.trim();
  if (!raw) return [];

  const candidates = new Set<string>();
  const add = (value: string) => {
    const normalized = value.trim();
    if (!normalized) return;
    candidates.add(normalized);
    candidates.add(normalizeClaudeVersionSeparators(normalized));
  };

  const withoutOneMillionMarker = raw.replace(/\[1m\]/gi, "");
  add(raw);
  add(withoutOneMillionMarker);

  if (withoutOneMillionMarker.includes("/")) {
    const tail = withoutOneMillionMarker.split("/").filter(Boolean).at(-1);
    if (tail) add(tail);
    if (withoutOneMillionMarker.startsWith("anthropic/")) {
      add(`openrouter/${withoutOneMillionMarker}`);
    }
  }

  return [...candidates];
}

export async function loadPricingCatalog(options: PricingCatalogOptions = {}): Promise<PricingCatalogSnapshot | null> {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? parsePositiveInt(options.env?.RAVI_PRICING_CATALOG_TTL_MS, DEFAULT_CATALOG_TTL_MS);
  const sourceUrl = options.env?.RAVI_PRICING_CATALOG_URL?.trim() || DEFAULT_PRICING_CATALOG_URL;
  const source = options.env?.RAVI_PRICING_CATALOG_SOURCE?.trim() || DEFAULT_PRICING_CATALOG_SOURCE;
  const cachePath = options.cachePath ?? defaultPricingCatalogCachePath(options.env);
  const cacheKey = pricingCatalogCacheKey(source, sourceUrl, cachePath);

  const memoryCatalog = memoryCatalogs.get(cacheKey);
  if (memoryCatalog && now - memoryCatalog.fetchedAt <= ttlMs) {
    return { ...memoryCatalog, stale: false };
  }

  const cached = readCatalogCache(cachePath);
  if (cached && cached.sourceUrl === sourceUrl && now - cached.fetchedAt <= ttlMs) {
    const snapshot = { ...cached, stale: false };
    memoryCatalogs.set(cacheKey, snapshot);
    return snapshot;
  }

  const stale = cached?.sourceUrl === sourceUrl ? cached : memoryCatalog;
  if (stale && options.allowStaleCache !== false) {
    const snapshot = { ...stale, stale: true };
    memoryCatalogs.set(cacheKey, snapshot);
    void fetchCatalogOnce({ ...options, now, source, sourceUrl, cachePath, cacheKey });
    return snapshot;
  }

  return await fetchCatalogOnce({ ...options, now, source, sourceUrl, cachePath, cacheKey });
}

export function prewarmPricingCatalog(options: PricingCatalogOptions = {}): void {
  void loadPricingCatalog(options);
}

function defaultPricingCatalogCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "pricing", CACHE_FILE_NAME);
}

async function fetchCatalog(
  options: PricingCatalogOptions & {
    now: number;
    source: string;
    sourceUrl: string;
    cachePath: string;
    cacheKey: string;
  },
): Promise<PricingCatalogSnapshot | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs =
    options.timeoutMs ?? parsePositiveInt(options.env?.RAVI_PRICING_CATALOG_TIMEOUT_MS, DEFAULT_FETCH_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(options.sourceUrl, { signal: controller.signal });
    if (!response.ok) return null;
    const parsed = await response.json();
    if (!isRecord(parsed)) return null;

    const snapshot: PricingCatalogSnapshot = {
      source: options.source,
      sourceUrl: options.sourceUrl,
      sourceVersion: response.headers.get("etag") ?? response.headers.get("last-modified"),
      fetchedAt: options.now,
      stale: false,
      entries: parsed,
    };
    writeCatalogCache(options.cachePath, snapshot);
    memoryCatalogs.set(options.cacheKey, snapshot);
    return snapshot;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function fetchCatalogOnce(
  options: PricingCatalogOptions & {
    now: number;
    source: string;
    sourceUrl: string;
    cachePath: string;
    cacheKey: string;
  },
): Promise<PricingCatalogSnapshot | null> {
  const existing = memoryCatalogPromises.get(options.cacheKey);
  if (existing) return existing;

  const promise = fetchCatalog(options).finally(() => {
    memoryCatalogPromises.delete(options.cacheKey);
  });
  memoryCatalogPromises.set(options.cacheKey, promise);
  return promise;
}

function pricingCatalogCacheKey(source: string, sourceUrl: string, cachePath: string): string {
  return `${source}\n${sourceUrl}\n${cachePath}`;
}

function readCatalogCache(path: string): PricingCatalogSnapshot | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PricingCatalogCacheFile;
    if (
      typeof parsed.source !== "string" ||
      typeof parsed.sourceUrl !== "string" ||
      typeof parsed.fetchedAt !== "number" ||
      !isRecord(parsed.entries)
    ) {
      return null;
    }

    return {
      source: parsed.source,
      sourceUrl: parsed.sourceUrl,
      sourceVersion: typeof parsed.sourceVersion === "string" ? parsed.sourceVersion : null,
      fetchedAt: parsed.fetchedAt,
      stale: false,
      entries: parsed.entries,
    };
  } catch {
    return null;
  }
}

function writeCatalogCache(path: string, snapshot: PricingCatalogSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        source: snapshot.source,
        sourceUrl: snapshot.sourceUrl,
        sourceVersion: snapshot.sourceVersion,
        fetchedAt: snapshot.fetchedAt,
        entries: snapshot.entries,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function parseLiteLlmPricing(entry: unknown): ModelPricing | null {
  if (!isRecord(entry)) return null;
  const row = entry as LiteLlmPricingEntry;
  const input = numberField(row.input_cost_per_token);
  const output = numberField(row.output_cost_per_token);
  if (input === null || output === null) return null;

  const cacheRead = numberField(row.cache_read_input_token_cost) ?? input;
  const cacheCreation = numberField(row.cache_creation_input_token_cost) ?? input;

  return {
    input: input * 1_000_000,
    output: output * 1_000_000,
    cacheRead: cacheRead * 1_000_000,
    cacheCreation: cacheCreation * 1_000_000,
  };
}

function normalizeClaudeVersionSeparators(model: string): string {
  return model.replace(/(claude-[a-z]+-\d+)\.(\d+)/gi, "$1-$2");
}

function numberField(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
