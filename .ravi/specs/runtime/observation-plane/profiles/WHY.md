# Observer Profiles / WHY

## Why Profiles

Observers are agents. The text they receive matters as much as the events selected for them.

Structured event data is useful for storage and audit, but raw structured dumps are a poor primary prompt interface. They are noisy, hard to tune, and make experiments depend on code changes instead of prompt/profile changes.

Observer Profiles let Ravi keep source events structured internally while rendering observer-facing prompts as readable Markdown.

The source bundle itself is also Markdown-only. Metadata lives in `PROFILE.md` frontmatter and all templates are Markdown files. This keeps profile authoring aligned with how operators already edit prompts and avoids a split-brain between structured manifests and Markdown templates.

## Why Separate From Rules

Rules answer policy questions:

- when does an observer attach;
- which source sessions match;
- which agent/model runs;
- which delivery policy and event filter apply;
- which permissions are granted.

Profiles answer presentation questions:

- how does `message.user` read;
- how does `turn.failed` differ from `turn.complete`;
- how much metadata should this observer see;
- how should realtime prompts differ from end-of-turn summaries.

Keeping these separate prevents rules from becoming hidden prompt templates and keeps matching explainable.

## Why Per-Event Templates

Different event types have different meanings. A user message, assistant response, tool completion, failed turn, and interrupted turn should not all be rendered through the same generic structured block.

Per-event templates make prompt changes local:

- task reporters can emphasize progress and blockers;
- memory observers can emphasize durable facts;
- quality observers can emphasize decisions, regressions, and open risks;
- cost observers can emphasize usage and model details.

## Why Snapshots

Profiles are editable. Existing observer bindings need deterministic behavior for audit and regression analysis.

Persisting profile resolution on the binding follows the same principle used by task profiles: the system can explain what profile rendered a prompt at the time the binding was created, even if profile source files change later.
