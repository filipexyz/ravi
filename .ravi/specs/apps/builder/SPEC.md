---
id: apps/builder
title: "Ravi App Builder"
kind: capability
domain: apps
capability: builder
capabilities:
  - cli
  - context
  - import-cli
  - manifest
  - permissions
  - scaffold
  - skills
  - testing
tags:
  - apps
  - builder
  - api
  - cli
  - skills
applies_to:
  - src/apps/builder.ts
  - src/apps/guide.ts
  - src/apps/import-cli.ts
  - src/apps/scaffold.ts
  - src/plugins/internal/ravi-dev/skills/app-creator
  - src/plugins/internal/ravi-system/skills/apps/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---

# Ravi App Builder

## Intent

Define one domain-independent workflow for turning official API documentation,
an existing CLI contract, or a new capability into a production-ready Ravi
App.

The builder produces a real CLI implementation plus `ravi.app.json`. The CLI
communicates with Ravi through public `ravi ...` commands under the
least-privilege child context issued by the App Router. There is no private
App-to-host JSON protocol.

## Builder Skill

The canonical builder skill is `ravi-dev-app-creator`, sourced from
`src/plugins/internal/ravi-dev/skills/app-creator/SKILL.md`.

- Claude MUST discover the source skill through the `ravi-dev` plugin.
- Codex MUST receive the managed `ravi-dev-app-creator` skill through plugin
  skill synchronization.
- Pi MUST receive an allowlist-filtered skill catalog in its appended system
  prompt and MUST be able to load the complete skill with
  `ravi skills show ravi-dev-app-creator --json`.
- Pi catalog advertisement MUST NOT be reported as loaded-skill evidence.
- `ravi apps guide`, scaffold results, and import results MUST link to this
  skill and this spec.

## Source Contract

Before implementation, the builder MUST record:

- official documentation URLs or the authoritative CLI metadata source;
- resources and useful operator workflows;
- authentication and credential lifecycle;
- methods or subcommands;
- pagination and limits;
- provider error envelopes;
- mutation, destructive action, retry, timeout, and idempotency behavior.

An app surface MUST represent useful, safe workflows. It MUST NOT publish every
endpoint or subcommand mechanically.

## Build Flow

### New API or CLI

1. Define the operator, problem, and operation matrix.
2. Run `ravi apps scaffold <app-id> --dry-run --json`.
3. Implement the real CLI and stable `--json` output.
4. Point `interfaces.cli.command` to the implementation, never to the public
   `ravi <app-id>` alias.
5. Declare operations, permissions, and the smallest `context.allow` ceiling.
6. Add the domain skill and explicit decisions for storage, events, artifacts,
   and semantic UI.
7. Validate the manifest and exercise a public alias operation through the App
   Router.

### Existing CLI

1. Prefer machine-readable manifest metadata, then decorated registry
   metadata, then human help as the lowest-confidence source.
2. Run `ravi apps import-cli <command> --id <app-id> --dry-run --json`.
3. Treat every generated operation, permission, context capability, schema,
   and product surface as a draft.
4. Remove interactive, streaming, debug-only, and unsafe candidates from the
   public app surface.
5. Complete the same auth, permission, skill, functional, and release gates as
   a new app.

`import-cli` MUST NOT claim readiness merely because it generated a valid
manifest.

## Authentication and Authorization

- Provider secrets MUST remain behind a Ravi credential broker or managed
  connector boundary.
- Tokens, refresh tokens, client secrets, secret references, and credential
  paths MUST NOT appear in manifests, argv, stdout, specs, skills, or events.
- Missing or disabled authentication MUST fail before network access.
- `manifest.permissions` declares caller requirements; it is not a grant.
- `manifest.context.allow` declares the child-process ceiling; it is not a
  grant.
- The router MUST fail before spawning when the parent cannot delegate the
  declared child capabilities.
- Restricted agents MUST receive only the app skill grants they need.

## Functional Contract

Every public operation MUST define:

- explicit input bounds;
- stable JSON output when machine use is supported;
- typed and sanitized failure output;
- non-zero exit status on failure;
- pagination cursors or offsets where applicable;
- bounded timeout and retry behavior;
- idempotency semantics for mutation.

Readiness requires a deterministic functional path through:

```text
ravi <app-id> <operation> -> App Router -> child context -> real CLI -> fake provider
```

Manifest validation alone is insufficient.

## Reference Acceptance Cases

The builder MUST remain independent of provider and domain. Its reference cases
are:

- Google Search Console: OAuth-backed sites, search analytics, sitemaps, health,
  pagination, quotas, and sanitized provider failures.
- Open-Meteo Forecast: unauthenticated forecast and health operations with a
  different resource model and no child Ravi capabilities.

The detailed briefs live in the builder skill reference
`references/acceptance-cases.md`. A workflow passes the domain-independence
gate only when the same builder checklist can create both apps without
provider-specific logic in the builder itself.

## Drift Contract

A deterministic contract eval MUST compare:

- decorated `ravi apps` registry commands;
- `RAVI_APPS_COMMAND_GUIDANCE`;
- prompt ids returned by `ravi apps guide`;
- command inventory in `apps`;
- commands documented by `ravi-system-apps`;
- builder links and both reference acceptance cases.

Adding or removing a command without updating every required surface MUST fail
the eval.

## Release Gate

An app is ready only when:

- the real CLI implements its public operations;
- auth and secrets remain behind a Ravi boundary;
- permissions and child context fail closed;
- the app skill is indexed or explicitly granted;
- `ravi apps check <app-id> --json` passes;
- at least one public alias operation passes against a deterministic fake
  provider;
- missing auth, provider error, pagination, and mutation risks are tested where
  relevant;
- specs, skills, guide, registry, generated SDK/OpenAPI, formatting,
  typechecking, and the full test suite have no drift.

## Known Failure Modes

- Treating a scaffold or imported draft as a finished application.
- Pointing the implementation command back at the public app alias.
- Adding a private host protocol instead of calling public Ravi commands.
- Forwarding provider secrets through the manifest or child argv.
- Treating permission declarations or skill visibility as grants.
- Testing only manifest shape while the real CLI path is broken.
- Embedding provider-specific assumptions in the generic builder.
