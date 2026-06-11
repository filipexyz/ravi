# Tags / CHECKS

## Registry Schema

```bash
sqlite3 ~/.ravi/ravi.db ".schema tag_definitions" ".schema tag_bindings"
```

Expected:

- both tables exist;
- `tag_definitions.slug` is unique;
- `tag_bindings` has a unique constraint on `tag_id, asset_type, asset_id`;
- indexes exist for tag and asset lookup.

## CLI Smoke

```bash
ravi tags list --json
```

Expected:

- command returns `total` and `tags`;
- every item includes `slug`, `kind`, and `bindingCount`.

## Binding Smoke

Use a disposable test tag and a disposable or known-safe target.

```bash
ravi tags create smoke.tags --label "Smoke Tags" --json
ravi tags attach smoke.tags --agent dev --meta '{"reason":"smoke"}' --json
ravi tags search --tag smoke.tags --json
ravi tags detach smoke.tags --agent dev --json
```

Expected:

- attach creates one binding;
- repeating attach does not create duplicates;
- search finds the binding before detach;
- detach removes the binding.

## Observation Policy Smoke

Given a tag-scoped observer rule:

```bash
ravi observers rules explain --session <session> --json
```

Expected:

- source tags are visible;
- matched rules include the tag reason;
- inherited matches are only present when the rule allows inherited tags.

## Permission Policy Boundary Smoke

```bash
ravi tags search --tag policy.profile.trusted-dev --json
ravi permissions policies dry-run --json
```

Expected:

- policy tags do not grant authority by themselves;
- dry-run shows explicit relation tuples before any write;
- generated permission grants have `source=policy:<rule-id>`;
- auto-generated policy tags are ignored unless the permission policy rule
  explicitly accepts that source.
- `policy.*` bindings include trusted source, creator, created context, and
  binding id/version;
- re-attaching a `policy.*` tag does not silently overwrite trust provenance.

## Local Tag Debt Scan

```bash
rg -n "tags_json|\\btags\\b|--tag|--tags" src .ravi/specs docs -g '*.ts' -g '*.md'
```

Expected:

- each local tag field is either external/provider/frontmatter metadata or has a
  migration path to `tag_bindings`;
- new internal runtime policy does not read local tag arrays directly.

## Unbounded Output Check

```bash
ravi tags search --json
```

Expected:

- acceptable only for small registries or manual debugging;
- production-safe consumers SHOULD use filters and later pagination/limits.
