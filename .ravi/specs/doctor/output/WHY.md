# Doctor Output / WHY

`ravi doctor` is used by humans, agents, CI, and future repair automation. The
JSON shape must be the source of truth so callers can make deterministic
decisions without scraping human text.

Human output is a compact projection of the same checks, findings, severity,
exit code, and runtime snapshot. This keeps diagnostics useful without creating
two incompatible doctor contracts.
