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
  - src/pages/read-download.ts
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
2. The read MUST decide one reader (`resolvePageReader`) from the connector
   classifier (`resolveConnectorTurn`) and the access actor
   (`resolveAccessActor`):
   - `operator`: a turn the classifier accepts as the operator's own (the
     terminal, the linked owner's message, routines the operator owns):
     `publicOnly: false` with the `ravi login` session alone.
   - `person`: another contact writing in their own direct chat, in a session
     of their own (`isContactPrivateDirectTurn`, the same check the
     `person_asking` connector mode uses), so what the read returns stays in
     a transcript only that person reads: `publicOnly: false`, and the
     request MUST name that contact in `x-ravi-actor-contact`, fixed from this
     same decision, so Console answers with that person's own access through
     this installation's `ravi link` (Console spec `cli/actor`). No link, not
     a member or no access to the Page is a refusal; Console never falls back
     to the operator's access for a named person.
   - `public_only`: anything else: a contact in a group, in a shared session
     or in a thread of one (other participants could ask the agent to repeat
     the Page), a routine or a thread working for a contact, an agent
     relaying, an unresolved speaker, a turn that cannot be classified:
     `publicOnly: true`, with no `x-ravi-actor-contact`, so reading a public
     Page never needs or starts anyone's link. A classification failure is
     logged at debug.
   The operator's session never returns a private Page to another person's
   turn with the operator's own access.
3. Without `--custom-domain`, only `*.ravi.page` hosts are sent to Console and
   any other host is a usage error. With `--custom-domain`, the given URL is
   sent to Console, so Console sees only the URLs an agent explicitly reads.
4. A `public_only` refusal MUST exit 3 (`PAGE_ACCESS_DENIED`, policy block);
   other access refusals exit 1. The refusal MUST say which classifier rule
   kept the turn from being the operator's own (`details.turn`:
   `relay_answer_chat`, `owner_outside_dm`, `group`, `shared_session` (a
   contact's direct chat in a shared session), `not_owner` or
   `unknown`, and the same sentence in the message). The owner's own message
   reads private routes in any chat, a group or the agent's shared session
   included (`cli/connectors`, "The owner's own turn"). That
   explanation never changes the classification. A refusal of a `person`
   read MUST exit 1 and say which case it was in `details.turn`
   (`not_member`, `no_page_access`, `executor_scoped` or
   `role_incomparable`), a field the CLI envelope and the gateway relay keep.
   No link stays `ACTOR_NOT_LINKED`, whose own refusal carries the link flow
   Ravi started (`linkFlow`, `turnLinkContract`). Through the daemon gateway
   the message, `turn` and `suggestedAction` reach the agent (`cli`). Not found is `PAGE_NOT_FOUND`; non-text
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
8. `--format` MUST let the agent pick: `markdown` (default), `html`, `files`
   or `zip`. `files` and `zip` send Console `format: "files"`, require `--out`
   (an empty or new directory, or a new zip file) and download every listed
   file, checking its size and sha256. Paths that are absolute or contain `..`
   are refused. The presigned URLs MUST NOT appear in any output.
   Directory downloads MUST authorize every final file destination through the
   caller file-write/provider-settings boundary before any file fetch or write.
   The boundary MUST be rechecked after downloading, before creating files.
   Write access to the parent directory MUST NOT authorize provider settings
   such as `.claude`, `.codex`, `.pi` or `.mcp.json` within it, including nested,
   case-variant and symlink destinations. Manifest filenames MUST remain literal.
   ZIP members are archive data; the ZIP destination itself MUST be authorized.
9. Every answer MUST say what its text is (`content.representation` and
   `content.note`, also printed as a `Format:` line): Markdown is an extraction
   without styles, layout or images and points to `html` and `zip|files` for
   the design. The prompt section says the same, so an agent asked for a page
   in the same style reads the source, not the Markdown.
