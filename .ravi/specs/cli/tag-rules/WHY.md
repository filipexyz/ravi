# Tag-rules agent-first CLI contract / WHY

Tag rules move contacts across lifecycle tags automatically — the highest
blast radius in the tagging stack, because `tick --apply` rewrites tags for
EVERY contact in one run. Yet this wave added no `--execute` brake, and that
is the point worth recording: both writes (`tick`, `evaluate`) were designed
dry-run-by-default from day one. Without `--apply` they already produce
exactly what `contractDryRun` produces elsewhere — a preview of what would be
written, with nothing written. Renaming `--apply` to `--execute` would break
every cron teaching (`tick --apply --json` is the documented periodic runner)
for zero safety gain, so the flag stays and the spec documents it as the brake
equivalent — the same decision `cli/chats` took for
`backfill-provider-timestamps`.

The uncomfortable truth this spec refuses to hide: `tick` and `evaluate`
declare `@CommandAccess kind:"read"` while writing under `--apply`. Flipping
the kind looks like the honest fix, but `access.kind` feeds runtime
authorization (`enforceCliCommandAuthorization`) — flipping it silently
revokes these commands from agents that only hold read grants. The whatsapp
wave hit the same wall (`join`/`leave` declared read) and set the precedent:
document the mis-declaration as a pendency for an authorization-focused wave,
never as a side effect of contract work.

Suggestion scoping follows the chats precedent: rule ids are local files, so
`TAG_RULE_NOT_FOUND` suggests freely from the loaded registry; contact ids are
scope-cloaked inside the contacts domain, so `CONTACT_NOT_FOUND` carries no
suggestions and points to `ravi contacts list` instead of guessing.

The test file (`tag-rules.test.ts`) is new — the domain had none. It runs
against a real isolated state (the engine.test.ts pattern) instead of module
mocks, so the "dry-run writes nothing" proof reads the actual contacts DB
after the run rather than trusting a mocked flag.
