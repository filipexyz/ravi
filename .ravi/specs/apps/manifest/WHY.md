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
