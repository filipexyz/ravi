# Tags / WHY

## Rationale

Ravi already has many objects that need cross-cutting classification: agents,
sessions, tasks, projects, contacts, chats, artifacts, commands, skills,
automations, observers, workflows, calls, and specs.

Without a shared tag layer, each domain creates its own small tagging mechanism:
arrays in JSON, frontmatter lists, provider tags, CLI flags, route scopes, or
name conventions. That makes the system harder to query and makes policy
invisible.

A unified registry gives Ravi one index for classification while still letting
each domain define its own semantics.

## Decisions

- Use `tag_definitions` and `tag_bindings` as the canonical internal model.
- Treat `tag_bindings` as polymorphic instead of adding a tag table per domain.
- Keep tags inert by default.
- Require explicit policy consumers before tags change behavior.
- Require explain/debug output for policy consumers.
- Keep inheritance opt-in per consumer.
- Allow local/external tags only when they represent provider state, document
  frontmatter, or temporary compatibility.
- Prefer domain-native aliases that write canonical bindings over exposing only
  the generic `ravi tags attach` shape.

## Why Tags Matter Operationally

Tags let main orchestrate work without hardcoding every special case.

Examples:

- A task tagged `task.observed` can receive a task-status observer.
- A project tagged `tier.core` can get stricter reporting or review.
- A chat tagged `surface.whatsapp` can receive channel-specific handling.
- A contact tagged `contact.vip` can receive stricter permission/routing rules.
- An artifact tagged `artifact.evidence` can be found later by reports.
- A trigger tagged `automation.cleanup` can be audited or disabled as a group.

## Rejected Alternatives

- Keeping every domain-specific `tags_json`.
  This preserves local convenience but prevents global policy and cross-domain
  queries.
- Encoding classifications in ids, names, or session prefixes.
  Names are display/debug aids, not policy state.
- Making dotted slugs automatically hierarchical.
  It creates surprising policy behavior. Prefix matching can exist later, but it
  must be explicit.
- Applying tags transitively everywhere.
  Transitive tags are powerful and dangerous; every consumer must choose its own
  inheritance behavior.
- Treating provider tags as the same thing as Ravi tags.
  Provider tags may be useful, but they have external ownership and different
  lifecycle guarantees.
