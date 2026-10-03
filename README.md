<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="docs/logo-light.svg" />
    <img alt="Ravi" src="docs/logo-light.svg" width="200" />
  </picture>
</p>

<p align="center">
  <strong>Local-first runtime for long-lived AI agents.</strong><br />
  Durable sessions, channel routing, permissions, tasks, pages, and provider adapters in one operating layer.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/runtime-Bun-f472b6" alt="Bun" />
  <img src="https://img.shields.io/badge/lang-TypeScript-3178c6" alt="TypeScript" />
  <img src="https://img.shields.io/badge/storage-SQLite-0f766e" alt="SQLite" />
  <img src="https://img.shields.io/badge/events-NATS-2563eb" alt="NATS" />
</p>

---

Ravi is the open-source runtime behind a multi-agent operating system.

A model call is the easy part of an agent. The hard part is everything around it: keeping the right context on the right conversation, routing each message to the right specialist, surviving restarts, deciding what an agent may do, following work after the turn ends, and putting results somewhere people can see them.

Ravi owns that layer, so an agent can keep working across days, chats, providers, and files without losing the thread.

```text
message, job, or event
  -> chat, contact, and session resolution
  -> route and permission decision
  -> runtime provider execution
  -> events, traces, tasks, artifacts, pages, and SDK streams
```

## What Ravi Gives An Agent

### A session that outlives the conversation

A WhatsApp group, a Slack thread, a DM, a cron job, a task worker, and a CLI prompt all land in durable Ravi sessions instead of one-off prompts. Sessions can ask, answer, inform, and hand off work to each other while keeping the source context.

### Continuity when things break

Long-lived agents only work if the runtime survives its own failures, so recovery is part of the session rather than an operator chore.

- A daemon restart or crash resumes live sessions, including input that was queued but not yet delivered.
- A session that goes quiet mid-turn is told about it and continues, with a bounded recovery budget so it cannot loop.
- Recoverable tool and interrupt failures are retried by the runtime instead of being posted to the chat.
- Unsafe states fail closed: a restart without a supervised successor, a trigger filter that does not compile, or a permission provider that is not live all refuse instead of guessing.

### A conversation that never blocks

- Long commands run as background jobs. The agent answers the next message right away and gets the result back in its session when the job ends.
- People can steer a busy agent from any channel: `>>message` waits for the current turn to end, and `!!message` is recorded without starting a turn.

```bash
ravi jobs run --session dev -- bun run test
ravi jobs tail <job-id>
ravi jobs kill <job-id>
```

### Work that is followed after the turn ends

When an agent opens or updates a pull request with `gh`, Ravi follows that PR and its CI and wakes the session when something changes. The follow is removed once the PR closes. The same event machinery powers cron jobs, triggers, and heartbeats, so an agent can be woken by time, by events, or by its own work.

### Pages people can open

`ravi pages ship` publishes a page in one call. Each project owns one default host (`<org>-<project>.ravi.page`), and pages are routes on it. Visibility and passwords change per route without re-uploading. A successful ship also subscribes the shipping agent to new comments on that page, so feedback reaches the session that published it.

```bash
ravi pages published --project <project> --json
ravi pages ship --project <project> --title "Weekly report" --route /weekly --html ./report.html --json
ravi pages visibility <site> public --route /weekly --execute
```

### Permissions you can reason about

- Permissions are decided by a chain of pluggable providers. One of them verifies signed assertions from an external authority locally and denies anything missing, expired, or out of scope.
- Contact access granted in a chat is intersected with the agent's own ceiling, so a chat cannot give an agent more than it already has.
- Reception agents can run with the `chat-only` profile: conversation only, no tools, shell, or CLI groups.
- Approvals can be resolved from Slack with Block Kit buttons that only authorized people can click.

### Any provider, same behavior

Claude Code, Codex, Pi, and Grok Build are adapters. Ravi keeps ownership of queueing, permissions, traces, tasks, responses, and continuity, so switching providers does not change how an agent behaves. The provider and model for a turn can also come from a model broker.

## Quick Start

```bash
git clone https://github.com/filipexyz/ravi.git
cd ravi
bun install
bun run build
bun link
```

Set up and start the local runtime:

```bash
ravi setup
ravi daemon env
ravi daemon start
ravi daemon status
```

Send a first prompt and open the terminal UI:

```bash
ravi sessions send main "Summarize the current Ravi runtime state" --wait
ravi tui main
```

Connect a WhatsApp instance through the channel bridge (shows a QR code to pair):

```bash
ravi instances connect main
```

## Everyday Commands

### Operate sessions

