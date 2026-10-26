/**
 * Shared helpers of the cloud agents product commands (`ravi cloud secrets|
 * triggers|credits|settings|catalog|webhook|worker` and the agent admin
 * commands): the injectable deps, argument parsing, BRL formatting and the
 * return schemas. Kept out of `src/cli/commands/` because every file there is
 * re-exported by the generated barrel.
 *
 * spec: cloud/agents, cli
 */

import { z } from "zod";

import type { CloudAgentsClient } from "../cloud-agents/client.js";
import type { CloudAgent } from "../cloud-agents/types.js";
import { isOperatorOwnTurn } from "../library/turn.js";
import { CONTRACT_EXIT_POLICY, contractFail, suggestSimilar } from "./agent-contract.js";
import {
  cloudAgentReturnSchema,
  requireCloudAgentsSession,
  usageError,
  type OpenCloudAgentsSession,
} from "./cloud-agents-contract.js";
import { matchCloudAgent } from "./commands/cloud-agents.js";
import { runtimeLibraryCaller, runtimeLibrarySession } from "./library-contract.js";
import { readNonInteractiveSecret } from "./secret-input.js";

export interface CloudProductCommandDeps {
  openSession?: OpenCloudAgentsSession;
  /** Reads a secret from redirected stdin (tests replace it). */
  readSecret?: () => Promise<string>;
  /** Whether this call runs inside an agent's turn, and whether that turn is the operator's own. */
  inAgentRuntime?: () => boolean;
  operatorOwnTurn?: () => boolean;
  /** The session of the current agent turn (a trigger's default delivery), or null in a terminal. */
  currentSessionName?: () => string | null;
  /** `RAVI_STATE_DIR`-style environment for the local worker store (tests pass a temp dir). */
  env?: NodeJS.ProcessEnv;
}

export function productDefaults(deps: CloudProductCommandDeps) {
  return {
    readSecret: deps.readSecret ?? (() => readNonInteractiveSecret({ fromStdin: true, maxBytes: 32_768 })),
    inAgentRuntime: deps.inAgentRuntime ?? (() => runtimeLibraryCaller() !== null),
    operatorOwnTurn: deps.operatorOwnTurn ?? (() => isOperatorOwnTurn()),
    currentSessionName: deps.currentSessionName ?? (() => runtimeLibrarySession()?.name ?? null),
    env: deps.env ?? process.env,
  };
}

export async function productSession(deps: CloudProductCommandDeps, project?: string, resolveProject = true) {
  return requireCloudAgentsSession({ project: project?.trim() || null, resolveProject }, deps.openSession ?? undefined);
}

export function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

export function requireArg(op: string, label: string, value: string | undefined, asJson?: boolean): string {
  const text = value?.trim() ?? "";
  if (!text) usageError(op, `${label} is required.`, asJson);
  return text;
}

/** Refuse a command an agent never runs (secrets, keys, money), with the command for the operator. */
export function refuseInAgentRuntime(
  op: string,
  deps: CloudProductCommandDeps,
  input: { code: string; message: string; suggestedAction: string; asJson?: boolean },
): void {
  const d = productDefaults(deps);
  if (!d.inAgentRuntime()) return;
  contractFail(op, input.code, input.message, {
    asJson: input.asJson,
    exitCode: CONTRACT_EXIT_POLICY,
    details: { suggestedAction: input.suggestedAction },
  });
}

/** The deployed agent a ref names (id, Library item id, slug or name), or the not-found failure. */
export async function requireProjectAgent(
  op: string,
  client: CloudAgentsClient,
  project: string,
  ref: string,
  asJson?: boolean,
): Promise<CloudAgent> {
  const agents = await client.listAgents(project);
  const found = matchCloudAgent(agents, ref);
  if (found) return found;
  contractFail(op, "CLOUD_AGENT_NOT_FOUND", `No cloud agent '${ref.slice(0, 80)}' in project ${project}.`, {
    asJson,
    details: {
      suggestedAction: `List them with: ravi cloud agents list --project ${project}`,
      suggestions: suggestSimilar(
        ref,
        agents.map((agent) => agent.library.slug || agent.name),
      ),
    },
  });
}

/** What the Console takes as `agent`: the Library slug (`org/x` becomes `x`). */
export function agentSlugArgument(ref: string, matched: CloudAgent | null): string {
  if (matched?.library.slug) return matched.library.slug;
  const raw = ref.trim();
  return raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
}

