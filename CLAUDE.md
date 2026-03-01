# Ravi Bot

The daemon that gives Claude a life. Multi-channel messaging (WhatsApp, Telegram, Discord) via omni-v2, running entirely locally with embedded NATS JetStream and omni API server as child processes.

## Architecture

```
ravi daemon start
  ├── nats-server :4222 (JetStream)
  ├── omni API    :8882 (child process bun)
  │     ├── WhatsApp (Baileys)
  │     ├── Telegram
  │     └── Discord
  └── ravi bot
        ├── OmniConsumer  → JetStream pull consumer (message.received.>)
        ├── Claude Agent SDK (sessions, tools)
        ├── OmniSender    → HTTP POST /api/v2/messages/send
        └── Runners (cron, heartbeat, triggers, outbound)
```

**Infrastructure:** nats-server (JetStream enabled) and omni API server start automatically as child processes. The omni API key is bootstrapped on first run and stored in `~/.ravi/omni-api-key`. Configure omni in `~/.ravi/.env` via `OMNI_DIR`, `DATABASE_URL`, `OMNI_API_PORT`.

## Quick Start

```bash
# 1. Install dependencies
bun install

# 2. Run setup wizard (downloads nats-server, configures auth, creates agent)
ravi setup

# 3. Configure omni in ~/.ravi/.env:
# OMNI_DIR=/path/to/omni-v2
# DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/omni

# 4. Start daemon (nats-server + omni + bot + gateway)
ravi daemon start

# 5. Connect WhatsApp
ravi whatsapp connect

# 6. Check status
ravi daemon status
ravi daemon logs
```

## Topics

For full topic reference with payloads, see the **events** skill (`src/plugins/internal/ravi-system/skills/events/SKILL.md`).

**omni NATS subjects (JetStream stream: MESSAGE):**
- `message.received.{channelType}.{instanceId}` — inbound message
- `reaction.received.{channelType}.{instanceId}` — inbound reaction
- `instance.connected.{channelType}.{instanceId}` — account connected
- `instance.qr_code.{channelType}.{instanceId}` — QR code for pairing

## Session Keys

```
agent:main:main                       # Shared session (all DMs + CLI)
agent:main:dm:5511999999999           # Per-peer DM session
agent:jarvis:main                     # Different agent
agent:main:whatsapp:group:123456      # WhatsApp group session
agent:main:trigger:a1b2c3d4           # Event trigger session (isolated)
agent:main:cron:abc123                # Cron job session (isolated)
agent:main:outbound:queueId:phone     # Outbound campaign session
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
- `main` - Shared session (default)
- `isolated` - Dedicated session per job (`agent:{agentId}:cron:{jobId}`)

**How it works:**
1. Daemon arms a timer for the next due job
2. When timer fires, job's message is emitted to the agent session
3. For isolated sessions, agent can use `cross_send` to deliver responses
4. Next run time is calculated (with anti-drift for intervals)
5. One-shot jobs (`--at`) are deleted after execution

## Event Triggers

Event-driven triggers that subscribe to any NATS topic and fire agent prompts when events occur:

```bash
# List all triggers
ravi triggers list

# Add trigger: notify when outbound lead is qualified
ravi triggers add "Lead Qualificado" \
  --topic "ravi.*.cli.outbound.qualify" \
  --message "Um lead foi qualificado. Notifica o grupo do Slack e atualiza o CRM." \
  --agent main \
  --cooldown 30s

# Add trigger: alert on agent tool errors
ravi triggers add "Agent Error Alert" \
  --topic "ravi.*.tool" \
  --message "Um tool deu erro. Analise o que aconteceu e me avise se precisa de ação." \
  --agent main \
  --cooldown 1m

# Add trigger: log all contact changes
ravi triggers add "Contact Audit" \
  --topic "ravi.*.cli.contacts.*" \
  --message "Um contato foi modificado. Registre a mudança no log de auditoria." \
  --agent main \
  --session isolated

# Show trigger details
ravi triggers show <id>

# Enable/disable
ravi triggers enable <id>
ravi triggers disable <id>

