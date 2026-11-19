# Ravi App Manifest / WHY

## Rationale

Ravi needs a way to treat capabilities as applications, not just as loose
commands, skills, plugins, or prompt templates.

The app manifest gives Ravi a stable indexable contract:

- agents can understand what an app does and which skill teaches it;
- UIs can list available apps without scraping plugin folders;
- launchers can preflight permissions before spawning a CLI;
- SDK/gateway, tools, and automations can invoke the generic App Router;
- operators can run health checks and diagnose missing capabilities;
- future app stores or plugin registries can describe capability without
  granting access.

## Decisions

- The initial canonical file is `ravi.app.json`, separate from plugin manifests.
  A plugin packages apps; it is not itself the app.
- The manifest schema is `ravi.app/v1` so future schema changes can be
  explicit.
- The manifest is declarative only. Discovery is metadata parsing, never code
  execution.
- Permissions are declared as requirements, not grants. Runtime authorization
  remains the source of truth.
- The CLI is the one executable App interface. Optional UI and compatibility
  adapter metadata describe presentation/discovery, not alternate execution.
- Caller permission requirements and child `context.allow` are separate
  declarations because authorizing use of an app is different from delegating
  Ravi capabilities into its process.
- `--json` is command output, not a separate protocol.
- Health checks belong in the manifest, but execution belongs to an explicit
  doctor/check command.
- Router-owned app operations can use `interface: "builtin"` so new apps can
  expose help/show/check without pretending those are external CLI commands.

## Rejected Alternatives

- Reusing only plugin manifests: rejected because plugins are packaging units,
  while apps are operational capability units.
- Inferring apps from skills: rejected because skills teach agents but do not
  define machine contracts, storage, health, or permissions.
- Inferring the entire app from CLI commands: rejected because CLI metadata
  alone cannot describe storage, events, artifacts, permissions, context
  delegation, or UI.
- Supporting independent CLI, SDK, tool, and stream executors: rejected because
  it creates multiple implementations and inconsistent authorization.
- Adding an App JSON-RPC protocol: rejected because the process contract and
  public Ravi CLI already provide the necessary integration.
- Letting discovery execute code to ask an app what it is: rejected because it
  creates side effects, security risk, and poor offline indexing.
- Modeling router-owned operations as CLI-backed manifest commands like
  `ravi <app-id> check`: rejected because runtime app routing would recursively
  call itself.
- Using a registered static Ravi command as the implementation: accepted even
  when it is textually `ravi <app-id>`, because static command precedence keeps
  execution out of the dynamic router. `ravi apps` is the canonical example.
- Modeling executable health checks as arbitrary `ravi <app-id> ...` commands:
  rejected because non-health app operations can recursively call the same
  router. Router `check` validates health metadata without executing it;
  executable health belongs under the real implementation CLI.

## Composition

Apps that need each other had no way to say so. A blog that needs a Markdown
renderer either carried a copy of the renderer or called an app and hoped it was
installed. Declaring the need in the manifest makes it checkable before anything
runs: the router can name what is missing, and the audit can name why one app
called another.

- The declaration is two small fields, not a second manifest: `provides` (what
  I offer, at which version, through which operations) and `requires` (which
  service I need, in which range). The key is `<app-id>/<service>` so a
  service always has one owner.
- The offered version is exact and the required range is strict. A manifest
  that says `latest` or `1.x` must fail validation, because the parser that
  decides satisfaction would otherwise call every version a match.
- A missing provider is a warning on the consumer, not an invalid manifest:
  apps are installed in any order, and the run is where the need becomes
  binding. A cycle is the opposite case, a fact about the manifests alone, so
  it is a validation error found once and on every app on it.
- Nothing is resolved by running anything. The answer comes from manifests
  discovery already read.

Rejected: letting an app name a provider by a path or a command (it would
bypass the router and the context lineage), and an install-time dependency
resolver (installation is not where authority is decided).
