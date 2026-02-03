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
ravi.{sessionKey}.tool      # Tool execution events (start/end)
```

- **prompt**: `{ prompt, source: { channel, accountId, chatId } }`
- **response**: `{ response, target: { channel, accountId, chatId } }`
- **claude**: Raw SDK events (used for typing heartbeat)
- **tool**: `{ event: "start"|"end", toolId, toolName, input?, output?, isError?, durationMs?, timestamp, sessionKey, agentId }`

## Session Keys

```
agent:main:main                          # Shared session (TUI + WA + Matrix)
agent:main:dm:5511999999999              # Per-peer session (WhatsApp)
agent:main:matrix:dm:@user:server        # Per-peer session (Matrix)
agent:jarvis:main                        # Different agent
agent:main:whatsapp:group:123456         # WhatsApp group session
agent:main:matrix:room:!roomid:server    # Matrix room session
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

## Heartbeat

Proactive agent runs that check pending tasks in `HEARTBEAT.md`:

```bash
# Enable heartbeat (runs every 30 minutes)
ravi heartbeat enable main 30m

# Disable
ravi heartbeat disable main

# Configure
ravi heartbeat set main interval 1h           # Change interval
ravi heartbeat set main model haiku           # Use cheaper model
ravi heartbeat set main active-hours 09:00-22:00  # Only run during these hours

# Manual trigger
ravi heartbeat trigger main

# Status
ravi heartbeat status   # All agents
ravi heartbeat show main
```

**How it works:**
1. Timer fires at configured interval
2. Reads `~/ravi/{agent}/HEARTBEAT.md`
3. Sends prompt to agent session
4. If agent responds with only `HEARTBEAT_OK`, message is suppressed
5. Otherwise, response is routed to the channel

**HEARTBEAT.md example:**
```markdown
# Tarefas Pendentes

- Lembre o Luis sobre a reunião às 15h
- Verifique o status do deploy
```

**Triggers:**
- `interval` - Timer-based (configurable)
- `tool-complete` - After agent finishes using a tool (with 30s cooldown)
- `manual` - Via `ravi heartbeat trigger`

## Cron Jobs

Scheduled jobs that send prompts to agents at specified times:

```bash
# List all jobs
ravi cron list

# Add job with cron expression (runs daily at 9am)
ravi cron add "Daily Report" --cron "0 9 * * *" --message "Generate daily summary"

# Add job with interval (runs every 30 minutes)
ravi cron add "Check emails" --every 30m --message "Check for new emails"

# Add one-shot job (runs once at specific time)
ravi cron add "Reminder" --at "2025-02-01T15:00" --message "Meeting in 10 min"

# Show job details
ravi cron show <id>

# Enable/disable
ravi cron enable <id>
ravi cron disable <id>

# Edit job properties
ravi cron set <id> name "New Name"
ravi cron set <id> message "New message"
ravi cron set <id> cron "0 10 * * *"
ravi cron set <id> every 1h
ravi cron set <id> tz America/Sao_Paulo
ravi cron set <id> agent jarvis
ravi cron set <id> session isolated
ravi cron set <id> delete-after true

# Manual run (ignores schedule)
ravi cron run <id>

# Delete
ravi cron rm <id>
```

**Schedule Types:**
- `--cron "0 9 * * *"` - Standard cron expression (with optional `--tz` for timezone)
- `--every 30m` - Interval (supports: `30s`, `5m`, `1h`, `2d`)
- `--at "2025-02-01T15:00"` - One-shot at specific ISO datetime

**Options:**
- `--message <text>` - Prompt to send (required)
- `--agent <id>` - Target agent (default: default agent)
- `--isolated` - Run in isolated session instead of main
- `--delete-after` - Delete job after first successful run
- `--description <text>` - Job description
- `--tz <timezone>` - Timezone for cron expressions (default: from settings)

**Session Targets:**
- `main` - Shared session with TUI/WhatsApp/Matrix (default)
- `isolated` - Dedicated session per job (`agent:{agentId}:cron:{jobId}`)

**How it works:**
1. Daemon arms a timer for the next due job
2. When timer fires, job's message is emitted to the agent session
3. For isolated sessions, agent can use `cross_send` to deliver responses
4. Next run time is calculated (with anti-drift for intervals)
5. One-shot jobs (`--at`) are deleted after execution

## Router (`~/ravi/ravi.db`)

Configuration is stored in SQLite and managed via CLI:

