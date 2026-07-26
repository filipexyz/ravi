import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  ChannelBackendOpaqueIdSchema,
  ChannelBackendWireKindSchema,
  ChannelSafeErrorSchema,
  type ChannelSafeError,
} from "./channel-backend.js";

export const LOCAL_AGENT_RECONCILIATION_PROTOCOL =
  "ravi.agent.local-reconciliation" as const;
export const LOCAL_AGENT_RECONCILIATION_SCHEMA_VERSION = 1 as const;
export const LOCAL_AGENT_RECONCILIATION_MAX_INSTRUCTIONS_BYTES = 65_536;
export const LOCAL_AGENT_RECONCILIATION_MAX_CAPABILITIES = 128;

const textEncoder = new TextEncoder();

function boundedUtf8String(maxBytes: number, label: string) {
  return z
    .string()
    .refine(
      (value) => textEncoder.encode(value).byteLength > 0,
      `${label} must not be empty`,
    )
    .refine(
      (value) => textEncoder.encode(value).byteLength <= maxBytes,
      `${label} exceeds ${maxBytes} UTF-8 bytes`,
    );
}

export const LocalAgentRuntimePreferenceSchema = z
  .object({
    provider: ChannelBackendOpaqueIdSchema.optional(),
    model: ChannelBackendOpaqueIdSchema.optional(),
    modelPreset: ChannelBackendOpaqueIdSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.model !== undefined && value.modelPreset !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["modelPreset"],
        message: "model and modelPreset are mutually exclusive",
      });
    }
  });

export const LocalAgentReconciliationRequestSchema = z.object({
  protocol: z.literal(LOCAL_AGENT_RECONCILIATION_PROTOCOL),
  schemaVersion: z.literal(LOCAL_AGENT_RECONCILIATION_SCHEMA_VERSION),
  requestId: ChannelBackendOpaqueIdSchema,
  idempotencyKey: ChannelBackendOpaqueIdSchema,
  sourceId: ChannelBackendOpaqueIdSchema,
  agentKey: ChannelBackendOpaqueIdSchema,
  templateId: ChannelBackendOpaqueIdSchema,
  revision: z
    .string()
    .regex(/^[a-f0-9]{64}$/, "must be a lowercase SHA-256 digest"),
  instructions: boundedUtf8String(
    LOCAL_AGENT_RECONCILIATION_MAX_INSTRUCTIONS_BYTES,
    "local agent instructions",
  ).optional(),
  runtime: LocalAgentRuntimePreferenceSchema.optional(),
  requestedCapabilities: z
    .array(ChannelBackendWireKindSchema)
    .max(LOCAL_AGENT_RECONCILIATION_MAX_CAPABILITIES)
    .refine(
      (capabilities) =>
        new Set(capabilities).size === capabilities.length,
      "requested capabilities must be unique",
    )
    .default([]),
});

export const LocalAgentReconciliationResultSchema = z
  .object({
    protocol: z.literal(LOCAL_AGENT_RECONCILIATION_PROTOCOL),
    schemaVersion: z.literal(LOCAL_AGENT_RECONCILIATION_SCHEMA_VERSION),
    requestId: ChannelBackendOpaqueIdSchema,
    disposition: z.enum([
      "created",
      "updated",
      "unchanged",
      "blocked",
    ]),
    state: z.enum(["ready", "blocked"]),
    agentId: ChannelBackendOpaqueIdSchema.optional(),
    appliedRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "must be a lowercase SHA-256 digest")
      .optional(),
    grantedCapabilities: z
      .array(ChannelBackendWireKindSchema)
      .max(LOCAL_AGENT_RECONCILIATION_MAX_CAPABILITIES)
      .refine(
        (capabilities) =>
          new Set(capabilities).size === capabilities.length,
        "granted capabilities must be unique",
      )
      .default([]),
    error: ChannelSafeErrorSchema.optional(),
    observedAt: z.string().datetime({ offset: true }),
  })
  .superRefine((value, context) => {
    if (
      value.state === "ready" &&
      (value.disposition === "blocked" ||
        value.agentId === undefined ||
        value.appliedRevision === undefined ||
        value.error !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message:
          "ready result requires an agent, applied revision, and no error",
      });
    }
    if (
      value.state === "blocked" &&
      (value.disposition !== "blocked" ||
        value.agentId !== undefined ||
        value.appliedRevision !== undefined ||
        value.error === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "blocked result requires only a safe error",
      });
    }
  });

