# Video agent-first CLI contract / WHY

The interesting decision here was WHERE to draw the brake line on a command
whose cost depends on a runtime fallback. `analyzeVideo` picks the path
internally: captions when available (free), Gemini otherwise (paid). Braking
everything would punish the common "watch this YouTube video" flow that
resolves to free captions; braking only `--strategy gemini` would leak money
through the `auto` default every time captions are missing or a local file is
passed.

The rule that survived: brake anything NOT GUARANTEED free at invocation time.
Only `--strategy subtitles` carries that guarantee, so only it runs without
`--execute`. The dry-run plan then does two jobs at once — it shows the Gemini
model that would be billed AND teaches the `freeAlternative` command, so an
agent blocked on exit 3 learns the zero-cost path instead of just retrying with
`--execute`.

This makes `auto` slightly more annoying (one extra confirmation even when
captions exist), which is the accepted trade: a wasted confirmation is cheaper
than an unplanned Gemini video-analysis bill on a long video.