# Update properties
ravi triggers set <id> name "New Name"
ravi triggers set <id> message "Nova instrução"
ravi triggers set <id> topic "ravi.*.cli.outbound.*"
ravi triggers set <id> agent jarvis
ravi triggers set <id> session main          # main or isolated
ravi triggers set <id> cooldown 30s          # supports: 5s, 30s, 1m, 5m, 1h

# Test trigger (fires with fake event data)
ravi triggers test <id>

# Delete
ravi triggers rm <id>
```

**Available Topics:**
- `ravi.*.cli.{group}.{command}` - CLI tool executions (e.g., `ravi.*.cli.contacts.add`)
- `ravi.*.tool` - SDK tool executions (Bash, Read, etc.)
- `message.received.{channelType}.{instanceId}` - Inbound channel messages (from omni)

**Blocked Topics (anti-loop):**
- `ravi.*.prompt` - Would create trigger→prompt→trigger loops
- `ravi.*.response` - Would create trigger→response self-fire loops
- `ravi.*.claude` - Internal SDK events, same risk

**Options:**
- `--topic <pattern>` - NATS topic pattern to subscribe to (required)
- `--message <text>` - Prompt to send when event fires (required)
- `--agent <id>` - Target agent (default: default agent)
- `--cooldown <duration>` - Minimum time between fires (default: 5s)
- `--session <type>` - `main` or `isolated` (default: isolated)

**Prompt Format (injected into agent):**
```
[Trigger: Lead Qualificado]
Topic: ravi.agent:main:main.cli.outbound.qualify
Data: {
  "event": "end",
  "tool": "outbound_qualify",
  "output": "✓ Qualification set: abc123 -> warm"
}

Um lead foi qualificado. Notifica o grupo do Slack e atualiza o CRM.
```

**Session Keys:**
- `isolated` (default): `agent:{agentId}:trigger:{triggerId}`
- `main`: `agent:{agentId}:main`

**Anti-Loop Protection:**
1. Blocked topics: `.prompt`, `.response`, `.claude` topics are rejected at subscription time
2. Session filter: events from trigger sessions (`:trigger:` in topic) are skipped
3. Data flag: events with `_trigger: true` are skipped
4. Cooldown: per-trigger cooldown (default 5s) prevents rapid re-firing

**How it works:**
1. Daemon starts TriggerRunner, which subscribes to all enabled trigger topics
2. When an event fires on a matching topic, runner builds a prompt with event data
3. Prompt is emitted to `ravi.{sessionKey}.prompt`
4. Agent processes normally (can use `cross_send`, CLI tools, etc.)
5. CLI mutations emit `ravi.triggers.refresh` to hot-reload subscriptions

All CLI commands are available as tools (`triggers_list`, `triggers_add`, etc.), so agents can self-configure triggers via conversation.

## Outbound Queues

Automated outreach campaigns with follow-ups and qualification tracking:

```bash
# Create a queue
ravi outbound create "Prospecting" \
  --instructions "Reach out to this lead..." \
  --every 5m \
  --agent main \
  --follow-up '{"cold":120,"warm":30}' \
  --max-rounds 3

# Add entries
ravi outbound add <queueId> <phone> --name "João Silva"
ravi outbound add <queueId> <phone> --name "Maria" --context '{"company":"Acme"}'
ravi outbound add <queueId> <phone> --tag leads  # Add all contacts with tag

# Manage queues
ravi outbound list                    # List all queues
ravi outbound show <id>               # Show queue details
ravi outbound start <id>              # Activate queue
ravi outbound pause <id>              # Pause queue
ravi outbound run <id>                # Manual trigger
ravi outbound rm <id>                 # Delete queue

# Manage entries
ravi outbound entries <queueId>       # List entries
ravi outbound status <entryId>        # Entry details
ravi outbound qualify <id> warm       # Set qualification
ravi outbound context <id> '{"note":"Interested in product X"}'
ravi outbound reset <id>              # Reset entry to pending
ravi outbound reset <id> --full       # Reset and clear context
ravi outbound skip <id>               # Skip entry
ravi outbound done <id>               # Mark as done

# Agent tools (used during outbound sessions)
ravi outbound send <entryId> "Hello!" --typing-delay 2000 --pause 1000

# View chat history
ravi outbound chat <entryId>
ravi outbound chat <entryId> --limit 10