export type LocalAgentRuntimePreference = z.infer<
  typeof LocalAgentRuntimePreferenceSchema
>;
export type LocalAgentReconciliationRequest = z.infer<
  typeof LocalAgentReconciliationRequestSchema
>;
export type LocalAgentReconciliationResult = z.infer<
  typeof LocalAgentReconciliationResultSchema
>;

export interface LocalAgentTemplate {
  readonly templateId: string;
  readonly workspaceRoot: string;
  readonly agentIdPrefix?: string;
  readonly allowAdoption?: boolean;
  readonly manageInstructions?: boolean;
  readonly baseInstructions?: string;
  readonly permissionProfile?: "bootstrap" | "full-access";
  readonly capabilityMap?: Readonly<
    Record<string, readonly string[]>
  >;
  readonly runtime?: Readonly<{
    provider?: string;
    model?: string;
    modelPreset?: string;
    allowedProviders?: readonly string[];
    allowedModels?: readonly string[];
    allowedModelPresets?: readonly string[];
  }>;
}

export interface LocalAgentRuntimeRecord {
  readonly agentId: string;
  readonly cwd: string;
  readonly provider?: string;
  readonly model?: string;
  readonly modelPreset?: string;
}

export interface LocalAgentRuntimeAdapter {
  inspect(agentId: string): Promise<LocalAgentRuntimeRecord | null>;
  create(input: {
    readonly agentId: string;
    readonly cwd: string;
    readonly runtime: LocalAgentRuntimePreference;
  }): Promise<void>;
  configureRuntime(
    agent: LocalAgentRuntimeRecord,
    desired: LocalAgentRuntimePreference,
  ): Promise<boolean>;
  configurePermissions(input: {
    readonly agentId: string;
    readonly profile: "bootstrap" | "full-access";
    readonly capabilities: readonly string[];
  }): Promise<boolean>;
}

interface RaviClientAgent {
  readonly id: string;
  readonly cwd: string;
  readonly provider?: string;
  readonly model?: string;
  readonly modelPresetId?: string | null;
}

export interface LocalAgentRaviClient {
  readonly agents: {
    list(options?: {
      limit?: string;
      offset?: string;
    }): Promise<{
      agents?: readonly RaviClientAgent[];
      items?: readonly RaviClientAgent[];
      pagination?: {
        nextOffset?: number | null;
      };
    }>;
    create(
      id: string,
      cwd: string,
      options?: {
        provider?: string;
        model?: string;
        modelPreset?: string;
      },
    ): Promise<unknown>;
    set(id: string, key: string, value: string): Promise<unknown>;
    permissions(
      id: string,
      profile?: string,
      options?: {
        capabilities?: string;
        clearCapabilities?: boolean;
      },
    ): Promise<{
      changed?: boolean;
      profile?: string;
      runtimePermissions?: {
        profile?: string;
        capabilities?: readonly (
          | string
          | {
              permission?: string;
              objectType?: string;
              objectId?: string;
            }
        )[];
      } | null;
    }>;
  };
}

