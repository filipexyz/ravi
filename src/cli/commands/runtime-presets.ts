/**
 * Runtime model preset commands
 *
 * Centrally managed, named model selectors that agents reference indirectly.
 * See `.ravi/specs/runtime/model-presets/SPEC.md` for the normative contract.
 */

import "reflect-metadata";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { fail } from "../context.js";
import { buildCliOffsetPagination } from "../pagination.js";
import { nats } from "../../nats.js";
import {
  runtimeModelPresetImpactReturnSchema,
  runtimeModelPresetMutationReturnSchema,
  runtimeModelPresetShowReturnSchema,
  runtimeModelPresetsListReturnSchema,
} from "./operational-return-schemas.js";
import {
  RuntimeModelPresetError,
  countAgentsReferencingPreset,
  createRuntimeModelPreset,
  deleteRuntimeModelPreset,
  getRuntimeModelPresetImpact,
  listRuntimeModelPresets,
  requireRuntimeModelPreset,
  setRuntimeModelPresetEnabled,
  setRuntimeModelPresetModel,
  type RuntimeModelPreset,
} from "../../runtime/model-preset-store.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function printPayload(payload: unknown, asJson: boolean, human: () => void): void {
  if (asJson) printJson(payload);
  else human();
}

/** Notify the gateway to reload config after a durable preset mutation. */
function emitConfigChanged(): void {
  nats.emit("ravi.config.changed", {}).catch(() => {});
}

