---
id: sandbox/home-passthrough
title: "Home Passthrough"
kind: capability
domain: sandbox
capabilities:
  - home-passthrough
tags:
  - sandbox
  - gateway
  - cli
  - security
applies_to:
  - src/cli/home-mode.ts
  - src/cli/remote-gateway.ts
  - src/cli/registry.ts
  - src/cli/index.ts
owners:
  - rbbt-sandbox
status: active
normative: true
---

# Home Passthrough

## Intent

A connected sandbox run has two Ravis: the one inside the sandbox, which runs
the task, and HOME, the daemon on the operator's machine that started the run
and owns the home task. `ravi home <group> <command> …` sends one allowlisted
task command from the sandbox to HOME through the Console sandbox Gate. This
spec bounds what that request carries, so the sandbox's own credentials and
identity never leave it and HOME sees only what the run's grant allows.

## Vocabulary

- HOME: the daemon that started the run, reached through the Gate at
  `RAVI_HOME_GATEWAY_URL` (`https://gw.ravi.bot/i/<installationId>`).
- Grant: the Console sandbox grant (`X-Ravi-Sandbox-Grant`), a compact JWS.
  The sandbox egress proxy adds it to requests for the Gate host; the
  `RAVI_SANDBOX_GRANT` env var is a fallback only.