export function createRaviClientLocalAgentRuntimeAdapter(
  client: LocalAgentRaviClient,
): LocalAgentRuntimeAdapter {
  return {
    async inspect(agentId) {
      let offset = 0;
      for (;;) {
        const page = await client.agents.list({
          limit: "500",
          offset: String(offset),
        });
        const agents = page.agents ?? page.items ?? [];
        const match = agents.find((agent) => agent.id === agentId);
        if (match !== undefined) {
          return {
            agentId: match.id,
            cwd: match.cwd,
            ...(match.provider === undefined
              ? {}
              : { provider: match.provider }),
            ...(match.model === undefined ? {} : { model: match.model }),
            ...(match.modelPresetId == null
              ? {}
              : { modelPreset: match.modelPresetId }),
          };
        }
        const nextOffset = page.pagination?.nextOffset;
        if (
          nextOffset == null ||
          !Number.isSafeInteger(nextOffset) ||
          nextOffset <= offset
        ) {
          return null;
        }
        offset = nextOffset;
      }
    },
    async create(input) {
      await client.agents.create(input.agentId, input.cwd, {
        ...(input.runtime.provider === undefined
          ? {}
          : { provider: input.runtime.provider }),
        ...(input.runtime.model === undefined
          ? {}
          : { model: input.runtime.model }),
        ...(input.runtime.modelPreset === undefined
          ? {}
          : { modelPreset: input.runtime.modelPreset }),
      });
    },
    async configureRuntime(agent, desired) {
      let changed = false;
      if (
        desired.model !== undefined &&
        agent.modelPreset !== undefined
      ) {
        await client.agents.set(agent.agentId, "modelPreset", "clear");
        changed = true;
      }
      if (
        desired.provider !== undefined &&
        desired.provider !== agent.provider
      ) {
        await client.agents.set(
          agent.agentId,
          "provider",
          desired.provider,
        );
        changed = true;
      }
      if (
        desired.modelPreset !== undefined &&
        desired.modelPreset !== agent.modelPreset
      ) {
        await client.agents.set(
          agent.agentId,
          "modelPreset",
          desired.modelPreset,
        );
        changed = true;
      } else if (
        desired.model !== undefined &&
        desired.model !== agent.model
      ) {
        await client.agents.set(agent.agentId, "model", desired.model);
        changed = true;
      }
      return changed;
    },
    async configurePermissions(input) {
      const current = await client.agents.permissions(input.agentId);
      const currentProfile =
        current.runtimePermissions?.profile ??
        current.profile ??
        "bootstrap";
      const currentCapabilities = (
        current.runtimePermissions?.capabilities ?? []
      )
        .flatMap((capability) => {
          if (typeof capability === "string") return [capability];
          const permission = capability.permission?.trim();
          const objectType = capability.objectType?.trim();
          const objectId = capability.objectId?.trim();
          return permission && objectType && objectId
            ? [`${permission}:${objectType}:${objectId}`]
            : [];
        })
        .sort();
      const desiredCapabilities = [...input.capabilities].sort();
      if (
        currentProfile === input.profile &&
        canonicalJson(currentCapabilities) ===
          canonicalJson(desiredCapabilities)
      ) {
        return false;
      }
      const result = await client.agents.permissions(
        input.agentId,
        input.profile,
        input.capabilities.length === 0
          ? { clearCapabilities: true }
          : { capabilities: input.capabilities.join(",") },
      );
      return result.changed ?? true;
    },
  };
}

interface ReconciliationMarker {
  readonly formatVersion: 1;
  readonly sourceId: string;
  readonly agentKey: string;
  readonly templateId: string;
  readonly agentId: string;
  readonly appliedRevision?: string;
  readonly desiredFingerprint?: string;
  readonly receipts: readonly Readonly<{
    idempotencyKey: string;
    fingerprint: string;
  }>[];
}