/** `--x <usd>`: a positive number of US dollars, or `none` when `allowNone`. */
export function parseUsd(
  op: string,
  flag: string,
  value: string | undefined,
  input: { min: number; max: number; allowNone?: boolean; asJson?: boolean },
): number | null | undefined {
  if (value === undefined) return undefined;
  const raw = String(value).trim();
  if (input.allowNone && /^(none|off|null)$/i.test(raw)) return null;
  const amount = Number(raw.replace(/^(US)?\$\s*/i, ""));
  if (!Number.isFinite(amount) || amount < input.min || amount > input.max || (input.min === 0 && amount <= 0)) {
    usageError(
      op,
      `${flag} must be a number of US dollars from ${input.min} to ${input.max}${input.allowNone ? ", or none" : ""}.`,
      input.asJson,
    );
  }
  return Math.round(amount * 100) / 100;
}

/** `R$ 50`, `50,00` or `50.5`: an amount in reais with at most two decimals. */
export function parseBrl(op: string, flag: string, value: string | undefined, asJson?: boolean): number {
  const raw = (value ?? "").trim().replace(/^R\$\s*/i, "");
  const normalized = /^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(raw)
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw.replace(",", ".");
  const amount = /^\d+(\.\d{1,2})?$/.test(normalized) ? Number(normalized) : Number.NaN;
  if (!Number.isFinite(amount)) usageError(op, `${flag} must be an amount in reais, such as 50 or 50,00.`, asJson);
  return amount;
}

export function parseIntegerFlag(
  op: string,
  flag: string,
  value: string | undefined,
  input: { min: number; max: number; asJson?: boolean },
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < input.min || parsed > input.max) {
    usageError(op, `${flag} must be a whole number from ${input.min} to ${input.max}.`, input.asJson);
  }
  return parsed;
}

/** Comma-separated or repeated values, trimmed, without duplicates. */
export function listFlag(values: string[] | string | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  const list = (Array.isArray(values) ? values : [values])
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(list)];
}

