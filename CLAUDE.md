# Ravi Bot

Claude-powered bot with session routing via notif.sh.

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

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Setup environment
ravi daemon env   # Edit ~/.ravi/.env with API keys

# 3. Start daemon (bot + gateway)
ravi daemon start

# 4. Check status
ravi daemon status
ravi daemon logs
```

## Topics

```
ravi.{sessionKey}.prompt    # User message (with source)
ravi.{sessionKey}.response  # Bot response (with target) - streamed
ravi.{sessionKey}.claude    # SDK events (system, assistant, result)
```

- **prompt**: `{ prompt, source: { channel, accountId, chatId } }`
- **response**: `{ response, target: { channel, accountId, chatId } }`
- **claude**: Raw SDK events (used for typing heartbeat)

## Session Keys

```
agent:main:main                    # Shared session (TUI + WA)
agent:main:dm:5511999999999        # Per-peer session
agent:jarvis:main                  # Different agent
agent:main:whatsapp:group:123456   # Group session
```

## Message Queue

When a new message arrives while a session is active:

- **Tool running**: Message queued, waits for tool to finish, then interrupts
- **No tool**: Interrupts immediately

Multiple messages from different users can queue up. After interrupt, all queued messages are processed in order.

## Debounce

Group messages arriving within a time window:

```bash
ravi agents debounce main 2000   # 2 second window
ravi agents debounce main 0      # Disable
```

Messages within the window are combined with `\n\n` before processing.

## Router (`~/ravi/router.json`)

```json
{
  "agents": {
    "main": {
      "id": "main",
      "cwd": "~/ravi/main",
      "dmScope": "main",
      "debounceMs": 2000
    }
  },
  "routes": [
    { "pattern": "lid:178035101794451", "agent": "main", "dmScope": "main" }
  ],
  "defaultAgent": "main",
  "defaultDmScope": "per-peer"
}
```

**Agent Config:**
- `cwd` - Working directory (CLAUDE.md, tools, etc)
- `model` - Model override (default: sonnet)
- `dmScope` - Session grouping for DMs
- `debounceMs` - Message grouping window
- `allowedTools` - Tool whitelist (undefined = all tools)

**DM Scopes:**
- `main` - All DMs share one session
- `per-peer` - Isolated by contact
- `per-channel-peer` - Isolated by channel+contact
- `per-account-channel-peer` - Full isolation

## Storage

```
~/ravi/
├── router.json      # Routing config
├── sessions.db      # Session → SDK session mapping
└── main/            # Agent CWD (CLAUDE.md, tools, etc)

~/.ravi/
├── .env             # Environment variables (loaded by daemon)
├── chat.db          # Message history
└── logs/
    └── daemon.log   # Daemon logs
```

## CLI

```bash
# Daemon (recommended)
ravi daemon start      # Start bot + gateway as service
ravi daemon stop       # Stop daemon
ravi daemon restart    # Restart daemon
ravi daemon status     # Show status
ravi daemon logs       # Tail logs
ravi daemon env        # Edit ~/.ravi/.env

# Service (manual)
ravi service start     # Start bot server only
ravi service wa        # Start WhatsApp gateway only
ravi service tui       # Start TUI

# Agents
ravi agents list                    # List agents
ravi agents show <id>               # Show agent details
ravi agents create <id> <cwd>       # Create agent
ravi agents set <id> <key> <value>  # Set property
ravi agents debounce <id> <ms>      # Set debounce
ravi agents tools <id>              # Manage tools

# Contacts
ravi contacts list       # List contacts
ravi contacts add <phone>
ravi contacts pending    # Pending approvals
```

## Message Formatting

### Reply Context

When a message replies to another, the quoted message is included:

```
[Replying to João id:ABC123]
Texto da mensagem original
[/Replying]

[WhatsApp Grupo id:123@g.us 30/01/2026, 14:30] Maria: Minha resposta
```

### Audio Transcription

Voice messages and audio files are automatically transcribed using OpenAI Whisper:

```
[WhatsApp +5511999 30/01/2026, 14:30]
[Audio]
Transcript:
O texto transcrito do áudio aparece aqui
```

For audio files sent as documents:

```
[Audio: gravacao.mp3]
Transcript:
O texto transcrito do arquivo
```

Requires `OPENAI_API_KEY` in environment.

## Environment (~/.ravi/.env)

```bash
# Required
NOTIF_API_KEY=nsh_xxx
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxx

# Optional
OPENAI_API_KEY=sk-xxx   # For audio transcription
RAVI_MODEL=sonnet
RAVI_LOG_LEVEL=info     # debug | info | warn | error
```

## Development

```bash
npm run build     # Compile TypeScript
npm run dev       # Watch mode
npm link          # Make `ravi` available globally
```