const ReconciliationMarkerSchema = z.object({
  formatVersion: z.literal(1),
  sourceId: ChannelBackendOpaqueIdSchema,
  agentKey: ChannelBackendOpaqueIdSchema,
  templateId: ChannelBackendOpaqueIdSchema,
  agentId: ChannelBackendOpaqueIdSchema,
  appliedRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  desiredFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  receipts: z
    .array(
      z.object({
        idempotencyKey: ChannelBackendOpaqueIdSchema,
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(128),
});

interface ValidatedTemplate extends LocalAgentTemplate {
  readonly templateId: string;
  readonly workspaceRoot: string;
  readonly agentIdPrefix: string;
  readonly allowAdoption: boolean;
  readonly manageInstructions: boolean;
  readonly permissionProfile: "bootstrap" | "full-access";
  readonly capabilityMap: Readonly<
    Record<string, readonly string[]>
  >;
}

export interface LocalAgentReconcilerOptions {
  readonly runtime: LocalAgentRuntimeAdapter;
  readonly templates: readonly LocalAgentTemplate[];
  readonly now?: () => string;
}

export class LocalAgentReconciler {
  private readonly runtime: LocalAgentRuntimeAdapter;
  private readonly templates = new Map<string, ValidatedTemplate>();
  private readonly now: () => string;
  private readonly tails = new Map<string, Promise<void>>();

  constructor(options: LocalAgentReconcilerOptions) {
    this.runtime = options.runtime;
    this.now = options.now ?? (() => new Date().toISOString());
    for (const input of options.templates) {
      const template = validateTemplate(input);
      if (this.templates.has(template.templateId)) {
        throw new Error(
          `Duplicate local agent template: ${template.templateId}`,
        );
      }
      this.templates.set(template.templateId, template);
    }
  }

  async reconcile(
    input: LocalAgentReconciliationRequest,
  ): Promise<LocalAgentReconciliationResult> {
    const request = LocalAgentReconciliationRequestSchema.parse(input);
    const key = `${request.sourceId}\u0000${request.agentKey}`;
    const prior = this.tails.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = prior.then(() => current);
    this.tails.set(key, chain);
    await prior;
    try {
      return await this.reconcileExclusive(request);
    } finally {
      release?.();
      if (this.tails.get(key) === chain) this.tails.delete(key);
    }
  }

  private async reconcileExclusive(
    request: LocalAgentReconciliationRequest,
  ): Promise<LocalAgentReconciliationResult> {
    const template = this.templates.get(request.templateId);
    if (template === undefined) {
      return blocked(request, this.now(), "NOT_FOUND", "validation");
    }
    if (
      request.instructions !== undefined &&
      !template.manageInstructions
    ) {
      return blocked(
        request,
        this.now(),
        "LOCAL_PERMISSION_DENIED",
        "authorization",
      );
    }

    const capabilities = resolveCapabilities(
      template,
      request.requestedCapabilities,
    );
    if (capabilities === null) {
      return blocked(
        request,
        this.now(),
        "LOCAL_PERMISSION_DENIED",
        "authorization",
      );
    }
    const runtime = resolveRuntime(template, request.runtime);
    if (runtime === null) {
      return blocked(
        request,
        this.now(),
        "LOCAL_PERMISSION_DENIED",
        "authorization",
      );
    }

    const agentId = deriveAgentId(template.agentIdPrefix, request);
    const desiredFingerprint = sha256(
      canonicalJson({
        sourceId: request.sourceId,
        agentKey: request.agentKey,
        templateId: request.templateId,
        revision: request.revision,
        instructions: request.instructions,
        requestedCapabilities: request.requestedCapabilities,
        agentId,
        runtime,
        capabilities,
        permissionProfile: template.permissionProfile,
        baseInstructions: template.baseInstructions,
      }),
    );

    try {
      const workspace = await ensureManagedWorkspace(
        template.workspaceRoot,
        agentId,
      );
      const markerPath = path.join(
        workspace,
        ".ravi",
        "local-agent-reconciliation.json",
      );
      const marker = await readMarker(markerPath);
      const receipt = marker?.receipts.find(
        (candidate) =>
          candidate.idempotencyKey === request.idempotencyKey,
      );
      if (
        receipt !== undefined &&
        receipt.fingerprint !== desiredFingerprint
      ) {
        return blocked(
          request,
          this.now(),
          "IDEMPOTENCY_CONFLICT",
          "validation",
        );
      }
      if (
        marker !== null &&
        (marker.sourceId !== request.sourceId ||
          marker.agentKey !== request.agentKey ||
          marker.templateId !== request.templateId ||
          marker.agentId !== agentId)
      ) {
        return blocked(
          request,
          this.now(),
          "LOCAL_PERMISSION_DENIED",
          "authorization",
        );
      }

      let existing = await this.runtime.inspect(agentId);
      if (
        existing !== null &&
        normalizePath(existing.cwd) !== normalizePath(workspace)
      ) {
        return blocked(
          request,
          this.now(),
          "LOCAL_PERMISSION_DENIED",
          "authorization",
        );
      }
      if (
        existing !== null &&
        marker === null &&
        !template.allowAdoption
      ) {
        return blocked(
          request,
          this.now(),
          "LOCAL_PERMISSION_DENIED",
          "authorization",
        );
      }

      const reservation =
        marker ??
        ({
          formatVersion: 1,
          sourceId: request.sourceId,
          agentKey: request.agentKey,
          templateId: request.templateId,
          agentId,
          receipts: [],
        } satisfies ReconciliationMarker);
      await writeMarker(markerPath, reservation);

      let changed = marker === null;
      if (template.manageInstructions) {
        const instructions = composeInstructions(
          template.baseInstructions,
          request.instructions,
        );
        changed =
          (await writeIfChanged(
            path.join(workspace, "AGENTS.md"),
            instructions,
          )) || changed;
      }

      const createdLocally = existing === null;
      if (existing === null) {
        try {
          await this.runtime.create({
            agentId,
            cwd: workspace,
            runtime,
          });
        } catch (error) {
          const recovered = await this.runtime.inspect(agentId);
          if (
            recovered === null ||
            normalizePath(recovered.cwd) !== normalizePath(workspace)
          ) {
            throw error;
          }
          existing = recovered;
          changed =
            (await this.runtime.configureRuntime(recovered, runtime)) ||
            changed;
        }
        changed = true;
      } else {
        changed =
          (await this.runtime.configureRuntime(existing, runtime)) ||
          changed;
      }
      changed =
        (await this.runtime.configurePermissions({
          agentId,
          profile: template.permissionProfile,
          capabilities,
        })) || changed;

      const nextMarker: ReconciliationMarker = {
        ...reservation,
        appliedRevision: request.revision,
        desiredFingerprint,
        receipts: rememberReceipt(
          reservation.receipts,
          request.idempotencyKey,
          desiredFingerprint,
        ),
      };
      changed =
        marker?.appliedRevision !== request.revision ||
        marker?.desiredFingerprint !== desiredFingerprint ||
        changed;
      await writeMarker(markerPath, nextMarker);

      return LocalAgentReconciliationResultSchema.parse({
        protocol: LOCAL_AGENT_RECONCILIATION_PROTOCOL,
        schemaVersion: LOCAL_AGENT_RECONCILIATION_SCHEMA_VERSION,
        requestId: request.requestId,
        disposition:
          createdLocally
            ? "created"
            : changed
              ? "updated"
              : "unchanged",
        state: "ready",
        agentId,
        appliedRevision: request.revision,
        grantedCapabilities: [...request.requestedCapabilities],
        observedAt: this.now(),
      });
    } catch {
      return blocked(
        request,
        this.now(),
        "INTERNAL",
        "internal",
      );
    }
  }
}

function validateTemplate(
  input: LocalAgentTemplate,
): ValidatedTemplate {
  const templateId = ChannelBackendOpaqueIdSchema.parse(
    input.templateId,
  );
  const workspaceRoot = normalizePath(input.workspaceRoot);
  if (
    !path.isAbsolute(workspaceRoot) ||
    path.parse(workspaceRoot).root === workspaceRoot
  ) {
    throw new Error(
      `Local agent template ${templateId} requires a bounded absolute workspace root`,
    );
  }
  const agentIdPrefix = input.agentIdPrefix ?? "managed";
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agentIdPrefix)) {
    throw new Error(
      `Local agent template ${templateId} has an invalid agent ID prefix`,
    );
  }
  if (
    input.runtime?.model !== undefined &&
    input.runtime.modelPreset !== undefined
  ) {
    throw new Error(
      `Local agent template ${templateId} cannot set model and modelPreset`,
    );
  }
  const capabilityMap = input.capabilityMap ?? {};
  for (const [capability, permissions] of Object.entries(capabilityMap)) {
    ChannelBackendWireKindSchema.parse(capability);
    for (const permission of permissions) {
      if (
        !/^[^,:]+:[^,:]+:[^,]+$/.test(permission) ||
        permission.length > 1_024
      ) {
        throw new Error(
          `Local agent template ${templateId} has an invalid permission mapping`,
        );
      }
    }
  }
  return {
    ...input,
    templateId,
    workspaceRoot,
    agentIdPrefix,
    allowAdoption: input.allowAdoption ?? false,
    manageInstructions: input.manageInstructions ?? false,
    permissionProfile: input.permissionProfile ?? "bootstrap",
    capabilityMap,
  };
}

function resolveCapabilities(
  template: ValidatedTemplate,
  requested: readonly string[],
): string[] | null {
  const resolved: string[] = [];
  for (const capability of requested) {
    const mapped = template.capabilityMap[capability];
    if (mapped === undefined) return null;
    resolved.push(...mapped);
  }
  return [...new Set(resolved)].sort();
}

function resolveRuntime(
  template: ValidatedTemplate,
  requested: LocalAgentRuntimePreference | undefined,
): LocalAgentRuntimePreference | null {
  const defaults = template.runtime ?? {};
  const provider = requested?.provider ?? defaults.provider;
  const model = requested?.model ?? defaults.model;
  const modelPreset = requested?.modelPreset ?? defaults.modelPreset;
  if (model !== undefined && modelPreset !== undefined) return null;
  if (
    !preferenceAllowed(
      requested?.provider,
      defaults.provider,
      defaults.allowedProviders,
    ) ||
    !preferenceAllowed(
      requested?.model,
      defaults.model,
      defaults.allowedModels,
    ) ||
    !preferenceAllowed(
      requested?.modelPreset,
      defaults.modelPreset,
      defaults.allowedModelPresets,
    )
  ) {
    return null;
  }
  return LocalAgentRuntimePreferenceSchema.parse({
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(modelPreset === undefined ? {} : { modelPreset }),
  });
}

function preferenceAllowed(
  requested: string | undefined,
  localDefault: string | undefined,
  allowlist: readonly string[] | undefined,
): boolean {
  if (requested === undefined) return true;
  if (allowlist !== undefined) return allowlist.includes(requested);
  return localDefault !== undefined && requested === localDefault;
}

function deriveAgentId(
  prefix: string,
  request: LocalAgentReconciliationRequest,
): string {
  const digest = sha256(
    `${request.sourceId}\u001f${request.agentKey}`,
  ).slice(0, 24);
  return ChannelBackendOpaqueIdSchema.parse(`${prefix}-${digest}`);
}

async function ensureManagedWorkspace(
  rootInput: string,
  agentId: string,
): Promise<string> {
  const root = normalizePath(rootInput);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Local agent workspace root is not a directory");
  }
  const canonicalRoot = await realpath(root);
  const candidate = path.join(canonicalRoot, agentId);
  const before = await lstat(candidate).catch((error: unknown) => {
    if (isFileSystemError(error, "ENOENT")) return null;
    throw error;
  });
  if (before?.isSymbolicLink()) {
    throw new Error("Local agent workspace cannot be a symbolic link");
  }
  await mkdir(candidate, { recursive: true, mode: 0o700 });
  const canonicalCandidate = await realpath(candidate);
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  if (
    relative.length === 0 ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Local agent workspace escaped its template root");
  }
  const markerDirectory = path.join(canonicalCandidate, ".ravi");
  const markerDirectoryStat = await lstat(markerDirectory).catch(
    (error: unknown) => {
      if (isFileSystemError(error, "ENOENT")) return null;
      throw error;
    },
  );
  if (markerDirectoryStat?.isSymbolicLink()) {
    throw new Error("Local agent marker directory cannot be a symlink");
  }
  await mkdir(markerDirectory, { recursive: true, mode: 0o700 });
  return canonicalCandidate;
}

