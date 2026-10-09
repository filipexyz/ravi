<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="docs/logo-light.svg" />
    <img alt="Ravi" src="docs/logo-light.svg" width="200" />
  </picture>
</p>

<p align="center">
  <strong>Local-first runtime for long-lived AI agents.</strong><br />
  Run agents on your own machine, reach them from Slack, WhatsApp or the terminal, publish what they build as pages, and build your own frontends on SDKs generated from the CLI.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun-f472b6" alt="Bun" />
  <img src="https://img.shields.io/badge/lang-TypeScript-3178c6" alt="TypeScript" />
  <img src="https://img.shields.io/badge/storage-SQLite-0f766e" alt="SQLite" />
  <img src="https://img.shields.io/badge/events-NATS-2563eb" alt="NATS" />
</p>

---

Ravi is a daemon that runs AI agents on your machine. Each agent has a working directory, an `AGENTS.md` with its instructions, a model provider and a permission ceiling. Messages from chat channels, scheduled jobs, events and the terminal land in durable sessions, and Ravi decides which agent answers, what it may do and where the reply goes.

Documentation: **[docs.ravi.bot](https://docs.ravi.bot)**

## What you get

- **Any provider, same behavior.** Claude Code, Codex, Pi and Grok Build are adapters. Ravi owns queueing, permissions, traces and delivery, so switching providers does not change how an agent works.
- **SDKs generated from the CLI.** Every public `ravi` command is also an HTTP endpoint on the daemon and a typed method in the TypeScript, Dart and Swift SDKs, all generated from the same command registry. The pre-push hook and CI compare the SDK sources in this repository with a fresh generation and fail on any difference, so they never drift from the CLI of the same commit. Build any frontend for your Ravi (a dashboard, a mobile app, a browser extension, an internal tool) while authentication, permissions, dry-runs and audit stay in Ravi.
- **Channels.** Slack runs natively (Socket Mode: DMs, channels, threads, files, Block Kit). WhatsApp, Telegram and Discord go through the Omni bridge. The terminal works too, with `ravi sessions send`.
- **Durable sessions.** By default each DM, group and thread gets its own named session, cron jobs and triggers can run in sessions of their own, and sessions can send, ask, inform and answer each other. People can steer a busy agent from chat: `>>message` waits for the current turn to end, and `!!message` is recorded without starting a turn.
- **Automation.** Cron jobs, event triggers on NATS topics, heartbeats driven by the agent's `HEARTBEAT.md`, and background jobs (`ravi jobs run`) whose result comes back to the session. When an agent creates or edits a pull request with `gh`, Ravi follows the PR and its CI and wakes the session when something changes.
- **Permissions you can reason about.** Each agent has a runtime profile (`bootstrap`, `chat-only`, `explicit-only`, `full-access`) and optional explicit capabilities. In a governed chat, each person gets their own grants intersected with the agent's ceiling; in any other chat, every sender who resolves to a contact gets the whole ceiling, so entry policies and routes decide who gets in. Approvals can be resolved from Slack with buttons that only authorized people can click, and every denial is published on `ravi.audit.denied`.
- **Planned restarts resume work.** `ravi daemon restart -m "<reason>"` tells the calling session why it restarted and resumes the sessions that were active. A crash does not resume sessions.
- **Pages and Bases.** Publish HTML to your project's `ravi.page` host with one command, and build members-only pages that read and write typed tables (Bases) in the Ravi Console.

## Quick start

You need macOS or Linux with Bun 1.0+ (`~/.bun/bin` on your `PATH`), Node.js 18+ (for PM2) and a Claude credential: a Claude Code OAuth token or an Anthropic API key. `ravi setup` installs PM2 and Omni, which runs the NATS server Ravi needs and keeps its data in PostgreSQL. [Install Ravi](https://docs.ravi.bot/start/install) covers the prerequisites and a Slack-only path without Omni.

```bash
bun add -g ravi.bot@next     # on an existing install: ravi update --next
ravi setup                   # PM2, Omni (NATS), ~/.ravi/.env, starts the daemon
ravi agents sync-instructions --agent main --materialize-missing
```

The built-in default provider is `codex`, but the wizard collects a Claude credential. Point the `main` agent at Claude:

```bash
# Only with a Claude Code OAuth token; skip these two lines if you gave the wizard an API key:
read -rs CLAUDE_TOKEN    # paste the sk-ant-oat01-... token, then press Enter
printf '%s' "$CLAUDE_TOKEN" | ravi runtime providers claude configure --stdin --set-provider

ravi agents set main provider claude
ravi daemon restart -m "main uses claude"
```

Check the install and talk to the agent:

```bash
ravi daemon status                       # ravi, omni-nats and omni-api online
ravi doctor                              # an instances.main error is expected; see Install Ravi
ravi sessions send main "hi" -a main -w  # -a creates the session the first time
```

To start the conversation over, run `ravi sessions reset main --execute`; without `--execute` it only prints the plan and exits 3. To use Codex instead, see the Codex tab in [Install Ravi](https://docs.ravi.bot/start/install).

The `ravi.bot@latest` channel is older: it lacks Bases, the one-command `ravi pages ship` and the `explicit-only` profile. These docs follow `@next`.

## Connect a channel

**Slack (recommended).** Slack runs inside Ravi, in its own PM2 process (`ravi-channels`). You create a Slack app, store its bot and app tokens with `ravi credentials connections add` (macOS Keychain, or Vault on Linux), create a channel config and an instance with the same name (`ravi channels create`, `ravi instances create`), and start the runner with `ravi channels start`. Step by step: [Connect Slack](https://docs.ravi.bot/channels/slack).

**WhatsApp through Omni.** Use a dedicated number. Connect it, scan the QR code, then set the instance policies, because connecting resets them to `open`:

```bash
ravi instances connect wa-main --agent main
ravi instances set wa-main dmPolicy pairing
ravi instances set wa-main groupPolicy allowlist
```

Step by step: [Connect WhatsApp](https://docs.ravi.bot/channels/whatsapp).

Then [make yourself the owner](https://docs.ravi.bot/start/owner): raise the agent's ceiling and tag your own contact `permission-owner`, so you can do everything and approve requests.

## Pages and Bases

Ravi Pages publishes HTML as routes on your Console project's host (`<org>-<project>.ravi.page`). Create an account, an organization and a project at [console.ravi.bot](https://console.ravi.bot), then:

```bash
ravi login                                         # opens the browser to approve this CLI
ravi cloud scope set --global --project <project>  # default project for this install
ravi pages ship --title "Hello" --body "<h1>Hello</h1>" --json
```

`ravi pages ship` publishes immediately, and a new route is `private` unless you pass `--visibility`. See [Log in to the Console](https://docs.ravi.bot/console/login) and [Publish pages](https://docs.ravi.bot/console/pages).

Bases are typed tables in a Console project. A page reads and writes them through a view, live for signed-in organization members on `private` or `protected_link` routes, and new rows can wake your agent through a trigger. See [Interactive pages with Bases](https://docs.ravi.bot/console/bases).

## Build on Ravi

Turn on the daemon's HTTP gateway by adding `RAVI_HTTP_PORT=7777` to `~/.ravi/.env` (`ravi daemon env` opens it), then restart and create a context key:

```bash
ravi daemon restart -m "sdk gateway"
ravi daemon init-admin-key     # prints an rctx_ key for RAVI_CONTEXT_KEY; narrower keys: ravi context issue
```

Then call your agents from any app:

```ts
import { RaviClient, createHttpTransport } from "@ravi-os/sdk";

const ravi = new RaviClient(
  createHttpTransport({ baseUrl: "http://127.0.0.1:7777", contextKey: process.env.RAVI_CONTEXT_KEY! }),
);

const agents = await ravi.agents.list();
const reply = await ravi.sessions.send("main", "Summarize today's work.", { wait: true });
```

Method names follow the CLI: `ravi instances routes add` is `ravi.instances.routes.add(...)`. Sessions, tasks and events stream live over SSE. The Dart (`ravi_sdk`) and Swift (`RaviSDK`) clients are generated from the same registry, and the daemon serves its OpenAPI 3.1 spec at `/api/v1/_meta/openapi.json` for any other language. The npm and pub.dev packages are released separately and can trail `ravi.bot@next`; the sources in `packages/` always match the CLI of the same commit. See [SDKs and HTTP gateway](https://docs.ravi.bot/guides/sdk).

## Learn more

- [Architecture](https://docs.ravi.bot/architecture), [CLI reference](https://docs.ravi.bot/cli/overview), [Permissions](https://docs.ravi.bot/guides/permissions), [Troubleshooting](https://docs.ravi.bot/guides/troubleshooting).
- Every command documents itself: `ravi --help` and `ravi <group> <command> --help`.
- The built-in skills your agents read are available to you too: `ravi skills list` and `ravi skills show <name>`.

## Development

Building from source, tests, the git hooks and pull requests are covered in [CONTRIBUTING.md](CONTRIBUTING.md). Coding agents working in this repository load [AGENTS.md](AGENTS.md).