export function formatBrl(value: number | null): string {
  if (value === null) return "-";
  const sign = value < 0 ? "-" : "";
  return `${sign}R$ ${Math.abs(value).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Return schemas

const userRefSchema = z.object({ id: z.string(), name: z.string().nullable() }).strict();

export const cloudSecretReturnSchema = z
  .object({
    id: z.string(),
    projectId: z.string().nullable(),
    name: z.string(),
    valueHint: z.string().nullable(),
    allowedHosts: z.array(z.string()),
    updatedAt: z.string().nullable(),
    updatedBy: userRefSchema.nullable(),
    lastUsedAt: z.string().nullable(),
  })
  .strict();

const deliveryReturnSchema = z
  .object({
    kind: z.enum(["session", "page_room", "none"]),
    installationId: z.string().optional(),
    sessionName: z.string().optional(),
    chat: z
      .object({
        channel: z.string(),
        chatId: z.string(),
        threadId: z.string().nullable().optional(),
        instanceId: z.string().nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    roomId: z.string().optional(),
    siteId: z.string().optional(),
  })
  .strict();

export const cloudTriggerReturnSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    agentId: z.string(),
    agentName: z.string(),
    actor: userRefSchema,
    source: z.enum(["bases", "mail", "meetings", "pages_comments"]),
    filter: z
      .object({
        baseId: z.string().optional(),
        viewId: z.string().optional(),
        events: z.array(z.string()).optional(),
        mailboxId: z.string().optional(),
        siteId: z.string().optional(),
      })
      .strict(),
    prompt: z.string(),
    delivery: deliveryReturnSchema.nullable(),
    enabled: z.boolean(),
    dailyCap: z.number(),
    batchWindowSeconds: z.number(),
    dedupeWindowSeconds: z.number(),
    budgetUsd: z.number().nullable(),
    firedToday: z.number(),
    lastFiredAt: z.string().nullable(),
    lastRunId: z.string().nullable(),
    pausedReason: z.string().nullable(),
    pendingEvents: z.number(),
  })
  .strict();

export const cloudTriggerTestReturnSchema = z
  .object({
    prompt: z.string().nullable(),
    eventCount: z.number(),
    sample: z.boolean(),
    blockedBy: z.string().nullable(),
  })
  .strict();

export const cloudCreditEntryReturnSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["topup", "run", "adjustment", "refund"]),
    amountBrl: z.number(),
    usd: z.number().nullable(),
    fxRate: z.string().nullable(),
    runId: z.string().nullable(),
    status: z.enum(["pending", "posted", "void"]),
    paymentUrl: z.string().nullable(),
    pixCopyPaste: z.string().nullable(),
    createdAt: z.string().nullable(),
    postedAt: z.string().nullable(),
  })
  .strict();

export const cloudCreditsReturnSchema = z
  .object({
    mode: z.enum(["byok", "credits"]),
    balanceBrl: z.number(),
    fxRate: z.string().nullable(),
    monthSpentBrl: z.number(),
    entries: z.array(cloudCreditEntryReturnSchema),
  })
  .strict();

export const cloudWebhookReturnSchema = z
  .object({ url: z.string().nullable(), configured: z.boolean(), lastEventAt: z.string().nullable() })
  .strict();

export const cloudSettingsReturnSchema = z
  .object({
    billingMode: z.enum(["byok", "credits"]),
    monthlyCapUsd: z.number().nullable(),
    monthSpentUsd: z.number(),
    pausedAt: z.string().nullable(),
    pausedReason: z.string().nullable(),
    dailyEventRunsCap: z.number(),
    webhook: cloudWebhookReturnSchema,
    gatewayAvailable: z.boolean(),
  })
  .strict();

const stringListSchema = z.array(z.string());

/** What a deployed agent can do (the Console's capability manifest). */
export const cloudManifestReturnSchema = z
  .object({
    model: z.string(),
    provider: z.enum(["anthropic", "ravi"]),
    placement: z.enum(["cloud", "installation"]),
    writes: z.enum(["ask", "auto"]),
    networking: z.enum(["limited", "unrestricted"]),
    allowedHosts: stringListSchema,
    mcpServers: stringListSchema,
    raviOps: stringListSchema,
    secrets: stringListSchema,
    repositories: stringListSchema,
    memory: z.enum(["agent", "person"]).nullable(),
    office: stringListSchema,
    web: z
      .object({
        search: z.boolean(),
        fetch: z.boolean(),
        allowedDomains: stringListSchema,
        blockedDomains: stringListSchema,
      })
      .strict(),
    askHuman: z.boolean(),
    workflows: z.boolean(),
  })
  .strict();

const publisherSchema = z.object({ id: z.string(), name: z.string().nullable() }).strict();

export const cloudCatalogEntryReturnSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    summary: z.string(),
    sector: z.string().nullable(),
    publisher: publisherSchema,
    manifest: cloudManifestReturnSchema.nullable(),
    manifestHash: z.string().nullable(),
    status: z.enum(["listed", "unlisted"]),
    installed: z.boolean(),
  })
  .strict();

export const cloudCatalogPackReturnSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    summary: z.string(),
    sector: z.string().nullable(),
    publisher: publisherSchema,
    entries: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string() }).strict()),
    revenueShareBps: z.number(),
    status: z.enum(["listed", "unlisted"]),
  })
  .strict();

export const cloudWorkerReturnSchema = z
  .object({
    id: z.string(),
    agentId: z.string(),
    agentName: z.string(),
    projectId: z.string(),
    installationId: z.string(),
    providerEnvironmentId: z.string(),
    status: z.enum(["waiting_key", "online", "offline", "disabled"]),
    lastSeenAt: z.string().nullable(),
    lastError: z.string().nullable(),
  })
  .strict();

/** A deployed agent with its product fields (manifest approval, cap, placement, catalog provenance). */
export const cloudProductAgentReturnSchema = cloudAgentReturnSchema
  .extend({
    config: cloudAgentReturnSchema.shape.config
      .extend({
        webFetch: z.boolean().optional(),
        office: z.array(z.string()).optional(),
        askHuman: z.boolean().optional(),
        workflows: z.boolean().optional(),
        secrets: z.array(z.string()).optional(),
        memory: z.enum(["agent", "person"]).nullable().optional(),
        outcome: z.object({ rubric: z.string(), maxIterations: z.number() }).strict().nullable().optional(),
        placement: z.enum(["cloud", "installation"]).optional(),
        provider: z.enum(["anthropic", "ravi"]).optional(),
      })
      .strict(),
    manifest: z
      .object({
        hash: z.string().nullable(),
        approved: z.boolean(),
        approvedAt: z.string().nullable(),
        value: cloudManifestReturnSchema.nullable(),
      })
      .strict()
      .nullable()
      .optional(),
    cap: z
      .object({
        monthlyCapUsd: z.number().nullable(),
        monthSpentUsd: z.number(),
        pausedAt: z.string().nullable(),
        pausedReason: z.string().nullable(),
      })
      .strict()
      .nullable()
      .optional(),
    placementInstallationId: z.string().nullable().optional(),
    catalogEntryId: z.string().nullable().optional(),
  })
  .strict();