async function readMarker(
  markerPath: string,
): Promise<ReconciliationMarker | null> {
  const stat = await lstat(markerPath).catch((error: unknown) => {
    if (isFileSystemError(error, "ENOENT")) return null;
    throw error;
  });
  if (stat === null) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Local agent marker must be a regular file");
  }
  return ReconciliationMarkerSchema.parse(
    JSON.parse(await readFile(markerPath, "utf8")),
  );
}

async function writeMarker(
  markerPath: string,
  marker: ReconciliationMarker,
): Promise<void> {
  const content = `${JSON.stringify(marker, null, 2)}\n`;
  await atomicWrite(markerPath, content, 0o600);
}

async function writeIfChanged(
  targetPath: string,
  content: string,
): Promise<boolean> {
  const stat = await lstat(targetPath).catch((error: unknown) => {
    if (isFileSystemError(error, "ENOENT")) return null;
    throw error;
  });
  if (stat?.isSymbolicLink()) {
    throw new Error("Managed instructions cannot be a symbolic link");
  }
  if (stat !== null && !stat.isFile()) {
    throw new Error("Managed instructions target is not a regular file");
  }
  if (
    stat !== null &&
    (await readFile(targetPath, "utf8")) === content
  ) {
    return false;
  }
  await atomicWrite(targetPath, content, 0o600);
  return true;
}

