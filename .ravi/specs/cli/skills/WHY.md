# Skills agent-first CLI contract / WHY

`ravi skills` is a governance surface: grants decide which skills each agent
can even see, and `install` pulls third-party code (from GitHub, arbitrary git
URLs, or local paths) into the operator's plugin bucket, from where it is
materialized into runtimes. A wrong `install` is not a local mistake — it
plants executable instructions into every agent that later receives the skill.
That is why `install` is the single braked op of the domain: dry-run by
default, `--execute` to write, and the plan spells out source → destination per
skill so the caller audits exactly what lands where.

The rest of the surface deliberately stays unbraked:

- `sync` only re-materializes skills that already exist in local plugins —
  idempotent and reversible by construction.
- `grant`/`revoke` are exact inverses with live effect; braking them would put
  exit-3 friction inside the curation loop without adding safety.
- `grant-batch`/`revoke-batch` ALREADY had a `--dry-run` preview with a
  didactic helpAfter before this migration — the best pre-existing brake in
  the repo. The contract adopts it as the official brake equivalent instead of
  renaming it: renaming would break every caller and erase a teaching surface
  that already does the job (preview counts, exit 0, no write). The trade-off
  is a taxonomy asymmetry (exit 0 preview instead of exit 3) documented in the
  spec and in both helpAfters.

Implementation findings worth keeping:

- `selectSkills` throws plain errors rather than returning null, and it runs
  inside `withResolvedSkillSource`, whose `finally` cleans up temp git clones.
  The not-found envelope (and the brake) must therefore fire OUTSIDE the
  callback, or a non-context `process.exit` skips cleanup and leaks a clone
  per dry-run.
- `installSkills` resolves its destination from `homedir()` with no CLI
  override, so the execute-path test redirects `HOME`/`USERPROFILE` to a temp
  dir and asserts the redirect took effect BEFORE any write.
- `skills.test.ts` doubles as a focused test for the `src/router/` coverage
  gate (grants live in router-db), so contract tests are additive only.
