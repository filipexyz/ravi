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
source_of_truth:
  - console/cli-scope
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

The product/security contract lives in the Console spec `console/cli-scope`.
This OSS spec owns local storage, resolution, CLI UX, and runtime context
projection that consume that Console contract.

## Definitions

- `Console organization`: the remote Ravi Console organization selected during
  `ravi login`.
- `Console project`: the remote project id or slug accepted by Console APIs such
  as Pages, Artifacts publish, provider connectors, MCP bridges, and sync.
- `Local project`: the OSS Ravi Projects domain stored locally under
  `src/projects`. It is not the same entity as a Console project.
- `Console scope`: non-secret local context containing the Console base URL,
  selected organization identity, and optionally a default Console project.
- `Credential profile`: local Ravi Cloud credentials for one Console URL, one
  selected organization, one user, and one local installation.
- `Scope source`: the layer that supplied the effective scope, such as
  explicit CLI argument, runtime context, session default, agent default, or
  workspace default.

## Current OSS Inventory

The current OSS implementation is not yet centralized:

- `src/cli/commands/pages.ts` requires a positional `project` for
  `list|create|publish|update|visibility|domains`.
- `src/pages/client.ts` sends that project as the Console `projectRef`.
- `src/artifacts/publish-client.ts` sends `projectRef` and optional `siteRef`
  during Pages/content publishing.
- `src/cli/commands/cloud-projects.ts` lists/creates remote Console projects
  for the organization encoded in cloud-auth credentials.
- `src/bridges/client.ts` already has command-local fallback to
  `RAVI_PROJECT`.
- `src/sync/console-bridge.ts` accepts optional project refs but does not use a
  shared resolver.
- `src/projects/*` owns local Ravi Projects. Those objects are alignment and
  workflow context, not remote Console Projects.
- `src/cloud-auth/storage.ts` currently stores a single
  `~/.ravi/cloud-auth/credentials.json`; this is not enough for complete
  multi-org operation because it can represent only one active organization at
  a time.

Until a shared resolver exists, project-scoped commands MUST keep requiring
explicit project args or command-specific compatibility env. They MUST NOT
silently use local Project slugs as remote Console project refs.

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
- A local Project slug that equals or resembles a Console project slug MUST NOT
  be enough to select remote scope.
- Command-specific `RAVI_PROJECT` fallbacks SHOULD be replaced by the shared
  Console scope resolver. `RAVI_PROJECT` MAY remain a compatibility input.

## Incident Pattern: `rbbt` Local Project vs Remote Project

The observed failure was:

- local `ravi projects list` showed a Project named `rbbt`;
- current `ravi whoami --json` was authenticated to the personal Console org;
- `ravi cloud projects list --json` for that org showed remote project
  `rbbt-ravi`, not `rbbt`;
- `ravi pages list rbbt --json` returned no site;
- an agent then tried to create a site/project in the wrong remote scope.

This is exactly what this capability must prevent. The resolver MUST distinguish
local project identity from Console project identity, and diagnostics MUST show
the selected Console organization plus the source of the project ref.

## Login Organization Selection

`ravi login` MUST NOT require a local `--org` flag for normal users.

When the authenticated Console user belongs to more than one organization, the
organization picker MUST happen inside the Console login flow. The CLI stores the
organization returned by Console in the cloud-auth credential metadata.

If the selected organization changes in Console, `ravi login` or credential
refresh MAY update the cached organization metadata. Local scope defaults that
point to inaccessible projects MUST then fail cleanly on use.

Scope defaults MUST be keyed by selected Console organization as well as Console
URL and local scope target. A session default saved while authenticated to the
personal organization MUST NOT be reused after the same local runtime logs into
the RBBT organization.

## Cloud Auth Credential Profiles

The OSS CLI MUST treat one Ravi Cloud credential as organization-scoped. A
credential profile MUST NOT be reused for another organization, even when the
same user and Console URL are involved.

The local credential store SHOULD support multiple profiles:

```ts
interface CloudCredentialProfile {
  profileId: string; // stable local id, not a secret
  consoleUrl: string;
  active: boolean;
  user?: CloudAuthUser | null;
  organization?: CloudAuthOrganization | null;
  installationId: string;
  credentials: CloudCredentials; // contains tokens, stored 0600/keychain
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | null;
}
```

The profile key SHOULD be derived from:

- normalized Console URL;
- Ravi user id/email when available;
- Ravi organization id or slug;
- local installation id.

The store MUST keep at most one active profile per Console URL by default. A
runtime context MAY explicitly select another already-approved profile, but it
MUST NOT mint a new organization credential locally.

Legacy single-file storage at `~/.ravi/cloud-auth/credentials.json` MAY be
migrated by treating that file as the active profile. Migration MUST preserve
0600 file permissions or use an OS keychain. Migration MUST NOT print token
values.

Profile-safe APIs SHOULD be added beside the legacy helpers:

- `readActiveCloudCredentials(consoleUrl?)`
- `writeCloudCredentialProfile(credentials, { active: true })`
- `listCloudCredentialProfiles(consoleUrl?)`
- `selectCloudCredentialProfile(orgRef, consoleUrl?)`
- `deleteCloudCredentialProfile(orgRef, consoleUrl?)`

