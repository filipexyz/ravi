---
id: pages/read
title: "Read a Ravi Page from the CLI"
kind: capability
domain: pages
capabilities:
  - read
tags:
  - pages
  - agents
  - console
applies_to:
  - src/pages/read.ts
  - src/cli/commands/pages.ts
  - src/hooks/pages-link-guard.ts
  - src/runtime/host-hooks.ts
  - src/cli/commands/context.ts
  - src/runtime/runtime-system-prompt.ts
  - src/prompt-builder.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Read a Ravi Page from the CLI

## Intent

An agent that receives a Ravi Page link reads it with `ravi pages read <url>`
instead of a browser. Console owns resolution, access and extraction (Console
spec `console/pages/cli-read`); this side owns transport, the turn rule and the
nudges that send agents to the command.

## Invariants

1. `ravi pages read` MUST call `POST /api/cli/pages/read` with `{ url,
   publicOnly, format, cursor?, maxChars? }` and the active `ravi login`
   session. It MUST NOT fetch the Page itself.
2. `publicOnly` MUST be `true` for every turn the connector classifier
   (`resolveConnectorTurn`) does not accept as the operator's own: anything but
   the terminal, the operator's linked direct chat and routines the operator
   owns. The operator's session never returns a private Page to another
   person's turn.
3. Only `*.ravi.page` hosts are sent to Console. Any other host is a usage
   error unless `--custom-domain` is passed, so Console never sees the URLs an
   agent browses.
4. A `public_only` refusal MUST exit 3 (`PAGE_ACCESS_DENIED`, policy block);
   other access refusals exit 1. Not found is `PAGE_NOT_FOUND`; non-text
   routes are `PAGE_CONTENT_UNSUPPORTED`.
5. Human output MUST fence the page text between matching nonce markers that
   say it is untrusted data. `--json` returns Console's `contentTrust:
   "untrusted"` unchanged.
6. The Claude host hooks MUST deny WebFetch, browser navigation tools and
   `curl`/`wget`-style Bash commands aimed at a `*.ravi.page` URL with a reason
   naming `ravi pages read <url>`. The Codex bash hook applies the same rule to
   shell commands. `ravi pages read` itself MUST never be denied by the guard.
7. The runtime prompt MUST mount "Ravi Page Links" for non-sentinel agents
   whose context can run the `pages` group, and never for sentinels.
