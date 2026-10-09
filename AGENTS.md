# Ravi Bot

The daemon that gives Claude a life. Ravi runs local agent sessions, native Slack channels, and legacy transport bridges with embedded NATS JetStream.

## Architecture

```
ravi daemon start
  ├── nats-server :4222 (JetStream)
  ├── legacy channel bridge :8882 (child process bun)
  │     ├── WhatsApp (Baileys)
  │     ├── Telegram
  │     └── Discord
  └── ravi bot
        ├── Native Slack adapter → Socket Mode, Web API, Canvas, files, threads
        ├── Channel consumer      → JetStream pull consumer (message.received.>)
        ├── Claude Agent SDK (sessions, tools)
        ├── Channel sender        → native Slack delivery + bridge delivery
        └── Runners (cron, heartbeat, triggers)
```

**Infrastructure:** nats-server starts automatically for local eventing. Slack runs through the native Ravi Slack adapter. Legacy transport bridges may also start as child processes for channels that have not moved to native adapters yet.

## Quick Start

```bash
# 1. Install dependencies
bun install

# 2. Run setup wizard (downloads nats-server, configures auth, creates agent)
ravi setup

# 3. Configure channel credentials in the Ravi credential broker / ~/.ravi/.env

# 4. Start daemon (nats-server + bot + gateway + configured channel adapters)
ravi daemon start

# 5. Connect WhatsApp
ravi whatsapp connect

# 6. Check status
ravi daemon status
ravi daemon logs
```

## Ravi Pages Publishing

Load the Pages skill first:

```bash
ravi skills show pages
```

Happy path is one command — `ravi pages ship`. Do not choreograph `create` + `publish`.
One project owns one default host (`<orgSlug>-<projectSlug>.ravi.page`). Pages are
routes on that host. `--title` is the page title and does not create a host.
List routes before choosing `--route`. Do not create one site per page.
Prefixes `ravi` and `ravi-*` are reserved and are not user-creatable.

```bash
ravi pages published --project <project> --json
ravi pages ship --project <project> --title "Weekly report" --route /weekly --body "<h1>OK</h1>" --json
ravi pages ship --title "Weekly report" --body "<h1>OK</h1>" --json
```

The command without `--route` publishes the project home `/` on the default host.
A positional slug is a legacy extra host, not the happy path.

`create` is host-only compatibility. `publish` is the advanced upload primitive
(including an existing local `art_*`). They stay available; the agent happy
path is `ravi pages ship`, not `artifacts publish`.

```bash
ravi pages create <project-ref> <site-slug> --visibility public
ravi pages publish <project-ref> <site-slug> <artifact-id> --route / --visibility public
```

`ship` executes immediately. Leftover `--execute` on `ship` is ignored.
`create`, `publish`, domain binding, password changes, and switching a site
to public visibility are dry-run by default (exit 3): re-run with `--execute`.

Change who can reach an already-published route without re-uploading files:

```bash
ravi pages visibility <site-slug> public --execute
ravi pages visibility <site-slug> public --route / --execute
```

Without `--route`, only site `defaultVisibility` changes. With `--route /`
(or `/foo`), only that route's policy changes. Success output reports the
effective visibility.

Protect an active route with a password without republishing its bytes:

```bash
ravi pages password set <project-ref> <site-slug> --route / --execute
ravi pages password status <project-ref> <site-slug> --route / --json
ravi pages password remove <project-ref> <site-slug> --route / --visibility private --execute
```

`password set` prompts invisibly and confirms by default. Non-interactive
automation must use `--stdin` with redirected input. Never put the password in
an argument, environment variable, log, or JSON payload outside the command's
authenticated HTTPS request body.

## Bases and Pages

Bases are typed tables of a Console project (`ravi bases`); the screen over them
is a Ravi Page that reads a view. To build a solution (a screen, intake from a
channel, an approval, an automation), start with the `solucoes` skill; syntax
lives in the `bases` and `pages` skills.

