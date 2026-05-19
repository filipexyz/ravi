<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="docs/logo-light.svg" />
    <img alt="Ravi" src="docs/logo-light.svg" width="200" />
  </picture>
</p>

<p align="center">
  <strong>Local-first runtime infrastructure for long-lived AI agents.</strong><br />
  Channel routing, durable sessions, identity, tasks, artifacts, specs, SDKs, and provider adapters in one coherent operating layer.
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

Most agent projects start with a model call and then struggle with the hard parts around it: keeping the right context attached to the right conversation, routing messages to the right specialist, preserving provider state, tracking work, explaining failures, storing generated artifacts, and giving agents rules they can actually consult before editing code.

Ravi is the layer that owns those concerns.

```text
message or job
  -> chat/contact/session resolution
  -> route and policy decision
  -> runtime provider execution
  -> events, traces, tasks, artifacts, metrics, and SDK streams
```

The goal is simple: an agent should be able to keep working across days, chats, providers, tasks, and files without losing the thread.

## What Changes

- Your WhatsApp group, DM, cron job, task worker, and CLI prompt all land in durable Ravi sessions instead of stateless one-off prompts.
- Agents can ask, answer, inform, execute, and hand off work across sessions while preserving source context.
- Contacts, chats, platform identities, agents, messages, and sessions have separate meanings, so raw channel ids do not become the product model.
- Generated outputs become artifacts with lineage, versions, assets, events, and restore/publish paths.
- Specs under `.ravi/specs` give agents durable rules before they touch governed areas of the codebase.
- Runtime providers such as Claude Code, Codex, and Pi are adapters. Ravi keeps ownership of queueing, permissions, traces, tasks, responses, and continuity.

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

Send a first prompt to a session:

```bash
ravi sessions send main "Summarize the current Ravi runtime state" --wait
```

Open the terminal UI:

```bash
ravi tui main
```

Connect WhatsApp when Omni is configured:

```bash
ravi whatsapp connect
```

## Choose Your Path

### Run Ravi Locally

Use Ravi as a local runtime and operator CLI.

```bash
ravi doctor
ravi daemon status
ravi sessions list --json
ravi events stream
```

### Operate Agent Sessions

Sessions are the durable runtime state for one agent working inside a chat, task, trigger, cron job, or operational lane.

```bash
ravi agents list
ravi sessions send main "Check what needs attention today" --wait
ravi sessions trace main --json
ravi sessions reset main
```

### Track Work With Tasks

Tasks are for execution that needs assignment, dependencies, status, comments, reports, and terminal state.

```bash
ravi tasks create "Investigate provider fallback behavior" --assignee dev
ravi tasks list --json
ravi tasks show <task-id>
ravi tasks watch <task-id>
```

### Manage Contacts And CRM Context

Contacts are canonical people or organizations. Platform identities are channel-specific ids linked to contacts or agents.

```bash
ravi contacts list --json
ravi contacts profile <contact-id> --json
ravi contacts timeline <contact-id> --json
ravi crm contacts --json
ravi crm next --json
```

### Store And Version Artifacts

Artifacts are durable generated or local outputs. They can contain one file, a directory/package, structured output, metadata, lifecycle events, immutable versions, and assets.

```bash
ravi artifacts create --path ./report --title "Runtime report"
ravi artifacts versions <artifact-id> --json
ravi artifacts snapshot <artifact-id> --label "before edits"
ravi artifacts restore <artifact-id> --version 1
```

Cloud-linked artifact publishing is exposed through a generic Console-compatible API contract:

```bash
ravi login
ravi whoami
ravi artifacts publish <artifact-id-or-path> --project <project> --site <site>
```

The proprietary server policy for hosted artifacts, billing, quotas, private asset auth, custom domains, and Console product behavior intentionally lives outside this open-source repo.

### Build Against The SDK

The decorated CLI registry is the source of truth for gateway routes, OpenAPI, and generated clients.

```bash
ravi sdk openapi emit --out docs/openapi.json
bun run sdk:generate
bun run sdk:check
```

Generated clients live in:

- `packages/ravi-os-sdk` for TypeScript.
- `packages/ravi-os-swift-sdk` for Swift.

### Work On The Codebase

Specs are required reading before changing governed areas.

```bash
ravi specs list
ravi specs get runtime/providers --mode rules --json
ravi specs get contacts/identity-graph/unified-model --mode full --json
```

Then run the normal local gates:

```bash
bun run build
bun run typecheck
bun run test
```

## Core Primitives

- `Agent`: a configured specialist runtime with instructions, model/provider settings, permissions, and working directory.
- `Chat`: a channel conversation container such as a WhatsApp DM, group, Telegram chat, room, or thread.
- `Session`: durable runtime state for one agent working in or about a chat, workflow, task, trigger, cron job, or operational lane.
- `Contact`: canonical person or organization, backed by platform identities and timeline events.
- `Platform identity`: channel-specific identity linked to a contact or agent, with raw ids preserved as provenance.
- `Task`: tracked execution with dispatch, dependencies, reports, status events, profiles, and automations.
- `Artifact`: durable output with lineage, lifecycle events, immutable versions, assets, and local blob ingestion.
- `Spec`: Markdown rules memory under `.ravi/specs`.
- `Project`: alignment and context surface that can link specs, tasks, sessions, and artifacts.
- `Plugin` and `Skill`: packaging and discovery surfaces for agent capabilities.