```bash
# Agents
ravi agents list
ravi agents set main dmScope main
ravi agents debounce main 2000

# Routes
ravi routes list
ravi routes add "lid:178035101794451" main

# Settings
ravi settings set defaultAgent main
ravi settings set defaultDmScope per-peer
ravi settings set defaultTimezone America/Sao_Paulo
```

**Agent Config:**
- `cwd` - Working directory (CLAUDE.md, tools, etc)
- `model` - Model override (default: sonnet)
- `dmScope` - Session grouping for DMs
- `debounceMs` - Message grouping window
- `allowedTools` - Tool whitelist (undefined = all tools)
- `matrixAccount` - Matrix account username (for multi-account)

**DM Scopes:**
- `main` - All DMs share one session
- `per-peer` - Isolated by contact
- `per-channel-peer` - Isolated by channel+contact
- `per-account-channel-peer` - Full isolation

**Global Settings:**
- `defaultAgent` - Default agent when no route matches
- `defaultDmScope` - Default DM scope for new agents
- `defaultTimezone` - Default timezone for cron jobs (e.g., `America/Sao_Paulo`)
- `whatsapp.groupPolicy` - Group policy: `open`, `allowlist`, `closed`
- `whatsapp.dmPolicy` - DM policy: `open`, `pairing`, `closed`

**Agent Resolution:**

Messages are routed to agents in this priority order:
1. Contact's assigned agent (from contacts DB)
2. Route match (from routes table)
3. AccountId-as-agent (if accountId matches an existing agent ID)
4. Default agent

The accountId-as-agent feature allows Matrix multi-account setups where each Matrix account maps directly to an agent with the same ID.

## Storage

```
~/ravi/
├── ravi.db          # Config and sessions (SQLite)
└── main/            # Agent CWD
    ├── CLAUDE.md    # Agent instructions
    └── HEARTBEAT.md # Pending tasks for heartbeat (optional)

~/.ravi/
├── .env             # Environment variables (loaded by daemon)
├── chat.db          # Message history
├── matrix/          # Matrix SDK storage (sync, crypto)
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
ravi daemon logs       # Show last 50 lines
ravi daemon logs -f    # Follow mode (tail -f)
ravi daemon logs -t 100  # Show last 100 lines
ravi daemon logs --clear # Clear log file
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

# Matrix
ravi matrix login        # Interactive login
ravi matrix status       # Show connection status
ravi matrix logout       # Clear credentials
ravi matrix rooms        # List joined rooms
ravi matrix whoami       # Show current identity

# Cross-session messaging
ravi cross send <session> <message>  # Send message to another session
ravi cross list                      # List sessions with channel info

# Heartbeat
ravi heartbeat status                # Show all agents
ravi heartbeat show <id>             # Show config
ravi heartbeat enable <id> [interval]  # Enable (e.g., 30m, 1h)
ravi heartbeat disable <id>          # Disable
ravi heartbeat set <id> <key> <value>  # Set property
ravi heartbeat trigger <id>          # Manual trigger

# Cron jobs
ravi cron list                       # List all jobs
ravi cron show <id>                  # Show job details
ravi cron add <name> [options]       # Add new job
ravi cron enable <id>                # Enable job
ravi cron disable <id>               # Disable job
ravi cron set <id> <key> <value>     # Set property
ravi cron run <id>                   # Manual trigger
ravi cron rm <id>                    # Delete job
```

## Testing Agents

Use the CLI to interact with agents directly (daemon must be running):

```bash
# Send a single prompt
ravi agents run test "lista os agentes"
ravi agents run main "oi, tudo bem?"

# Interactive chat mode
ravi agents chat test
# Commands: /reset, /session, /exit

# Check session status
ravi agents session test

# Reset session (clear context)
ravi agents reset test
```

The `test` agent is pre-configured with all tools enabled (SDK + MCP CLI tools).

### MCP CLI Tools

Agents can use CLI commands as MCP tools. Tool naming convention:

```
mcp__ravi-cli__agents_list      # ravi agents list
mcp__ravi-cli__agents_show      # ravi agents show <id>
mcp__ravi-cli__contacts_list    # ravi contacts list
```

Manage agent tools:

```bash
ravi agents tools test              # List tools with status
ravi agents tools test init all     # Enable all tools
ravi agents tools test allow Bash   # Enable specific tool
ravi agents tools test deny Bash    # Disable specific tool
ravi agents tools test clear        # Bypass mode (all allowed)
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

# Matrix (optional)
MATRIX_HOMESERVER=https://matrix.org
MATRIX_ACCESS_TOKEN=syt_xxx   # Or use ravi matrix login
MATRIX_ENCRYPTION=false       # Enable E2EE (requires native deps)
MATRIX_DM_POLICY=open         # open | closed | pairing
MATRIX_ROOM_POLICY=closed     # open | closed | allowlist
MATRIX_ROOM_ALLOWLIST=!room1:server,#alias:server
```

## Cross-Session Messaging

Agents can send typed messages to other sessions using CLI tools:

```bash
# From CLI
ravi cross send agent:main:dm:5511999 send "Lembrete: reunião em 10 minutos"

# From agent (via MCP tool)
mcp__ravi-cli__cross_send agent:main:dm:5511999 send "Mensagem do agente"
```

**Message Types:**

| Type | Prefix | Behavior |
|------|--------|----------|
| `send` | `[System] Send:` | Agent responds with ONLY the message, adding nothing |
| `contextualize` | `[System] Context:` | Agent remembers the info, no tools. Replies with short text or `@@SILENT@@` |
| `execute` | `[System] Execute:` | Agent performs the task using tools, responds with result |
| `ask` | `[System] Ask:` | Asks another agent a question. Includes `[from: <session>]` |
| `answer` | `[System] Answer:` | Delivers a response to a previous `ask`. Includes `[from: <session>]` |

**Ask/Answer flow:**
1. Agent A: `cross_send(sessionB, "ask", "qual o status do deploy?")`
2. Agent B receives `[System] Ask: [from: sessionA] qual o status do deploy?`
3. Agent B: `cross_send(sessionA, "answer", "deploy concluído com sucesso")`
4. Agent A receives `[System] Answer: [from: sessionB] deploy concluído com sucesso` — can use tools and respond normally

## Notif Singleton

All components share a single notif.sh WebSocket connection via `src/notif.ts`:

```typescript
import { notif } from "./notif.js";

await notif.emit("topic", { data });
for await (const event of notif.subscribe("topic.*")) { ... }
```

Connection is shared across bot, gateway, plugins, and CLI. Closes automatically when process exits.

## Matrix Integration

### Setup

```bash
# Option 1: Interactive login
ravi matrix login

# Option 2: Environment variables
export MATRIX_HOMESERVER=https://matrix.org
export MATRIX_ACCESS_TOKEN=syt_xxx

# Restart daemon to pick up changes
ravi daemon restart
```

### Configuration

Matrix is configured via environment variables in `~/.ravi/.env`:

| Variable | Description | Default |
|----------|-------------|---------|
| `MATRIX_HOMESERVER` | Homeserver URL | (required) |
| `MATRIX_ACCESS_TOKEN` | Access token | (from login) |
| `MATRIX_USER_ID` | User ID (optional with token) | - |
| `MATRIX_PASSWORD` | Password (if using password auth) | - |
| `MATRIX_ENCRYPTION` | Enable E2EE | `false` |
| `MATRIX_DM_POLICY` | DM policy: `open`, `closed`, `pairing` | `open` |
| `MATRIX_ROOM_POLICY` | Room policy: `open`, `closed`, `allowlist` | `closed` |
| `MATRIX_ROOM_ALLOWLIST` | Comma-separated room IDs/aliases | - |

### Policies

**DM Policy:**
- `open` - Accept messages from anyone
- `closed` - Reject all DMs
- `pairing` - Save as pending for approval

**Room Policy:**
- `open` - Accept messages from all rooms
- `closed` - Reject all room messages
- `allowlist` - Only accept from rooms in allowlist

### E2EE (Optional)

End-to-end encryption requires the native `@matrix-org/matrix-sdk-crypto-nodejs` module:

```bash
npm install @matrix-org/matrix-sdk-crypto-nodejs
```

Then set `MATRIX_ENCRYPTION=true` in environment.

### Message Flow

```
Matrix Room → room.message event
    ↓
MatrixGatewayAdapter.handleMessage
    ↓ (normalize → InboundMessage)
notif.emit("matrix.default.inbound")
    ↓
Gateway → format envelope, resolve session
    ↓
notif.emit("ravi.{sessionKey}.prompt")
    ↓
RaviBot → Claude
    ↓
notif.emit("ravi.{sessionKey}.response")
    ↓
Gateway → MatrixOutboundAdapter.send
    ↓
MatrixClient.sendMessage
```

## Development

```bash
npm run build     # Compile TypeScript
npm run dev       # Watch mode
npm link          # Make `ravi` available globally
```
