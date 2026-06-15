---
id: cli/console-scope
title: "Console Scope Defaults - Why"
kind: capability
domain: cli
capability: console-scope
status: draft
normative: false
owners:
  - ravi-dev
---

# Why

Ravi is moving from one-off CLI calls to agents operating inside durable
sessions and workspaces. In that model, requiring every tool invocation to pass
`--project` is friction and a source of production mistakes.

The RBBT Pages incident is the concrete example: a site was created under the
operator's personal org/project when the session was functionally doing RBBT
work. The remote API correctly authorized the user, but the local CLI had no
first-class notion of "this session is currently operating for org/project X".

## Decisions

### Keep login and focus separate

`ravi login` selects an organization because the access token is issued for a
Console account/org context. That does not mean the token should also decide the
current project forever.

Project focus changes more often than auth identity:

- one agent may work across multiple projects;
- one user may operate several orgs;
- one session may need a temporary override;
- a workspace may have a stable default project independent of the current
  browser-selected org.

### Use runtime context as the canonical in-process carrier

The runtime already issues `RAVI_CONTEXT_KEY` and stores context metadata. That
is the right place for child CLIs to recover the current Console scope.

Env vars such as `RAVI_PROJECT` are useful compatibility, but they are too easy
to leak, override accidentally, or apply outside their intended session.

### Do not collapse local Projects into Console Projects

Local Projects are an OSS operational model for grouping tasks, workflows,
resources, specs, and sessions. Console Projects are remote product resources
with hosted artifacts, Pages, provider connectors, billing, quota, and auth.

They should be linkable, not identical. A local project can say "its Console
project is rbbt-lab", but Ravi should not guess that every local project slug is
a valid remote project slug.

## Alternatives Rejected

### Store default project inside cloud-auth credentials

Rejected. Credentials are security-sensitive auth material with a token
lifecycle. Project focus is local operational state. Coupling them makes
switching projects unnecessarily risky and encourages agents to treat auth as
ambient authority.

### Keep using only `RAVI_PROJECT`

Rejected as the primary mechanism. It is invisible to `ravi context whoami`, not
auditable as a scope source, and does not compose with session/agent/workspace
defaults.

### Infer the project from chat names or session names

Rejected. Names are display metadata. They can drift, collide, or contain human
language that should not become an authorization or routing decision.

### Require every command to add its own fallback logic

Rejected. Pages, Artifacts, Connectors, Bridges, Sync, Watch, Tags, Sessions,
and Devin all need similar behavior. Duplicating it would recreate the current
inconsistency with more code.
