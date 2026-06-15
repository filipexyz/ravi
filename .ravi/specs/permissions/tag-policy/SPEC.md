---
id: permissions/tag-policy
title: "Tag-Driven Permission Policy"
kind: capability
domain: permissions
capability: tag-policy
capabilities:
  - local-grants
  - tags
  - policy-materialization
  - profiles
  - delegation
  - resource-visibility
tags:
  - permissions
  - local-grants
  - tags
  - policy
  - profiles
  - delegation
applies_to:
  - src/permissions
  - src/tags
  - src/tag-rules
  - src/cli/commands/permissions.ts
  - src/cli/commands/tags.ts
  - .ravi/specs/tags
owners:
  - ravi-dev
status: draft
normative: true
---

# Tag-Driven Permission Policy

## Intent

Tag-driven permission policy lets operators manage permissions at human scale
without making tags become hidden authority.

Tags classify subjects, surfaces, and resources. Policy rules consume selected
tags and materialize explicit provider-owned grants. The Permission Provider
Runtime remains the authorization surface.

## Core Decision

Tags MUST NOT be checked as ambient permission inside `can()`, tool gates, app
routers, CLI decorators, provider hooks, or runtime contexts.

The allowed flow is:

```text
tag_bindings -> permission policy rule -> provider-owned grants -> effective capabilities
```

This preserves auditability, revocation, TTL, explain output, and one
authorization path.

## Definitions

- `classification tag`: a normal tag such as `domain.*`, `function.*`,
  `state.*`, `risk.*`, or `tier.*`. It carries no permission meaning by
  itself.
- `policy tag`: a tag intentionally used as selector input for a permission
  policy rule. Policy tags SHOULD use the `policy.*` namespace.
- `permission policy rule`: a stored declarative rule that selects tagged
  assets and emits desired provider-owned grant tuples.
- `rule version`: immutable version or content hash of a permission policy rule
  at the moment it was evaluated.
- `materialized grant`: a relation row created or refreshed by a policy rule.
- `policy materialization ledger`: durable table or event stream that records
  which rule version wanted which relation, even when the relation row already
  existed from another source.
- `role closure`: the full transitive capability set reachable from a role,
  including nested role membership if supported.

## Invariants

- Tags are inert by default.
- A policy rule MUST be explicit before a tag can affect authority.
- Policy rules MUST materialize concrete provider-owned grants; they MUST NOT
  introduce a second authorization surface outside the provider runtime.
- Policy materialization MUST be deterministic and explainable.
- Policy materialization MUST fail closed when a selector, tag, asset,
  relation, object, TTL, or rule source cannot be resolved.
- Generated grants MUST obey the same expiration, revocation, and audit rules
  as manual grants.
- Generated grants MUST be temporary by default unless the rule explicitly
  marks them permanent.
- A policy rule MUST NOT create `admin system:*` or `delegate_admin` grants.
- A policy rule MUST NOT grant membership into a role whose closure contains
  forbidden outputs, unless an explicit break-glass policy approves that exact
  role version and closure.
- A policy rule MUST NOT materialize broad wildcard outputs such as
  `use tool:*`, `execute executable:*`, `execute group:*`,
  `write_contacts system:*`, or `read_tagged_contacts system:*` unless the rule
  is marked break-glass, carries an approval record, and uses a short maximum
  TTL.
- A policy rule MUST NOT exceed delegated turn ceilings. It can only create
  provider-owned grant state that the provider runtime later intersects with
  actor, surface, agent, and turn authority.
- Policy-owned grants MUST be revoked or suspended immediately when a policy
  tag is detached, a policy rule is disabled, a policy source becomes
  untrusted, or the emitted role closure becomes forbidden.
- Runtime contexts whose effective capabilities include revoked/suspended
  policy-owned grants MUST be invalidated before the next tool/CLI/app check.
- Auto-tagging MUST NOT grant permissions directly. If an auto-tagging rule
  produces a policy tag, the permission policy rule MUST explicitly opt in to
  consuming auto-generated bindings from that tag.

## Policy Tag Namespace

Permission policy selectors SHOULD use these namespaces:

```text
policy.profile.<profile-id>
policy.allow.tool.<tool-id>
policy.allow.executable.<binary>
policy.allow.group.<group-id>
policy.allow.app.<app-id>
policy.allow.contact-scope.<scope>
policy.surface.<surface-profile>
policy.visibility.<resource-family>
policy.breakglass.<purpose>
```

Rules:

- Permission policy selectors MUST consume tags whose definitions are policy
  trustable. Until `tag_definitions.role` is exposed through the tag service,
  the minimum trustable convention is an exact `policy.*` slug with trusted
  binding provenance.
