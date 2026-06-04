# Ravi App Manifest / WHY

## Rationale

Ravi needs a way to treat capabilities as applications, not just as loose
commands, skills, plugins, or prompt templates.

The app manifest gives Ravi a stable indexable contract:

- agents can understand what an app does and which skill teaches it;
- UIs can list available apps without scraping plugin folders;
- launchers can preflight permissions before spawning a CLI;
- SDK/gateway surfaces can map an app to namespaces and commands;
- operators can run health checks and diagnose missing capabilities;
- future app stores or plugin registries can describe capability without
  granting access.

## Decisions

- The initial canonical file is `ravi.app.json`, separate from plugin manifests.
  A plugin packages apps; it is not itself the app.
- The manifest protocol is `ravi.app/v1` so future schema changes can be
  explicit.
- The manifest is declarative only. Discovery is metadata parsing, never code
  execution.
- Permissions are declared as requirements, not grants. Runtime authorization
  remains the source of truth.
- Interfaces are plural because an app may expose CLI, SDK, stream, tool, and
  UI surfaces at the same time.
- Health checks belong in the manifest, but execution belongs to an explicit
  doctor/check command.

## Rejected Alternatives

- Reusing only plugin manifests: rejected because plugins are packaging units,
  while apps are operational capability units.
- Inferring apps from skills: rejected because skills teach agents but do not
  define machine contracts, storage, health, or permissions.
- Inferring apps from CLI commands: rejected because not every app is CLI-first,
  and command metadata alone cannot describe storage, events, artifacts, or UI.
- Letting discovery execute code to ask an app what it is: rejected because it
  creates side effects, security risk, and poor offline indexing.
