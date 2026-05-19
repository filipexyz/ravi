# Runbook

## Inspect A Contact Profile

```bash
ravi contacts profile <contact> --json
```

Use the canonical contact id when available. Identity values such as phone or WhatsApp LID are accepted only as lookup inputs.

## Inspect Evidence

```bash
ravi contacts sessions <contact> --json
ravi contacts messages <contact> --json
ravi contacts activity <contact> --json
ravi contacts timeline <contact> --json
ravi contacts metadata list <contact> --json
```

## Seed Profile Context

Use global scope only for durable facts.

```bash
ravi contacts metadata set <contact> profile.summary '"Short summary"' --source cli
ravi contacts metadata set <contact> communication.preferences '{"style":"concise"}' --source cli
```

Use scoped metadata for context that is only true inside a project, chat, session, domain, agent, or task.

```bash
ravi contacts metadata set <contact> project.role '"stakeholder"' --scope project:ravi-web --source cli
ravi contacts metadata set <contact> group.role '"admin"' --scope chat:<chat_id> --source cli
```

## Contact Profiler Prompt Skeleton

```text
You are contact-profiler.

Your target is one Ravi contact, provided as target_contact_id.

Your job is to maintain a useful contact profile card by reading Ravi contact profile, activity, messages, sessions, timeline, and metadata surfaces.

Write durable updates only through contact timeline or metadata APIs. Include source='agent', actor_id='contact-profiler', confidence, and evidence.

Use scoped metadata when a fact is only true within a project, chat, session, agent, domain, or task.

Never merge identities automatically. Never infer identity from display name alone. Weak evidence becomes context.fact_proposed, not confirmed state.
```

## Task-First Runtime

Install `contact-profile-research` as an operational profile outside Ravi's built-in system profile catalog. Prefer a user or plugin profile; do not add it to `src/tasks/profile-catalog/system-profiles.json`.

Create profile research as a task:

```bash
ravi tasks create "Research Luis contact profile" \
  --profile contact-profile-research \
  --agent contact-profiler \
  --input target_contact_id=d8f3d5ad489d \
  --input evidence_limit=100 \
  --input write_mode=propose
```

Use `write_mode=apply` only when durable metadata/timeline writes are explicitly authorized.

## Suggested Runtime Configuration

Runtime routes are owned by main. The profiler does not need a WhatsApp route.

Suggested agent id:

```text
contact-profiler
```

Suggested task profile:

```text
contact-profile-research
```

Future triggers may create tasks from contact events, but they must be permission-scoped to the target contact.
