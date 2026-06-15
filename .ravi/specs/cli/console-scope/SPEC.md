---
id: cli/console-scope
title: "Console Scope Defaults"
kind: capability
domain: cli
capability: console-scope
status: draft
normative: true
owners:
  - ravi-dev
applies_to:
  - src/cloud-auth
  - src/cli/commands/cloud-auth.ts
  - src/cli/commands/cloud-projects.ts
  - src/cli/commands/pages.ts
  - src/cli/commands/artifacts.ts
  - src/cli/commands/bridges.ts
  - src/cli/commands/connectors.ts
  - src/cli/commands/sync.ts
  - src/cli/commands/watch.ts
  - src/runtime/context-registry.ts
  - src/runtime/runtime-request-context.ts
  - src/router/router-db.ts
  - src/router/types.ts
tags:
  - cli
  - console
  - cloud-auth
  - projects
  - runtime-context
---

# Console Scope Defaults

## Intent

Console scope defaults let local Ravi commands operate against the intended Ravi
Console organization and project without requiring every agent turn or CLI call
to pass `--project`.

This is an OSS-side convenience and context propagation layer. Console remains
the authority for membership, project access, resource ownership, quotas,
billing, provider policy, and remote mutation authorization.

## Definitions

- `Console organization`: the remote Ravi Console organization selected during
  `ravi login`.
- `Console project`: the remote project id or slug accepted by Console APIs such
  as Pages, Artifacts publish, provider connectors, MCP bridges, and sync.
- `Local project`: the OSS Ravi Projects domain stored locally under
  `src/projects`. It is not the same entity as a Console project.
- `Console scope`: non-secret local context containing the Console base URL,
  selected organization identity, and optionally a default Console project.
- `Scope source`: the layer that supplied the effective scope, such as
  explicit CLI argument, runtime context, session default, agent default, or
  workspace default.

## Boundaries

- Cloud auth credentials MUST remain authentication material, not the sole
  operational focus model.
- Credentials MAY cache selected organization metadata returned by Console.
- Credentials MUST NOT store bearer-visible project authority beyond non-secret
  cached labels/ids returned by Console.
- Console scope defaults MUST NOT bypass Console authorization. Every remote
  mutation still uses the access token and lets Console accept or deny it.
- Local Projects MAY link to Console projects as resources or metadata, but a
  local project id MUST NOT be treated as a Console project id unless an
  explicit Console mapping exists.
- Command-specific `RAVI_PROJECT` fallbacks SHOULD be replaced by the shared
  Console scope resolver. `RAVI_PROJECT` MAY remain a compatibility input.

## Login Organization Selection

`ravi login` MUST NOT require a local `--org` flag for normal users.

When the authenticated Console user belongs to more than one organization, the
organization picker MUST happen inside the Console login flow. The CLI stores the
organization returned by Console in the cloud-auth credential metadata.

If the selected organization changes in Console, `ravi login` or credential
refresh MAY update the cached organization metadata. Local scope defaults that
point to inaccessible projects MUST then fail cleanly on use.

## Scope Storage

The OSS MUST store Console scope defaults as non-secret local state.

The initial implementation SHOULD use a SQLite table owned by the Ravi local
state DB:

```sql
CREATE TABLE IF NOT EXISTS console_scope_defaults (
  scope_kind TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  console_url TEXT NOT NULL,
  organization_id TEXT,
  organization_slug TEXT,
  organization_name TEXT,
  project_id TEXT,
  project_slug TEXT,
  project_name TEXT,
  source_note TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope_kind, scope_key, console_url)
);
```

Allowed `scope_kind` values:

- `session`: default for one Ravi session key or session name.
- `agent`: default for one agent id.
- `workspace`: default for one normalized cwd/worktree path.
- `global`: local fallback for the current Ravi installation.

Future scope kinds MAY include `chat`, `route`, or `task`, but only after a spec
update defines how they interact with delegated authority.

## Resolution Order

All Console-aware commands MUST resolve scope through one shared resolver before
calling product-specific clients.

The resolver MUST use this order:

1. Explicit CLI input: `--console`, `--project`, `--project-ref`, or equivalent
   command argument.
2. Runtime context metadata from `RAVI_CONTEXT_KEY`, specifically
   `metadata.consoleScope`.
3. Session default for the current `sessionKey` or `sessionName`.
4. Agent default for the current `agentId`.
5. Workspace default for the current cwd or configured workspace root.
6. Global default for the local installation.
7. Cloud-auth credential organization metadata for organization-only commands.
8. Console single-project fallback, only when the command can cheaply list
   accessible projects and exactly one project is visible.

If the command requires a project and no project can be resolved, it MUST fail
with a stable `PAYLOAD_INVALID` error and a concrete next command.

The result SHOULD include:

