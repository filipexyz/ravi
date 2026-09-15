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
- The default scaffold creates a thin runnable `cli.ts` so the public alias can
  prove real process execution immediately. Domain implementation still happens
  after the contract is reviewed.
- The generated CLI command identifies the real app executable. The root
  `ravi <app-id>` surface is derived by the router.
- Child capabilities start empty because generation cannot safely infer what
  authority an app should receive.
- The scaffold should prepare apps for runtime routing. The generated root
  command is an app-router alias, not a new static TypeScript command.
- Initial scaffold operations should prefer router builtins for help/show/check
  and use the thin CLI for a read-only `list`, so a new app is both inspectable
  and invokable before domain implementation exists.

## Rejected Alternatives

- Generating full domain logic immediately: rejected because product behavior
  needs app-specific modeling.
- Putting scaffold instructions only in chat: rejected because agents need to
  recover the contract through `ravi apps`.
- Overwriting by default: rejected because app manifests and skills are durable
  product surfaces.
- Generating a new static Ravi command for every app: rejected because the
  dynamic root alias is derived from the manifest and App Router.
- Generating SDK/tool/stream implementations: rejected because they would
  duplicate the app CLI instead of calling the generic App Router.
- Generating operations that call `ravi <app-id>` from inside the manifest:
  rejected because router-executed CLI operations would recursively dispatch
  themselves.
- Generating health checks without a real CLI health contract: rejected because
  the scaffold cannot prove that an invented command is safe or implemented.
- Using `ravi <app-id> check` as `interfaces.cli.health`: rejected because
  router `check` validates metadata and would recurse if executed as app
  health.
