# CLI / WHY

Ravi CLIs are used by both humans and agents. Agents need bounded,
machine-readable output and predictable failure shapes; humans need compact
text that points to the next useful command.

The CLI domain prevents operational commands from growing unbounded, leaking
loose return shapes into SDK/OpenAPI, or forcing agents to scrape prose when a
`--json` contract should exist.
