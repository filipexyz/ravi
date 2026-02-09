# Ravi Bot

A Claude-powered conversational bot with WhatsApp and Matrix integration, session routing, and message queuing.

## Features

- **WhatsApp Integration** - Connect via Baileys (no API keys needed)
- **Matrix Integration** - Connect to any Matrix homeserver
- **Session Routing** - Route conversations to different agents based on rules
- **Message Queue** - Smart interruption handling when tools are running
- **Debounce** - Group rapid messages before processing
- **Heartbeat** - Proactive agent runs on schedule to check pending tasks
- **Cron Jobs** - Schedule prompts with cron expressions, intervals, or one-shot times
- **Event Triggers** - Subscribe to any notif topic and fire agent prompts on events
- **Outbound Queues** - Automated outreach campaigns with follow-ups and qualification
- **Emoji Reactions** - Agents can react to messages with emojis
- **Media Downloads** - Images, videos, documents saved to /tmp with paths in prompts
- **Bash Permissions** - Control which CLI commands agents can execute
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

### 1. Configure Environment

```bash
ravi daemon env
```

Add your API keys to `~/.ravi/.env`:

```bash
NOTIF_API_KEY=nsh_xxx           # Get from notif.sh
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxx  # From claude auth
```

### 2. Start the Daemon

```bash
ravi daemon start
```

This starts both the bot server and WhatsApp gateway as a background service.

### 3. Connect WhatsApp

On first run, scan the QR code in the terminal to link your WhatsApp.

### 4. Monitor

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

### Agent Configuration

```bash
ravi agents list                      # List all agents
ravi agents show main                 # Show agent details
ravi agents create mybot ~/ravi/mybot # Create new agent
ravi agents set main model opus       # Set model
ravi agents debounce main 2000        # Set 2s debounce
ravi agents tools main                # Manage tool whitelist
ravi agents bash main                 # Manage bash permissions
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

### Bash Permissions (Agent Security)

```bash
ravi agents bash main                # Show current config
ravi agents bash main init           # Init denylist (block dangerous CLIs)
ravi agents bash main init strict    # Init allowlist (only safe CLIs)
ravi agents bash main allow curl     # Add to allowlist
ravi agents bash main deny rm        # Add to denylist
ravi agents bash main clear          # Reset to bypass mode
```

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
| `dmScope` | How to group DM sessions |
| `debounceMs` | Message grouping window in ms |
| `allowedTools` | Whitelist of allowed tools |
| `bashConfig` | Bash CLI permissions (bypass/allowlist/denylist) |

### DM Scopes

| Scope | Session Key | Use Case |
|-------|-------------|----------|
| `main` | `agent:X:main` | Shared context for all DMs |
| `per-peer` | `agent:X:dm:PHONE` | Isolated per contact |
| `per-channel-peer` | `agent:X:wa:dm:PHONE` | Isolated per channel+contact |

## Architecture

```
┌─────────────┐                              ┌───────────────────────┐
│    TUI      │──────────────────────────────│       notif.sh        │
└─────────────┘                              │  ravi.{sessionKey}.*  │
                                             └───────────┬───────────┘
┌─────────────┐     ┌─────────────┐                      │
│  WhatsApp   │────▶│   Gateway   │──────────────────────┤
│   Plugin    │     │  (router)   │                      │
└─────────────┘     └─────────────┘                      ▼
                                             ┌───────────────────────┐
                                             │       RaviBot         │
                                             │   Claude Agent SDK    │
                                             │   cwd: ~/ravi/{agent} │
                                             └───────────────────────┘
```

### Message Flow

1. **Inbound**: WhatsApp → Gateway → notif.sh → Bot
2. **Processing**: Bot uses Claude SDK with agent's working directory
3. **Outbound**: Bot → notif.sh → Gateway → WhatsApp

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
ravi daemon env    # Verify API keys are set
```

### WhatsApp not connecting

Delete the auth folder and restart to get a new QR code:

```bash
rm -rf ~/.ravi/whatsapp-auth
ravi daemon restart
```

### Messages not being processed

```bash
# Check bot is running
ravi daemon status

# Check notif.sh connection
RAVI_LOG_LEVEL=debug ravi daemon restart
```

## License

MIT
