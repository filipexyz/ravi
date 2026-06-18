#!/usr/bin/env bun
/**
 * Idempotent migration helper: enrich an existing CRM pipeline's `metadata`
 * with canonical-schema defaults (src/crm/pipeline-metadata.ts).
 *
 * Generic — does not encode any business pipeline IDs. Caller passes:
 *   --pipeline <id>           Pipeline ref (id or name) to enrich.
 *   --profile <name>          Default profile to apply (built-in: cobranca,
 *                             novo-contato, pos-venda, reativacao, recorrente,
 *                             generic). Each profile sets sensible defaults for
 *                             priority_global, send_window, vip_guard,
 *                             producers, consumers, versao, related_crons.
 *   --dry-run                 Print diff (current vs proposed). Default.
 *   --apply                   Persist via `ravi crm pipeline set`.
 *   --json                    Emit machine-readable diff.
 *
 * Backward-compat:
 *   - Existing metadata keys are PRESERVED. Profile fields only fill the gaps.
 *   - To override an existing field, edit it manually via `ravi crm pipeline
 *     set <id> metadata - --<field> <value>`.
 *   - Stages structure is NEVER touched (this script edits the metadata blob
 *     only — stages are managed via `ravi crm pipeline stage` commands).
 *
 * Usage examples (generic):
 *   bun scripts/migrate-pipeline-metadata.ts --pipeline crm_pipeline_xxx \\
 *     --profile cobranca --dry-run
 *   bun scripts/migrate-pipeline-metadata.ts --pipeline leads-prospect \\
 *     --profile generic --apply
 */

import { spawnSync } from "node:child_process";

interface ProfileDefaults {
  objetivo?: string;
  priority_global?: number;
  producers?: string[];
  consumers?: string[];
  versao?: string;
  send_window?: { hours: string; days?: string; timezone: string };
  vip_guard?: { tag_triggers: string[]; action: "hitl" | "block" | "tag_only" };
  related_crons?: string[];
  related_triggers?: string[];
}

const PROFILES: Record<string, ProfileDefaults> = {
  // Generic default — least opinionated. Useful as a starting point.
  generic: {
    objetivo: "TODO: describe the purpose of this pipeline in one paragraph.",
    priority_global: 3,
    producers: [],
    consumers: [],
    versao: "1.0.0",
    send_window: { hours: "9-21", days: "mon-sat", timezone: "America/Sao_Paulo" },
    vip_guard: { tag_triggers: ["perfil:vip"], action: "hitl" },
  },

  // Collection / dunning pipelines: highest priority (legal-sensitive), strict
  // hours, VIP guard mandatory.
  cobranca: {
    objetivo: "TODO: describe this collection / dunning pipeline (preserve original intent).",
    priority_global: 1,
    versao: "1.0.0",
    send_window: { hours: "9-20", days: "mon-fri", timezone: "America/Sao_Paulo" },
    vip_guard: { tag_triggers: ["perfil:vip", "cobranca:vip"], action: "hitl" },
  },

  // New-contact onboarding pipelines: lower priority, broader window.
  "novo-contato": {
    objetivo: "TODO: describe this new-contact onboarding pipeline.",
    priority_global: 4,
    versao: "1.0.0",
    send_window: { hours: "9-21", days: "mon-sat", timezone: "America/Sao_Paulo" },
    vip_guard: { tag_triggers: ["perfil:vip"], action: "hitl" },
  },

  // Post-sale follow-up: medium priority.
  "pos-venda": {
    objetivo: "TODO: describe this post-sale follow-up pipeline.",
    priority_global: 3,
    versao: "1.0.0",
    send_window: { hours: "9-21", days: "mon-sat", timezone: "America/Sao_Paulo" },
    vip_guard: { tag_triggers: ["perfil:vip"], action: "hitl" },
  },

  // Re-engagement / reactivation: lower priority, more permissive window.
  reativacao: {
    objetivo: "TODO: describe this re-engagement pipeline.",
    priority_global: 5,
    versao: "1.0.0",
    send_window: { hours: "9-21", days: "mon-sat", timezone: "America/Sao_Paulo" },
    vip_guard: { tag_triggers: ["perfil:vip"], action: "hitl" },
  },

  // Recurring revenue / subscription pipelines: medium-high priority.
  recorrente: {
    objetivo: "TODO: describe this recurring-revenue pipeline.",
    priority_global: 2,
    versao: "1.0.0",
    send_window: { hours: "9-21", days: "mon-sat", timezone: "America/Sao_Paulo" },
    vip_guard: { tag_triggers: ["perfil:vip"], action: "hitl" },
  },
};

