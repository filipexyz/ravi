# Ravi

Ravi is a local-first, multi-provider runtime for long-lived AI agents. Running under PM2, it takes messages from native Slack, from WhatsApp, Telegram and Discord through the Omni bridge, and from cron, triggers, heartbeats and the CLI, routes each one to an agent session, runs the turn with a runtime provider (Claude Code, Codex, Pi or Grok Build; the built-in default is `codex`) and delivers the reply. Pages, Bases and cloud auth go through the hosted Ravi Console.

This file is for coding agents working in this repository. User docs: [docs.ravi.bot](https://docs.ravi.bot) (source in `docs/`). Contributor workflow: `CONTRIBUTING.md`. `CLAUDE.md` is a generated bridge that imports this file; edit `AGENTS.md`.

## Architecture

```
PM2 process     what it is
ravi            the daemon (`ravi daemon start`, src/daemon.ts): Omni consumer, RaviBot (sessions
                and providers), gateway, cron/heartbeat/trigger/job runners, and the HTTP
                gateway when RAVI_HTTP_PORT is set
ravi-channels   native channel runner, Slack Socket Mode (`ravi channels start`)
omni-nats       NATS with JetStream on :4222, installed by `ravi setup` through Omni
omni-api        Omni API on :8882 (WhatsApp, Telegram, Discord)
```

- The daemon spawns no child processes. It connects to NATS at `NATS_URL` (default `nats://127.0.0.1:4222`) and to Omni via `OMNI_API_URL`/`OMNI_API_KEY` or `~/.omni/config.json`; without Omni only native channels deliver. `ravi daemon start` does not start `ravi-channels`, and the text output of `ravi daemon status` does not list it (`--json` does).
- Inbound messages (Omni and Slack) become prompts on `ravi.session.<name>.prompt` (stream `SESSION_PROMPTS`). Slack replies go out on `ravi.channel.outbound.*` (stream `CHANNEL_OUTBOUND`), consumed by `ravi-channels`. Omni's subjects (`message.received.{channelType}.{instanceId}`, `reaction.received.*`, `instance.*`) never carry Slack.
- State is SQLite under `RAVI_STATE_DIR` (default `~/.ravi`); `ravi.db` holds agents, instances, routes, sessions, contacts, triggers and settings. The daemon loads `~/.ravi/.env` over the process environment; the CLI loads it without overriding. Logs are PM2's (`ravi daemon logs --path`). Each agent's `cwd` holds its `AGENTS.md` and optional `HEARTBEAT.md`.

## Repository map

```
src/cli/commands/   one decorated class per command group; `bun run gen:commands` writes index.ts
src/cli/            decorators, registry, agent-contract.ts (exit codes, dry-run), command-access.ts
src/runtime/        provider adapters (claude, codex, pi, grok), dispatcher, event loop, recovery
src/router/         ravi.db schema and queries (router-db.ts), routes, resolver, session keys
src/channels/       native channel runner; Slack in src/channels/slack/
src/omni/           Omni bridge: JetStream consumer, sender, session prompt stream
src/permissions/    provider chain, runtime profiles, contact policies; src/approval/ for approvals
src/triggers/ cron/ heartbeat/ watch/ jobs/ hooks/   automation
src/pages/ bases/ cloud-auth/ console-scope/          Console-backed features
src/sdk/            HTTP gateway, OpenAPI, SDK codegen; packages/ holds the generated SDKs
src/plugins/internal/ravi-system/skills/   system skills (SKILL.md + references/), shipped on npm
src/plugins/internal/ravi-dev/skills/      skills for developing Ravi itself
.ravi/specs/        normative specs (SPEC.md + WHY, CHECKS, RUNBOOK); repo-only, not shipped
docs/               Mintlify source of docs.ravi.bot (docs.json is the navigation)
bin/ravi            wrapper; rebuilds dist/bundle when src/ or package.json is newer
```

Read the governing spec before changing an area (`./bin/ravi specs get <id> --mode rules`) and run `./bin/ravi specs sync --json` after editing `.ravi/specs/**`. Shipped skills must not send users to `.ravi/specs` or other repo-only files: `ravi specs get` only reads `<cwd>/.ravi/specs`.

## Build, test, restart

```bash
bun install          # also points git at .githooks/
bun run build        # gen:commands, bundle CLI (dist/bundle) and TUI (dist/tui), gen:plugins
make quality         # biome check src/ + tsc --noEmit
bun run test         # the CI suite, including SDK, OpenAPI, Swift and Dart drift checks
bun test <path>      # one focused suite
```

- Pre-commit runs Biome on staged files. Pre-push runs `bun run sdk:check` (on drift it regenerates and blocks until you commit), then build, typecheck and `bun run test`. Never use `--no-verify`.
- Changing a command's flags or return schema changes the generated SDKs and `openapi.json`/`docs/openapi.json`; `CONTRIBUTING.md` lists the regenerate commands.
- `src/cli/execute-consumers.test.ts` checks exact command strings in `README.md`, `AGENTS.md`, skills and docs. When a command gains or loses its `--execute` brake, update that test and those files.
- Try the CLI without touching a live install: `HOME=$(mktemp -d) ./bin/ravi <group> <command> --help`.

The daemon and the channel runner run the built bundle, so `src/` changes need a build and a restart. `ravi daemon restart` re-registers the daemon with the bundle of the CLI you invoke, so restart through `./bin/ravi` to run this checkout. CLI config writes (agents, instances, routes, triggers, cron) need no restart: they emit refresh events such as `ravi.config.changed`. Editing `~/.ravi/.env` needs a daemon restart.

```bash
./bin/ravi daemon restart -m "<reason>"   # -m is required; -b runs bun run build first
./bin/ravi channels restart -b            # after changing src/channels; refused unless the daemon runs the same bundle
./bin/ravi daemon dev                     # rebuilds on every src/ change; apply with daemon restart
./bin/ravi sessions send teste-main "lista os agentes" -a main -w   # try a change on a live agent
./bin/ravi sessions trace teste-main --explain
```

## CLI Runtime Hierarchy

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

## Agent-first CLI contract

Every command follows `.ravi/specs/cli/SPEC.md` (helpers in `src/cli/agent-contract.ts`). Exit codes: `0` success, `1` execution or not-found error, `2` usage error, `3` blocked by policy. Exit 3 is the write brake, not a failure: commands with external, irreversible or triggered effects dry-run by default, print the plan and exit 3, and act only with `--execute`. Reversible local writes and changes that only reduce authority run immediately; do not add `--execute` to them. `--json` gives machine output, and failures print `{success:false, op, error:{code, message, ...}}`. A command without `@CommandAccess` is denied.

```bash
ravi triggers test <id> --execute          # braked: emits a synthetic event only with --execute
ravi heartbeat trigger <id> --execute      # braked when HEARTBEAT.md has pending work
ravi agents permissions dev full-access --execute   # expanding a ceiling is braked
ravi agents permissions dev none           # reduces to the bootstrap floor: applies immediately
```

## Session Keys

The CLI addresses sessions by name (`ravi sessions list`); the key is the database identity (`src/router/session-key.ts`):

```
agent:main:main                                       # dmScope main: all DMs in one session
agent:main:dm:5511999999999                           # per-peer (default)
agent:main:whatsapp:dm:5511999999999                  # per-channel-peer
agent:main:whatsapp:wa-main:dm:5511999999999          # per-account-channel-peer
agent:main:whatsapp:wa-main:group:120363012345678901  # group, with the instance
agent:main:slack:slack-main:group:C0ABC123:thread:1712345678.123456
agent:main:cron:<jobId>                               # cron --isolated
agent:main:trigger:<triggerId>[:key:<hash>]           # legacy isolated / named or template session
```

## Message Queue

A message for a busy session is queued with a delivery barrier (`src/delivery-barriers.ts`, `docs/ravi-delivery-barriers-v0.md`). Chat messages default to `after_tool`: they wait for the running tool, then steer the turn. `>>message` waits for the current reply and `!!message` is recorded without a turn. Cron, hooks and `[System] Inform/Ask/Answer` wait for the reply; triggers, heartbeats and `[System] Execute` wait for the task. `ravi sessions send --barrier followup|steer|p0|p1|p2|p3` sets it explicitly.

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
effective visibility. A `public` route on a site whose default is `private`
stays private.

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

## Where everything else lives

Operating Ravi is documented in the system skills (`ravi skills show <skill>`) and on [docs.ravi.bot](https://docs.ravi.bot); the paths below are relative to `https://docs.ravi.bot/`. Read the skill before working in an area; `ravi <group> <command> --help` is the final word on flags.

| Topic | Skills | docs.ravi.bot path |
|---|---|---|
| Install, provider, owner, permission profiles, approvals | `agents`, `settings`, `permissions` | `start/install`, `start/owner`, `guides/permissions` |
| Slack: credentials, channel config, runner, operations | `channels`, `slack` | `channels/slack` |
| WhatsApp through Omni, groups and DMs | `instances`, `whatsapp` | `channels/whatsapp` |
| Instances, policies, routes, pending, DM scopes | `instances`, `routes` | `guides/routing` |
| Agent keys, settings, `~/.ravi/.env`, files, PM2 | `agents`, `settings`, `daemon` | `reference/configuration` |
| Contacts and sessions (send, ask, inform, reset, trace) | `contacts`, `sessions` | `guides/contacts`, `guides/sessions` |
| Cron, triggers, heartbeat | `cron`, `triggers`, `heartbeat` | `guides/cron-jobs`, `guides/triggers`, `guides/heartbeat` |
| Logs, doctor, events, JetStream | `daemon`, `events` | `guides/troubleshooting`, `reference/nats-events` |
| Console login, Pages | `pages` | `console/login`, `console/pages` |
| Bases and data pages | `solucoes`, `bases` | `console/bases` |
| Media, artifacts, skills | `audio`, `image`, `video`, `artifacts`, `skills` | `reference/media`, `reference/artifacts`, `reference/skills` |
| Tasks, CLI conventions, SDK and HTTP gateway | `tasks` | `cli/overview`, `guides/sdk` |

The docs describe the `dev` branch, published as `ravi.bot@next`. `ravi.bot@latest` (branch `main`) lacks `ravi bases`, `ravi sandbox`, the `explicit-only` profile and the one-command `pages ship`.
