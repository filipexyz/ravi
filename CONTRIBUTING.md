# Contributing to Ravi

This guide covers building Ravi from source, running the checks CI runs, and sending a pull request. To use Ravi, start at [docs.ravi.bot](https://docs.ravi.bot). Coding agents working here also load [AGENTS.md](AGENTS.md), which describes the architecture and the repository rules.

## Branches and releases

- `dev` is the default branch. Branch from it and open pull requests against it.
- After CI passes on a push to `dev`, the "Version And Publish" workflow bumps the version, tags it and publishes the package to npm as `ravi.bot@next` (when the push changed publishable files). Pushes to `main` publish `ravi.bot@latest`.
- The version bump is a CI commit (`chore(version): bump to <version> [skip ci]`). Do not edit `version` in `package.json` yourself.

## Prerequisites

- [Bun](https://bun.sh) (CI uses 1.3.11). Use Bun for every package operation: `bun install`, `bun add`, `bun remove`.
- git.
- To run the daemon from your checkout: PM2 and a NATS server with JetStream, as set up in [Install Ravi](https://docs.ravi.bot/start/install).
- Optional: a Swift toolchain for `bun run test:swift-sdk`, which CI also runs.

## Set up

```bash
git clone https://github.com/filipexyz/ravi.git
cd ravi
bun install        # dependencies; the prepare script points git at .githooks/
bun run build
bun link           # puts this checkout's ravi in ~/.bun/bin
```

`bin/ravi` runs `dist/bundle/index.js`. In a source checkout it first rebuilds the bundle (`build:cli` and `gen:plugins`) whenever anything in `src/` or `package.json` is newer, and it refuses to run if that build fails. `RAVI_ALLOW_STALE_BUNDLE=1` skips the check. Inside the repo, prefer `./bin/ravi`, so you know which code you are running (see "CLI Runtime Hierarchy" in AGENTS.md).

Other ways to run code from the checkout:

```bash
bun src/cli/index.ts agents list    # the CLI straight from source, no bundle
./bin/ravi tui main                 # in a checkout the TUI runs from src/tui/index.tsx
./bin/ravi daemon start             # registers this checkout's bundle as the PM2 process "ravi"
./bin/ravi daemon dev               # rebuilds on every src/ change; apply with ravi daemon restart -m "<reason>"
```

To try commands without touching a real install, give them a throwaway home: `HOME=$(mktemp -d) ./bin/ravi <group> <command> --help`.

## Build

```bash
bun run build
```

`build` runs `gen:commands` first (the `prebuild` script writes the barrel `src/cli/commands/index.ts`), then bundles the CLI into `dist/bundle/` (`build:cli`) and the TUI into `dist/tui/` (`build:tui`), then writes the packaged skills and plugins to `dist/bundle/internal-plugins.json` (`gen:plugins`). The barrel file is tracked in git: when adding a command file changes it, commit it. The automatic rebuild in `bin/ravi` skips `gen:commands`, so after adding a command file run `bun run gen:commands` or `bun run build`.

The daemon (`ravi`) and the channel runner (`ravi-channels`) run the built bundle. After changing `src/`, rebuild and restart what you changed. A restart re-registers the process with the bundle of the CLI you invoke, so use `./bin/ravi` to run this checkout:

```bash
./bin/ravi daemon restart -m "<reason>"   # -m is required; -b builds first
./bin/ravi channels restart -b            # Slack and other native channels; -b uses this repo's bundle
```

`channels restart` refuses a bundle that differs from the one the live daemon runs, so restart the daemon first.

Configuration changed through the CLI (agents, instances, routes, triggers, cron) is picked up without a restart.

## Test and check

```bash
bun run test          # the suite CI runs
bun test <path>       # one focused file or directory
make quality          # lint + typecheck, no auto-fix (make lint, make typecheck)
bun run lint:fix      # apply Biome fixes in src/
```

- `bun run test` runs a curated list of suites and then checks generated code against the live command registry: the TypeScript SDK, `docs/openapi.json`, `openapi.json`, and the Swift and Dart SDKs. A plain `bun test` with no path runs every test file, which is not what CI runs.
- Other entry points: `bun run test:cli-commands`, `bun run test:sdk`, `bun run test:agent-contract`, `bun run test:swift-sdk` (needs Swift), and `bun run test:live` (sets `RAVI_LIVE_TESTS=1` and calls real providers).
- Tests that touch Ravi's SQLite state must isolate it with `createIsolatedRaviState()` and `cleanupIsolatedRaviState()` from `src/test/ravi-state.ts`, which point `RAVI_STATE_DIR` at a temporary directory.
- `src/cli/execute-consumers.test.ts` checks exact command strings in `README.md`, `AGENTS.md`, skills and docs. If you change whether a command needs `--execute`, update that test and the files it checks.

## Git hooks

`bun install` sets `core.hooksPath` to `.githooks/`.

- **pre-commit** runs `biome check` on staged `.ts`, `.tsx`, `.js` and `.jsx` files.
- **pre-push** mirrors CI: `bun run sdk:check`, then `bun run build`, `bun run typecheck` and `bun run test`. If the generated TypeScript SDK is stale, the hook regenerates it with `bun run sdk:generate`, leaves the changed files in your worktree and blocks the push until you commit them.

Never bypass the hooks with `--no-verify`.

## Adding or changing a CLI command

Each command group is a class in `src/cli/commands/`, described with decorators from `src/cli/decorators.ts`. The decorated registry is the single source for the CLI, the exported tools, the HTTP gateway, OpenAPI and the generated SDKs.

```typescript
import "reflect-metadata";
import { z } from "zod";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { contractDryRun } from "../agent-contract.js";

@Group({ name: "notes", description: "Example notes", scope: "open" })
export class NotesCommands {
  @Command({ name: "delete", description: "Delete a note" })
  @CommandAccess({ kind: "mutate", resource: "notes", action: "delete", risk: "high" })
  @Returns(z.object({ deleted: z.boolean(), id: z.string() }))
  async delete(
    @Arg("id", { description: "Note id" }) id: string,
    @Option({ flags: "--execute", description: "Actually delete; default is a dry-run (exit 3)" }) execute?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (execute !== true) contractDryRun("notes delete", { id }, { asJson });
    // ... perform the delete, print text or JSON, and return the payload
    return { deleted: true, id };
  }
}
```

- `@Group({ name })` names the group; a dotted name such as `bases.rows` becomes the subgroup `ravi bases rows`. `scope` defaults to `admin`; `@Scope()` overrides it for one command.
- Every command needs `@CommandAccess` (kind, resource, action, risk). A command without it is denied at run time.
- Declare the return shape with `@Returns(<zod schema>)`; it feeds OpenAPI and the SDK types. Mark commands that cannot work over the gateway (long-lived loops, interactive or process-level commands) with `@CliOnly()`.
- Follow the agent-first contract in `.ravi/specs/cli/SPEC.md`: exit `0` success, `1` error, `2` usage error, `3` blocked by policy; `--json` on every command; failures through `contractFail()`. Only external, irreversible or triggered effects get the `--execute` brake (`contractDryRun()`); local reversible writes run immediately.
- `ravi skills show cli-creator` has the full walkthrough.

When you add a command or change its arguments, flags or return schema, regenerate and commit the generated files, or `bun run test` fails:

```bash
bun run sdk:generate                                   # packages/ravi-os-sdk
bun run sdk:dart:generate                              # packages/ravi-os-dart-sdk
bun src/cli/index.ts sdk swift generate                # packages/ravi-os-swift-sdk
bun run docs:openapi                                   # docs/openapi.json
bun src/cli/index.ts sdk openapi emit --out openapi.json
```

## Source layout

```
src/cli/commands/   command groups, one class per group (subgroups share their group's file)
src/cli/            decorators, registry, agent contract, command access, transports
src/daemon.ts       daemon boot: NATS, Omni, bot, gateway, runners
src/runtime/        provider adapters (claude, codex, pi, grok), dispatcher, recovery
src/router/         ravi.db schema and queries, routes, resolver, session keys
src/channels/       native channel runner; Slack in src/channels/slack/
src/omni/           Omni bridge for WhatsApp, Telegram and Discord
src/permissions/    permission provider chain, profiles, contact policies
src/approval/       approval requests and decisions
src/triggers/ src/cron/ src/heartbeat/ src/watch/ src/jobs/ src/hooks/   automation
src/pages/ src/bases/ src/cloud-auth/ src/console-scope/                 Console-backed features
src/sdk/            HTTP gateway, OpenAPI emitter, SDK codegen
src/tui/            terminal UI
src/sandbox/        E2B sandbox runs
src/ci/             the PR quality gate
src/test/           shared test helpers
tests/integration/  integration tests
packages/           generated SDKs (TypeScript, Swift, Dart)
scripts/            build and docs scripts
```

## Skills

System skills are the documentation Ravi's agents read. Each one is a folder in `src/plugins/internal/ravi-system/skills/<name>/` with a `SKILL.md` (YAML frontmatter with `name` and `description`, then Markdown) and optional files under `references/`. Skills for developing Ravi itself live in `src/plugins/internal/ravi-dev/skills/`.

- `bun run build` (its `gen:plugins` step) packages them into `dist/bundle/internal-plugins.json`. The npm package, the daemon and `./bin/ravi` all read that file; only `bun src/cli/index.ts` reads `src/plugins/internal/` directly. `./bin/ravi` regenerates it when `src/` changed, so `./bin/ravi skills show` sees an edit at once. The daemon caches the plugin snapshot it hands to providers, so for running agents, build and restart the daemon.
- Read one with `./bin/ravi skills show <name>` or `./bin/ravi skills show <name> --file references/<file>`.
- Most system skills are written in Brazilian Portuguese. Keep the language of the file you edit.
- A shipped skill must not send the reader to `.ravi/specs`, `MIGRACAO-LEDGER.md` or any other file that only exists in this repository.

## Specs

`.ravi/specs/` holds the normative rules for each area, as `<domain>/<capability>/<feature>/` folders with `SPEC.md` (frontmatter, intent, invariants) and its companions `WHY.md`, `CHECKS.md` and `RUNBOOK.md`. Specs are not shipped on npm.

```bash
./bin/ravi specs list
./bin/ravi specs get cli --mode rules        # also: full, checks, why, runbook
./bin/ravi specs new <id>                    # scaffold a new spec
./bin/ravi specs sync --json                 # re-index after editing .ravi/specs/**
```

Read the spec that governs a file before changing it (its `applies_to` frontmatter lists the paths). When you change behavior, update the spec and its `CHECKS.md` in the same pull request; reviewers check for drift in both directions.

## Documentation

The site [docs.ravi.bot](https://docs.ravi.bot) is built with Mintlify from `docs/`. `docs/docs.json` holds the navigation. Published pages are `.mdx` files with `title` and `description` frontmatter; plain `.md` files in `docs/` are internal notes kept off the site by `docs/.mintignore`. The docs describe the `dev` branch, which ships as `ravi.bot@next`.

```bash
bun run docs:dev            # regenerates docs/openapi.json, then starts the Mintlify dev server
bun run docs:check-links    # checks internal links in docs/
bun run lint:docs           # markdownlint on every .md and .mdx file
bun run check:docs          # lint:docs + docs:check-links (also: make docs-check)
```

## Pull requests

- Keep each pull request to one change. Run `bun run test` and `make quality` before pushing; the pre-push hook runs the same build, typecheck and test steps.
- Fill in every section of [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md): the objective, the problem, the solution, the practical impact, what does not change, how you validated it, the risks and how to roll it back. Follow-ups are optional. The "PR Description" check fails when a required section is missing, has less than 20 characters of content, or still contains template comments, `TODO`/`TBD` or an empty `-` bullet. Name the commands and tests you actually ran under Validation.
- CI runs `bun run build`, `bun run typecheck`, `bun run test` and the Swift SDK tests, then a quality gate on the pull request diff:
  - **Specs:** every changed spec needs valid frontmatter and its `WHY.md`, `RUNBOOK.md` and `CHECKS.md`, and `CHECKS.md` needs verifiable list items.
  - **Coverage:** a change under `src/channels/`, `src/omni/`, `src/router/`, `src/runtime/`, `src/jobs/`, `src/watch/`, `src/hooks/`, `src/session-trace/`, `src/triggers/`, `src/approval/`, `src/apps/` or `src/devin/` must include one of that area's focused test files (listed in `src/ci/quality-gate.ts`) in the same diff. Diffs that only touch docs, Markdown or `.ravi/` are exempt.
- Run the gate locally against `dev` with `git fetch origin dev && GITHUB_BASE_REF=dev bun src/ci/run-quality-gate.ts`.
