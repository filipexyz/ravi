import "reflect-metadata";
import { Arg, Command, Group, Option } from "../decorators.js";
import { fail } from "../context.js";
import { buildCliOffsetPagination } from "../pagination.js";
import {
  createRuntimeCredential,
  getRuntimeCredential,
  getRuntimeCredentialHealth,
  listRuntimeCredentials,
  listRuntimeProviderHealth,
  recordRuntimeCredentialLimitPressure,
  recordRuntimeCredentialFailure,
  resetRuntimeCredentialHealth,
  serializeRuntimeCredential,
  setRuntimeCredentialEnabled,
} from "../../runtime/credential-store.js";
import { selectRuntimeCredential } from "../../runtime/credential-pool.js";
import { refreshRuntimeCredential, refreshRuntimeCredentialPool } from "../../runtime/credential-refresh.js";
import {
  classifyRuntimeCredentialFailure,
  evaluateCredentialLimitPressure,
} from "../../runtime/credential-classifier.js";
import type {
  RuntimeCredentialInput,
  RuntimeCredentialSecretBinding,
  RuntimeCredentialStatus,
} from "../../runtime/credential-types.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function printPayload(payload: unknown, asJson: boolean, human: () => void): void {
  if (asJson) printJson(payload);
  else human();
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseIntOption(value: string | undefined, label: string, fallback = 0): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) fail(`${label} must be an integer.`);
  return parsed;
}

