# Instances & routes agent-first CLI contract / WHY

Routes are where a config mistake becomes a live-conversation mistake: the
resolver picks the winning route for every inbound message, so a stray
`routes remove` does not just delete a row — it can hand an active chat to a
different agent (or to the instance default). The mutation remains high-impact,
but both route and instance deletion are local soft-deletes with explicit
restore commands, so a second identical call adds friction rather than safety.
`pending reject` discards a review entry with no restore path and keeps the
write brake. Its confirmation plan keeps only the instance, pending kind, and
presence flags because phone, chat id, and name are personal data. Everything
else stays immediate: `routes add`/`set` echo their
live effect and clean conflicting sessions on purpose, `enable`/`disable`/
`restore` are reversible pairs, and
`connect` is an interactive QR pairing with a human watching the terminal —
braking it would only add friction to an already-supervised act.

Two domain findings shaped this wave:

- All four command groups (`instances`, `routes`, `instances routes`,
  `instances pending`) live in one file and share resolver helpers, so the
  envelope had to be threaded through the shared
  `buildRouteListPayload`/`buildRouteDetailsPayload`/`buildRouteExplanationPayload`
  chain (each caller passes its own `op`) instead of being added per command.
- `instances disable` with an unknown target is intentionally not a not-found:
  it adds the target to the ignored-omni-instanceIds setting. Only `enable`
  maps the unknown-and-not-ignored case to `INSTANCE_NOT_FOUND`.

Suggestions come from the full instance list because instances have no
per-agent cloak — `instances list` exposes every name (tag filter aside), so
enriching NOT_FOUND with real names/instanceIds leaks nothing, unlike the
scoped domains (contacts, sessions) that filter candidates by visibility.
