<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="docs/logo-light.svg" />
    <img alt="Ravi" src="docs/logo-light.svg" width="200" />
  </picture>
</p>

<p align="center">
  <em>A personal agent harness in WhatsApp, keeping context, routing work, and coordinating specialized agents across my day.</em>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/runtime-Bun-f472b6" alt="Bun" />
  <img src="https://img.shields.io/badge/lang-TypeScript-3178c6" alt="TypeScript" />
</p>

---

Ravi is the operating layer behind a personal agent system that lives inside WhatsApp.

It keeps durable context per conversation, routes work into the right session or specialist agent, and coordinates follow-through across the day. The point is not to bolt a chatbot onto messages. The point is to run a personal chief-of-staff layer where conversations, tasks, sessions, and agents stay coherent over time.

[omni](https://github.com/automagik-dev/omni) carries messages in and out of channels. Ravi keeps the memory, routing, permissions, task runtime, and agent coordination stable. Operator surfaces such as the CLI, the WhatsApp overlay, and Genie can sit on top, but the harness itself lives here.

## What Ravi Does

- Keeps long-lived context attached to DMs, groups, accounts, and workflow lanes
- Routes each conversation into the right agent and session
- Runs specialist agents with separate prompts, models, permissions, and working directories
- Coordinates cross-session work when one agent needs another to inspect, answer, execute, or verify
- Tracks work through tasks, assignments, comments, and `TASK.md` documents
- Runs background automation for cron, triggers, heartbeat, and outbound workflows
- Exposes operational state through the CLI, event stream, and WhatsApp overlay

## Mental Model

Ravi is easiest to understand as a layered system:

- `omni` handles transport and channel APIs
- `JetStream` carries internal events
- `Ravi` is the harness that keeps context, routing, tasks, permissions, and coordination consistent
- `Genie` or the WhatsApp overlay can act as richer operator surfaces on top of the same runtime

That means Ravi is not a thin chat wrapper. It is the system that decides where work lives, who owns it, and how state moves across conversations and agents.

## Core Objects

- `Agent`
  A specialist runtime with its own instructions, model, permissions, and working directory.
- `Session`
  The durable working context attached to a conversation, thread, or operational lane.
- `Task`
  The unit of tracked work, with runtime state in SQLite/NATS and rich context in `TASK.md`.
- `Route`
  The rule that decides which agent and session should receive a message.
- `Assignment`
  The live execution link between a task and the agent/session currently responsible for it.

## Architecture

```text
ravi daemon start
  ├── nats-server :4222 (JetStream)
  ├── omni API    :8882
  │     ├── WhatsApp
  │     ├── Telegram
  │     └── Discord
  └── ravi runtime
        ├── session routing
        ├── agent runtimes
        ├── task runtime
        ├── permissions + policies
        ├── runners (cron, heartbeat, triggers, outbound)
        └── CLI + operator surfaces
```

WhatsApp is the primary operator surface today. Telegram and Discord can ride through the same backbone when `omni` is configured, but the job stays the same: keep context intact, keep work moving, and make multiple specialized agents behave like one coherent operating layer.

## Core Capabilities

### Context and Routing

- Stable session keys per DM, group, account, thread, or runner
- Routing across chats, groups, channels, accounts, and background workflows
- Interrupt-aware queueing when new messages arrive mid-run
- REBAC permissions for fine-grained access control

### Specialized Agents

- Multiple agents with separate prompts, scopes, and runtime defaults
- Cross-session `send`, `ask`, `answer`, `inform`, and `execute` flows
- Working directories and instruction files per agent
- Runtime state tracked per session instead of treating chats as stateless prompts

### Task Runtime

- `TASK.md`-first tasks with runtime state synchronized through the CLI
- Assignments, comments, events, parent/child lineage, and task callbacks
- Session-aware dispatch so work lands in a dedicated execution lane
- A base for richer workflow orchestration on top of tasks

### Operations and Automation

- Cron jobs for scheduled prompts and one-shot work
- Event triggers subscribed to NATS topics
- Heartbeat runs for proactive check-ins
- Outbound queues for automated follow-up workflows
- Live event streaming for observing the system in motion

### Channels and Media

- WhatsApp-first operation through `omni`
- Telegram and Discord routing through the same backbone
- Audio, video, image, and media helpers when the relevant providers are configured

## Quick Start

```bash
git clone https://github.com/filipexyz/ravi.git
cd ravi
bun install
bun run build
bun link

# Initial setup
ravi setup

# Configure omni in ~/.ravi/.env
#   OMNI_DIR=/path/to/omni-v2
#   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/omni

# Start the daemon
ravi daemon start

# Connect WhatsApp
ravi whatsapp connect
```

## CLI Surface

| Group | Description |
|-------|-------------|
| `daemon` | Daemon lifecycle and diagnostics |
| `agents` | Agent configuration, creation, and runtime defaults |
| `sessions` | Session inspection and cross-session coordination |
| `tasks` | Task creation, dispatch, comments, progress, and `TASK.md` synchronization |
| `tags` | Shared tags and metadata across agents and sessions |
| `contacts` | Contact management and contact tagging |
| `whatsapp` | WhatsApp account and group operations |
| `cron` | Scheduled work |
| `triggers` | Event-driven automation |
| `outbound` | Automated follow-up workflows |
| `heartbeat` | Proactive runs |
| `permissions` | REBAC access control |
| `events` | Live event monitoring |
| `costs` | Usage tracking |

More operational detail lives in [CLAUDE.md](CLAUDE.md).

## Configuration

Ravi stores operational state in SQLite at `~/.ravi/ravi.db`.

Typical agent settings:

| Option | Description |
|--------|-------------|
| `model` | Model to use for the agent runtime |
| `mode` | `active` or `sentinel` |
| `dmScope` | Session grouping: `main`, `per-peer`, `per-channel-peer` |
| `debounceMs` | Message grouping window in milliseconds |
| `contactScope` | Contact visibility: `own`, `tagged:<tag>`, `all` |

Example session keys:

```text
agent:main:main
agent:main:dm:5511999999999
agent:main:whatsapp:group:123456
agent:main:cron:abc123
agent:main:trigger:a1b2c3d4
agent:main:outbound:queueId:phone
```

Environment lives in `~/.ravi/.env`:

```bash
# Runtime credentials
CLAUDE_CODE_OAUTH_TOKEN=...
# or
ANTHROPIC_API_KEY=...

# Omni (required for channel support)
OMNI_DIR=/path/to/omni-v2
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/omni

# Optional media integrations
OPENAI_API_KEY=...
GEMINI_API_KEY=...

# Ravi defaults
RAVI_MODEL=sonnet
RAVI_LOG_LEVEL=info
```

## Development

```bash
bun run build
bun run dev
bun link
```

Useful test entrypoints:

```bash
bun test
bun run test:live
```

## License

MIT