```bash
ravi skills show solucoes   # who sees what, the six-verb sheet, the eight rules
ravi skills show bases      # schema, views as access contracts, rows, row events
ravi skills show pages      # ship, host-wide --uses, data pages
```

- Live data pages are for signed-in org members, on `private` or `protected_link` routes. Outsiders use a channel and get messages or snapshots. `ravi pages ship` refuses `ravi.bases.*` in `--uses` on a public route unless `--members-best-effort` is passed on purpose.
- `--uses` covers the whole host: every ship lists the union of the ids all data pages on that host call.
- Row changes arrive as `ravi.console.inbox.item` (`category: "bases"`) after `ravi bases subscribe <base>`. A trigger whose agent writes the same base filters `data.actor.type == "user"`.

## Topics

For full topic reference with payloads, see the **events** skill (`src/plugins/internal/ravi-system/skills/events/SKILL.md`).

**Legacy bridge NATS subjects (JetStream stream: MESSAGE):**
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
ravi heartbeat trigger main --execute

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
- `manual` - Via `ravi heartbeat trigger <id> --execute` when work is pending

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
ravi cron run <id> --execute

# Delete
ravi cron rm <id> --execute
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
6. `lastStatus`/`lastError` are recorded from the agent turn outcome (`turn.complete` → `ok`, `turn.failed`/`turn.interrupted` → `error`), not from the prompt dispatch

## Event Triggers

Event-driven triggers that subscribe to any NATS topic and fire agent prompts when events occur:

```bash
# List all triggers
ravi triggers list

# Add trigger: notify when contacts change
ravi triggers add "Contato alterado" \
  --topic "ravi.*.cli.contacts.*" \
  --message "Um contato foi alterado. Notifica o grupo do Slack e atualiza o CRM." \
  --agent main \
  --cooldown 30s

# Add trigger: alert on permission denials
ravi triggers add "Permission Alert" \
  --topic "ravi.audit.denied" \
  --message "Uma permissão foi negada. Analise o que aconteceu e me avise se precisa de ação." \
  --agent main \
  --cooldown 1m

# Add trigger: log all contact changes
ravi triggers add "Contact Audit" \
  --topic "ravi.*.cli.contacts.*" \
  --message "Um contato foi modificado. Registre a mudança no log de auditoria." \
  --agent main \
  --session contact-audit

# Show trigger details
ravi triggers show <id>

# Enable/disable
ravi triggers enable <id>
ravi triggers disable <id>

# Update properties
ravi triggers set <id> name "New Name"
ravi triggers set <id> message "Nova instrução"
ravi triggers set <id> topic "ravi.*.cli.contacts.*"
ravi triggers set <id> agent jarvis
ravi triggers set <id> session issue-{{data.id}}  # session name or name template
ravi triggers set <id> cooldown 30s          # supports: 5s, 30s, 1m, 5m, 1h

# Test trigger (fires with fake event data)
ravi triggers test <id> --execute

# Delete
ravi triggers rm <id> --execute
```

**Topic Catalog:**
- `ravi triggers topics` - Inspect built-in topic templates, payload schemas, examples, and notes
- `ravi.*.cli.{group}.{command}` - CLI command audit events emitted from an agent session
- `ravi._cli.cli.{group}.{command}` - CLI command audit events emitted outside an agent session
- `ravi.inbound.reaction` - Normalized emoji reactions
- `ravi.console.inbox.item` - Console Agent Inbox items, including Bases row events (`category: "bases"`; payload has ids and, for `bases.row.*`, the row values read at delivery in `payload.row`; envelope has `actor.type` and `dedupeKey`). Enable per base with `ravi bases subscribe <base>`
- `ravi.audit.denied` - Permission or policy denial events
- The catalog is hints/templates, not a whitelist. Custom publisher subjects are allowed when emitted by local code or another NATS publisher.