interface ParsedArgs {
  pipeline?: string;
  profile?: string;
  apply: boolean;
  dryRun: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { apply: false, dryRun: true, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pipeline") out.pipeline = argv[++i];
    else if (a === "--profile") out.profile = argv[++i];
    else if (a === "--apply") {
      out.apply = true;
      out.dryRun = false;
    } else if (a === "--dry-run") {
      out.dryRun = true;
      out.apply = false;
    } else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function usage(): never {
  console.log(`Usage: bun scripts/migrate-pipeline-metadata.ts [options]

Options:
  --pipeline <id|name>   Required. Pipeline ref to enrich.
  --profile <name>       Required. Default profile to apply.
                         Built-ins: generic | cobranca | novo-contato |
                                    pos-venda | reativacao | recorrente
  --dry-run              Print the diff without writing (DEFAULT).
  --apply                Persist via 'ravi crm pipeline set'.
  --json                 Emit machine-readable JSON instead of text diff.
  -h, --help             Show this help.

Notes:
  - Existing metadata keys are NEVER overwritten — only missing fields are
    filled. To override, edit manually via 'ravi crm pipeline set'.
  - Stages structure is NEVER touched.
  - Run with --dry-run first; review diff; then --apply.
`);
  process.exit(2);
}

interface PipelineRecord {
  id: string;
  name: string;
  entityType: string;
  metadata: Record<string, unknown> | null;
}

function fetchPipeline(ref: string): { pipeline: PipelineRecord } | null {
  const result = spawnSync("ravi", ["crm", "pipeline", "show", ref, "--json"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(`error: ravi crm pipeline show failed for ${ref}:\n${result.stderr}`);
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout) as { pipeline: PipelineRecord };
    return parsed;
  } catch (err) {
    console.error(`error: invalid JSON from ravi crm pipeline show:\n${err}`);
    return null;
  }
}

function applyProfileDefaults(
  current: Record<string, unknown>,
  profile: ProfileDefaults,
): {
  proposed: Record<string, unknown>;
  added: Array<{ key: string; value: unknown }>;
  unchanged: string[];
} {
  const proposed: Record<string, unknown> = { ...current };
  const added: Array<{ key: string; value: unknown }> = [];
  const unchanged: string[] = [];

  for (const [key, value] of Object.entries(profile)) {
    if (current[key] !== undefined) {
      unchanged.push(key);
      continue;
    }
    proposed[key] = value;
    added.push({ key, value });
  }

  return { proposed, added, unchanged };
}

function persistMetadata(pipelineRef: string, metadata: Record<string, unknown>): boolean {
  const json = JSON.stringify(metadata);
  const result = spawnSync(
    "ravi",
    ["crm", "pipeline", "set", pipelineRef, "metadata", json, "--json"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    console.error(`error: ravi crm pipeline set failed:\n${result.stderr}`);
    return false;
  }
  return true;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.pipeline || !args.profile) usage();

  const profile = PROFILES[args.profile!];
  if (!profile) {
    console.error(`error: unknown profile "${args.profile}". Built-ins: ${Object.keys(PROFILES).join(", ")}`);
    process.exit(2);
  }

  const fetched = fetchPipeline(args.pipeline!);
  if (!fetched) process.exit(1);
  const pipeline = fetched.pipeline;
  const current = (pipeline.metadata as Record<string, unknown> | null) ?? {};

  const { proposed, added, unchanged } = applyProfileDefaults(current, profile);

  const diff = {
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    profile: args.profile,
    mode: args.apply ? "apply" : "dry-run",
    added,
    unchanged,
    currentKeys: Object.keys(current),
    proposedKeys: Object.keys(proposed),
  };

  if (args.json) {
    console.log(JSON.stringify(diff, null, 2));
  } else {
    console.log(`\nMigration plan: ${pipeline.name} (${pipeline.id})`);
    console.log(`Profile: ${args.profile}`);
    console.log(`Mode: ${diff.mode}`);
    if (added.length === 0) {
      console.log(`\nNo changes needed — metadata already has the profile keys (${unchanged.length} preserved).`);
    } else {
      console.log(`\nFields to add (${added.length}):`);
      for (const { key, value } of added) {
        console.log(`  + ${key}: ${JSON.stringify(value)}`);
      }
      if (unchanged.length > 0) {
        console.log(`\nFields preserved (${unchanged.length}): ${unchanged.join(", ")}`);
      }
    }
  }

  if (args.apply && added.length > 0) {
    const ok = persistMetadata(args.pipeline!, proposed);
    if (!ok) process.exit(1);
    console.log(`\n✓ Persisted (${added.length} new fields).`);
  } else if (args.dryRun && added.length > 0) {
    console.log(`\nDry-run — to apply: re-run with --apply`);
  }
}

await main();
