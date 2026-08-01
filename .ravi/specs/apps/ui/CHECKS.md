# Ravi App UI Contract / CHECKS

## Checks

- `ravi specs get apps/ui --mode rules --json`
  - Confirms the UI contract is indexed and retrievable.

- UI interface check
  - Fail if `interfaces.ui` exists and is not an object.
  - Fail if `routes` or `views` exists and is not an array.
  - Fail if routes omit `id`, `path`, `label`, or `view`.
  - Fail if routes omit design-system `icon`.
  - Fail if route paths do not start with `/apps/`.
  - Fail if a route references an undeclared view.

- UI view check
  - Fail if a view omits valid `id` or primitive `type`.
  - Fail if `density`, `layout`, `components`, `query`, `refreshOn`, or
    `actions` have invalid shapes.
  - Fail if `uiArtifact` is present and does not declare a supported
    `kind`, valid `artifactId`, and valid optional `version`.
  - Fail if `refreshOn` contains malformed event topics.
  - Fail if a query references an undeclared operation.

- UI action check
  - Fail if actions omit `id`, `label`, or `operation`.
  - Warn if actions omit design-system `icon`.
  - Fail if actions reference undeclared operations.
  - Fail if action placement is outside the supported design-system placements.

- Operation check
  - Fail if `operations` exists and is not an object.
  - Fail if operation ids are not fully qualified dot ids.
  - Fail if operation `interface` is not `cli` or `builtin`.
  - Fail if CLI operations omit command.
  - Fail if builtin operations omit an allowlisted handler.
  - Warn if operations omit `mutating`.
  - Warn if CLI operations do not indicate machine-readable JSON output.

- Router boundary check
  - Confirm UI queries and actions invoke the generic App Router.
  - Confirm UI invocation and CLI alias invocation resolve the same operation.
  - Confirm both paths enforce caller authorization and issue the same bounded
    child-context class.

- Design-system boundary check
  - Fail if UI declarations include raw CSS, HTML, JavaScript, component,
    bundle, class name, style, stylesheet, or Tailwind keys.
