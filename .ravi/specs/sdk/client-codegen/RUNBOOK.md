# Client Codegen — Runbook

1. Reproduce an argument-name failure with a small decorated mock registry in
   `src/sdk/client-codegen/codegen.test.ts`, rather than changing a live command.
2. Compare parameter identifiers, body value references, and raw body keys
   independently. Check `src/sdk/gateway/dispatcher.ts` before changing any wire
   name; check Swift/Dart emitters for the same contract.
3. Run the focused codegen suite. A syntax/import failure points to emitted
   source; a runtime reference or value mismatch points to symbol binding.
4. Regenerate SDK artifacts only when the production registry projection changes
   the output. Never hand-edit generated clients to conceal generator drift.
5. Validate the spec tree and generated drift in isolation/CI. On the production
   host, use the coordinated focused-test slot and sanctioned Git Data API
   publication path, retaining pre-commit hooks. Do not run the full build/suite.
6. Verify the PR Quality Gate on its exact head SHA and its active CI follow.
   Record focused checks and root typecheck limitations in the PR description.

Revert the generator, tests, spec, and any derived changes together if rollback
is required. This fix does not change gateway validation or request keys.