- HOME commands: the static allowlist `tasks.block`, `tasks.done`,
  `tasks.fail`, `tasks.report`, `tasks.show` (Console
  `SANDBOX_COMMAND_ALLOWLIST`, ADR 0003 #3), narrowed by `RAVI_HOME_COMMANDS`.

## Invariants

### Targeting

- `ravi home` is recognized only as the first CLI argument, before any other
  root routing. The entrypoint removes the token and sets an in-process
  invocation target; it MUST NOT set or read an env var for this, so a child
  process or a later command never inherits HOME targeting.
- Without `home`, every command keeps its transport: local, host socket, or
  `RAVI_GATEWAY_URL`. `RAVI_HOME_GATEWAY_URL` and `RAVI_SANDBOX_GRANT` change
  nothing outside home mode.
- In home mode the command MUST go to `RAVI_HOME_GATEWAY_URL` only. It never
  falls back to local execution, the host socket or `RAVI_GATEWAY_URL`, and it
  skips the codex-hook transport and the context-key requirement.
- `RAVI_HOME_GATEWAY_URL` MUST be `https:` (loopback `http:` is refused too),
  with no user or password, no `?` and no `#`. Missing gives
  `HOME_GATEWAY_REQUIRED` (exit 1); `http:` or `unix:` gives
  `HOME_GATEWAY_INSECURE` (exit 2); credentials, query, fragment or an
  unparsable value give `HOME_GATEWAY_INVALID` (exit 2). When
  `RAVI_GATEWAY_URL` parses to the same origin as `RAVI_HOME_GATEWAY_URL`,
  home mode is refused with `HOME_GATEWAY_CONFLICT` (exit 2) before any
  request. No error echoes the value.

### Command allowlist

- HOME commands are the static allowlist ∩ `RAVI_HOME_COMMANDS` (comma- or
  space-separated ids) when that is set and not blank, else the static
  allowlist. The env var can only narrow; an id outside the static list is
  ignored.
- A command outside the HOME commands exits 3 with
  `HOME_COMMAND_NOT_ALLOWED` and sends nothing; this includes
  `tasks.comment`. The check runs on the argv tokens before parsing and again
  on the parsed command. It is UX only: the Gate and the HOME listener enforce
  the allowlist themselves.
- `ravi home`, `ravi home --help` and `ravi home --json` print the HOME
  commands and whether `RAVI_HOME_GATEWAY_URL` is set, never its value, and
  exit 0.

### Request

- `POST <RAVI_HOME_GATEWAY_URL>/api/v1/<group>/<command>`, the same path the
  local gateway uses (Gate §Pipeline 2, Identifiers).
- Body: the same flat JSON object the decorated command sends to a local
  gateway, built by the same registry code: declared args and options only,
  rendering flags (`--json`) removed, the task positional as `taskId` (the Gate
  and the listener require `taskId` equal to the grant's task).
- Headers: exactly `content-type: application/json`, `accept:
  application/json` and, only when `RAVI_SANDBOX_GRANT` is set and not blank,
  `X-Ravi-Sandbox-Grant`. Never `authorization`, `x-ravi-cwd`,
  `x-ravi-gateway-internal`, `cookie`, `X-Ravi-Request-Id` (the Gate sets
  it) or a value taken from `RAVI_CONTEXT_KEY`, `RAVI_AGENT_ID`,
  `RAVI_SESSION_*` or any other `RAVI_*` identity env.
- `RAVI_SANDBOX_GRANT`, trimmed, MUST be one compact JWS of at most 8 KiB;
  anything else (whitespace, comma-joined, CR/LF) is refused before any
  request with `HOME_GRANT_INVALID` (exit 2).
- Redirects are not followed (`redirect: "manual"`); a 3xx answer is
  `HOME_GATEWAY_REDIRECT` (exit 1). The client timeout is 35 s, above the
  Gate's 30 s upstream timeout.
- A response is read up to 4 MiB (`HOME_RESPONSE_MAX_BYTES`). A larger
  `content-length` or body aborts the request and fails
  `HOME_RESPONSE_TOO_LARGE` (exit 1); nothing of the body is printed.

### Responses

- Success: a JSON body is pretty-printed, any other body is printed as text;
  never as raw bytes. In text mode every C0 control except `\n` and `\t`,
  every C1 control and the bidi overrides and isolates
  (U+202A–U+202E, U+2066–U+2069) are stripped (`stripTerminalControls`), from
  JSON string values and keys too. With `--json` the output stays JSON and
  those characters are written as `\uXXXX` escapes (`terminalSafeJson`).
- A Gate envelope `{error:{code,requestId}}` or a listener envelope
  `{error:{code,requestId,source:"ravi-listener"}}` (code
  `^[a-z][a-z0-9_]{0,63}$`) becomes `HOME_<CODE>` with `status`, `homeCode`,
  `source` (`gate` or `ravi-listener`) and `requestId` in the details and the
  request id in the message. Exit 1 for `grant_header_invalid` (the request
  carried two grants or a malformed one: the input is not at fault), else exit
  2 for status 400 and 413, exit 3 for `command_not_allowed`, exit 1
  otherwise; 429, 502, 503 and 504 are retryable, except
  `response_too_large` (the Gate's 4 MiB bound on HOME's answer, which the
  same request hits again). `grant_missing`,
  `grant_invalid`, `grant_revoked`, `grant_header_invalid`,
  `command_not_allowed`, `task_not_allowed`, `resource_forbidden`,
  `body_invalid`, `argument_invalid`, `payload_too_large`,
  `response_too_large`, `not_found`,
  `method_not_allowed`, `rate_limited`, `gate_unavailable`,
  `gateway_misconfigured` and `daemon_offline` carry a specific
  `suggestedAction`; `grant_header_invalid` says to unset
  `RAVI_SANDBOX_GRANT` when the egress proxy injects the header.
- The request id is shown only when it is a UUID, from the body or else from
  the `X-Ravi-Request-Id` response header.
- A complete contract envelope relayed from HOME's dispatcher keeps the remote
  projection (`remoteGatewayErrorToContractError`).
- Anything else (an edge HTML page, an unknown `source`, a non-matching code)
  is `HOME_GATEWAY_FAILED`; a transport failure is `HOME_GATEWAY_UNREACHABLE`
  (exit 1). No other field of the body, and never the transport error's
  message, is printed.
- Errors render like successes: terminal controls stripped in text mode
  (also from the error body before it is projected), escaped as `\uXXXX` with
  `--json`.
- The grant value MUST NOT appear in any output, error, log or audit, and
  never in argv. Every home output, 2xx bodies and relayed contract envelopes
  included (message, issues, suggestions, keys), shows `[grant]` in place of
  the `RAVI_SANDBOX_GRANT` value when it is set, and in place of any compact
  JWS whose header and payload are base64url JSON (`eyJ….eyJ….…`), which
  covers a grant the egress proxy injected without the CLI seeing it. A grant
  of another shape that only the proxy knows cannot be recognized by the
  CLI; the Gate and the listener never echo it.

### Contract surface

- No decorated group is added: no SDK, OpenAPI or command barrel change.

## Validation

```bash
bun test src/cli/home-mode.test.ts src/cli/remote-gateway.test.ts src/cli/registry.test.ts
```

See `CHECKS.md`.

## Known Failure Modes

- When the egress proxy injects the grant and `RAVI_SANDBOX_GRANT` is also
  set, the Gate may receive two grant headers and answer 400
  `grant_header_invalid` (exit 1, advice to unset `RAVI_SANDBOX_GRANT`);
  whether E2B's transform replaces or appends is an open live check
  (RUNBOOK).
- The static allowlist is a copy of Console's and the HOME listener's; the
  three must change together.
- `ravi home` inside a sandbox started without `--connected` has no
  `RAVI_HOME_GATEWAY_URL` and fails with `HOME_GATEWAY_REQUIRED`.
