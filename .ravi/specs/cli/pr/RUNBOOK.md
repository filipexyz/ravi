# Verified PR publication / RUNBOOK

From the clean, committed worktree in a publishing Ravi session, through its
gateway/agent:

```bash
ravi pr publish --repo owner/repo --base dev --title "Fix publication" --body-file /tmp/pr.md --dry-run --json
ravi pr publish --repo owner/repo --base dev --title "Fix publication" --body-file /tmp/pr.md --expect-sha <full-local-sha> --execute --json
```

From the operator's own terminal, with the installed CLI, name the session
whose chat receives the CI follow:

```bash
ravi pr publish --repo owner/repo --base dev --title "Fix publication" --body-file /tmp/pr.md --reply-session <session> --dry-run --json
ravi pr publish --repo owner/repo --base dev --title "Fix publication" --body-file /tmp/pr.md --reply-session <session> --expect-sha <full-local-sha> --execute --json
```

Preview exits 3. The publishing or named session must have a chat destination;
thread publications hand CI to their durable parent.

- `PERMISSION_DENIED` with `pr publish requires an authenticated session
  context; run through the gateway/agent.`: a runtime context that belongs to
  no session ran the command. It cannot name another session; run it in a
  session, or from the operator's terminal.
- `RUNTIME_CONTEXT_INACTIVE`: the turn that started publish ended and revoked
  its context, possibly mid-upload. The grant is not the problem; do not ask for
  one. Rerun the same command with the same `--expect-sha` from a live turn and
  keep that turn open until it exits. Uploaded objects are skipped.
- `PUBLICATION_SESSION_REQUIRED` from a terminal: `--reply-session` is missing
  (exit 2), or the session has no chat destination. `--reply-session` names a
  destination and grants no authority.
- `STATE_SCHEMA_NOT_READY` from a terminal: the installed daemon has not
  prepared state for this release. Run `ravi daemon restart -m "prepare state"`
  and rerun.
- A CLI run from a checkout or a worktree cannot open runtime state and cannot
  publish or preview. Do not point it at real state.
- If the refusal says `Approval required`, obtain approval and a reissued scope
  from that authority, or have the operator run the command.

Do not repair a refusal by bypassing the journal or bootstrapping an admin key.
Runtime and client must both contain this feature.
`FOLLOW_RUNTIME_UNAVAILABLE` means update/start the normal Ravi
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

`PUBLICATION_AUDIT_FAILED` from local journal access: the installed daemon
prepares the journal. Run `ravi daemon restart -m "prepare state"`, then rerun
with the same `--expect-sha`.

The result's CI state is a snapshot; the returned trigger follows later events.
Record independent current-head review in the PR; use the live repository's
required checks, not the retired Review Gate. The replaced
`scripts/publish-pr.ts` entrypoint is removed; use this registered command.
