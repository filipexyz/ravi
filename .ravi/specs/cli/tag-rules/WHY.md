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

`tick` and `evaluate` declare `@CommandAccess kind:"mutate"`, because the
static authorization contract must represent their real `--apply` effect.
This does not add a second confirmation flag: authorization and confirmation
remain separate. Exact legacy read grants are migrated to matching mutate
grants so least-privilege agents keep the access they had; broad read
wildcards remain unchanged and require explicit review.

Suggestion scoping follows the chats precedent: rule ids are local files, so
`TAG_RULE_NOT_FOUND` suggests freely from the loaded registry; contact ids are
scope-cloaked inside the contacts domain, so `CONTACT_NOT_FOUND` carries no
suggestions and points to `ravi contacts list` instead of guessing.

The test file (`tag-rules.test.ts`) is new — the domain had none. It runs
against a real isolated state (the engine.test.ts pattern) instead of module
mocks, so the "dry-run writes nothing" proof reads the actual contacts DB
after the run rather than trusting a mocked flag.