function runPresetMutation<T>(action: () => T): T {
  try {
    return action();
  } catch (err) {
    if (err instanceof RuntimeModelPresetError) {
      fail(err.nextCommand ? `${err.message}\nNext: ${err.nextCommand}` : err.message);
    }
    fail(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function serializePreset(preset: RuntimeModelPreset) {
  return {
    id: preset.id,
    provider: preset.provider,
    model: preset.model,
    description: preset.description,
    enabled: preset.enabled,
    version: preset.version,
    createdAt: preset.createdAt,
    updatedAt: preset.updatedAt,
  };
}

@Group({
  name: "runtime.presets",
  description: "Runtime model presets referenced by agents",
  scope: "admin",
})
export class RuntimeModelPresetCommands {
  @Command({
    name: "list",
    description: "List runtime model presets",
    helpAfter: "\nExamples:\n  ravi runtime presets list\n  ravi runtime presets list --provider anthropic --json",
  })
  @CommandAccess({ kind: "read", resource: "runtime.presets", action: "list", risk: "low" })
  @Returns(runtimeModelPresetsListReturnSchema)
  list(
    @Option({ flags: "--provider <id>", description: "Filter by provider" }) provider?: string,
    @Option({ flags: "--enabled", description: "Only enabled presets" }) enabledOnly = false,
    @Option({ flags: "--disabled", description: "Only disabled presets" }) disabledOnly = false,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of presets to skip (default: 0)" }) offset?: string,
  ) {
    if (enabledOnly && disabledOnly) fail("--enabled and --disabled are mutually exclusive.");
    const enabled = enabledOnly ? true : disabledOnly ? false : undefined;
    const page = listRuntimeModelPresets({ provider: provider?.trim() || undefined, enabled, limit, offset });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "runtime", "presets", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: ["--provider", provider, enabledOnly ? "--enabled" : null, disabledOnly ? "--disabled" : null],
    });
    const payload = {
      total: page.total,
      pagination,
      presets: page.items.map(serializePreset),
    };
    printPayload(payload, asJson, () => {
      console.log(`\nRuntime model presets (${page.items.length} returned of ${page.total}):\n`);
      for (const preset of payload.presets) {
        console.log(
          `  ${preset.id}  ${preset.provider}/${preset.model}  v${preset.version}${preset.enabled ? "" : " (disabled)"}`,
        );
      }
      if (pagination.nextCommand) {
        console.log("\nNext page:");
        console.log(`  ${pagination.nextCommand}`);
      }
    });
    return payload;
  }

  @Command({
    name: "show",
    description: "Show a runtime model preset",
    helpAfter: "\nExamples:\n  ravi runtime presets show fast-sonnet --json",
  })
  @CommandAccess({ kind: "read", resource: "runtime.presets", action: "show", risk: "low" })
  @Returns(runtimeModelPresetShowReturnSchema)
  show(
    @Arg("id", { description: "Preset id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const preset = runPresetMutation(() => requireRuntimeModelPreset(id));
    const payload = {
      preset: serializePreset(preset),
      referencingAgentsTotal: countAgentsReferencingPreset(preset.id),
    };
    printPayload(payload, asJson, () => {
      console.log(`\nPreset: ${preset.id}`);
      console.log(`  Provider:   ${preset.provider}`);
      console.log(`  Model:      ${preset.model}`);
      console.log(`  Enabled:    ${preset.enabled}`);
      console.log(`  Version:    ${preset.version}`);
      console.log(`  Referenced: ${payload.referencingAgentsTotal} agent(s)`);
      if (preset.description) console.log(`  Description: ${preset.description}`);
    });
    return payload;
  }

  @Command({
    name: "create",
    description: "Create a runtime model preset",
    helpAfter: "\nExamples:\n  ravi runtime presets create fast-sonnet --provider anthropic --model sonnet",
  })
  @CommandAccess({ kind: "mutate", resource: "runtime.presets", action: "create", risk: "medium" })
  @Returns(runtimeModelPresetMutationReturnSchema)
  create(
    @Arg("id", { description: "Stable preset id/slug" }) id: string,
    @Option({ flags: "--provider <id>", description: "Runtime provider id (immutable)" }) provider?: string,
    @Option({ flags: "--model <model>", description: "Model selector" }) model?: string,
    @Option({ flags: "--description <text>", description: "Human-readable description" }) description?: string,
    @Option({ flags: "--disabled", description: "Create in the disabled state" }) disabled = false,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    if (!provider?.trim()) fail("--provider is required.");
    if (!model?.trim()) fail("--model is required.");
    const preset = runPresetMutation(() =>
      createRuntimeModelPreset({
        id,
        provider: provider!.trim(),
        model: model!.trim(),
        description: description?.trim() || null,
        enabled: !disabled,
      }),
    );
    emitConfigChanged();
    const payload = {
      action: "create" as const,
      changed: true,
      dryRun: false,
      preset: serializePreset(preset),
    };
    printPayload(payload, asJson, () =>
      console.log(`\u2713 Created model preset ${preset.id} (${preset.provider}/${preset.model})`),
    );
    return payload;
  }

  @Command({
    name: "set",
    description: "Update a runtime model preset field (model)",
    helpAfter:
      "\nExamples:\n  ravi runtime presets set fast-sonnet model sonnet-4\n  ravi runtime presets set fast-sonnet model sonnet-4 --dry-run",
  })
  @CommandAccess({ kind: "mutate", resource: "runtime.presets", action: "set", risk: "medium" })
  @Returns(runtimeModelPresetMutationReturnSchema)
  set(
    @Arg("id", { description: "Preset id" }) id: string,
    @Arg("field", { description: "Field to set (model)" }) field: string,
    @Arg("value", { description: "New value" }) value: string,
    @Option({ flags: "--dry-run", description: "Preview without persisting or bumping the version" }) dryRun = false,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    if (field !== "model") fail(`Invalid field: ${field}. Only 'model' can be set (provider is immutable).`);
    const before = runPresetMutation(() => requireRuntimeModelPreset(id));
    const preset = runPresetMutation(() => setRuntimeModelPresetModel(id, value, { dryRun }));
    const changed = preset.version !== before.version || preset.model !== before.model;
    if (!dryRun && changed) emitConfigChanged();
    const payload = {
      action: "set-model" as const,
      changed,
      dryRun,
      preset: serializePreset(preset),
    };
    printPayload(payload, asJson, () => {
      if (dryRun) console.log(`[dry-run] Would set ${preset.id} model -> ${preset.model} (v${preset.version})`);
      else if (changed) console.log(`\u2713 Set ${preset.id} model -> ${preset.model} (v${preset.version})`);
      else console.log(`No change: ${preset.id} model is already ${preset.model}`);
    });
    return payload;
  }

  @Command({
    name: "impact",
    description: "Show agents/sessions affected by a preset",
    helpAfter: "\nExamples:\n  ravi runtime presets impact fast-sonnet --json",
  })
  @CommandAccess({ kind: "read", resource: "runtime.presets", action: "impact", risk: "low" })
  @Returns(runtimeModelPresetImpactReturnSchema)
  impact(
    @Arg("id", { description: "Preset id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of agents to skip (default: 0)" }) offset?: string,
  ) {
    const impact = runPresetMutation(() => getRuntimeModelPresetImpact(id, { limit, offset }));
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "runtime", "presets", "impact", impact.presetId],
      limit: impact.limit,
      offset: impact.offset,
      returned: impact.agents.length,
      total: impact.referencingAgentsTotal,
    });
    const payload = { ...impact, pagination };
    printPayload(payload, asJson, () => {
      console.log(`\nImpact for preset ${impact.presetId} (v${impact.version}):`);
      console.log(`  Referencing agents: ${impact.referencingAgentsTotal}`);
      console.log(`  Shadowing sessions: ${impact.shadowingSessionsTotal}`);
      for (const agent of impact.agents) {
        console.log(
          `  - ${agent.agentId} -> ${agent.provider}/${agent.effectiveModel} (${agent.shadowingSessions} shadowing)`,
        );
      }
      if (impact.correctionCommand) {
        console.log(`\nCorrection:\n  ${impact.correctionCommand}`);
      }
      if (pagination.nextCommand) {
        console.log("\nNext page:");
        console.log(`  ${pagination.nextCommand}`);
      }
    });
    return payload;
  }

  @Command({
    name: "enable",
    description: "Enable a runtime model preset",
    helpAfter: "\nExamples:\n  ravi runtime presets enable fast-sonnet",
  })
  @CommandAccess({ kind: "mutate", resource: "runtime.presets", action: "enable", risk: "medium" })
  @Returns(runtimeModelPresetMutationReturnSchema)
  enable(
    @Arg("id", { description: "Preset id" }) id: string,
    @Option({ flags: "--dry-run", description: "Preview without persisting or bumping the version" }) dryRun = false,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const before = runPresetMutation(() => requireRuntimeModelPreset(id));
    const preset = runPresetMutation(() => setRuntimeModelPresetEnabled(id, true, { dryRun }));
    const changed = preset.version !== before.version || preset.enabled !== before.enabled;
    if (!dryRun && changed) emitConfigChanged();
    const payload = { action: "enable" as const, changed, dryRun, preset: serializePreset(preset) };
    printPayload(payload, asJson, () =>
      console.log(
        dryRun
          ? `[dry-run] Would enable ${preset.id}`
          : changed
            ? `\u2713 Enabled ${preset.id}`
            : `No change: ${preset.id} already enabled`,
      ),
    );
    return payload;
  }

  @Command({
    name: "disable",
    description: "Disable an unreferenced runtime model preset",
    helpAfter: "\nExamples:\n  ravi runtime presets disable fast-sonnet --dry-run",
  })
  @CommandAccess({ kind: "mutate", resource: "runtime.presets", action: "disable", risk: "medium" })
  @Returns(runtimeModelPresetMutationReturnSchema)
  disable(
    @Arg("id", { description: "Preset id" }) id: string,
    @Option({ flags: "--dry-run", description: "Preview without persisting or bumping the version" }) dryRun = false,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const before = runPresetMutation(() => requireRuntimeModelPreset(id));
    const preset = runPresetMutation(() => setRuntimeModelPresetEnabled(id, false, { dryRun }));
    const changed = preset.version !== before.version || preset.enabled !== before.enabled;
    if (!dryRun && changed) emitConfigChanged();
    const payload = { action: "disable" as const, changed, dryRun, preset: serializePreset(preset) };
    printPayload(payload, asJson, () =>
      console.log(
        dryRun
          ? `[dry-run] Would disable ${preset.id}`
          : changed
            ? `\u2713 Disabled ${preset.id}`
            : `No change: ${preset.id} already disabled`,
      ),
    );
    return payload;
  }

  @Command({
    name: "delete",
    description: "Delete an unreferenced runtime model preset",
    helpAfter: "\nExamples:\n  ravi runtime presets delete fast-sonnet --dry-run",
  })
  @CommandAccess({ kind: "mutate", resource: "runtime.presets", action: "delete", risk: "high" })
  @Returns(runtimeModelPresetMutationReturnSchema)
  delete(
    @Arg("id", { description: "Preset id" }) id: string,
    @Option({ flags: "--dry-run", description: "Preview without persisting" }) dryRun = false,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const preset = runPresetMutation(() => deleteRuntimeModelPreset(id, { dryRun }));
    if (!dryRun) emitConfigChanged();
    const payload = { action: "delete" as const, changed: !dryRun, dryRun, preset: serializePreset(preset) };
    printPayload(payload, asJson, () =>
      console.log(dryRun ? `[dry-run] Would delete ${preset.id}` : `\u2713 Deleted ${preset.id}`),
    );
    return payload;
  }
}