**Topic Warnings:**
- Unknown topics are accepted, but the CLI may warn when they are not in the built-in templates.
- `ravi.session.*` topics are accepted by the CLI, but the trigger runner skips internal session subscriptions to prevent loops.

**Options:**
- `--topic <pattern>` - NATS topic pattern to subscribe to (required)
- `--message <text>` - Prompt to send when event fires (required)
- `--agent <id>` - Target agent (default: default agent)
- `--cooldown <duration>` - Minimum time between fires (default: 5s)
- `--session <name>` - Session to run in, by name; may be a template (see below). Default: the current session (the agent main session outside one)

**Prompt Format (injected into agent):**
```
[Trigger: Contato alterado]
Topic: ravi.agent:main:main.cli.contacts.add
Data: {
  "event": "end",
  "tool": "contacts_add",
  "output": "✓ Contact added: abc123"
}

Um contato foi alterado. Notifica o grupo do Slack e atualiza o CRM.
```

**Sessions:**
- `--session` is a session name. An existing session with that name is reused (the turn replies where it last talked, unless `--reply-session` says otherwise); a missing one is created as `agent:{agentId}:trigger:{triggerId}:key:{hash}`.
- The name may be a template with the message syntax (`{{topic}}`, `{{data.<path>}}`, array items by index), resolved per event and normalized to a session name: `--session issue-{{data.payload.row.values.topic_id.0}}` keeps one persistent session per issue. An event whose name does not resolve is skipped and logged, never routed to a shared or main session. Cooldown counts per resolved session.
- Legacy stored values still work: `main` (agent main session) and `isolated` (`agent:{agentId}:trigger:{triggerId}`).

**Anti-Loop Protection:**
1. Internal session topics: `ravi.session.*` can be configured, but the runner skips those subscriptions to prevent loops
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

## Cloud Sandbox Tasks (E2B)

Run one task in a disposable E2B microVM: boot from a snapshot (NATS already up),
clone a repo, run the task with a Claude worker agent, save `TASK.md`,
`task.json`, `changes.patch` and `daemon.log` locally, then destroy the machine.
Nothing is pushed; apply the patch yourself.

```bash
# Once (and whenever the Ravi baked into the template should be updated)
ravi sandbox template build                    # [name] --ref dev --cpu 2 --memory 4096

# Per task
ravi sandbox run --repo https://github.com/owner/repo.git --task "..." \
  [--branch b] [--title t] [--model sonnet] [--timeout-min 55] [--keep] [--output dir] [--json]
```

- Credentials come from the environment: `E2B_API_KEY`, plus `CLAUDE_CODE_OAUTH_TOKEN` or
  `ANTHROPIC_API_KEY` (the `RAVI_`-prefixed names also work, for hosts that hide the standard ones).
  `GITHUB_TOKEN` is used only to clone private repos, and only for `https://github.com/...` URLs.
- Outputs default to `~/.ravi/sandbox-runs/<sandbox-id>/`. Exit code is 1 unless the task ends `done`.
- `changes.patch` holds everything the task changed, committed or not, minus the `AGENTS.md`/`CLAUDE.md`
  scaffolding Ravi adds to the worker's cwd. Apply it with `git apply`.
- `--keep` pauses the sandbox instead of killing it. Ctrl-C kills (or, with `--keep`, pauses) it too.
- Both commands are CLI-only (not exposed through the gateway/SDK): they run for minutes and use host paths.

## Router (`~/.ravi/ravi.db`)

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
- `cwd` - Working directory (`AGENTS.md`, tools, optional `CLAUDE.md` compatibility bridge)
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

**Permission Provider Runtime:**

Runtime permissions for agents are configured through provider-owned agent
defaults:

```bash
ravi agents permissions dev             # Show runtime profile
ravi agents permissions dev full-access --execute # Full Ravi permissions (sem --execute e dry-run, exit 3)
ravi agents permissions dev chat-only             # Reception agent: conversation only, no tools/shell/CLI groups
ravi agents permissions dev explicit-only --capabilities use:tool:Bash,read:crypto:* --execute # Public agent: only the listed capabilities, no bootstrap floor
ravi agents permissions dev none                  # Reset to bootstrap minimum immediately (not zero-authority)
```

