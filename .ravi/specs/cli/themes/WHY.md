# Themes agent-first CLI contract / WHY

An org theme changes how every page of the organization (or of one project)
looks. The surface is split by that reach.

- **Reads and checks run at once.** `search`, `show`, `active`, `proposals`,
  `proposal` and `check` change nothing. `check` sends the folder to the
  Console because the Console owns the compiler and the contrast rules; a
  local copy of those rules would drift from what publish enforces.
- **`init` is a local write.** It only fills a folder, so it runs at once and
  refuses to overwrite files without `--force`: losing someone's draft tokens
  costs more than one extra flag.
- **`publish`, `propose` and `use` are braked.** A new version or a pointer
  change reaches pages other people already shipped, and a proposal notifies
  reviewers. The dry-run plan shows the scope and, for `use`, the hosts it
  affects, so the operator decides with the blast radius in view.
- **Agents propose, people decide.** Inside an agent runtime `publish` and
  `use` refuse before any request. An agent can draft and propose a theme,
  but the org's look changes only when a person publishes or switches it.
- **The Console's diagnostics are the answer.** A failing contrast pair or a
  bad token is reported with its file, line and column (`THEME_INVALID`,
  exit 2), so the caller can fix the exact place instead of guessing from a
  generic cloud error.