- Exact tag matching is the default.
- Prefix matching MUST be explicit in the rule and MUST show the matched tag in
  explain output.
- Classification tags MAY be consumed by a permission policy only when the rule
  sets an explicit `allow_classification_tags` or equivalent flag and documents
  why that classification is safe as authority input.
- `policy.breakglass.*` tags MUST NOT materialize grants unless the rule is
  disabled by default or requires an explicit operator approval path.

## Rule Model

Permission policy rules MUST be stored as versioned files or DB rows with a
stable id and immutable rule version/hash.

The MVP source-of-truth format SHOULD be JSON under:

```text
.ravi/permission-policies/<policy-id>.json
```

This is a separate DSL from `tag-rules`. Existing `tag-rules` classify assets
by adding/removing tags; they MUST NOT execute permission policy rules.

Minimum rule schema:

```json
{
  "id": "trusted-dev-contact-profile",
  "version": "sha256:<content-hash>",
  "enabled": true,
  "description": "Contacts tagged as trusted devs become trusted-dev role members.",
  "selector": {
    "assetType": "contact",
    "tag": "policy.profile.trusted-dev",
    "match": "exact",
    "acceptedBindingSources": ["manual"]
  },
  "emits": [
    {
      "subject": { "fromAsset": true },
      "relation": "member",
      "object": { "type": "role", "id": "trusted-dev" }
    }
  ],
  "grant": {
    "mode": "temporary",
    "ttl": "24h",
    "renew": true,
    "reason": "policy profile tag"
  }
}
```

Example: profile assignment from a contact tag.

```json
{
  "id": "trusted-dev-contact-profile",
  "version": "sha256:<content-hash>",
  "enabled": true,
  "selector": {
    "assetType": "contact",
    "tag": "policy.profile.trusted-dev",
    "match": "exact",
    "acceptedBindingSources": ["manual"]
  },
  "emits": [
    {
      "subject": { "fromAsset": true },
      "relation": "member",
      "object": { "type": "role", "id": "trusted-dev" }
    }
  ],
  "grant": {
    "mode": "temporary",
    "ttl": "24h",
    "renew": true,
    "reason": "policy profile tag"
  }
}
```

Example: chat-scoped delegated tool override.

```json
{
  "id": "local-grants-chat-bash-override",
  "version": "sha256:<content-hash>",
  "enabled": true,
  "description": "This chat may delegate Bash to resolved contacts through ravi-dev.",
  "selector": {
    "assetType": "chat",
    "tag": "policy.allow.tool.bash",
    "match": "exact",
    "acceptedBindingSources": ["manual"]
  },
  "emits": [
    {
      "subject": { "fromAsset": true },
      "relation": "delegate_use",
      "object": { "type": "tool", "id": "Bash" }
    }
  ],
  "grant": {
    "mode": "temporary",
    "ttl": "1h",
    "renew": true,
    "reason": "chat-scoped tool override"
  }
}
```

Example: app visibility through a profile.

```json
{
  "id": "khal-tasks-ops-profile",
  "version": "sha256:<content-hash>",
  "enabled": true,
  "selector": {
    "assetType": "contact",
    "tag": "policy.profile.ops-apps",
    "match": "exact",
    "acceptedBindingSources": ["manual"]
  },
  "emits": [
    {
      "subject": { "fromAsset": true },
      "relation": "member",
      "object": { "type": "role", "id": "ops-apps" }
    }
  ]
}
```

The role owns the app grants:

```text
role:ops-apps use app:khal-tasks
role:ops-apps execute app:khal-tasks
```

## Selector And Emit Validation

Policy rules MUST validate selector asset types and emitted subjects before
materialization.

Allowed `fromAsset` subject mappings:

```text
contact -> subject contact:<asset-id>
chat -> subject chat:<asset-id>
agent -> subject agent:<asset-id>
role -> subject role:<asset-id>
automation -> subject automation:<asset-id>
session -> subject session:<asset-id>
```

Resource assets such as `app`, `artifact`, `task`, `project`, `command`,
`skill`, `context`, `observer_rule`, and `cron_job` MUST NOT become subjects
through `fromAsset` unless a future spec explicitly models that asset as a
principal. They MAY be emitted as objects only when the object type is valid
for the requested relation.

Allowed policy outputs in the MVP:

- `contact:<id> member role:<id>`
- `agent:<id> member role:<id>`
- `automation:<id> member role:<id>`
- `chat:<id> constrain role:<id>`
- `session:<id> constrain role:<id>`
- `chat:<id> delegate_<relation> <object-type>:<object-id>`
- `agent:<id> delegate_<relation> <object-type>:<object-id>`
- `role:<id> <relation> <object-type>:<object-id>` when the rule is explicitly
  a profile-definition policy and passes the forbidden output matrix.

