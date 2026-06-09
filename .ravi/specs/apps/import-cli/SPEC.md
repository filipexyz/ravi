---
id: apps/import-cli
title: "Import CLI To Ravi App"
kind: capability
domain: apps
capability: import-cli
capabilities:
  - cli-introspection
  - manifest-generation
  - scaffold
  - review-gates
  - agent-operation
tags:
  - apps
  - cli
  - import
  - manifest
  - generated-draft
applies_to:
  - src/apps
  - src/cli/commands/apps.ts
  - src/apps/scaffold.ts
  - src/plugins/internal/ravi-dev/skills/cli-creator
  - src/plugins/internal/ravi-system/skills/apps/SKILL.md
owners:
  - ravi-dev
status: draft
normative: true
---

# Import CLI To Ravi App

## Intent

Generate the first Ravi App contract from an existing CLI.

The import path turns a CLI command tree into a draft `ravi.app.json`, app spec,
and app skill. It is an accelerator, not a substitute for product design. The
CLI can describe command mechanics; humans still decide which operations are
daily app buttons, which commands remain debug-only, which actions are risky,
which permissions apply, and which events/UI/storage matter.

## Invariants

- CLI import MUST produce a draft app contract, not a trusted finished app.
- CLI import MUST support `--dry-run` and SHOULD default to non-writing preview
  behavior when invoked by agents.
- CLI import MUST NOT execute business/domain commands, health checks, writes,
  migrations, network mutations, or any operation that is not explicitly marked
  as safe introspection.
- CLI import SHOULD prefer an explicit self-description surface over parsing
  human help text.
- CLI import MAY use help parsing only as a low-confidence fallback, and MUST
  label help-derived fields as needing review.
- Imported manifests MUST use `schema: "ravi.app/v1"`.
- Imported operations MUST reference `interface: "cli"` unless the source CLI
  explicitly declares SDK, tool, or stream surfaces.
- Imported CLI operations MUST NOT point back to the app router dynamic alias
  such as `ravi <app-id> ...`.
- Imported CLI operations SHOULD include `--json` when the source command
  supports machine output.
- Commands without machine-readable output MUST be imported as warnings or
  debug candidates, not as agent/UI-ready operations.
- Mutating, destructive, externally visible, or money-spending operations MUST
  require explicit review before they are treated as app operations.
- Generated permission metadata MUST be conservative. The importer MAY suggest
  permission names, but MUST NOT treat suggestions as grants.
- Generated storage, events, UI, and skill text MUST be considered draft unless
  the source CLI self-describes those surfaces with schemas.
- Imported command lists SHOULD be collapsed into domain operations. The
  importer MUST NOT blindly expose every low-level subcommand as a top-level app
  operation when that would recreate the raw CLI inside the app manifest.
- Import output MUST include enough provenance to review what was generated
  from explicit metadata, what came from registry/decorators, and what came from
  heuristics.
- Import output SHOULD include confidence, warnings, and review-required fields.
- `ravi apps check <app-id> --json` MUST remain the validation gate after any
  import writes files.

## Preferred CLI Self-Description Contract

CLIs that want good Ravi App import SHOULD expose one of:

```bash
<cli> manifest --json
<cli> app-manifest --json
<cli> ravi manifest --json
```

The payload SHOULD include:

- CLI name, version, description, and canonical command;
- command groups, command names, args, options, examples, and aliases;
- whether each command supports JSON;
- whether each command is read-only, mutating, destructive, streaming, or
  interactive;
- stable input schemas where available;
- output schemas where available;
- health/check commands that are safe and non-mutating;
- suggested app operations and debug-only commands;
- suggested permissions, storage, events, and skill hints when known.

The self-description command MUST be safe, deterministic, and side-effect free.
It MUST NOT require domain credentials beyond what is needed to describe the
CLI itself.

## Introspection Sources

Importers SHOULD resolve CLI metadata in this order:

1. Explicit CLI self-description (`manifest --json`, `app-manifest --json`, or
   equivalent).
2. First-party Ravi decorated registry when the CLI lives under Ravi's command
   registry.
3. Structured external tool metadata when the CLI publishes schemas.
4. Human help parsing as fallback.

Fallback help parsing MUST be treated as advisory. It can discover names and
examples, but it cannot reliably infer permissions, mutation risk, output
schemas, event topics, storage ownership, or UI semantics.

## Generated Draft Surface

An import SHOULD generate or preview:

- `src/apps/<app-id>/ravi.app.json` or the chosen app target path;
- `.ravi/specs/apps/<app-id>/SPEC.md`;
- `src/plugins/internal/ravi-system/skills/<app-id>/SKILL.md` for first-party
  internal apps, or the appropriate plugin/app skill path for packaged apps;
- an import report with provenance, confidence, warnings, and next commands.

Generated manifest drafts SHOULD include:

- `interfaces.cli.command`;
- `interfaces.cli.json` when supported;
- safe `interfaces.cli.health` only when the source declares a safe health
  command;
- operation candidates for daily app operations;
- debug-only candidate commands as review notes, not necessarily operations;
- conservative permission suggestions;
- placeholder storage/events/UI sections only when useful and clearly marked
  for review.

## Command Contract

The preferred operator surface is:

```bash
ravi apps import-cli <command> \
  --id <app-id> \
  --name "Display Name" \
  --description "What this app exposes" \
  --source auto|manifest|registry|help \
  --dry-run \
  --force \
  --json
```

`ravi apps scaffold <app-id> --from-cli <command>` MAY exist as an ergonomic
alias, but it MUST obey this spec.

Dry-run output SHOULD include:

```json
{
  "appId": "example",
  "sourceCommand": "example-cli",
  "source": "manifest",
  "confidence": "high",
  "plannedFiles": [],
  "manifest": {},
  "warnings": [],
  "reviewRequired": []
}
```

## Boundaries

- CLI import is not app discovery. Discovery reads manifests; import creates or
  previews manifests.
- CLI import is not permission grant. Suggested permissions remain
  requirements until REBAC grants them.
- CLI import is not SDK codegen. Static SDK methods still come from the Ravi
  decorated command registry; dynamic app operations are routed through
  `apps.run` unless a separate static SDK surface is added.
- CLI import is not UI implementation. It may draft semantic UI descriptors,
  but Web OS owns rendering.
- CLI import does not replace domain modeling. It accelerates the first draft.

## Validation

- `ravi specs get apps/import-cli --mode rules --json` MUST return this
  contract.
- `ravi apps import-cli <command> --dry-run --json` MUST NOT write files.
- Importing a CLI with explicit self-description SHOULD produce fewer warnings
  than help parsing.
- Importing a CLI with no JSON-capable commands SHOULD warn that generated
  operations are not agent/UI-ready.
- Imported manifests SHOULD pass `ravi apps check <app-id> --json` after
  required review fields are resolved.

## Known Failure Modes

- Treating generated manifest text as a product decision.
- Exposing every raw CLI command as an app button.
- Marking a destructive command as safe because its help text used a mild verb.
- Parsing human help and pretending the result is a schema.
- Generating operations without `--json` and forcing agents to scrape prose.
- Inferring permissions as grants.
- Running domain commands during import and causing side effects.
- Creating recursive operations that dispatch back through the same dynamic app
  alias.
