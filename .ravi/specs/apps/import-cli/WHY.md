# Import CLI To Ravi App / WHY

## Rationale

Most useful Ravi Apps will start from existing CLIs. Requiring humans or agents
to hand-write the first manifest for every CLI repeats work the CLI already
knows: command names, arguments, flags, JSON support, examples, and health
checks.

However, CLI metadata is not the same as app design. A raw command tree often
contains debug commands, migration commands, one-off utilities, low-level
provider wrappers, and dangerous operations. A useful app should expose the
daily, permissioned, machine-readable operations that humans, agents, UIs, and
automations actually need.

The import path exists to generate the boring contract skeleton while forcing
explicit review for product, risk, storage, events, and UI decisions.

## Decisions

- Prefer self-describing CLIs over help parsing.
- Keep import as a draft generator, not an auto-install decision.
- Generate conservative operation candidates and review notes.
- Keep `ravi.app.json` as the app contract even when it is generated.
- Keep dynamic apps out of static SDK method generation by default.
- Import every executable operation through the source CLI; other caller
  surfaces use the generic App Router.
- Default child `context.allow` to empty because CLI metadata is not authority;
  infer only an exact `execute:group:<group>` when the generated operation
  directly calls `ravi <group>`, and keep that inference review-required.
- Allow `scaffold --from-cli` as an alias, but make `apps/import-cli` the
  normative behavior.

## Rejected Alternatives

- Hand-write every app manifest from scratch.
  This wastes CLI metadata and makes migration slow.
- Fully trust generated manifests.
  This hides product and permission decisions behind heuristics.
- Parse `--help` as the primary contract.
  Human help is not reliable enough for mutation, permissions, schemas, or UI.
- Generate one app operation per CLI command by default.
  This recreates the raw CLI instead of making an app.
- Generate static Ravi command files for imported apps.
  That makes runtime app installation build-time again.
- Generate SDK/tool/stream executors from source metadata.
  That turns one imported CLI into multiple drifting implementations.