# Full report
ravi outbound report                  # All queues
ravi outbound report <queueId>        # Specific queue
```

**Queue Options:**
- `--every <interval>` - Time between processing entries (5m, 1h, etc.)
- `--agent <id>` - Agent to process entries
- `--active-start/--active-end` - Active hours (e.g., 09:00-22:00)
- `--tz <timezone>` - Timezone for active hours
- `--follow-up <json>` - Delays per qualification (minutes): `{"cold":120,"warm":30}`
- `--max-rounds <n>` - Maximum rounds per entry

**Entry Fields:**
- `status` - pending, active, done, skipped, error
- `qualification` - cold, warm, interested, qualified, rejected
- `roundsCompleted` - Number of completed follow-up rounds
- `context` - JSON with name, company, and custom fields

**Humanized Delivery:**
- `--typing-delay <ms>` - Show typing indicator before sending
- `--pause <ms>` - Pause before typing (simulates reading)

**Session Keys:**
Outbound entries run in isolated sessions: `agent:{agentId}:outbound:{queueId}:{phone}`

## Router (`~/ravi/ravi.db`)

Configuration is stored in SQLite and managed via CLI:

```bash
# Agents
ravi agents list
ravi agents set main dmScope main
ravi agents debounce main 2000

# Routes
ravi routes list
ravi routes add "+5511*" main

# Settings
ravi settings set defaultAgent main
ravi settings set defaultDmScope per-peer
ravi settings set defaultTimezone America/Sao_Paulo
```

**Agent Config:**
- `cwd` - Working directory (CLAUDE.md, tools, etc)
- `model` - Model override (default: sonnet)
- `mode` - Operating mode: `active` (responds) or `sentinel` (observes silently)
- `dmScope` - Session grouping for DMs
- `debounceMs` - Message grouping window
- `contactScope` - Contact visibility: `own`, `tagged:<tag>`, `all`

**DM Scopes:**
- `main` - All DMs share one session
- `per-peer` - Isolated by contact
- `per-channel-peer` - Isolated by channel+contact
- `per-account-channel-peer` - Full isolation

**REBAC Permissions:**

Fine-grained relation-based access control for agents:

```bash
ravi permissions grant agent:dev use tool:Bash
ravi permissions grant agent:dev execute executable:git
ravi permissions grant agent:dev execute group:contacts
ravi permissions grant agent:dev access session:dev-*
ravi permissions revoke agent:dev use tool:Bash
ravi permissions check agent:dev execute group:contacts
ravi permissions list --subject agent:dev
ravi permissions init agent:dev full-access      # Template: all tools + executables
ravi permissions init agent:dev sdk-tools        # Template: SDK tools only
ravi permissions init agent:dev safe-executables # Template: safe CLIs only
ravi permissions sync                            # Re-sync from config
ravi permissions clear                           # Clear manual relations
```

**Relations:** `admin`, `use` (tools), `execute` (executables/CLI groups), `access`/`modify` (sessions), `write_contacts`, `read_own_contacts`, `read_tagged_contacts`, `read_contact`

**Entity types:** `agent`, `system`, `group`, `session`, `contact`, `tool`, `executable`, `cron`, `trigger`, `outbound`, `team`

**Enforcement:** New agents are closed-by-default (no permissions). Denied actions emit audit events to `ravi.audit.denied`.

**Global Settings:**
- `defaultAgent` - Default agent when no route matches
- `defaultDmScope` - Default DM scope for new agents
- `defaultTimezone` - Default timezone for cron jobs (e.g., `America/Sao_Paulo`)
- `whatsapp.groupPolicy` - Group policy: `open`, `allowlist`, `closed`
- `whatsapp.dmPolicy` - DM policy: `open`, `pairing`, `closed`

**Agent Resolution:**

Messages are routed to agents in this priority order:
1. Account-agent mapping (from `account.<id>.agent` setting)
2. Route match (from routes table, scoped to account)
3. Default agent (only for default account)

The account-agent mapping is set via `ravi whatsapp connect --agent <id>` or `ravi whatsapp set --account <id> --agent <id>`.

**Multi-Account:**

Connect multiple accounts (WhatsApp, Telegram), each mapped to a different agent:

```bash
ravi whatsapp connect --account vendas --agent vendas --mode active
ravi whatsapp connect --account suporte --agent suporte --mode sentinel
```

**Sentinel Mode:** Agents in sentinel mode observe messages silently without auto-replying. Useful for monitoring accounts where an agent only acts when instructed.

**Contact Fields:**
- `phone` - Normalized phone number (primary key)
- `name` - Contact name
- `email` - Email address
- `status` - allowed, pending, blocked, discovered
- `agent_id` - Assigned agent
- `reply_mode` - auto (default) or mention
- `tags` - JSON array of tags (e.g., `["lead", "vip"]`)
- `notes` - JSON object for custom data (e.g., `{"company": "Acme"}`)
- `opt_out` - Whether contact opted out
- `interaction_count` - Total interactions
- `last_inbound_at` - Last message received
- `last_outbound_at` - Last message sent

## Storage

```
~/ravi/
├── ravi.db          # Config and sessions (SQLite)
└── main/            # Agent CWD
    ├── CLAUDE.md    # Agent instructions
    ├── HEARTBEAT.md # Pending tasks for heartbeat (optional)
    └── SPEC_INSTRUCTIONS.md  # Custom spec mode instructions (optional)