function parseHeaders(value: string | undefined): Record<string, string> | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail("--headers must be a JSON object.");
    }
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([key, v]) => [key, String(v)]));
  } catch (err) {
    fail(`--headers must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseSecretEnvBindings(
  secretEnv: string | undefined,
  targetEnv: string | undefined,
  remoteForward: boolean,
): Array<Omit<RuntimeCredentialSecretBinding, "id" | "credentialId" | "createdAt" | "updatedAt">> {
  const sourceNames = splitCsv(secretEnv);
  const targetNames = splitCsv(targetEnv);
  if (sourceNames.length === 0 && targetNames.length === 0) return [];
  if (sourceNames.length !== targetNames.length) {
    fail(
      "Each --secret-env entry must have one matching --target-env entry. Use comma-separated pairs for composite credentials.",
    );
  }
  const seen = new Set<string>();
  return sourceNames.map((source, index) => {
    const target = targetNames[index];
    if (!target) fail("Missing target env for secret env binding.");
    const key = `${source}->${target}`;
    if (seen.has(key)) fail(`Duplicated secret env binding: ${key}`);
    seen.add(key);
    return {
      sourceKind: "env",
      targetKind: "env",
      targetName: target,
      secretRef: `env:${source}`,
      sourceHint: source,
      sensitive: true,
      remoteForward,
    };
  });
}

function buildCredentialInput(options: {
  provider?: string;
  upstream?: string;
  label?: string;
  authMethod?: string;
  secretEnv?: string;
  targetEnv?: string;
  authProfile?: string;
  models?: string;
  agents?: string;
  taskProfiles?: string;
  priority?: string;
  remoteForward?: boolean;
  notes?: string;
  readOnly?: boolean;
}): RuntimeCredentialInput {
  if (!options.provider?.trim()) fail("--provider is required.");
  if (!options.label?.trim()) fail("--label is required.");

  const bindings = parseSecretEnvBindings(options.secretEnv, options.targetEnv, Boolean(options.remoteForward));
  if (options.authProfile?.trim()) {
    bindings.push({
      sourceKind: "provider-profile",
      targetKind: "auth-profile",
      targetName: "profile",
      secretRef: `file:${options.authProfile.trim()}`,
      sourceHint: options.authProfile.trim(),
      sensitive: true,
      remoteForward: false,
    });
  }
  if (!bindings.length) fail("Provide at least one credential source via --secret-env/--target-env or --auth-profile.");

  return {
    label: options.label.trim(),
    runtimeProvider: options.provider.trim(),
    upstreamProvider: options.upstream?.trim() || undefined,
    authMethod: options.authMethod?.trim() || undefined,
    authProfileRef: options.authProfile?.trim() || undefined,
    sourceKind: options.authProfile ? "provider-profile" : "env",
    modelAllowlist: splitCsv(options.models),
    agentAllowlist: splitCsv(options.agents),
    taskProfileAllowlist: splitCsv(options.taskProfiles),
    priority: parseIntOption(options.priority, "--priority", 0),
    notes: options.notes?.trim() || (options.readOnly ? "read-only external credential source" : undefined),
    bindings,
  };
}

@Group({
  name: "runtime.credentials",
  description: "Runtime provider credential pools",
  scope: "admin",
})
export class RuntimeCredentialsCommands {
  @Command({ name: "list", description: "List runtime provider credentials" })
  list(
    @Option({ flags: "--provider <id>", description: "Filter by runtime provider" }) provider?: string,
    @Option({ flags: "--upstream <id>", description: "Filter by upstream provider" }) upstream?: string,
    @Option({ flags: "--status <status>", description: "Filter by credential status" })
    status?: RuntimeCredentialStatus,
    @Option({ flags: "--all", description: "Include disabled credentials" }) includeDisabled = false,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching credentials to skip (default: 0)" })
    offset?: string,
  ) {
    const page = listRuntimeCredentials({
      runtimeProvider: provider,
      upstreamProvider: upstream,
      status,
      includeDisabled,
      limit,
      offset,
    });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "runtime", "credentials", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: ["--provider", provider, "--upstream", upstream, "--status", status, includeDisabled ? "--all" : null],
    });
    const payload = {
      total: page.total,
      pagination,
      credentials: page.items.map((item) => serializeRuntimeCredential(item, { includeBindings: true })),
      providerHealth: listRuntimeProviderHealth(),
    };
    printPayload(payload, asJson, () => {
      console.log(`\nRuntime credentials (${page.items.length} returned of ${page.total}):\n`);
      for (const credential of payload.credentials) {
        console.log(`  ${credential.id}  ${credential.label}`);
        console.log(
          `    provider=${credential.runtimeProvider} upstream=${credential.upstreamProvider ?? "-"} status=${credential.status}`,
        );
        console.log(`    priority=${credential.priority} fingerprint=${credential.fingerprint}`);
      }
      if (pagination.nextCommand) {
        console.log("\nNext page:");
        console.log(`  ${pagination.nextCommand}`);
      }
    });
    return payload;
  }

  @Command({ name: "add", description: "Add a managed runtime provider credential" })
  add(
    @Option({ flags: "--provider <id>", description: "Runtime provider id, e.g. claude, codex, pi" }) provider?: string,
    @Option({ flags: "--label <label>", description: "Human label that does not contain secrets" }) label?: string,
    @Option({ flags: "--upstream <id>", description: "Upstream provider id, e.g. anthropic, openai" })
    upstream?: string,
    @Option({ flags: "--auth-method <method>", description: "Auth method, e.g. claude-oauth, api-key, codex-profile" })
    authMethod?: string,
    @Option({ flags: "--secret-env <names>", description: "Comma-separated source env vars holding secrets" })
    secretEnv?: string,
    @Option({ flags: "--target-env <names>", description: "Comma-separated provider-facing env vars" })
    targetEnv?: string,
    @Option({ flags: "--auth-profile <path>", description: "Provider-native auth profile path" }) authProfile?: string,
    @Option({ flags: "--models <list>", description: "Comma-separated model allowlist" }) models?: string,
    @Option({ flags: "--agents <list>", description: "Comma-separated agent allowlist" }) agents?: string,
    @Option({ flags: "--task-profiles <list>", description: "Comma-separated task profile allowlist" })
    taskProfiles?: string,
    @Option({ flags: "--priority <n>", description: "Selection priority (higher first)" }) priority?: string,
    @Option({
      flags: "--remote-forward",
      description: "Allow selected target env vars to be forwarded to remote workers",
    })
    remoteForward = false,
    @Option({ flags: "--notes <text>", description: "Operator notes, without secrets" }) notes?: string,
    @Option({ flags: "--read-only", description: "Mark the source as external/read-only in notes" }) readOnly = false,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const credential = createRuntimeCredential(
      buildCredentialInput({
        provider,
        label,
        upstream,
        authMethod,
        secretEnv,
        targetEnv,
        authProfile,
        models,
        agents,
        taskProfiles,
        priority,
        remoteForward,
        notes,
        readOnly,
      }),
    );
    const payload = { credential: serializeRuntimeCredential(credential, { includeBindings: true }) };
    printPayload(payload, asJson, () => {
      console.log(`Added runtime credential ${credential.id} (${credential.label})`);
    });
    return payload;
  }

  @Command({ name: "import", description: "Import/reference an existing provider-native credential source" })
  importCredential(
    @Option({ flags: "--provider <id>", description: "Runtime provider id" }) provider?: string,
    @Option({ flags: "--label <label>", description: "Human label that does not contain secrets" }) label?: string,
    @Option({ flags: "--from-codex-home <path>", description: "Reference a Codex CODEX_HOME profile" })
    codexHome?: string,
    @Option({ flags: "--from-claude-code", description: "Reference the default Claude Code OAuth profile" })
    fromClaudeCode = false,
    @Option({ flags: "--managed-refresh", description: "Allow future provider-specific refresh/write-back" })
    managedRefresh = false,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    if (!provider?.trim()) fail("--provider is required.");
    if (!label?.trim()) fail("--label is required.");
    const authProfile = codexHome?.trim() || (fromClaudeCode ? "~/.claude" : undefined);
    if (!authProfile) fail("Provide --from-codex-home <path> or --from-claude-code.");
    const credential = createRuntimeCredential({
      label: label.trim(),
      runtimeProvider: provider.trim(),
      authMethod: provider === "codex" ? "codex-profile" : provider === "claude" ? "claude-oauth" : "provider-profile",
      sourceKind: "provider-profile",
      authProfileRef: authProfile,
      notes: managedRefresh
        ? "provider-native profile, managed refresh allowed"
        : "provider-native profile, read-only import",
      bindings: [
        {
          sourceKind: "provider-profile",
          targetKind: "auth-profile",
          targetName: "profile",
          secretRef: `file:${authProfile}`,
          sourceHint: authProfile,
          sensitive: true,
          remoteForward: false,
        },
      ],
    });
    const payload = { credential: serializeRuntimeCredential(credential, { includeBindings: true }) };
    printPayload(payload, asJson, () => {
      console.log(`Imported runtime credential ${credential.id} (${credential.label})`);
    });
    return payload;
  }

  @Command({ name: "status", description: "Show credential health and provider health" })
  status(
    @Arg("id", { required: false, description: "Credential id" }) id?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    if (id) {
      const credential = getRuntimeCredential(id);
      if (!credential) fail(`Runtime credential not found: ${id}`);
      const payload = {
        credential: serializeRuntimeCredential(credential, { includeBindings: true }),
        health: getRuntimeCredentialHealth(id),
      };
      printPayload(payload, asJson, () => {
        console.log(`${credential.id} (${credential.label})`);
        console.log(`  status=${credential.status} provider=${credential.runtimeProvider}`);
        console.log(`  health=${JSON.stringify(payload.health)}`);
      });
      return payload;
    }
    return this.list(undefined, undefined, undefined, true, asJson, undefined, undefined);
  }

  @Command({ name: "disable", description: "Disable a runtime credential immediately" })
  disable(
    @Arg("id", { description: "Credential id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const credential = setRuntimeCredentialEnabled(id, false);
    const payload = { credential: serializeRuntimeCredential(credential, { includeBindings: true }) };
    printPayload(payload, asJson, () => console.log(`Disabled runtime credential ${credential.id}`));
    return payload;
  }

  @Command({ name: "enable", description: "Enable a runtime credential" })
  enable(
    @Arg("id", { description: "Credential id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const credential = setRuntimeCredentialEnabled(id, true);
    const payload = { credential: serializeRuntimeCredential(credential, { includeBindings: true }) };
    printPayload(payload, asJson, () => console.log(`Enabled runtime credential ${credential.id}`));
    return payload;
  }

  @Command({ name: "reset-health", description: "Clear cooldown/error state for a credential" })
  resetHealth(
    @Arg("id", { description: "Credential id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const result = resetRuntimeCredentialHealth(id);
    const payload = {
      credential: serializeRuntimeCredential(result.credential, { includeBindings: true }),
      health: result.health,
    };
    printPayload(payload, asJson, () => console.log(`Reset runtime credential health ${result.credential.id}`));
    return payload;
  }

  @Command({ name: "refresh", description: "Refresh or recover credential health before pool selection" })
  async refresh(
    @Arg("id", { required: false, description: "Credential id" }) id?: string,
    @Option({ flags: "--provider <id>", description: "Runtime provider id for pool refresh" }) provider?: string,
    @Option({ flags: "--upstream <id>", description: "Upstream provider id for pool refresh" }) upstream?: string,
    @Option({ flags: "--model <model>", description: "Model selector for pool refresh" }) model?: string,
    @Option({ flags: "--agent <id>", description: "Agent id for pool refresh" }) agentId?: string,
    @Option({ flags: "--task-profile <id>", description: "Task profile id for pool refresh" }) taskProfile?: string,
    @Option({ flags: "--force", description: "Attempt provider hook even when health does not require it" })
    force = false,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    if (id) {
      const result = await refreshRuntimeCredential(id, { reason: "operator", force });
      const payload = { refreshed: [result] };
      printPayload(payload, asJson, () => {
        console.log(`${result.credentialId} ${result.action}: ${result.message ?? result.statusAfter}`);
      });
      return payload;
    }
    if (!provider?.trim()) fail("Provide a credential id or --provider for pool refresh.");
    const refreshed = await refreshRuntimeCredentialPool({
      runtimeProvider: provider.trim(),
      upstreamProvider: upstream?.trim() || undefined,
      model: model?.trim() || undefined,
      agentId: agentId?.trim() || undefined,
      taskProfile: taskProfile?.trim() || undefined,
      reason: "operator",
      force,
    });
    const payload = { refreshed };
    printPayload(payload, asJson, () => {
      if (refreshed.length === 0) {
        console.log("No runtime credentials needed refresh.");
        return;
      }
      for (const result of refreshed) {
        console.log(`${result.credentialId} ${result.action}: ${result.message ?? result.statusAfter}`);
      }
    });
    return payload;
  }

  @Command({ name: "select", description: "Preview which credential the pool would select" })
  select(
    @Option({ flags: "--provider <id>", description: "Runtime provider id" }) provider?: string,
    @Option({ flags: "--upstream <id>", description: "Upstream provider id" }) upstream?: string,
    @Option({ flags: "--model <model>", description: "Model selector" }) model?: string,
    @Option({ flags: "--agent <id>", description: "Agent id" }) agentId?: string,
    @Option({ flags: "--task-profile <id>", description: "Task profile id" }) taskProfile?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    if (!provider?.trim()) fail("--provider is required.");
    const result = selectRuntimeCredential({
      runtimeProvider: provider.trim(),
      upstreamProvider: upstream?.trim() || undefined,
      model: model?.trim() || undefined,
      agentId: agentId?.trim() || undefined,
      taskProfile: taskProfile?.trim() || undefined,
    });
    const payload = {
      selected: result.credential ? serializeRuntimeCredential(result.credential, { includeBindings: true }) : null,
      candidates: result.candidates.map((item) => serializeRuntimeCredential(item)),
      rejected: result.rejected,
    };
    printPayload(payload, asJson, () => {
      if (result.credential) console.log(`Selected ${result.credential.id} (${result.credential.label})`);
      else console.log("No eligible runtime credential selected.");
    });
    return payload;
  }

  @Command({ name: "classify", description: "Classify a provider failure for credential fallback" })
  classify(
    @Option({ flags: "--provider <id>", description: "Runtime provider id" }) provider?: string,
    @Option({ flags: "--status <code>", description: "HTTP status code" }) status?: string,
    @Option({ flags: "--upstream <id>", description: "Upstream provider id" }) upstream?: string,
    @Option({ flags: "--credential <id>", description: "Credential id to update" }) credentialId?: string,
    @Option({ flags: "--provider-code <code>", description: "Provider error code" }) providerCode?: string,
    @Option({ flags: "--provider-type <type>", description: "Provider error type" }) providerType?: string,
    @Option({ flags: "--message <text>", description: "Provider error message" }) message?: string,
    @Option({ flags: "--headers <json>", description: "Provider response headers as JSON object" })
    headersJson?: string,
    @Option({ flags: "--record", description: "Record the failure against --credential" }) record = false,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    if (!provider?.trim()) fail("--provider is required.");
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: provider.trim(),
      upstreamProvider: upstream?.trim() || undefined,
      credentialId: credentialId?.trim() || undefined,
      httpStatus: status ? parseIntOption(status, "--status") : undefined,
      providerCode,
      providerType,
      message,
      headers: parseHeaders(headersJson),
    });
    const pressure = evaluateCredentialLimitPressure(signal);
    const transition =
      record && credentialId
        ? pressure.nearLimit && signal.kind === "unknown"
          ? recordRuntimeCredentialLimitPressure(credentialId, signal)
          : recordRuntimeCredentialFailure(credentialId, signal)
        : undefined;
    const payload = {
      signal,
      pressure,
      ...(transition
        ? {
            transition: {
              credential: serializeRuntimeCredential(transition.credential, { includeBindings: true }),
              health: transition.health,
              providerHealth: transition.providerHealth ?? null,
            },
          }
        : {}),
    };
    printPayload(payload, asJson, () => {
      console.log(`kind=${signal.kind} confidence=${signal.confidence} retryable=${signal.retryableByCredential}`);
      if (pressure.nearLimit) console.log("limit pressure: near limit");
    });
    return payload;
  }
}
