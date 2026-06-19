# Ravi App Scaffold / WHY

## Rationale

Ravi Apps need a repeatable starting point. Without a scaffold, agents and
humans have to remember the manifest shape, UI contract, skill location, specs,
and validation commands by hand.

The scaffold keeps app creation aligned with the ecosystem:

- manifests are discoverable by `ravi apps`;
- skills teach agents how to operate the app;
- specs capture durable rules;
- UI descriptors stay semantic;
- operations remain explicit and machine-readable.

## Decisions

- The scaffold writes files, so it is a mutating operation.
- The default target is a first-party repo app under `src/apps/<app-id>`.
- The generated skill lives under the internal `ravi-system` plugin for
  first-party system apps.
- Dry-run exists so agents can preview side effects before writing files.
- The scaffold creates contract files only. CLI/domain implementation happens
  after the contract is reviewed.
- The scaffold should prepare apps for runtime routing. The generated root
  command is an app-router alias, not a new static TypeScript command.
- Initial scaffold operations should prefer router builtins for help/show/check
  so a new app is inspectable before domain implementation exists.

## Rejected Alternatives

- Generating full CLI implementation immediately: rejected because domain logic
  needs app-specific modeling.
- Putting scaffold instructions only in chat: rejected because agents need to
  recover the protocol through `ravi apps`.
- Overwriting by default: rejected because app manifests and skills are durable
  product surfaces.
- Generating static CLI stubs for every scaffolded app: rejected because app
  routing should work at runtime without a CLI rebuild.
- Generating operations that call `ravi <app-id>` from inside the manifest:
  rejected because router-executed CLI operations would recursively dispatch
  themselves.
- Generating health checks that call arbitrary `ravi <app-id> ...` operations:
  rejected because non-health app operations can recursively dispatch
  themselves. The router-owned safe check `ravi <app-id> check --json` is
  allowed for `interfaces.cli.health`.
