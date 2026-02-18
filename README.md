# Ravi Bot

A Claude-powered conversational bot with multi-channel messaging (WhatsApp, Telegram, Discord) via [omni](https://github.com/namastex/omni-v2), session routing, and message queuing. Runs entirely locally with embedded NATS JetStream for pub/sub.

## Features

- **Zero-Config Infrastructure** - Embedded nats-server (JetStream) + omni API server start automatically
- **Multi-Channel** - WhatsApp, Telegram, Discord via omni (no direct Baileys/SDKs)
- **Multi-Account Routing** - Map channel accounts to different agents, sentinel mode for observation
- **REBAC Permissions** - Fine-grained relation-based access control for tools, contacts, sessions
- **Session Management** - Named sessions with model/thinking overrides, ephemeral TTL, cross-session messaging
- **Message Queue** - Smart interruption handling when tools are running
- **Debounce** - Group rapid messages before processing
- **Heartbeat** - Proactive agent runs on schedule to check pending tasks
- **Cron Jobs** - Schedule prompts with cron expressions, intervals, or one-shot times
- **Event Triggers** - Subscribe to any NATS topic and fire agent prompts on events
- **Outbound Queues** - Automated outreach campaigns with follow-ups and qualification
- **Spec Mode** - Collaborative specification before implementation (explore, plan, then code)
- **Video Analysis** - Analyze YouTube URLs or local videos via Gemini
- **Audio Transcription** - Transcribe voice messages via OpenAI Whisper
- **Media Sending** - Send images, videos, audio, documents via any channel
- **Emoji Reactions** - Agents can react to messages with emojis
- **Contact Management** - Tags, notes, identities, merging, per-group tags, opt-out
- **WhatsApp Groups** - Create, manage members, settings, invite links
- **Multi-Agent** - Configure multiple agents with different capabilities and modes
- **Live Event Stream** - Real-time colored view of all NATS events
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
- Download the `nats-server` binary (local pub/sub + JetStream)
- Configure Claude authentication (API key or OAuth token)
- Create the default agent
- Install and start the daemon

Configure omni in `~/.ravi/.env`:

```bash
OMNI_DIR=/path/to/omni-v2          # Required for channel support
DATABASE_URL=postgresql://...       # PostgreSQL for omni
OMNI_API_PORT=8882                  # Default
```

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
ravi events stream   # Live event stream
```

## CLI Reference

### Daemon Management

```bash
ravi daemon start      # Start bot + omni + gateway
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
ravi whatsapp set --account vendas --agent main  # Change agent mapping
ravi whatsapp disconnect                 # Disconnect account
```

**Agent modes:**
- `active` (default) - Agent responds to messages normally
- `sentinel` - Agent observes silently, only sends when explicitly instructed via `ravi whatsapp dm send`

### WhatsApp DMs

```bash
ravi whatsapp dm send <contact> "message"            # Send DM
ravi whatsapp dm send <contact> "message" --account vendas
ravi whatsapp dm read <contact>                      # Read last 10 messages
ravi whatsapp dm read <contact> --last 20            # Read last 20
ravi whatsapp dm ack <contact> <messageId>           # Send read receipt (blue ticks)
```

Contacts can be referenced by phone, LID, or contact name.

### WhatsApp Group Management

```bash
ravi whatsapp group list                             # List groups
ravi whatsapp group info <groupId>                   # Group metadata + members
ravi whatsapp group create "Name" "phone1,phone2"    # Create group
ravi whatsapp group add <groupId> "phone1,phone2"    # Add participants
ravi whatsapp group remove <groupId> "phones"        # Remove participants
ravi whatsapp group promote <groupId> "phones"       # Promote to admin
ravi whatsapp group invite <groupId>                 # Get invite link
ravi whatsapp group join <code>                      # Join via invite
ravi whatsapp group leave <groupId>                  # Leave group
ravi whatsapp group rename <groupId> "New Name"      # Rename
```

### Session Management

```bash
# Listing
ravi sessions list                          # List all sessions
ravi sessions list --agent main             # Filter by agent
ravi sessions list --ephemeral              # Show only ephemeral

# Inspection
ravi sessions info <name>                   # Session details (tokens, model, channel)
ravi sessions read <name>                   # Read last 20 messages
ravi sessions read <name> -n 50            # Read last 50

# Modification
ravi sessions reset <name>                  # Reset session (fresh start)
ravi sessions delete <name>                 # Delete permanently
ravi sessions rename <name> <display>       # Set display name
ravi sessions set-model <name> opus         # Override model (sonnet/opus/haiku/clear)
ravi sessions set-thinking <name> verbose   # Set thinking (off/normal/verbose/clear)

# Ephemeral sessions (auto-delete after TTL)
ravi sessions set-ttl <name> 5h             # Expires in 5 hours
ravi sessions extend <name>                 # Extend by 5h (default)
ravi sessions keep <name>                   # Make permanent (remove TTL)

# Cross-session messaging
ravi sessions send <name> "prompt"          # Send prompt and stream response
ravi sessions send <name> -i               # Interactive chat mode
ravi sessions execute <name> "task"         # Send execute task
ravi sessions ask <name> "question"         # Ask another session
ravi sessions answer <name> "reply"         # Reply to a previous ask
ravi sessions inform <name> "info"          # Send context info
```

### Agent Configuration

```bash
ravi agents list                      # List all agents
ravi agents show main                 # Show agent details
ravi agents create mybot ~/ravi/mybot # Create new agent
ravi agents set main model opus       # Set model
ravi agents set main mode sentinel    # Set agent mode (active/sentinel)
ravi agents set main dmScope per-peer # Set DM scope
ravi agents debounce main 2000        # Set 2s debounce
ravi agents reset main                # Reset main session
ravi agents reset main all            # Reset ALL sessions
ravi agents spec-mode main true       # Enable spec mode
ravi agents debug main                # Show last turns (raw transcript)
```

### Testing Agents

Use these commands to interact with agents directly (daemon must be running):

```bash
# Send a single prompt
ravi agents run main "oi, tudo bem?"
ravi agents run main "lista os agentes"

# Interactive chat mode
ravi agents chat main
# Commands: /reset, /session, /exit

# Check session status
ravi agents session main

# Reset session (clear context)
ravi agents reset main                    # Reset main session
ravi agents reset main <sessionKey>       # Reset specific session
ravi agents reset main all                # Reset ALL sessions
```

### Contacts

```bash
ravi contacts list                   # List approved contacts
ravi contacts add +5511999999999     # Add contact
ravi contacts approve <contact>      # Approve with optional reply mode
ravi contacts pending                # Show pending requests
ravi contacts info <contact>         # Show full details + identities
ravi contacts tag +55... lead        # Add tag
ravi contacts untag +55... lead      # Remove tag
ravi contacts find "João"            # Search by name/phone
ravi contacts find lead --tag        # Find by tag
ravi contacts set +55... email user@example.com
ravi contacts set +55... opt-out true
ravi contacts set +55... allowed-agents '["main","jarvis"]'

# Identity management
ravi contacts identity-add <contact> phone +5511...
ravi contacts identity-remove phone +5511...

# Merge contacts
ravi contacts merge <target> <source>
```

### REBAC Permissions

Fine-grained relation-based access control:

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
ravi triggers add "Contact Changed" \
  --topic "ravi.*.cli.contacts.*" \
  --message "Um contato foi modificado." \
  --cooldown 30s

ravi triggers list                   # List all triggers
ravi triggers show <id>              # Show details
ravi triggers enable <id>            # Enable
ravi triggers disable <id>           # Disable
ravi triggers set <id> <key> <value> # Edit property
ravi triggers test <id>              # Test with fake event
ravi triggers rm <id>                # Delete
```

**Options:** `--topic` (required), `--message` (required), `--agent`, `--cooldown` (default: 5s), `--session` (main/isolated, default: isolated)

### Outbound Queues (Automated Campaigns)

```bash
# Create queue
ravi outbound create "Prospecting" \
  --instructions "Reach out to this lead..." \
  --every 5m --agent main \
  --follow-up '{"cold":120,"warm":30}' \
  --max-rounds 3

# Manage queues
ravi outbound list                   # List queues
ravi outbound show <id>              # Queue details
ravi outbound start <id>             # Activate
ravi outbound pause <id>             # Pause
ravi outbound run <id>               # Manual trigger
ravi outbound rm <id>                # Delete queue

# Manage entries
ravi outbound add <queueId> +55... --name "João Silva"
ravi outbound add <queueId> +55... --tag leads       # Add all contacts with tag
ravi outbound entries <queueId>      # List entries
ravi outbound status <entryId>       # Entry details
ravi outbound qualify <id> warm      # Set qualification (cold/warm/interested/qualified/rejected)
ravi outbound context <id> '{"note":"Interested in X"}'  # Update entry context
ravi outbound reset <id>             # Reset to pending
ravi outbound reset <id> --full      # Reset and clear context
ravi outbound skip <id>              # Skip entry
ravi outbound done <id>              # Mark as done

# Chat history and reports
ravi outbound chat <entryId>         # View chat history
ravi outbound chat <entryId> --limit 20
ravi outbound report                 # Report for all queues
ravi outbound report <queueId>       # Report for specific queue

# Humanized send (used by agent during outbound session)
ravi outbound send <entryId> "Hello!" --typing-delay 2000 --pause 1000
```

### Video Analysis

Analyze videos using Google Gemini (YouTube URLs or local files):

```bash
ravi video analyze <url-or-path>                # Analyze video
ravi video analyze <url> -o output.md           # Custom output
ravi video analyze <url> -p "Focus on X"        # Custom prompt
```

Requires `GEMINI_API_KEY` in `~/.ravi/.env`.

### Audio Transcription

```bash
ravi transcribe file <path>           # Transcribe audio file
ravi transcribe file audio.ogg --lang pt  # Specify language
```

Requires `OPENAI_API_KEY` in `~/.ravi/.env`.

### Media Sending

```bash
ravi media send <filePath>                          # Send file (auto-detects type)
ravi media send photo.jpg --caption "Check this"    # With caption
ravi media send video.mp4 --channel telegram --to <chatId>
```

### Live Event Stream

```bash
ravi events stream                        # Stream all events
ravi events stream --filter "ravi.session.*"  # Filter by topic
ravi events stream --only prompt          # Only prompts
ravi events stream --only tool            # Only tool events
ravi events stream --no-claude            # Hide Claude SDK events
ravi events stream --no-heartbeat         # Hide heartbeat events
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
| `contactScope` | Contact visibility: `own`, `tagged:<tag>`, `all` |
| `settingSources` | Claude SDK setting sources (JSON array) |

### DM Scopes

| Scope | Session Key | Use Case |
|-------|-------------|----------|
| `main` | `agent:X:main` | Shared context for all DMs |
| `per-peer` | `agent:X:dm:PHONE` | Isolated per contact |
| `per-channel-peer` | `agent:X:wa:dm:PHONE` | Isolated per channel+contact |

### Spec Mode

Collaborative specification before implementation:

```bash
ravi agents spec-mode main true    # Enable
ravi agents spec-mode main false   # Disable
```

When enabled, agents get MCP tools (`enter_spec_mode`, `update_spec`, `exit_spec_mode`) to explore code, ask clarifying questions, and produce an approved spec before writing code. Destructive tools are blocked during spec mode.

Customize via `SPEC_INSTRUCTIONS.md` in the agent's CWD.

## Architecture

```
ravi daemon start
  ├── nats-server :4222 (JetStream)
  ├── omni API    :8882 (child process)
  │     ├── WhatsApp (Baileys)
  │     ├── Telegram
  │     └── Discord
  └── ravi bot
        ├── OmniConsumer  → subscribe JetStream message.received.>
        ├── Claude Agent SDK (sessions, tools)
        ├── OmniSender    → HTTP POST /api/v2/messages/send
        └── Runners (cron, heartbeat, triggers, outbound)
```

**Message flow:**

```
[WhatsApp / Telegram / Discord]
    → omni API
    → NATS JetStream (stream: MESSAGE)
    → OmniConsumer (pull consumer, ACK explicit)
    → ravi.{sessionKey}.prompt
    → RaviBot (Claude SDK)
    → ravi.{sessionKey}.response
    → Gateway
    → OmniSender (HTTP)
    → omni API
    → [WhatsApp / Telegram / Discord]
```

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
    └── SPEC_INSTRUCTIONS.md  # Custom spec mode instructions (optional)

~/.ravi/                  # Ravi config directory
├── .env                  # Environment variables
├── omni-api-key          # Auto-generated omni API key
├── jetstream/            # NATS JetStream storage
├── bin/
│   └── nats-server       # nats-server binary (auto-downloaded)
└── logs/
    └── daemon.log        # Daemon logs
```

## Environment (~/.ravi/.env)

```bash
# Required
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxx
# or
ANTHROPIC_API_KEY=sk-ant-xxx

# Omni (required for channel support)
OMNI_DIR=/path/to/omni-v2
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/omni
OMNI_API_PORT=8882          # Default

# Optional
OPENAI_API_KEY=sk-xxx       # For audio transcription
GEMINI_API_KEY=AIza...      # For video analysis
RAVI_MODEL=sonnet
RAVI_LOG_LEVEL=info         # debug | info | warn | error
NATS_PORT=4222              # Default
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

If nats-server fails to start, the daemon auto-recovers by clearing JetStream storage and retrying.

### WhatsApp not connecting

```bash
ravi whatsapp status      # Check current state
ravi whatsapp connect     # Reconnect (shows QR if needed)
ravi daemon logs          # Check omni logs
```

### Messages not being processed

```bash
ravi daemon status                    # Check bot is running
ravi events stream --only prompt      # Watch for incoming prompts
RAVI_LOG_LEVEL=debug ravi daemon restart
```

### Reset local infrastructure

```bash
ravi daemon stop
ravi daemon start   # Will re-bootstrap
```

## License

MIT
