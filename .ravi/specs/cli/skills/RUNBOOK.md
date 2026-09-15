# Skills agent-first CLI contract / RUNBOOK

## Debug flow

1. Read the domain rules with
   `ravi specs get cli/skills --mode rules --json`. The global contract remains
   authoritative for envelopes, exits, transports, authorization and audit.
2. Classify the actual install invocation before diagnosing it:
   - catalog or local source plus no `--overwrite`: immediate additive write;
   - Git source or any `--overwrite`: confirmation-braked write.
3. For an additive catalog/local call, absence of `--execute` is expected. A
   valid selection installs and returns exit 0. `SKILL_NOT_FOUND`, exit 1,
   means selection failed before any destination write.
4. For a Git call without `--execute`, exit 3 is expected before resolution.
   Read only `sourceKind`, controlled `sourceLabel`, `selectionDeferred`,
   `overwrite` and `codexSync` from `error.plan`.
5. For a catalog/local overwrite without `--execute`, safe lookup and selection
   happen first. Exit 3 is expected with `sourceKind`, controlled `sourceLabel`,
   `skillCount`, `overwrite` and `codexSync` in `error.plan`.
6. `selectionDeferred: true` means a Git source was not resolved, discovered or
   selected. A Git not-found condition is therefore not knowable on the first
   call; it may appear as `SKILL_NOT_FOUND`, exit 1, after confirmation.
7. `sourceLabel` must be exactly `catalog`, `local` or `git`. If either plan
   contains a URL, path, basename/subpath, destination, skill name, skill
   content or arbitrary metadata, treat it as a plan-minimization regression.
   A `skillCount` is allowed only after safe catalog/local selection.
8. Batch visibility changes (`grant-batch`/`revoke-batch`) have no
   `--execute`. Their preview remains the pre-existing `--dry-run`, exit 0 with
   counts and no write.
9. For other entity errors, branch on `error.code`: `SKILL_NOT_FOUND` uses
   visible skill suggestions; `AGENT_NOT_FOUND` uses real agent ids/names.
   Neither the message, action nor suggestions may repeat the source input.

## Zero-effect diagnosis

When a dry-run appears to mutate before exit 3, inspect the ordering in
`skills install`:

1. Purely normalize the requested name and parse the source kind.
2. For Git, call `contractDryRun` before `withResolvedSkillSource`, discovery,
   selection, `installSkills` or Codex sync. Confirm that the plan has
   `selectionDeferred: true` and no `skillCount`.
3. For catalog/local overwrite, perform safe enumeration/discovery and
   selection first so not-found remains exit 1; then call `contractDryRun`
   before `installSkills` or Codex sync. Confirm that the plan reports only the
   selected `skillCount`, never names or content.
4. Confirm through the control flow that the unconfirmed Git branch never
   enters the resolver and no braked branch reaches installation or Codex
   synchronization.

If an additive catalog/local call returns exit 3, the condition is too broad.
If a Git call resolves before exit 3, or any braked call writes before exit 3,
the brake is too late. If catalog/local overwrite hides a safe not-found behind
exit 3, the brake is too early.

## Validation

```bash
bun test src/cli/commands/skills.test.ts
```

Run live install checks only with isolated `RAVI_STATE_DIR`, `HOME` and
`USERPROFILE`; `installSkills` derives its plugin destination from the home
directory. Refuse an execute-path check if the redirected home is not active.

```bash
# Additive catalog/local: immediate exit 0, no --execute required.
ravi skills install cli-creator --json
ravi skills install --source ./fixture-skills --all --json

# Git: exit 3 before source resolution. Overwrite: exit 3 after safe selection,
# but before writing.
ravi skills install --source https://github.com/example/ravi-skills.git --all --json
ravi skills install cli-creator --overwrite --json
ravi skills install --source ./fixture-skills --all --overwrite --json

# Confirm only inside the isolated fixture after reviewing the minimal plan.
ravi skills install --source https://github.com/example/ravi-skills.git --all --execute --json
ravi skills install cli-creator --overwrite --execute --json

# Other domain contracts.
ravi skills show nope-skill --json
ravi skills grant nope-agent agents-manager --json
ravi skills grant-batch --all-agents --all-skills --dry-run --json
ravi skills list --fields name,source --json
```

Expected ordering for a missing Git selection is exit 3 on the unconfirmed
call, followed by exit 1 `SKILL_NOT_FOUND` only on the confirmed call. For a
missing catalog/local selection, additive or overwrite, expect exit 1 before
the brake and before any write on the first call.