~/.ravi/
├── .env             # Environment variables (loaded by daemon)
├── omni-api-key     # Auto-generated omni API key
├── jetstream/       # NATS JetStream storage
├── bin/
│   └── nats-server  # nats-server binary (auto-downloaded)
└── logs/
    └── daemon.log   # Daemon logs
```

## CLI

```bash
# Setup
ravi setup             # Interactive setup wizard

# Daemon (recommended)
ravi daemon start      # Start nats + omni + bot + gateway
ravi daemon stop       # Stop daemon
ravi daemon restart    # Restart daemon
ravi daemon status     # Show status
ravi daemon logs       # Show last 50 lines
ravi daemon logs -f    # Follow mode (tail -f)
ravi daemon logs -t 100  # Show last 100 lines
ravi daemon logs --clear # Clear log file
ravi daemon env        # Edit ~/.ravi/.env

# WhatsApp
ravi whatsapp connect                # Connect account (QR code)
ravi whatsapp connect --account <id> --agent <id> --mode sentinel
ravi whatsapp status                 # Show connection status
ravi whatsapp set --account <id> --agent <id>
ravi whatsapp disconnect             # Disconnect account

# Agents
ravi agents list                    # List agents
ravi agents show <id>               # Show agent details
ravi agents create <id> <cwd>       # Create agent
ravi agents set <id> <key> <value>  # Set property
ravi agents debounce <id> <ms>      # Set debounce
ravi agents run <id> "prompt"       # Send prompt and stream response
ravi agents chat <id>               # Interactive chat mode (/reset, /session, /exit)
ravi agents session <id>            # Check session status
ravi agents reset <id>              # Reset main session
ravi agents reset <id> <sessionKey> # Reset specific session
ravi agents reset <id> all          # Reset ALL sessions for agent

# Contacts
ravi contacts list                   # List contacts
ravi contacts add <phone> [name]     # Add/allow a contact
ravi contacts pending                # Pending approvals
ravi contacts check <phone>          # Show contact details
ravi contacts tag <phone> <tag>      # Add tag
ravi contacts untag <phone> <tag>    # Remove tag
ravi contacts find <query>           # Search by name/phone
ravi contacts find <tag> --tag       # Find by tag
ravi contacts set <phone> email <email>
ravi contacts set <phone> tags '["lead","vip"]'
ravi contacts set <phone> notes '{"company":"Acme"}'
ravi contacts set <phone> opt-out true

# Cross-session messaging
ravi sessions send <session> "prompt"   # Send prompt to session
ravi sessions send <session> -i         # Interactive mode
ravi sessions execute <session> "task"  # Execute task
ravi sessions ask <session> "question"  # Ask another session
ravi sessions answer <session> "reply"  # Reply to a previous ask
ravi sessions inform <session> "info"   # Send context info

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