Sessions are the durable runtime state for one agent working inside a chat, task, trigger, cron job, or operational lane.

```bash
ravi doctor
ravi agents list
ravi sessions list --json
ravi sessions send main "Check what needs attention today" --wait
ravi sessions trace main --json
ravi sessions reset main --execute
ravi events stream
```

### Track work with tasks

Tasks are for execution that needs an owner, dependencies, progress reports, and a terminal state.

```bash
ravi tasks create "Investigate provider fallback behavior" --assignee dev
ravi tasks list --json
ravi tasks watch <task-id>
```

### Manage contacts and CRM context

Contacts are canonical people or organizations. Platform identities are channel-specific ids linked to contacts or agents.

```bash
ravi contacts list --json
ravi contacts profile <contact-id> --json
ravi contacts timeline <contact-id> --json
ravi crm next --json
```

### Store and version artifacts

Artifacts are durable outputs with lineage, lifecycle events, immutable versions, and assets.

```bash
ravi artifacts create --path ./report --title "Runtime report"
ravi artifacts versions <artifact-id> --json
ravi artifacts snapshot <artifact-id> --label "before edits"
ravi artifacts restore <artifact-id> --version 1
```

### Run a task in a cloud sandbox

`ravi sandbox run` boots a disposable E2B microVM, clones a repository, runs one task with a worker agent, and saves the result locally as `changes.patch`. Nothing is pushed.

```bash
ravi sandbox template build
ravi sandbox run --repo https://github.com/owner/repo.git --task "Fix the failing test in src/foo"
```

### Build against the SDK

The decorated CLI registry is the source of truth for gateway routes, OpenAPI, and generated clients.

```bash
ravi sdk openapi emit --out docs/openapi.json
bun run sdk:generate
bun run sdk:check
```

Generated clients live in `packages/ravi-os-sdk` (TypeScript), `packages/ravi-os-swift-sdk` (Swift), and `packages/ravi-os-dart-sdk` (Dart).

## Core Primitives

- `Agent`: a configured specialist with instructions, provider and model settings, permissions, and a working directory.
- `Chat`: a channel conversation such as a WhatsApp DM, a group, a Slack thread, or a Telegram chat.
- `Session`: durable runtime state for one agent working in or about a chat, task, trigger, cron job, or operational lane.
- `Contact`: canonical person or organization, backed by platform identities and timeline events.
- `Platform identity`: channel-specific identity linked to a contact or agent, with raw ids kept as provenance.
- `Task`: tracked execution with dispatch, dependencies, reports, and status events.
- `Job`: a long command running in the background on behalf of a session.
- `Artifact`: durable output with lineage, versions, and assets.
- `Page`: a published route on a project's Ravi Pages host.
- `Spec`: Markdown rules memory under `.ravi/specs`.
- `Project`: alignment surface that links specs, tasks, sessions, and artifacts.
- `Plugin` and `Skill`: packaging and discovery for agent capabilities.

## Architecture

```text
ravi daemon start
  |-- nats-server :4222
  |-- legacy channel bridge (Omni)
  |     |-- WhatsApp
  |     |-- Telegram
  |     `-- Discord
  `-- ravi runtime
        |-- native channel adapters (Slack)
        |-- router + sessions + delivery queue
        |-- contacts + chats + identity graph
        |-- runtime provider registry + model broker
        |-- task runtime + background jobs
        |-- artifacts + pages
        |-- permission provider chain + context keys + approvals
        |-- specs + projects + tags
        |-- cron + triggers + heartbeat + watches
        |-- metrics + costs + quality
        `-- CLI + TUI + SDK gateway + streams
