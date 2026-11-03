# Verified PR publication / RUNBOOK

From the clean, committed worktree in the publishing Ravi session:

```bash
ravi pr publish --repo owner/repo --base dev --title "Fix publication" --body-file /tmp/pr.md --dry-run --json
ravi pr publish --repo owner/repo --base dev --title "Fix publication" --body-file /tmp/pr.md --expect-sha <full-local-sha> --execute --json
```

Preview exits 3. From a local operator terminal, add `--reply-session <session>`;
the session must have a chat destination. Runtime and client must both contain
this feature. `FOLLOW_RUNTIME_UNAVAILABLE` means update/start the normal Ravi
runtime; never start a second runner or disable this check.

After a partial failure, rerun in the same session/worktree, with the same
`--expect-sha`. Keep title/body when PR creation may not have happened. Existing
PR text is preserved. Ref already uploaded and PR already created are recovery
states, not reasons to skip CI follow. Use `partial.phase`, `refPublished`,
`prNumber`, `uncertain`, `publicationId` and `attemptId` for diagnosis.

`GIT_OBJECT_MISMATCH`: stop and inspect hashes; never accept the remote SHA as
a replacement. `NON_FAST_FORWARD`/`REMOTE_REF_CHANGED`: integrate the remote
work explicitly or choose a new work branch. `PR_CONFLICT`: resolve the
existing PR explicitly. No force, auto-rebase, automatic retry loop or cleanup
of uploaded objects is part of publication.

The result's CI state is a snapshot; the returned trigger follows later events.
An independent current-head review is still needed before merge. The replaced
`scripts/publish-pr.ts` entrypoint is removed; use this registered command.
