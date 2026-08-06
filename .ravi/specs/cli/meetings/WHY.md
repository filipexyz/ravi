# Meetings agent-first CLI contract / WHY

Meetings is the wave's counter-example: the contract principle (brake external
/ irreversible / real-execution writes) does NOT automatically mean adding
`--execute` everywhere. `join` performs a real action, but one that is
visible, consented and interruptible — the bot enters as a named participant
and can be removed by any host — and it already shipped `--dry-run` as its
inspection path. Renaming or duplicating that flag would break every existing
caller for zero safety gain, so the pre-existing flag is documented as the
brake EQUIVALENT and the skill teaches inspect-then-join.

The remaining mutations earned their unbraked status by rationale, not by
omission: `login` is an interactive human flow where the human at the browser
is the confirmation step; `finalize` registers a local artifact from a run
that already happened; `profiles init` is a reversible local scaffold with the
tasks `profiles init` precedent.

The not-found work had one subtlety worth recording: `resolveMeetingProfile`
throws for unknown ids AND for existing-but-invalid profiles. Mapping every
throw to `MEETING_PROFILE_NOT_FOUND` would misreport config corruption as a
typo, so the envelope only fires when the id is genuinely absent from the
local catalog.

Testing exposed a latent environment bug: the whole pre-existing meetings
suite died mid-run on Windows because the recorder stub (bash script, POSIX
PATH separator, X_OK probe) can never resolve there — and `fail()` without a
tool context calls process.exit. The fix (BIN env override + one skipped
spawn test) made the suite deterministic on every platform without weakening
POSIX CI coverage.
