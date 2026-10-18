---
id: knowledge/checks
title: "Ravi Knowledge Checks"
kind: domain
domain: knowledge
status: active
normative: false
---

# Ravi Knowledge Checks

## Commands

- `ravi knowledge --help` lists exactly 8 commands: search, read, why, sources, marks, remember, forget, propose.
- Every command calls the gate before any work; a gate refusal exits 3 and makes no Console call (`src/cli/commands/knowledge.test.ts`).
- `propose` without `--execute` exits 3 `WRITE_REQUIRES_EXECUTE`; the plan has `bytes` and never the body.
- `forget <id>` without `--redact` runs at once; `forget --redact` without `--execute` exits 3.
- `search --json` returns a `KnowledgeSearchPayload` that parses with the command's return schema.
- `--execute` is the last declared option and no knowledge return schema is weak (`confirmation-policy.test.ts`, `return-schema-coverage.test.ts`).
- The skill gate maps `knowledge.*` to `ravi-system-knowledge` (`skill-gates.test.ts`).

## Gate and audiences

- Owner in a group, heartbeats, triggers, agents and contacts get `KNOWLEDGE_TURN_NOT_OPERATOR` (exit 3).
- With an outsider-reachable agent on `bootstrap`, every command exits 3 `KNOWLEDGE_EXPOSURE_UNSAFE`, and `ravi doctor` fails `permissions.knowledge_exposure`. An enabled trigger on `ravi.inbox.mail.*`, `ravi.inbound.*`, `ravi.console.inbox.*`, a watch, a webhook or a custom topic makes its agent outsider-reachable.
- The operator relay or an owner cron in a shared session (`agent:<id>:main`, a group, a session with a route or a trigger) gets reason `shared_session`.
- A write in a later turn of the same session after an unapproved read is gated; after `sessions reset` it is not.

## Transport

- The exec-context header decodes to v1 without `consoleUserId`.
- A 404 without an error code on a knowledge path is "unavailable"; a 404 `NOT_FOUND` is exit 1 `KNOWLEDGE_NOT_FOUND`; a search with a bad `--project` does not fall back to local results.
- Console down gives local results plus `issues: ["console_unavailable: <code>"]` and exit 0.

## Output

- One nonce per call; text containing `RAVI_KNOWLEDGE` or `>>>` cannot close the fence.
- `next` is never empty; zero results include the re-search recipe.

## Local store and memory

- Indexing is idempotent; `meetings/cloud/`, curator and Library-request sessions and forgotten subjects are skipped.
- With FTS5 off, local search still finds rows through `LIKE`.
- After `forget --about`, a contact with a WhatsApp JID has zero index rows.
- A `remember` from a channel turn whose text is only in a quote becomes a draft.
- Guarded sessions rewrite unmarked Ravi links to `[link removido]` on every outbound path; a bare domain is caught whatever precedes it (not an email), with its port and path.
- After `⟦forget⟧` the session keeps a guard-only row.
- Operator notes appear in the packet under the private-notes line, never under `[memory]`.
- A batched turn has exactly one `[knowledge]` line.