Existing `readCloudCredentials` MAY remain as a compatibility wrapper around
the active profile.

`ravi login` behavior:

1. Browser/device approval selects one organization in Console.
2. The exchange response returns credentials plus organization metadata.
3. The CLI writes or updates the profile for that organization.
4. The new profile becomes active for that Console URL.
5. Other profiles for the same Console URL remain stored and can be switched
   back without relogging while their refresh tokens remain valid.

`ravi logout` behavior:

- default logout SHOULD revoke/delete only the active profile;
- `--all` or equivalent MAY revoke/delete all profiles for a Console URL;
- deleting one profile MUST NOT delete scope defaults for other organizations.

## Scope Storage

The OSS MUST store Console scope defaults as non-secret local state.

The initial implementation SHOULD use a SQLite table owned by the Ravi local
state DB:

```sql
CREATE TABLE IF NOT EXISTS console_scope_defaults (
  scope_kind TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  console_url TEXT NOT NULL,
  organization_ref TEXT NOT NULL,
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
  PRIMARY KEY (scope_kind, scope_key, console_url, organization_ref)
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
   `metadata.consoleScope`. If it includes an organization/profile selector,
   the resolver MUST use only an already-approved local credential profile.
3. Active cloud-auth credential profile for the Console URL.
4. Compatibility runtime env projection (`RAVI_CONSOLE_PROJECT_REF` or
   `RAVI_CONSOLE_PROJECT_ID`) when context metadata is unavailable.
5. Explicit Console mapping attached to the active local Project in runtime
   context, when the mapping is stored as a Console resource/metadata link.
6. Session default for the current `sessionKey` or `sessionName`, scoped to the
   selected organization.
7. Agent default for the current `agentId`, scoped to the selected
   organization.
8. Workspace default for the current cwd or configured workspace root, scoped to
   the selected organization.
9. Global default for the local installation, scoped to the selected
   organization.
10. Compatibility `RAVI_PROJECT` fallback.
11. Cloud-auth credential organization metadata for organization-only commands.
12. Console single-project fallback, only when the command can cheaply list
   accessible projects and exactly one project is visible in the selected
   organization.

If the command requires a project and no project can be resolved, it MUST fail
with a stable `PAYLOAD_INVALID` error and a concrete next command.

The result SHOULD include:

```ts
interface ResolvedConsoleScope {
  consoleUrl: string;
  credentialProfile?: {
    profileId?: string | null;
    active?: boolean;
  } | null;
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
    | "local_project_mapping"
    | "session_default"
    | "agent_default"
    | "workspace_default"
    | "global_default"
    | "cloud_credentials"
    | "env_compat"
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

If runtime context includes a local Project but no `consoleScope`, the resolver
MAY inspect that local Project for an explicit Console resource/metadata link.
It MUST report `source="local_project_mapping"` when that mapping is used.

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
ravi cloud auth profiles list [--console <url>] [--json]
ravi cloud auth profiles switch <org-ref> [--console <url>] [--json]
ravi cloud auth profiles remove <org-ref> [--console <url>] [--json]
ravi cloud scope show [--json]
ravi cloud scope explain [--json]
ravi cloud scope set --project <project-ref> [--session <session>|--agent <agent>|--workspace <path>|--global]
ravi cloud scope clear [--session <session>|--agent <agent>|--workspace <path>|--global]
```

`show` MUST display the effective scope and the source layer.

`profiles list` MUST display safe profile metadata only. It MUST NOT print
tokens, raw credential JSON, provider secrets, or context keys.

`profiles switch` MUST switch only to an already-approved local profile. If the
requested org is absent, it MUST instruct the user to run `ravi login` and
select that organization in Console.

`explain` SHOULD display all candidate layers in resolution order, redacting
secrets and showing only ids/slugs/names.

`set` MUST validate the target project against the authenticated Console API
when credentials are available. If offline, it MAY store a project ref with
`validationStatus=unverified`, but the first use MUST still be authorized by
Console.

`explain` MUST show enough non-secret detail to debug wrong-scope incidents:

- selected Console URL;
- selected active credential profile and organization from credentials;
- every candidate project source;
- whether a candidate came from explicit input, runtime context, local Project
  mapping, session, agent, workspace, global, or single-project fallback;
- the final project ref or the reason resolution failed.

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
- `ravi login` can be run for org `luis`, then org `rbbt`, and both approved
  profiles remain available locally.
- `ravi cloud auth profiles switch rbbt --json` changes the active profile
  without exposing or rewriting token values from other profiles.
- A local Project named `rbbt` does not make `ravi pages list` target Console
  project `rbbt` unless the local Project has an explicit Console mapping.
- A session default saved for org `luis` is not used after switching to org
  `rbbt`.
- `ravi cloud scope explain --json` can explain why a command is using
  `rbbt-ravi` instead of local `rbbt`.
- Existing local-only Ravi behavior works without cloud credentials.
- No scope command or JSON output prints access tokens, refresh tokens, context
  keys, provider secrets, or WorkOS tokens.