# Event triggers
ravi triggers list                   # List all triggers
ravi triggers add <name> [options]   # Add new trigger
ravi triggers show <id>              # Show trigger details
ravi triggers enable <id>            # Enable trigger
ravi triggers disable <id>           # Disable trigger
ravi triggers set <id> <key> <value> # Set property
ravi triggers test <id>              # Test with fake event
ravi triggers rm <id>                # Delete trigger

# Outbound queues
ravi outbound list                   # List queues
ravi outbound create <name> [opts]   # Create queue
ravi outbound show <id>              # Queue details
ravi outbound start <id>             # Activate
ravi outbound pause <id>             # Pause
ravi outbound entries <id>           # List entries
ravi outbound add <queueId> <phone>  # Add entry
ravi outbound status <entryId>       # Entry details
ravi outbound run <id>               # Manual trigger
ravi outbound rm <id>                # Delete queue

# Permissions (REBAC)
ravi permissions grant <subject> <relation> <object>
ravi permissions revoke <subject> <relation> <object>
ravi permissions check <subject> <permission> <object>
ravi permissions list                # List all relations
ravi permissions init <subject> <template>  # Apply template
ravi permissions sync                # Re-sync from config
ravi permissions clear               # Clear manual relations

# Reactions
ravi react send <messageId> <emoji>  # Send emoji reaction
```

## Testing Agents

Use the CLI to interact with agents directly (daemon must be running):

```bash
# Send a single prompt
ravi agents run main "lista os agentes"
ravi agents run main "oi, tudo bem?"

# Interactive chat mode
ravi agents chat main
# Commands: /reset, /session, /exit

# Check session status
ravi agents session main

# Reset session (clear context)
ravi agents reset main                    # Reset main session
ravi agents reset main <sessionKey>       # Reset specific session
ravi agents reset main all                # Reset ALL sessions for agent
```

### CLI Tools

Agents can use CLI commands as tools via Bash. Tool naming convention:

```
agents_list      # ravi agents list
agents_show      # ravi agents show <id>
contacts_list    # ravi contacts list
```

Tool and executable access is controlled via REBAC permissions:

```bash
ravi permissions grant agent:main use tool:Bash          # Allow SDK tool
ravi permissions grant agent:main execute executable:git  # Allow CLI executable
ravi permissions grant agent:main execute group:contacts  # Allow CLI command group
ravi permissions init agent:main full-access              # All tools + executables
```

## Emoji Reactions

Agents can send emoji reactions to messages. Message envelopes include `[mid:ID]` tags:

```
[+5511999 mid:ABC123XYZ 30/01/2026, 14:30] João: Bom dia!
```

From CLI or agent tools:

```bash
ravi react send ABC123XYZ 👍
```

## Message Formatting

### Reply Context

When a message replies to another, the quoted message is included:

```
[Replying to João id:ABC123]
Texto da mensagem original
[/Replying]

[Grupo id:123@g.us 30/01/2026, 14:30] Maria: Minha resposta
```

### Audio Transcription

Voice messages and audio files are automatically transcribed using OpenAI Whisper:

```
[+5511999 30/01/2026, 14:30]
[Audio]
Transcript:
O texto transcrito do áudio aparece aqui
```

Requires `OPENAI_API_KEY` in environment.

### Media Downloads

Images, videos, documents, and stickers are downloaded to `/tmp/ravi-media/` and the local path is included in the prompt:

```
[+5511999 30/01/2026, 14:30]
[Image: /tmp/ravi-media/1706619000000-ABC123.jpg]
```

- Max file size: 20MB (larger files are skipped with a note)
- Supported types: images, videos, PDFs, documents, stickers
- Files are named: `{timestamp}-{messageId}.{ext}`

## Environment (~/.ravi/.env)

```bash
# Required (one of these)
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxx
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

## Cross-Session Messaging

Agents can send typed messages to other sessions using CLI tools:

