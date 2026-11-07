# Verified PR publication / WHY

The supported alternative to git push in a runtime session was manual Git
Data API work followed by a separate script. Incorrect raw-diff parsing could
upload the wrong tree; successful PR creation could still leave no CI follow.
One command owns the complete outcome and exposes partial states honestly.

Content-addressed objects make retries safe only when their hashes are checked.
GitHub's commit endpoint does not accept arbitrary raw commit bytes, so v1
refuses formats it cannot reproduce exactly. It never manufactures a replacement
commit or weakens independent review to make publication appear successful.

A row in the trigger table is not proof of a loaded subscription. The runner
health request confirms that the existing runner consumed this exact desired
follow configuration, without adding another watcher or scheduling system.

## Historical preview limitation — resolved by #816

The local-operator path inherited from #793 accepted a nonempty
`--reply-session` and could return a preview with exit 3 even though execution
would fail authentication at the publication journal before any mutation.
The independent review of #769 identified this existing asymmetry; it was not
a regression introduced by that PR. A reply destination did not authenticate
the publisher, so the preview did not establish that the plan was executable.

[PR #816](https://github.com/filipexyz/ravi/pull/816) resolves this limitation
by removing `--reply-session` from the CLI, OpenAPI and SDK inputs and requiring
an authenticated session for preview and execution before body/worktree,
GitHub, health or journal IO. Missing authenticated context is refused with
exit 1; an authorized preview remains exit 3. This is historical context,
not an open runtime-warning task or a reason to relax journal authentication.