```ts
interface ResolvedConsoleScope {
  consoleUrl: string;
  organization?: {
    id?: string | null;
    slug?: string | null;
    name?: string | null;
  } | null;
  project?: {
    id?: string | null;
    slug?: string | null;
    name?: string | null;
    ref: string;
  } | null;
  source:
    | "explicit"
    | "runtime_context"
    | "session_default"
    | "agent_default"
    | "workspace_default"
    | "global_default"
    | "cloud_credentials"
    | "single_remote_project";
}
```

## Runtime Context Projection

Runtime launches SHOULD project the effective Console scope into the runtime
context metadata:

```json
{
  "consoleScope": {
    "consoleUrl": "https://console.ravi.bot",
    "organization": { "id": "org_...", "slug": "rbbt" },
    "project": { "id": "proj_...", "slug": "rbbt-lab", "ref": "rbbt-lab" },
    "source": "session_default"
  }
}
```

Child CLIs MUST prefer `RAVI_CONTEXT_KEY` and context metadata over reconstructing
identity from environment variables.

For compatibility, runtime env MAY also project:

- `RAVI_CONSOLE_URL`
- `RAVI_CONSOLE_ORG_ID`
- `RAVI_CONSOLE_ORG_SLUG`
- `RAVI_CONSOLE_PROJECT_ID`
- `RAVI_CONSOLE_PROJECT_REF`

These env vars are a compatibility projection only. They are not the canonical
source of identity.

## CLI Surface

The CLI SHOULD expose a single operator surface under cloud auth:

```bash
ravi cloud scope show [--json]
ravi cloud scope explain [--json]
ravi cloud scope set --project <project-ref> [--session <session>|--agent <agent>|--workspace <path>|--global]
ravi cloud scope clear [--session <session>|--agent <agent>|--workspace <path>|--global]
```

`show` MUST display the effective scope and the source layer.

`explain` SHOULD display all candidate layers in resolution order, redacting
secrets and showing only ids/slugs/names.

`set` MUST validate the target project against the authenticated Console API
when credentials are available. If offline, it MAY store a project ref with
`validationStatus=unverified`, but the first use MUST still be authorized by
Console.

## Command Adoption

Project-scoped commands SHOULD accept omitted project arguments when the shared
resolver can provide a project.

Pages command semantics MUST stay explicit:

- `ravi pages list|create|update|visibility|domains` manages Pages site records
  only.
- `ravi pages publish` is the user-facing CLI path that uploads HTML/assets and
  creates or activates a Pages release.
- Agents MUST NOT infer that `ravi pages create` uploads content.
- Pages publishing MUST use `ravi pages publish` against Console.

Canonical Pages content publish:

```bash
ravi pages publish <project-ref> <site-slug> ./site --route / --visibility public --entrypoint index.html
```

Highest-priority commands:

- `ravi pages list|create|update|visibility|domains`
- `ravi pages publish`
- `ravi artifacts publish` for generic artifact publishing
- `ravi bridges list|create`
- `ravi connectors connect`
- `ravi sync push|pull`
- `ravi watch create`
- `ravi tags attach|detach|list` when the tag operation targets project scope
- `ravi sessions goal set|create --project`
- `ravi devin sessions create --project`

List/search commands whose product semantics are not project-scoped MUST NOT
silently narrow to the default project. They SHOULD expose project filters while
keeping "all visible resources" behavior unless the command name or help says it
is project-scoped.

## Errors

Missing project errors SHOULD say:

```text
Missing Console project. Set one with:
  ravi cloud scope set --project <project-ref> --session <session>
or pass --project <project-ref>.
```

Ambiguous project errors SHOULD list safe project refs returned by Console and
suggest setting a default.

Remote denial MUST preserve Console error codes such as:

- `ORG_ACCESS_DENIED`
- `PROJECT_ACCESS_DENIED`
- `PUBLISH_NOT_ALLOWED`

The resolver MUST NOT rewrite authorization failures as local missing-default
errors.

## Acceptance Criteria

- A runtime command launched inside a session with a session Console scope can
  run `ravi pages create <slug> --json` without passing a project.
- The same command with explicit `--project other-project` uses the explicit
  project and reports `source="explicit"` in JSON/debug output.
- A child CLI using only `RAVI_CONTEXT_KEY` can recover the same effective scope.
- `ravi pages publish docs ./dist --json` resolves the project from
  the shared scope when no `--project` is passed.
- `ravi connectors connect google` resolves a project from the shared scope or
  fails with a clear next command when ambiguous.
- `ravi login` with multiple organizations is completed through Console-side org
  selection, not a local `--org` flag.
- Existing local-only Ravi behavior works without cloud credentials.
- No scope command or JSON output prints access tokens, refresh tokens, context
  keys, provider secrets, or WorkOS tokens.