## Architecture

```text
ravi daemon start
  |-- nats-server :4222
  |-- omni API / channel adapters
  |     |-- WhatsApp
  |     |-- Telegram
  |     `-- Discord
  `-- ravi runtime
        |-- router + sessions + delivery queue
        |-- contacts + chats + identity graph
        |-- runtime provider registry
        |-- task runtime + dependencies + automations
        |-- artifacts + versions + blob storage
        |-- permissions + context keys + policies
        |-- specs + projects + tags
        |-- cron + triggers + heartbeat + observers
        |-- metrics + costs + quality
        `-- CLI + TUI + SDK gateway + streams
```

Omni owns transport: raw channel payloads, provider ids, delivery state, attachments, and native channel APIs.

Ravi owns semantics: chats, contacts, agents, sessions, routing, policies, runtime execution, permissions, tasks, artifacts, specs, traces, and operator APIs.

NATS carries live events and coordination. SQLite stores local operational state. Runtime providers adapt external execution engines into Ravi's canonical event and session model.

## Runtime Provider Contract

Providers are adapters, not owners of Ravi behavior.

They normalize native execution into canonical events:

- `thread.started`
- `turn.started`
- `assistant.message`
- `tool.started`
- `tool.completed`
- `approval.requested`
- `turn.complete`
- `turn.failed`
- `turn.interrupted`

Ravi remains responsible for:

- queueing, debounce, interruption, and pool backpressure;
- session continuity, provider state, resume, fork, and replay planning;
- tool permissions, host services, context keys, and approvals;
- task barriers and cross-session coordination;
- traces, metrics, costs, response delivery, and artifact lineage.

See [Runtime provider contract](docs/runtime-provider-contract.md) and `.ravi/specs/runtime`.

## Specs Are The Governance Layer

README is orientation. Specs are the durable rule source.

```text
.ravi/specs/
  runtime/
  contacts/
  channels/
  artifacts/
  sdk/
  cli/
  commands/
  plugins/
  quality/
```

Useful commands:

```bash
ravi specs get runtime --mode rules --json
ravi specs get sdk/streaming --mode full --json
ravi specs sync --json
```

Current active spec domains include `artifacts`, `channels`, `daemon`, `runtime`, and `specs`. Draft normative domains include `cli`, `commands`, `contacts`, `knowledge`, `learning`, `plugins`, `quality`, `routines`, `sdk`, `self`, `tags`, and `todos`.

## Repository Map

```text
src/runtime/          provider adapters, dispatcher, event loop, continuity
src/router/           routes, sessions, persistence, runtime dispatch links
src/contacts.ts       contacts, identity graph, timeline, profile data
src/tasks/            task runtime, dependencies, profiles, automations
src/artifacts/        artifact ledger, blobs, versions, lineage
src/sdk/              gateway, OpenAPI, generated-client support, streams
src/cli/commands/     decorated command handlers and CLI surface
src/omni/             transport boundary to Omni/channel events
src/permissions/      REBAC and context-key authorization
src/plugins/          plugin and skill discovery
src/specs/            specs indexing and CLI support
src/tui/              terminal UI
docs/                 public documentation
.ravi/specs/          normative rules memory
packages/             generated SDK packages
```

## Security And Boundaries

- Raw channel ids are provenance, not canonical product objects.
- Contacts represent people or organizations; chats represent conversations; agents remain agents.
- Providers do not bypass Ravi permissions or mutate tasks/sessions directly.
- Secrets must not be stored in SQLite, emitted in traces, forwarded to shell tools, or leaked through provider raw events.
- Cloud auth stores Ravi-owned CLI credentials, not browser cookies or provider tokens.
- Commercial hosting, billing, quotas, hosted artifact serving, private asset auth, custom domains, and Console server policy are not documented as normative specs in this OSS repo.

## Configuration

Environment is read from the Ravi home directory, usually `~/.ravi/.env`.

Common local settings:

```bash
# Runtime provider credentials
CLAUDE_CODE_OAUTH_TOKEN=...
# or provider/API-key flows when explicitly used
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
ELEVENLABS_API_KEY=...

# Omni/channel support
OMNI_DIR=/path/to/omni-v2
DATABASE_URL=<postgres-url-used-by-omni>

# Ravi defaults
RAVI_MODEL=sonnet
RAVI_LOG_LEVEL=info
```

Cloud-linked commands use local Ravi CLI credentials created by:

```bash
ravi login
ravi whoami
ravi logout
```

## Development

Use Bun for every package operation:

```bash
bun install
bun add <pkg>
bun add -D <pkg>
bun remove <pkg>
```

Core checks:

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

The repo installs a pre-push hook through `bun install` or `bun run prepare`. It mirrors the CI quality gate and checks SDK drift before pushing.

## Useful Docs

- [Architecture](docs/architecture.mdx)
- [Runtime provider contract](docs/runtime-provider-contract.md)
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