Any other emitted tuple MUST fail validation until the relation/object family is
added to this spec.

## Materialization Semantics

The MVP MUST add durable storage for policy rules and materialization
provenance. The exact SQL may evolve, but the model must preserve these fields:

```text
permission_policy_rules
  id
  version
  enabled
  source_path
  rule_json
  created_at
  updated_at
  disabled_at

permission_policy_materializations
  id
  policy_id
  policy_version
  selector_asset_type
  selector_asset_id
  tag_slug
  tag_binding_id
  tag_binding_source
  subject_type
  subject_id
  relation
  object_type
  object_id
  desired_hash
  relation_id
  status             # desired|materialized|conflict|revoked|rejected
  conflict_source
  reason
  expires_at
  created_at
  updated_at
  revoked_at
```

The materialization ledger is first-class authority provenance. CLI list,
explain, revoke, dry-run, and audit commands MUST read it, not only
`relations.source`.

For each matching asset, the policy engine MUST:

1. Resolve the canonical asset from `tag_bindings`.
2. Resolve emitted subject, relation, object, grant lifetime, reason, and
   issuer.
3. Validate that the emitted tuple is allowed for policy materialization.
4. Create or refresh a relation only when that relation is owned by the same
   policy source.
5. Record the policy's desired relation in a materialization ledger.
6. Reconcile stale policy-owned grants when the tag or rule no longer matches.

Generated relation metadata:

```text
source: policy:<rule-id>
issued_by: policy:<rule-id>
policy_version: <stored in materialization ledger>
reason: <rule reason or description>
grant_mode: temporary by default
expires_at: now + ttl when temporary
```

If the same relation tuple already exists with another source, the
materializer MUST NOT overwrite it just to mark policy provenance. Current
`relations` rows are unique by tuple and carry only one `source`; therefore a
separate materialization ledger is required to preserve multi-source
provenance.

The materializer MUST NOT call a generic relation upsert that overwrites
`source`, `grant_mode`, `expires_at`, `reason`, or `issued_by` on tuple
conflict. It MUST use a conflict-safe API with these semantics:

- insert absent tuple with `source=policy:<rule-id>` and explicit lifetime;
- refresh only tuples already owned by `policy:<same-rule-id>`;
- mark `conflict` in the ledger when the tuple exists from another source;
- never revive a revoked row unless the row is policy-owned by the same rule
  and the rule still matches;
- never convert manual/config/test rows into policy rows.

When a policy stops matching, the materializer MUST revoke only grants it owns
or ledger entries it created. It MUST NOT revoke a manual/config/test grant
that happens to have the same tuple.

## Preferred Shape: Tags Assign Profiles

Policy rules SHOULD prefer assigning profiles/roles over emitting many direct
tool, executable, group, or app grants.

Preferred:

```text
contact:<id> member role:trusted-dev
role:trusted-dev use tool:Bash
role:trusted-dev execute executable:git
```

Use direct materialized grants only for narrow surface overrides such as:

```text
chat:<id> delegate_use tool:Bash
chat:<id> use app:khal-tasks
```

This keeps large permission sets inspectable and reduces duplicated grants.

## Role Closure Validation

Policy-managed role membership is itself authority.

Before materializing `member role:<id>` or `constrain role:<id>`, the policy
engine MUST compute the target role closure using active, non-expired,
non-revoked role grants.

The closure MUST include:

- direct grants on `role:<id>`;
- nested role membership if role-to-role membership is supported;
- delegated overrides attached to that role if supported;
- wildcard grants and pattern grants.

The engine MUST reject or suspend policy-managed membership when the closure
contains forbidden outputs.

Forbidden by default:

```text
admin system:*
delegate_admin system:*
use tool:*
execute executable:*
execute group:*
access group:*
admin group:*
write_contacts system:*
read_tagged_contacts system:*
modify session:*
```

Sensitive outputs that require explicit declaration, max TTL, and approval:

```text
use tool:Bash
execute executable:<binary>
execute group:<group>
execute app:<app-id>
modify session:<id-or-pattern>
read_contact contact:<id-or-pattern>
delegate_use tool:<tool>
delegate_execute group:<group>
```

If a role changes after a policy has materialized membership, the role closure
MUST be revalidated. If it becomes forbidden, policy-owned memberships into
that role MUST be revoked or suspended immediately and affected runtime
contexts MUST be invalidated before the next authority check.

## Delegation Override Boundary

Policy rules MAY emit `delegate_<relation>` for agent or surface subjects when
the rule is explicitly about delegated execution.

Rules:

- `delegate_admin` is forbidden.
- Agent-level `delegate_<relation>` can satisfy only the actor branch during
  turn-scoped context materialization.
