# Ravi Bot

A Claude-powered conversational bot with WhatsApp and Matrix integration, session routing, and message queuing.

## Features

- **WhatsApp Integration** - Connect via Baileys (no API keys needed)
- **Matrix Integration** - Connect to any Matrix homeserver
- **Session Routing** - Route conversations to different agents based on rules
- **Message Queue** - Smart interruption handling when tools are running
- **Debounce** - Group rapid messages before processing
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
```

### Contacts (WhatsApp)

```bash
ravi contacts list       # List approved contacts
ravi contacts add +5511999999999
ravi contacts pending    # Show pending requests
```

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
```

### Agent Options

| Option | Description |
|--------|-------------|
| `cwd` | Working directory with CLAUDE.md and tools |
| `model` | Model to use (sonnet, opus, haiku) |
| `dmScope` | How to group DM sessions |
| `debounceMs` | Message grouping window in ms |
| `allowedTools` | Whitelist of allowed tools |

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
