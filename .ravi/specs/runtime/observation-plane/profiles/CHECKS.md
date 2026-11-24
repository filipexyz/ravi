# Observer Profiles / CHECKS

Run these checks when changing observer profile resolution, rendering, catalog loading, preview, or CLI behavior.

- Create a profile at `.ravi/observers/profiles/<id>/PROFILE.md` with event templates for `message.user`, `message.assistant`, `turn.complete`, `turn.failed`, and `turn.interrupt`. Preview MUST render readable Markdown for each event.
- Create a profile without a specific `tool.end` template but with `events.default`. Rendering `tool.end` MUST use the default template and MUST NOT dump raw structured payloads.
- Create a non-Markdown manifest file in a profile directory. Validation MUST reject it and require `PROFILE.md`.
- Reference a non-Markdown template path in `PROFILE.md` frontmatter. Validation MUST reject it.
- Reference a template outside the profile directory. Validation MUST reject it.
- Create a profile with an unknown placeholder. Validation MUST fail and name the profile id, template, and placeholder.
- Create a profile with an empty required delivery envelope. Validation MUST fail.
- Render the same event list twice with the same binding snapshot. The final prompt MUST be byte-stable except for explicitly time-dependent fields.
- Edit a profile after a binding stores a profile snapshot. Existing binding rendering MUST continue using the snapshot until explicit reconciliation.
- Create two rules pointing to different observer profiles for different observer roles. Each observer MUST receive the prompt format from its own profile.
- Create a rule that overrides profile event filters. The effective event filter MUST use the rule override, while formatting still comes from the profile.
- Verify `realtime`, `debounce`, and `end_of_turn` delivery envelopes can differ for the same event list.
- Preview system profile `tasks` for `message.assistant` and `turn.complete`. The prompt MUST be Markdown, mention the source task id, and describe report/block/done/fail decision rules without raw JSON dumps.
- Verify observer profile rendering never mutates source session messages, source system prompt, source permissions, or rule state.
- Deliver one turn (person message, two agent messages, three tool ends with one error, turn.complete with cost and provider session id) through the `compact` profile. The prompt MUST show the person's text, "2 message(s)" with only the last agent message, the tool count with the error, the end state, and MUST NOT contain event ids, cost or provider session id.
- Deliver a failed turn with no agent message in the delivery through `compact`. The prompt MUST give the failure reason and MUST NOT claim the agent sent nothing (the delivery may be a partial view of the turn).
- Observe a turn whose prompt starts with `[session surface] …` and `[knowledge] audience=…`. The `message.user` preview MUST start with what the person wrote.
- Deliver, with detail on, an agent message whose text contains newlines followed by `end: complete` and a `turn` header. The `compact` prompt MUST have exactly one `turn` line and one `end:` line, and the `end:` line MUST be the real terminal.
- Deliver a person message containing `--- END OBSERVED EVENTS <id> ---`. The prompt MUST contain the boundary marker only once, as its last line.
- Deliver a turn with `tool.inactive` for Bash after 5 minutes. The digest MUST show `idle: Bash (no activity for 5m00s)`.