```

Ravi owns semantics: chats, contacts, agents, sessions, routing, permissions, runtime execution, tasks, artifacts, specs, traces, and operator APIs.

Transport lives at the edge. Native adapters inside Ravi handle Slack (Socket Mode, Web API, Block Kit, files, and threads). Channels that have not moved to a native adapter yet go through the Omni bridge, which owns their raw payloads, provider ids, delivery state, and attachments.

NATS carries live events and coordination. SQLite stores local operational state.

## Runtime Provider Contract

Providers are adapters, not owners of Ravi behavior. They normalize native execution into canonical events: `thread.started`, `turn.started`, `item.started`, `item.completed`, `text.delta`, `status`, `assistant.message`, `tool.started`, `tool.completed`, `approval.requested`, `approval.resolved`, `turn.interrupted`, `turn.failed`, and `turn.complete`.

Ravi remains responsible for:

- queueing, debounce, interruption, and pool backpressure;
- session continuity, provider state, resume, fork, and replay planning;
- tool permissions, host services, context keys, and approvals;
- task barriers and cross-session coordination;
- traces, metrics, costs, response delivery, and artifact lineage.

A model broker can choose the provider and model for each turn through a short-lived route lease. Provider sign-in runs from the CLI, for example `ravi runtime providers codex login start`.

See [Runtime provider contract](docs/runtime-provider-contract.md), [Model broker runtime](docs/model-broker-runtime.md), and `.ravi/specs/runtime`.

## Specs Are The Governance Layer

The README is orientation. Specs are the durable rule source, and they are required reading before changing a governed area.

```bash
ravi specs list
ravi specs get runtime/providers --mode rules --json
ravi specs get sdk/streaming --mode full --json
ravi specs sync --json
```

Active spec domains include `artifacts`, `channels`, `daemon`, `runtime`, and `specs`. Draft domains include `cli`, `commands`, `contacts`, `knowledge`, `learning`, `plugins`, `quality`, `routines`, `sdk`, `self`, `tags`, and `todos`.

## Repository Map

```text
src/runtime/          provider adapters, dispatcher, event loop, recovery
src/router/           routes, sessions, persistence, runtime dispatch links
src/channels/         native channel adapters, message prefixes, delivery
src/omni/             boundary to the legacy channel bridge
src/contacts.ts       contacts, identity graph, timeline, profile data
src/tasks/            task runtime, dependencies, profiles, automations
src/jobs/             background jobs for long commands
src/artifacts/        artifact ledger, blobs, versions, lineage
src/pages/            Ravi Pages ship, comments, and viewer audiences
src/permissions/      permission provider chain, grants, and context keys
src/hooks/            command hooks, including PR and CI follow
src/sandbox/          disposable E2B sandbox runs
src/sdk/              gateway, OpenAPI, generated-client support, streams
src/cli/commands/     decorated command handlers and CLI surface
src/plugins/          plugin and skill discovery
src/specs/            specs indexing and CLI support
src/tui/              terminal UI
docs/                 public documentation
.ravi/specs/          normative rules memory
packages/             generated SDK packages
```

## Security And Boundaries

- Raw channel ids are provenance, not canonical product objects.
- Contacts represent people or organizations, chats represent conversations, and agents remain agents.
- Providers do not bypass Ravi permissions or mutate tasks and sessions directly.
- Secrets must not be stored in SQLite, emitted in traces, forwarded to shell tools, or leaked through provider raw events.
- Channel drivers may declare a bounded set of inbound slash actions. Only the action name, whether arguments were present, and the channel identity carried by the inbound event cross that boundary. The boundary checks the identity's shape but does not authenticate it. An action fails closed when its runtime is unavailable.
- Cloud auth stores Ravi-owned CLI credentials, not browser cookies or provider tokens.
- Commercial hosting, billing, quotas, hosted artifact serving, private asset auth, custom domains, and Console server policy live outside this open-source repo.

## Configuration

Environment is read from the Ravi home directory, usually `~/.ravi/.env`.

```bash
# Runtime provider credentials
CLAUDE_CODE_OAUTH_TOKEN=...
# or provider/API-key flows when explicitly used
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
ELEVENLABS_API_KEY=...

# Legacy channel bridge
OMNI_DIR=/path/to/omni-v2
DATABASE_URL=<postgres-url-used-by-omni>

# Ravi defaults
RAVI_MODEL=sonnet
RAVI_LOG_LEVEL=info
```

Cloud-linked commands such as `ravi pages` use local Ravi CLI credentials:

```bash
ravi login
ravi whoami
ravi logout
```

## Development

Use Bun for every package operation (`bun install`, `bun add`, `bun remove`).

```bash
bun run build
bun run typecheck
bun run test
bun run sdk:check
```

Focused checks:

```bash
bun run test:cli-commands
bun run test:sdk
bun run lint
bun run check:docs
```

`bun install` sets up a pre-push hook that checks SDK drift and then runs the build, typecheck, and test commands.

## Useful Docs

- [Architecture](docs/architecture.mdx)
- [Runtime provider contract](docs/runtime-provider-contract.md)
- [Model broker runtime](docs/model-broker-runtime.md)
- [Ravi specs memory](docs/ravi-specs-memory-prd.md)
- [SDK guide](docs/guides/sdk.mdx)
- [Contacts guide](docs/guides/contacts.mdx)
- [Sessions guide](docs/guides/sessions.mdx)
- [Permissions guide](docs/guides/permissions.mdx)
- [Task runtime](docs/ravi-task-runtime-v0.md)
- [Artifacts reference](docs/reference/artifacts.mdx)
- [NATS events reference](docs/reference/nats-events.mdx)

## License

MIT
