# Client Codegen — Decisions

## Separate local identifiers from request keys

The TypeScript emitter once used raw positional argument names as both method
parameters and object shorthand. A declaration such as `@Arg("request-id")`
therefore emitted invalid TypeScript in both places. The drift check accepted
that output because it faithfully matched the generator; the root typecheck did
not prove validity of the generated package because its include is `src/**/*`.

Normalize local names with the existing TypeScript `camelCase` helper. Preserve
raw wire keys using explicit property/value mappings when the spellings differ.
The gateway's `normalizeBody` and `validateAndPack` use raw `arg.name`, as do
input schemas, OpenAPI, and the Swift/Dart body emitters. Renaming body keys would
silently break the request contract: `requestId` is not `request-id`.

Normalization can collapse `artifactId`, `artifact_id`, and `artifact-id` into
one spelling. Allocate in registry positional-index order, reserving `options`
only when the generated method needs an options bag. Prefer the normalized base
name; if already used, try `_2`, `_3`, etc. until unused. Thus the fixture emits
`artifactId`, `artifactId_2`, `artifactId_3`, while an argument named `options`
becomes `options_2` when a trailing bag exists. Ordinary option fields are inside
that bag and do not occupy parameter bindings. Each case has a separate runtime
regression. Suffixes never change registry, schema, or request keys.
Keep shorthand for unchanged names to avoid unrelated generated-source churn.

An ASCII identifier regex is insufficient for parameter bindings: normalization
can turn a valid `Class` or `Await` spelling into a reserved word. Validate the
normalized binding against strict/module/async restrictions and fail generation
with the command and argument name. Keep this check separate from property name
validation, where keywords are legal.

Execute the emitted fixture through a recording transport as well as importing
it. Parsing alone cannot detect a valid but unbound body reference, and string
snapshots alone do not establish that consumers can load the client. This uses
Bun's existing TypeScript module loader without a new toolchain or CI job.
