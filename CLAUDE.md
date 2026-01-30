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

## Router (`~/ravi/router.json`)

```json
{
  "agents": {
    "main": {
      "id": "main",
      "cwd": "~/ravi/main",
      "dmScope": "main"
    }
  },
  "routes": [
    { "pattern": "lid:178035101794451", "agent": "main", "dmScope": "main" }
  ],
  "defaultAgent": "main",
  "defaultDmScope": "per-peer"
}
```

**DM Scopes:**
- `main` - All DMs share one session: `agent:X:main`
- `per-peer` - Isolated by contact: `agent:X:dm:PHONE`
- `per-channel-peer` - Isolated by channel+contact
- `per-account-channel-peer` - Full isolation

## Storage

```
~/ravi/
├── router.json      # Routing config
├── sessions.db      # Session → SDK session mapping
└── main/            # Agent CWD (CLAUDE.md, tools, etc)

~/.ravi/
└── chat.db          # Message history
```

## CLI

```bash
ravi --help                # Show all commands
ravi contacts list         # List contacts
ravi contacts add <phone>  # Add contact
ravi contacts pending      # Pending approvals
ravi service start         # Start bot server
ravi service tui           # Start TUI
ravi service wa            # Start WhatsApp gateway
```

Setup: `npm link` (once, to make `ravi` available globally)

## Environment

- `ANTHROPIC_API_KEY`: API key
- `RAVI_MODEL`: Model (default: sonnet)
- `RAVI_LOG_LEVEL`: debug | info | warn | error
