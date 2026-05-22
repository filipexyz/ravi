# Runtime Prompt Rules / RUNBOOK

## Debug Flow

Use this flow when a runtime session appears to ignore `.ravi/rules`.

1. Confirm the session cwd.

   Task sessions use the effective agent/session cwd, not necessarily the git checkout where the operator is standing.

2. Inspect the rules directory.

   ```bash
   rg --files <session-cwd>/.ravi/rules
   ```

   Hidden files, empty files, and unsupported extensions are intentionally ignored.

3. Inspect the built prompt path.

   The canonical builder is `buildRuntimeSystemPrompt()` in `src/runtime/runtime-system-prompt.ts`. It should include a section with `id=ravi.rules` when rules exist.

4. Inspect traces for a real runtime turn.

   The `adapter.request` trace should include `system_prompt_section_metadata` with:

   ```json
   {
     "id": "ravi.rules",
     "title": "Ravi Rules",
     "source": "<session-cwd>/.ravi/rules"
   }
   ```

5. Check provider fallback only if the runtime prompt did not already contain `## Ravi Rules`.

   Codex may inject rules as fallback, but it must skip injection when the runtime prompt already includes the section.

## Common Fixes

- If rules are absent, add text rule files under `<session-cwd>/.ravi/rules`.
- If rules already exist in provider folders, inspect import sources:

  ```bash
  ravi rules sources all --cwd <session-cwd> --json
  ravi rules sources all --cwd <session-cwd> --include-user --json
  ```

- Import provider project rules with an explicit write:

  ```bash
  ravi rules import all --cwd <session-cwd> --write --json
  ```

- Import user-level rules only with explicit opt-in:

  ```bash
  ravi rules import claude --cwd <session-cwd> --include-user --write --json
  ```

- If rules exist under the repository but the task uses another agent cwd, copy or link the intended rule files into that agent cwd.
- If the section is duplicated, fix provider fallback detection before changing rule content.
- If hidden files appear in the prompt, fix `src/runtime/ravi-rules.ts`; do not rename sentinel files to work around the loader.
- If imported files already exist, review the diff and re-run with `--force` only when overwriting is intended.
