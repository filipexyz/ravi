# Video agent-first CLI contract / WHY

`analyzeVideo` picks its processing path internally: captions when available,
Gemini otherwise. The CLI cannot produce a reliable price before that decision
and has no configured cost threshold to compare against. An unconditional
confirmation therefore creates a second call without enforcing a real limit.

All strategies now run immediately because analysis has no external delivery
or destructive effect. `--strategy subtitles` remains an explicit cost-control
choice: it prohibits Gemini fallback rather than merely confirming it.

If Ravi later gains a configured spend threshold and trustworthy estimate,
cost-based confirmation can be reintroduced against that policy instead of an
arbitrary hard-coded amount.