- Surface-level `delegate_<relation>` can satisfy actor and surface branches
  only for that surface.
- The executor agent still needs the underlying normal capability.
- The current turn and child-context ceilings still win.
- Unknown actors and automation principals do not receive human delegation
  overrides from these rules.

## Auto-Tagging Boundary

Auto-tagging may classify assets, but it is not a permission system.

For `policy.*` tags:

- Operator-authored tag bindings are allowed policy input only when the binding
  preserves trusted provenance.
- Auto-generated, imported, mirrored, or unknown tag bindings are denied as
  policy input by default.
- A policy rule MAY opt in to auto-generated policy tags only by declaring the
  accepted tag source and source rule id.
- Explain output MUST show whether the tag was operator-authored,
  auto-generated, mirrored, or imported.
- `policy.*` binding trust provenance MUST NOT be overwritten by idempotent
  reattach or metadata update. Trust-changing updates MUST create an audit event
  and force policy revalidation.

This prevents a deterministic classifier or regex rule from accidentally
granting tools, apps, sessions, or executables.

## Lifecycle

Policy evaluation modes:

- `dry-run`: compute desired relations and stale revocations without writing.
- `apply`: materialize the diff.
- `reconcile`: revoke/suspend policy-owned relations whose selector no longer
  matches.
- `explain`: show why an asset receives or does not receive policy grants.

Tag detach, policy disable, policy source distrust, and role closure changes
MUST trigger immediate reconciliation for affected policy materializations.

Disabling a policy MUST stop future materialization and revoke/suspend active
policy-owned grants by default. A `--keep-active-until-expiry` escape hatch MAY
exist only for non-sensitive grants and MUST be visible in audit output.

Deleting a policy MUST preserve materialization history. Deletion SHOULD be
blocked while active policy-owned grants exist unless `--force` is supplied.

## CLI Surface

The permission CLI SHOULD expose these MVP target commands:

```bash
ravi permissions policies list
ravi permissions policies show <id>
ravi permissions policies validate
ravi permissions policies dry-run [<id>]
ravi permissions policies apply [<id>]
ravi permissions policies reconcile [<id>]
ravi permissions policies explain --target <asset-type>:<asset-id>
ravi permissions explain --actor contact:<id> --chat <chat-id> --agent <agent-id> --cap use:tool:Bash
```

`dry-run` MUST be the default for broad operations. `apply` MUST show a compact
diff before mutating unless an explicit non-interactive flag is provided.

Until these commands exist, checks that reference them are target
post-implementation checks. Interim audits MUST use SQL against `relations`,
`tag_bindings`, and the materialization ledger once it exists.

## Explain And Audit

Permission explain output MUST be able to show:

- matched tag slug;
- tagged asset type/id;
- tag source and creator when known;
- policy rule id/version;
- policy materialization ledger id/status;
- emitted relation tuple;
- relation row id when materialized;
- conflict source when a desired tuple already exists from manual/config/test;
- grant lifetime and expiration;
- whether the grant is direct, profile-expanded, delegated override, or
  surface constraint;
- whether the capability survived actor, surface, agent, and turn
  intersections.

Audit events for policy materialization SHOULD include:

```text
permission.policy.matched
permission.policy.materialized
permission.policy.refreshed
permission.policy.revoked
permission.policy.skipped
permission.policy.conflict
```

## Existing Contact Tag Grants

`read_tagged_contacts system:<tag>` is a legacy/specialized tag consumer.

Rules:

- New broad `read_tagged_contacts system:*` grants SHOULD NOT be created.
- Policy rules MUST treat `read_tagged_contacts system:*` as a forbidden broad
  wildcard output unless a break-glass rule approves it with max TTL.
- Contact tag read scopes SHOULD migrate toward explicit policy rules and
  profiles where possible.
- Existing contact tag grants remain valid for compatibility, but explain
  output MUST distinguish them from generic tag-driven policy materialization.

## Acceptance Criteria

- Attaching a normal `domain.*` or `state.*` tag never changes permissions.
- Attaching a `policy.*` tag changes permissions only when an enabled policy
  rule consumes it.
- A dry-run shows every relation that would be created, refreshed, skipped, or
  revoked.
- A policy-generated grant is temporary unless the rule explicitly marks it
  permanent.
- Removing a policy tag revokes or lets expire only grants owned by the matching
  policy.
- A manual grant with the same tuple is not overwritten by policy
  materialization.
- `delegate_admin` and `admin system:*` are rejected as policy materialization
  outputs.
- `permissions explain` can trace an allowed or denied tool/app/group decision
  back to the tag, policy rule, profile, relation, and delegated intersection.