Least privilege is an explicit capability list on the agent, in the form
`permission:objectType:objectId`. `--capabilities` replaces the list, so repeat
the capabilities the agent already has:

```bash
ravi agents permissions dev bootstrap --capabilities use:tool:Bash,execute:executable:git,execute:group:contacts,access:session:dev-* --execute
ravi agents permissions dev --clear-capabilities                         # Drop the explicit list, keep the profile
ravi permissions materialize --subject-type agent --subject-id dev --json  # What dev can do now
ravi permissions check --permission execute --object-type group --object-id contacts --json
ravi permissions allow <profile> --to agent:dev --capabilities <permission>:<objectType>:<objectId> --apply  # Shared profile
ravi permissions status                                                  # Active permission chain
```

**Permissions:** `admin`, `use` (tools), `execute` (executables/CLI groups), `access`/`modify` (sessions), `write_contacts`, `read_own_contacts`, `read_tagged_contacts`, `read_contact`

**Object types:** `agent`, `system`, `group`, `session`, `contact`, `tool`, `executable`, `cron`, `trigger`, `team`

Subcommand groups are their own objects: `ravi bases rows add` needs `execute:group:bases_rows` (or the semantic `mutate:bases.rows:add`), so `execute:group:bases` alone does not cover `ravi bases rows`.

**Enforcement:** New agents start with bootstrap runtime permissions. Denied actions emit audit events to `ravi.audit.denied`.

**Global Settings:**
- `defaultAgent` - Default agent when no route matches
- `defaultDmScope` - Default DM scope for new agents
- `defaultTimezone` - Default timezone for cron jobs (e.g., `America/Sao_Paulo`)
- `whatsapp.groupPolicy` - Group policy: `open`, `allowlist`, `closed`
- `whatsapp.dmPolicy` - DM policy: `open`, `pairing`, `closed`
- `announceCompaction` - Post compacting/compacted notices to the conversation channel (`true` / `false`, default: `false`)

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
└── main/            # Agent CWD
    ├── AGENTS.md    # Canonical agent instructions
    ├── CLAUDE.md    # Claude compatibility bridge (when needed)
    ├── HEARTBEAT.md # Pending tasks for heartbeat (optional)
    └── SPEC_INSTRUCTIONS.md  # Custom spec mode instructions (optional)

~/.ravi/
├── ravi.db          # Config and sessions (SQLite)
├── .env             # Environment variables (loaded by daemon)
├── omni-api-key     # Auto-generated legacy bridge API key
├── jetstream/       # NATS JetStream storage
├── bin/
│   └── nats-server  # nats-server binary (auto-downloaded)
└── logs/
    └── daemon.log   # Daemon logs
```

## CLI

### CLI Runtime Hierarchy

The CLI is only trustworthy when it is targeting the same runtime and database as the live daemon.

- **Authority order:** live daemon/runtime > repo wrapper (`bin/ravi`) > stale/global PATH wrappers
- **Canonical wrapper:** prefer `./bin/ravi` from this repo when mutating `agents`, `instances`, `routes`, or `sessions`
- **Mutations must make target explicit:**
  - which CLI bundle is running
  - which SQLite DB is being changed
  - which instance is being targeted
  - whether that instance affects the live `main`
- **Live routing beats apparent success:** if a route mutation succeeds but the live resolver still picks a different winner, the operation is not done
- **Fail closed on runtime split:** when the CLI bundle differs from the daemon bundle, mutating commands should refuse by default unless the caller explicitly overrides the mismatch

Recommended inspection flow before/after route mutations:

```bash
./bin/ravi instances target main --pattern group:120363426276457547
./bin/ravi instances routes add main group:120363426276457547 energia-video-dev
./bin/ravi instances target main --pattern group:120363426276457547
```

This keeps three truths aligned:

1. the runtime/db you mutated
2. the instance you think you changed
3. the live routing winner the daemon will actually use

```bash
# Setup
ravi setup             # Interactive setup wizard

