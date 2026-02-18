# Ravi Bot

A Claude-powered conversational bot with WhatsApp and Matrix integration, session routing, and message queuing. Runs entirely locally with embedded infrastructure (pgserve + notifd).

## Features

- **Zero-Config Infrastructure** - Embedded Postgres (pgserve :8432) and notifd (:8080 with NATS) start automatically
- **WhatsApp Integration** - Connect via Baileys (no API keys needed), multi-account support
- **Matrix Integration** - Connect to any Matrix homeserver
- **Multi-Account Routing** - Route WhatsApp accounts to different agents, sentinel mode for observation
- **REBAC Permissions** - Fine-grained relation-based access control for tools, contacts, sessions
- **Session Routing** - Route conversations to different agents based on rules
- **Message Queue** - Smart interruption handling when tools are running
- **Debounce** - Group rapid messages before processing
- **Heartbeat** - Proactive agent runs on schedule to check pending tasks
- **Cron Jobs** - Schedule prompts with cron expressions, intervals, or one-shot times
- **Event Triggers** - Subscribe to any notif topic and fire agent prompts on events
- **Outbound Queues** - Automated outreach campaigns with follow-ups and qualification
- **Emoji Reactions** - Agents can react to messages with emojis
- **Media Downloads** - Images, videos, documents saved to /tmp with paths in prompts
- **Contact Management** - Tags, notes, opt-out, interaction tracking
- **Multi-Agent** - Configure multiple agents with different capabilities
- **Daemon Mode** - Run as a system service (launchd/systemd)

## Installation

```bash
git clone https://github.com/filipelabs/ravi.bot
cd ravi.bot
bun install
bun run build
bun link   # Makes `ravi` command available globally
```

## Quick Start

### 1. Setup

```bash
ravi setup
```

The setup wizard will:
- Download the `notifd` binary (local event bus)
- Configure Claude authentication (API key or OAuth token)
- Create the default agent
- Install and start the daemon

No external services needed. The daemon auto-starts embedded Postgres (pgserve) and notifd on launch, bootstrapping an API key on first run.

### 2. Connect WhatsApp

```bash
ravi whatsapp connect
```

Scan the QR code to link your WhatsApp. For multi-account setups:

```bash
ravi whatsapp connect --account vendas --mode sentinel
```

### 3. Monitor

```bash
ravi daemon status   # Check if running
ravi daemon logs     # View logs
```

## CLI Reference

### Daemon Management

```bash
ravi daemon start      # Start bot + gateway
ravi daemon stop       # Stop daemon
ravi daemon restart    # Restart daemon
ravi daemon status     # Show status
ravi daemon logs       # Follow logs
ravi daemon env        # Edit environment
ravi daemon install    # Install system service
ravi daemon uninstall  # Remove system service
```

### WhatsApp Account Management

```bash
ravi whatsapp connect                    # Connect default account (QR code)
ravi whatsapp connect --account vendas   # Connect named account
ravi whatsapp connect --account vendas --agent vendas --mode sentinel
ravi whatsapp status                     # Show connection status
ravi whatsapp status --account vendas    # Status for specific account
ravi whatsapp set --account vendas --agent main  # Change agent mapping
ravi whatsapp disconnect                 # Disconnect account
```

**Agent modes:**
- `active` (default) - Agent responds to messages normally
- `sentinel` - Agent observes silently, only sends when explicitly instructed via `ravi whatsapp dm send`

### Agent Configuration

```bash
ravi agents list                      # List all agents
ravi agents show main                 # Show agent details
ravi agents create mybot ~/ravi/mybot # Create new agent
ravi agents set main model opus       # Set model
ravi agents set main mode sentinel    # Set agent mode
ravi agents debounce main 2000        # Set 2s debounce
ravi agents reset main                # Reset main session
ravi agents reset main all            # Reset ALL sessions
```

### Heartbeat (Scheduled Tasks)

```bash
ravi heartbeat status                 # Show all agents
ravi heartbeat enable main 30m        # Run every 30 minutes
ravi heartbeat disable main           # Disable
ravi heartbeat set main interval 1h   # Change interval
ravi heartbeat set main active-hours 09:00-22:00  # Limit hours
ravi heartbeat trigger main           # Manual trigger
```

Create `~/ravi/main/HEARTBEAT.md` with pending tasks. Agent runs periodically and executes them. If nothing to do, agent responds with `HEARTBEAT_OK` (suppressed).

### Cron Jobs (Scheduled Prompts)