```bash
ravi sessions send agent:main:dm:5511999 "Lembrete: reunião em 10 minutos"
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

## NATS JetStream Debugging

NATS runs on `:4222`. Use the `nats` CLI (`brew install nats-io/nats-tools/nats`) to inspect streams and replay messages.

### Connection shortcut

```bash
alias nats-local='nats --server nats://127.0.0.1:4222'
```

### Streams overview

```bash
nats stream ls --server nats://127.0.0.1:4222
```

Omni streams: `MESSAGE`, `INSTANCE`, `REACTION`, `MEDIA`, `ACCESS`, `IDENTITY`, `CUSTOM`, `SYSTEM`.

### Inspect a stream

```bash
nats stream info MESSAGE --server nats://127.0.0.1:4222
# Shows: subjects, retention, message count, consumer count, first/last seq
```

### Read messages from stream

```bash
# Last message on a subject pattern
nats stream get MESSAGE --server nats://127.0.0.1:4222 --last-for "message.received.>"

# Specific sequence number
nats stream get MESSAGE --server nats://127.0.0.1:4222 --seq 5

# Pretty-print the JSON payload
nats stream get MESSAGE --server nats://127.0.0.1:4222 --seq 5 | python3 -c "
import sys, json
raw = sys.stdin.read()
start = raw.find('{')
if start >= 0:
    d = json.loads(raw[start:])
    print('METADATA:', json.dumps(d.get('metadata', {}), indent=2))
    print('PAYLOAD:', json.dumps(d.get('payload', {}), indent=2))
"
```

### List / inspect consumers

```bash
# All consumers with their positions (ack floor = last processed seq)
nats consumer report MESSAGE --server nats://127.0.0.1:4222

# Ravi consumers
nats consumer report MESSAGE --server nats://127.0.0.1:4222 | grep ravi
nats consumer report INSTANCE --server nats://127.0.0.1:4222 | grep ravi
```

**Ravi consumer names:** `ravi-messages` (MESSAGE stream), `ravi-instances` (INSTANCE stream).

### Replay messages to ravi (debug)

Create a **temporary ephemeral consumer** that delivers from a specific sequence — useful to re-inject a message into the stream and watch ravi process it:

```bash
# Subscribe and receive all messages from seq 20 onwards (prints to terminal)
nats consumer sub MESSAGE \
  --server nats://127.0.0.1:4222 \
  --filter "message.received.>" \
  --deliver-start-sequence 20 \
  --ack

# Or deliver all messages from beginning
nats consumer sub MESSAGE \
  --server nats://127.0.0.1:4222 \
  --filter "message.received.>" \
  --deliver-all \
  --ack
```

To force ravi to **reprocess** a specific message, bump the ravi consumer's ack floor back:

```bash
# Delete ravi-messages consumer (ravi recreates it with DeliverPolicy.New on restart)
# WARNING: ravi won't get new messages until daemon restarts
nats consumer rm MESSAGE ravi-messages --server nats://127.0.0.1:4222
ravi daemon restart
```

### Live subscribe (plain pub/sub — no JetStream)

Watch events in real time as they arrive from omni:

```bash
# All message events
nats sub "message.received.>" --server nats://127.0.0.1:4222

# Specific instance
nats sub "message.received.whatsapp-baileys.d1458eb9-eec8-49b2-a7ad-d5f2ced8a280" \
  --server nats://127.0.0.1:4222

# Instance events (connect, disconnect, qr_code)
nats sub "instance.>" --server nats://127.0.0.1:4222
```

### Check if ingestMode is set correctly

After the history-sync fix, new messages should have `ingestMode: "realtime"` in metadata. History-sync messages get `ingestMode: "history-sync"` and are skipped by ravi.

```bash
# Inspect metadata of last received message
nats stream get MESSAGE --server nats://127.0.0.1:4222 --last-for "message.received.>" | \
  python3 -c "import sys,json; raw=sys.stdin.read(); d=json.loads(raw[raw.find('{'):]); print(d['metadata'].get('ingestMode','NOT SET'))"
```

## Development

```bash
bun run build     # Compile TypeScript
bun run dev       # Watch mode
bun link          # Make `ravi` available globally
make quality      # Run lint + typecheck
```

### When to restart the daemon

- **Restart required**: After `bun run build` (code changes need the new bundle)
- **NO restart needed**: After `ravi outbound reset`, `ravi outbound set`, `ravi outbound start/pause`, or any other CLI config command. The CLI writes directly to SQLite and emits refresh signals — the running daemon picks up changes automatically.
- **NO manual trigger needed**: Active queues process on their interval timer. `ravi outbound run` is only for one-off testing, not needed after reset/start.
