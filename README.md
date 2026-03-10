<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="docs/logo-light.svg" />
    <img alt="Ravi" src="docs/logo-light.svg" width="200" />
  </picture>
</p>

<p align="center">
  <em>The daemon that gives Claude a life</em>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/runtime-Bun-f472b6" alt="Bun" />
  <img src="https://img.shields.io/badge/lang-TypeScript-3178c6" alt="TypeScript" />
  <img src="https://img.shields.io/badge/AI-Claude%20SDK-d97706" alt="Claude SDK" />
</p>

---

Ravi is a multi-agent messaging daemon built on the Claude Agent SDK. It connects Claude to WhatsApp, Telegram, and Discord via [omni](https://github.com/automagik-dev/omni), with session routing, message queuing, and automation — all running locally with embedded NATS JetStream.

## Architecture

```
ravi daemon start
  ├── nats-server :4222 (JetStream)
  ├── omni API    :8882 (child process)
  │     ├── WhatsApp (Baileys)
  │     ├── Telegram
  │     └── Discord
  └── ravi bot
        ├── OmniConsumer  → JetStream pull consumer
        ├── Claude Agent SDK (sessions, tools)
        ├── OmniSender    → HTTP POST /api/v2/messages/send
        └── Runners (cron, heartbeat, triggers, outbound)
```

## Features

**Core**
- **Multi-Channel** — WhatsApp, Telegram, Discord via omni
- **Multi-Agent** — Multiple agents with different models, modes, and capabilities
- **Session Routing** — Per-peer, per-group, per-thread session isolation
- **Message Queue** — Smart interrupt handling with debounce support
- **REBAC Permissions** — Fine-grained relation-based access control

**Automation**
- **Heartbeat** — Proactive agent runs on schedule to check pending tasks
- **Cron Jobs** — Schedule prompts with cron expressions, intervals, or one-shot times
- **Event Triggers** — Subscribe to NATS topics and fire agent prompts on events
- **Outbound Queues** — Automated outreach campaigns with follow-ups and qualification
- **Cross-Session Messaging** — Agents can send, ask, answer, and execute across sessions

**Media & AI**
- **Audio Transcription** — Voice messages via OpenAI Whisper
- **Video Analysis** — YouTube and local videos via Gemini
- **Image Generation** — Via Gemini Imagen
- **Media Sending** — Images, videos, documents, stickers via any channel

**Operations**
- **Daemon Mode** — Run as system service (launchd/systemd)
- **Live Event Stream** — Real-time colored view of all NATS events
- **Contact Management** — Tags, notes, identities, opt-out, per-group tags
- **Spec Mode** — Collaborative specification before implementation

## Quick Start

```bash
# Install
git clone https://github.com/filipexyz/ravi.git
cd ravi
bun install && bun run build && bun link

# Setup (downloads nats-server, configures auth, creates agent)
ravi setup

# Configure omni in ~/.ravi/.env
#   OMNI_DIR=/path/to/omni-v2
#   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/omni

# Start everything
ravi daemon start

# Connect WhatsApp
ravi whatsapp connect
```

## How It Works

```
[WhatsApp / Telegram / Discord]
    → omni API
    → NATS JetStream (stream: MESSAGE)
    → OmniConsumer (pull consumer, ACK explicit)
    → ravi.{sessionKey}.prompt
    → RaviBot (Claude SDK)
    → ravi.{sessionKey}.response
    → Gateway → OmniSender (HTTP)
    → omni API
    → [WhatsApp / Telegram / Discord]
```

When messages arrive while an agent is processing:
- **Tool running** — message queues, waits for tool to finish, then interrupts
- **No tool** — interrupts immediately
- **Debounce active** — groups messages within time window

## CLI

| Group | Commands | Description |
|-------|----------|-------------|
| `daemon` | start, stop, restart, status, logs | Daemon lifecycle |
| `agents` | list, create, set, run, chat, reset | Agent configuration and testing |
| `sessions` | list, info, send, ask, execute, reset | Session management and cross-session messaging |
| `contacts` | list, add, tag, find, set, merge | Contact management |
| `whatsapp` | connect, status, dm, group | WhatsApp accounts and groups |
| `cron` | list, add, enable, disable, run, rm | Scheduled jobs |
| `triggers` | list, add, enable, disable, test, rm | Event-driven automation |
| `outbound` | create, start, pause, entries, report | Outreach campaigns |
| `heartbeat` | enable, disable, set, trigger | Proactive agent runs |
| `permissions` | grant, revoke, check, list, init | REBAC access control |
| `events` | stream | Live event monitoring |
| `costs` | summary, today, agent, session, top | API usage tracking |

Full CLI reference is in [CLAUDE.md](CLAUDE.md).

## Configuration

All config is stored in SQLite (`~/.ravi/ravi.db`) and managed via CLI.

### Agent Options

| Option | Description |
|--------|-------------|
| `model` | Model to use (sonnet, opus, haiku) |
| `mode` | `active` (responds) or `sentinel` (observes silently) |
| `dmScope` | Session grouping: `main`, `per-peer`, `per-channel-peer` |
| `debounceMs` | Message grouping window in ms |
| `contactScope` | Contact visibility: `own`, `tagged:<tag>`, `all` |

### Session Keys

```
agent:main:main                          # Shared session (all DMs)
agent:main:dm:5511999999999              # Per-peer DM session
agent:main:whatsapp:group:123456         # WhatsApp group
agent:main:cron:abc123                   # Cron job (isolated)
agent:main:trigger:a1b2c3d4              # Event trigger (isolated)
agent:main:outbound:queueId:phone        # Outbound campaign
```

## File Structure

```
~/ravi/
└── main/                 # Agent working directory
    ├── CLAUDE.md         # Agent instructions
    ├── HEARTBEAT.md      # Pending tasks for heartbeat
    └── MEMORY.md         # Agent memory (auto-managed)

~/.ravi/
├── ravi.db               # Config: agents, routes, sessions, contacts (SQLite)
├── .env                  # Environment variables
├── omni-api-key          # Auto-generated omni API key
├── jetstream/            # NATS JetStream storage
├── bin/nats-server       # nats-server binary (auto-downloaded)
└── logs/daemon.log       # Daemon logs
```

## Environment (`~/.ravi/.env`)

```bash
# Required (one of these)
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxx
ANTHROPIC_API_KEY=sk-ant-xxx

# Omni (required for channel support)
OMNI_DIR=/path/to/omni-v2
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/omni

# Optional
OPENAI_API_KEY=sk-xxx       # Audio transcription
GEMINI_API_KEY=AIza...      # Video analysis + image generation
RAVI_MODEL=sonnet           # Default model
RAVI_LOG_LEVEL=info         # debug | info | warn | error
```

## Development

```bash
bun run build     # Compile TypeScript
bun run dev       # Watch mode
bun link          # Make `ravi` available globally
make quality      # Lint + typecheck
```

## License

MIT