```bash
ravi cron list                       # List all jobs
ravi cron add "Report" --cron "0 9 * * *" --message "Daily report"
ravi cron add "Check" --every 30m --message "Check status"
ravi cron add "Remind" --at "2025-02-01T15:00" --message "Meeting soon"
ravi cron show <id>                  # Show job details
ravi cron enable <id>                # Enable job
ravi cron disable <id>               # Disable job
ravi cron set <id> <key> <value>     # Edit property
ravi cron run <id>                   # Manual trigger
ravi cron rm <id>                    # Delete job
```

**Schedule types:**
- `--cron "0 9 * * *"` - Cron expression (with `--tz` for timezone)
- `--every 30m` - Interval (`30s`, `5m`, `1h`, `2d`)
- `--at "2025-02-01T15:00"` - One-shot at specific time

**Options:** `--agent`, `--isolated`, `--delete-after`, `--description`

### Event Triggers

```bash
# Add trigger: fire when a contact is modified
ravi triggers add "Contact Changed" \
  --topic "ravi.*.cli.contacts.*" \
  --message "Um contato foi modificado. Registre a mudança." \
  --cooldown 30s

# Add trigger: alert on WhatsApp inbound
ravi triggers add "CRM Sync" \
  --topic "whatsapp.*.inbound" \
  --message "Nova mensagem recebida. Atualize o CRM." \
  --cooldown 10s

ravi triggers list                   # List all triggers
ravi triggers show <id>              # Show details
ravi triggers enable <id>            # Enable
ravi triggers disable <id>           # Disable
ravi triggers set <id> <key> <value> # Edit property
ravi triggers test <id>              # Test with fake event
ravi triggers rm <id>                # Delete
```

**Options:** `--topic` (required), `--message` (required), `--agent`, `--cooldown` (default: 5s), `--session` (main/isolated, default: isolated)

**Available topics:** `ravi.*.cli.{group}.{command}`, `ravi.*.tool`, `whatsapp.*.inbound`, `matrix.*.inbound`

Agents can self-configure triggers via CLI tools (`triggers_add`, `triggers_list`, etc.).

### Contacts

```bash
ravi contacts list                   # List approved contacts
ravi contacts add +5511999999999     # Add contact
ravi contacts pending                # Show pending requests
ravi contacts check +5511999999999   # Show contact details
ravi contacts tag +55... lead        # Add tag
ravi contacts untag +55... lead      # Remove tag
ravi contacts find "João"            # Search by name/phone
ravi contacts find lead --tag        # Find by tag
ravi contacts set +55... email user@example.com
ravi contacts set +55... opt-out true
```

### Outbound Queues (Automated Campaigns)

```bash
# Create queue
ravi outbound create "Prospecting" \
  --instructions "Reach out to this lead..." \
  --every 5m --agent main

# Manage queues
ravi outbound list                   # List queues
ravi outbound show <id>              # Queue details
ravi outbound start <id>             # Activate
ravi outbound pause <id>             # Pause
ravi outbound run <id>               # Manual trigger

# Manage entries
ravi outbound add <queueId> +55... --name "João Silva"
ravi outbound entries <queueId>      # List entries
ravi outbound status <entryId>       # Entry details
ravi outbound qualify <id> warm      # Set qualification
ravi outbound reset <id>             # Reset to pending
```

### REBAC Permissions

Fine-grained relation-based access control (replaced legacy allowedTools/bashConfig):

```bash
# Grant/revoke relations
ravi permissions grant agent:dev use tool:Bash
ravi permissions grant agent:dev execute executable:git
ravi permissions grant agent:dev execute group:contacts
ravi permissions grant agent:dev access session:dev-*
ravi permissions revoke agent:dev use tool:Bash

# Apply templates
ravi permissions init agent:dev full-access      # All tools + executables
ravi permissions init agent:dev sdk-tools        # SDK tools only
ravi permissions init agent:dev safe-executables # Safe CLIs only

# Check permissions
ravi permissions check agent:dev execute group:contacts
ravi permissions list --subject agent:dev

# Sync from config
ravi permissions sync
```

**Relation types:** `admin`, `use` (tools), `execute` (executables/groups), `access`/`modify` (sessions), `write_contacts`, `read_own_contacts`, `read_tagged_contacts`, `read_contact`

**Entity types:** `agent`, `system`, `group`, `session`, `contact`, `tool`, `executable`, `cron`, `trigger`, `outbound`, `team`

### Emoji Reactions

```bash
ravi react send <messageId> 👍       # React to a message
```

Messages include `[mid:ID]` tags for reaction targeting.

## Configuration

### Router (`~/ravi/ravi.db`)

Configuration is stored in SQLite and managed via CLI:

```bash
# Agents
ravi agents list
ravi agents create assistant ~/ravi/assistant
ravi agents set main model sonnet
ravi agents set main dmScope main
ravi agents debounce main 2000

# Routes
ravi routes list
ravi routes add "+5511*" assistant
ravi routes set "+5511*" priority 10

# Settings
ravi settings list
ravi settings set defaultAgent main
ravi settings set defaultDmScope per-peer
ravi settings set defaultTimezone America/Sao_Paulo
```

### Agent Options

| Option | Description |
|--------|-------------|
| `cwd` | Working directory with CLAUDE.md and tools |
| `model` | Model to use (sonnet, opus, haiku) |
| `mode` | Operating mode: `active` (responds) or `sentinel` (observes silently) |
| `dmScope` | How to group DM sessions |
| `debounceMs` | Message grouping window in ms |
| `matrixAccount` | Matrix account username (for multi-account) |
| `contactScope` | Contact visibility: `own`, `tagged:<tag>`, `all` |

### DM Scopes

| Scope | Session Key | Use Case |
|-------|-------------|----------|
| `main` | `agent:X:main` | Shared context for all DMs |
| `per-peer` | `agent:X:dm:PHONE` | Isolated per contact |
| `per-channel-peer` | `agent:X:wa:dm:PHONE` | Isolated per channel+contact |

## Architecture

```
                                    ┌──────────────┐  ┌──────────────┐
                                    │   pgserve    │  │    notifd     │
                                    │  :8432 (PG)  │  │ :8080 (NATS) │
                                    └──────┬───────┘  └──────┬───────┘
                                           └───────┬─────────┘
┌─────────────┐                              ┌─────┴─────────────────┐
│    TUI      │──────────────────────────────│       notif.sh        │
└─────────────┘                              │  ravi.{sessionKey}.*  │
                                             └───────────┬───────────┘
┌─────────────┐     ┌─────────────┐                      │
│  WhatsApp   │────▶│   Gateway   │──────────────────────┤
│   Plugin    │     │  (router)   │                      │
└─────────────┘     └─────────────┘                      │
┌─────────────┐            │                             │
│   Matrix    │────────────┘                             │
│   Plugin    │                                          ▼
└─────────────┘                              ┌───────────────────────┐
                                             │       RaviBot         │
                                             │   Claude Agent SDK    │
                                             │   cwd: ~/ravi/{agent} │
                                             └───────────────────────┘
```

**Local Infrastructure:** The daemon auto-starts pgserve (embedded Postgres on :8432) and notifd (event bus on :8080 with embedded NATS). No external services needed -- API keys are bootstrapped on first run and stored in `~/.ravi/local-api-key`.

### Message Flow

1. **Inbound**: WhatsApp/Matrix → Gateway → notifd → Bot
2. **Processing**: Bot uses Claude SDK with agent's working directory
3. **Outbound**: Bot → notifd → Gateway → WhatsApp/Matrix

### Message Queue

When messages arrive while processing:

- **Tool running**: Queue message, wait for tool to finish, then interrupt
- **No tool running**: Interrupt immediately
- **Debounce active**: Group messages within time window

## File Structure

```
~/ravi/                    # Ravi data directory
├── ravi.db               # All config: agents, routes, sessions, contacts (SQLite)
└── main/                 # Agent working directory
    ├── CLAUDE.md         # Agent instructions
    ├── HEARTBEAT.md      # Pending tasks for heartbeat (optional)
    └── ...               # Agent-specific files

~/.ravi/                  # Ravi config directory
├── .env                  # Environment variables
├── local-api-key         # Auto-generated notifd API key
├── bin/
│   └── notifd            # notifd binary (auto-downloaded)
├── pgserve/              # Embedded Postgres data
├── nats/                 # Embedded NATS JetStream store
├── chat.db               # Message history
├── matrix/               # Matrix SDK storage
└── logs/
    └── daemon.log        # Daemon logs
```

## Development

```bash
bun run build    # Compile TypeScript
bun run dev      # Watch mode
make quality     # Run lint + typecheck
```

## Troubleshooting

### Daemon won't start

```bash
ravi daemon logs   # Check for errors
ravi daemon env    # Verify Claude auth is set
```

If notifd fails to start, check that ports 8080 and 8432 are free:
```bash
lsof -i :8080
lsof -i :8432
```

### WhatsApp not connecting

```bash
ravi whatsapp status                  # Check current state
rm -rf ~/.ravi/whatsapp-auth          # Reset auth, get new QR
ravi daemon restart
```

### Messages not being processed

```bash
# Check bot is running
ravi daemon status

# Check notifd connection
RAVI_LOG_LEVEL=debug ravi daemon restart
```

### Reset local infrastructure

```bash
ravi daemon stop
rm -rf ~/.ravi/pgserve ~/.ravi/nats ~/.ravi/local-api-key
ravi daemon start   # Will re-bootstrap
```

## License

MIT