# Daemon (recommended)
ravi daemon start      # Start nats + bot + gateway + configured channel adapters
ravi daemon stop       # Stop daemon
ravi daemon restart    # Restart daemon
ravi daemon status     # Show status
ravi daemon logs       # Show last 50 lines
ravi daemon logs -f    # Follow mode (tail -f)
ravi daemon logs -t 100  # Show last 100 lines
ravi daemon logs --clear --execute # Clear logs (dry-run without --execute)
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
ravi sessions send <session> "prompt" -a <id> -w  # Send a prompt to a session of agent <id> and wait for the reply
ravi sessions send <session> -a <id> -i           # Interactive mode
ravi agents session <id>            # Check session status
ravi agents reset <id> --execute              # Reset main session (sem --execute e dry-run, exit 3)
ravi agents reset <id> <sessionKey> --execute # Reset specific session
ravi agents reset <id> all --execute          # Reset ALL sessions for agent

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
ravi sessions send <session> "prompt"   # Send context/prompt to session (fire-and-forget)
ravi sessions send <session> "prompt" -w # Wait and stream response
ravi sessions send <session> -i         # Interactive mode
ravi sessions execute <session> "task"  # Execute task
ravi sessions ask <session> "question"  # Ask another session
ravi sessions answer <session> "reply"  # Reply to a previous ask
ravi sessions inform <session> "info"   # Send context info

# Tasks
ravi tasks create "Title" --instructions "..."  # Create tracked work
ravi tasks dispatch <task-id> --agent <id> --execute # Dispatch to an agent/session
ravi tasks watch [task-id]                      # Watch live task events
ravi tasks report <task-id>                     # Read progress + progress_note from TASK.md
ravi tasks report <task-id> --progress 30 --message "..."  # Report concrete progress
ravi tasks done <task-id> --summary "..."      # Mark task done
ravi tasks block <task-id> --reason "..."      # Mark task blocked
ravi tasks fail <task-id> --reason "..."       # Mark task failed

# Eval
ravi eval run <spec.json>        # Run reproducible eval
ravi eval run <spec.json> --json # Emit machine-readable result

# Heartbeat
ravi heartbeat status                # Show all agents
ravi heartbeat show <id>             # Show config
ravi heartbeat enable <id> [interval]  # Enable (e.g., 30m, 1h)
ravi heartbeat disable <id>          # Disable
ravi heartbeat set <id> <key> <value>  # Set property
ravi heartbeat trigger <id> --execute # Manual trigger (dry-run when work is pending)

# Cron jobs
ravi cron list                       # List all jobs
ravi cron show <id>                  # Show job details
ravi cron add <name> [options]       # Add new job
ravi cron enable <id>                # Enable job
ravi cron disable <id>               # Disable job
ravi cron set <id> <key> <value>     # Set property
ravi cron run <id> --execute         # Manual trigger (dry-run sem --execute)
ravi cron rm <id> --execute          # Delete job (dry-run sem --execute)

# Event triggers
ravi triggers list                   # List all triggers
ravi triggers add <name> [options]   # Add new trigger
ravi triggers show <id>              # Show trigger details
ravi triggers enable <id>            # Enable trigger
ravi triggers disable <id>           # Disable trigger
ravi triggers set <id> <key> <value> # Set property
ravi triggers test <id> --execute    # Test with fake event (dry-run without --execute)
ravi triggers rm <id> --execute      # Delete trigger (dry-run sem --execute)

# Permissions (provider runtime)
ravi agents permissions <id> <profile> [--capabilities <list>] --execute  # Profiles: bootstrap, chat-only, explicit-only, full-access, none
ravi permissions status              # Active permission chain
ravi permissions check --permission <p> --object-type <t> --object-id <id>
ravi permissions list --chat <chat>  # Contact profile grants in a chat scope
ravi permissions allow <profile> --to agent:<id> --apply

