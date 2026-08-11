# Cron agent-first CLI contract / CHECKS

## Checks

- `cron show <unknown-id> --json` MUST exit 1 with the `CRON_JOB_NOT_FOUND`
  envelope and up to three `suggestions` of real, scope-visible job ids/names.
- An invalid flag on any `cron` op MUST exit 2 with `acceptedFlags` in the
  envelope.
- `cron rm` without `--execute` MUST exit 3, MUST report `dryRun: true` with
  the job `plan`, and MUST NOT delete anything; with `--execute` the delete
  MUST happen and `ravi.cron.refresh` MUST be emitted.
- `cron run` without `--execute` MUST exit 3, its `plan` MUST show the resolved
  job id, execution/schedule types, and message/command presence or length, but
  MUST NOT show the job name, message, schedule text, or shell command. It MUST
  NOT emit `ravi.cron.trigger`; with `--execute` the trigger MUST be emitted.
- A braked op invoked with `RAVI_*` envs present (agent context) MUST still
  exit 3 with the envelope — the registry dispatcher MUST preserve
  `ContractError.exitCode` instead of the generic exit 1.
- `cron list --fields a,b,c --json` MUST return `items` (and `jobs`) containing
  only the requested fields.
- Unbraked writes (`add`, `set`, `enable`, `disable`) MUST keep
  immediate-write behavior, and the shipped `cron` skill MUST list them
  explicitly as unbraked.
- `bun test src/cli/commands/cron-commands.test.ts` SHOULD pass after any
  change to the cron contract surface.
