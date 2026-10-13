---
id: pages/read
title: "Why agents read Pages through the CLI"
kind: capability
domain: pages
capability: read
status: active
---

# Why agents read Pages through the CLI

## Problem

Agents get Ravi Page links in chat and open them with a browser or WebFetch.
A private Page (the `ship` default) stops at the Console login, and a public
one arrives wrapped in the Pages bar. The agent ends up guessing, or asking
the operator to paste the content.

## Design

- Console already resolves a Page URL exactly as the Worker does, and it
  already holds the viewer rule. Reading through Console reuses both, so the
  CLI adds no second access model. The OSS side only decides `publicOnly`.
- `publicOnly` follows the same turn classifier as connectors. The operator's
  `ravi login` must never carry a private Page into someone else's turn.
- The agent picks the representation. Markdown is cheap to read but drops the
  design. An agent asked for "a page in the same style" needs the source, so
  `html` and `zip|files` exist, and every answer says what its text is.
- Files come through short-lived presigned URLs. Console never streams a whole
  site through a Vercel function, and the URLs stay inside the CLI.
- The guard and the prompt section steer agents to the command. Without them,
  agents keep reaching for the browser out of habit.

## Caveats

- The read is static. A Page built by JavaScript (Bases data pages) returns
  little text and sets `signals.renderSuggested`. A rendered read through
  Browser Run is a later phase.
- The guard recognizes tools by name pattern and shell commands by
  command position. It is a nudge, not a sandbox: the prompt section is the
  main path, and access is enforced in Console either way.
- Custom domains are read only with `--custom-domain`, and the guard does not
  cover them.