# Reactions
ravi react send <messageId> <emoji>  # Send emoji reaction
```

## Testing Agents

Use the CLI to interact with agents directly (daemon must be running):

```bash
# Send a single prompt and wait for the reply (creates session teste-main for agent main)
ravi sessions send teste-main "lista os agentes" -a main -w
ravi sessions send teste-main "oi, tudo bem?" -w

# Interactive mode
ravi sessions send teste-main -i

# Check session status
ravi agents session main

# Reset session (clear context)
ravi agents reset main --execute                    # Reset main session (dry-run sem --execute)
ravi agents reset main <sessionKey> --execute       # Reset specific session
ravi agents reset main all --execute                # Reset ALL sessions for agent
```

### CLI Tools

Agents can use CLI commands as tools via Bash. Tool naming convention:

```
agents_list      # ravi agents list
agents_show      # ravi agents show <id>
contacts_list    # ravi contacts list
```

Tool and executable access is controlled by the agent's runtime permissions:

```bash
ravi agents permissions main bootstrap --capabilities use:tool:Bash,execute:executable:git,execute:group:contacts --execute  # Explicit list; replaces the previous one
ravi agents permissions main full-access --execute        # Full Ravi runtime profile (dry-run sem --execute)
ravi agents permissions main chat-only                    # Reception agent (conversation only)
ravi agents permissions main none                         # Reset overlay to bootstrap minimum
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

# Legacy transport bridge (only for channels still using the bridge)
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

## Operational Triangle

Use the three surfaces for different jobs:

- `ravi sessions ...` = communication between sessions. Ask, inform, answer, or send lightweight prompts/context.
- `ravi tasks ...` = tracked execution. Clear owner, dedicated work session, progress, blocked/done/failed.
- `ravi eval ...` = measurement. Reproducible runs, artifacts, diff, and rubric for regression/benchmark.

Rule of thumb:

- If it only needs message passing or short coordination, use `sessions`.
- If it needs `watch/report/done/block/fail`, use `tasks`.
- If you changed behavior and need evidence, use `eval` after the change.

### Cross-Session Messaging

Agents can send typed messages to other sessions using CLI tools. This is the communication layer, not the task runtime:

```bash
ravi sessions send agent:main:dm:5511999 "Lembrete: reunião em 10 minutos"
```

**Message Types:**

| CLI | Injected prompt | Intended use |
|-----|-----------------|--------------|
| `ravi sessions send` | `[System] Inform: [from: <origin>] ...` | Default fire-and-forget send. Use `-w` to wait for a response or `-i` for interactive mode. |
| `ravi sessions inform` | `[System] Inform: ...` | Fire-and-forget context with no tracked work item. |
| `ravi sessions execute` | `[System] Execute: ...` | Ask another session to execute something operationally. |
| `ravi sessions ask` | `[System] Ask: [from: <session>] ...` | Structured question that can be relayed back over time. |
| `ravi sessions answer` | `[System] Answer: [from: <session>] ...` | Deliver an answer back to the origin session. |

There is no separate `[System] Send:` or `contextualize` contract in the current CLI surface.

**Ask/Answer flow:**
1. Agent A: `ravi sessions ask sessionB "qual o status do deploy?"`
2. Agent B receives `[System] Ask: [from: sessionA] qual o status do deploy?`
3. Agent B: `ravi sessions answer sessionA "deploy concluído com sucesso"`
4. Agent A receives `[System] Answer: [from: sessionB] deploy concluído com sucesso` and can keep working normally

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

Legacy bridge streams: `MESSAGE`, `INSTANCE`, `REACTION`, `MEDIA`, `ACCESS`, `IDENTITY`, `CUSTOM`, `SYSTEM`.

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

Watch legacy bridge events in real time:

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
