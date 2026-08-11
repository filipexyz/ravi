# Settings agent-first CLI contract / CHECKS

## Checks

- `settings get <unknown-unset-key> --json` MUST exit 1 with the
  `SETTING_NOT_FOUND` envelope and up to three `suggestions` drawn from known
  keys plus keys actually set.
- `settings get` of a known-but-unset key MUST keep its informational read
  (exit 0 with the default shown), and legacy `account.*` reads MUST keep the
  `ravi instances` hint.
- `settings delete <set-key>` without `--execute` MUST exit 3, MUST report
  `dryRun: true` with a `plan` carrying only
  `key`/`valuePresent`/`legacy`/`known`, MUST NOT expose the current value, and
  MUST NOT delete the row nor emit `ravi.config.changed`.
- `settings delete <unset-key>` MUST exit 1 with `SETTING_NOT_FOUND` even
  without `--execute` — validation fires before the brake, never exit 3.
- `settings delete <set-key> --execute` MUST delete the row and emit
  `ravi.config.changed`.
- `settings list --fields a,b,c --json` MUST return `items` containing only
  the requested fields.
- `settings set` MUST keep immediate-write behavior (unbraked, declared) and
  MUST keep rejecting legacy `account.*` writes with the instances hint. CLI,
  tool and gateway audits MUST retain the setting key but replace its value
  with `[REDACTED]`, including custom keys such as `custom.password`.
- The `settings.test.ts` mock of `../context.js` MUST export
  `hasContext: () => true` or contract helpers exit the test process.
- `bun test src/cli/commands/settings.test.ts` SHOULD pass after any change to
  the settings contract surface.