async function atomicWrite(
  targetPath: string,
  content: string,
  mode: number,
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${randomUUID()}.tmp`,
  );
  await writeFile(temporaryPath, content, {
    encoding: "utf8",
    flag: "wx",
    mode,
  });
  await rename(temporaryPath, targetPath);
}

function composeInstructions(
  base: string | undefined,
  desired: string | undefined,
): string {
  const sections = [base?.trim(), desired?.trim()].filter(
    (value): value is string => Boolean(value),
  );
  return `# Managed agent instructions\n\n${
    sections.length === 0
      ? "Follow the local runtime policy."
      : sections.join("\n\n")
  }\n`;
}

function rememberReceipt(
  receipts: ReconciliationMarker["receipts"],
  idempotencyKey: string,
  fingerprint: string,
): ReconciliationMarker["receipts"] {
  const next = receipts.filter(
    (receipt) => receipt.idempotencyKey !== idempotencyKey,
  );
  next.push({ idempotencyKey, fingerprint });
  return next.slice(-128);
}

function blocked(
  request: LocalAgentReconciliationRequest,
  observedAt: string,
  code: ChannelSafeError["code"],
  category: ChannelSafeError["category"],
): LocalAgentReconciliationResult {
  return LocalAgentReconciliationResultSchema.parse({
    protocol: LOCAL_AGENT_RECONCILIATION_PROTOCOL,
    schemaVersion: LOCAL_AGENT_RECONCILIATION_SCHEMA_VERSION,
    requestId: request.requestId,
    disposition: "blocked",
    state: "blocked",
    grantedCapabilities: [],
    error: {
      code,
      category,
      retryable: code === "INTERNAL",
      correlationId: request.requestId,
    },
    observedAt,
  });
}

function normalizePath(value: string): string {
  const expanded =
    value === "~"
      ? homedir()
      : value.startsWith("~/")
        ? path.join(homedir(), value.slice(2))
        : value;
  return path.resolve(expanded);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isFileSystemError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === code
  );
}
