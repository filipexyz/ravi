# Ravi App Builder / CHECKS

## Checks

- The builder skill MUST validate with the canonical skill validator.
- Claude, Codex, and Pi MUST advertise the app builder skill through their
  declared skill-visibility mechanisms.
- Pi MUST return an empty loaded-skill vector until it observes an explicit
  skill load.
- `ravi apps scaffold <app-id> --dry-run --json` MUST return the builder skill,
  builder spec, and complete review checklist without writing files.
- `ravi apps import-cli <command> --id <app-id> --dry-run --json` MUST label its
  output as a draft requiring review.
- Missing authentication MUST fail before provider network access.
- The App Router MUST reject an undelegable child capability before spawning
  the app CLI.
- A public `ravi <app-id> <operation> --json` call MUST reach the real CLI and a
  deterministic fake provider.
- Google Search Console and Open-Meteo reference briefs MUST remain present and
  MUST use the same generic builder workflow.
- The Apps contract drift eval MUST fail when a registry command is absent from
  guide guidance, the system skill, or the root Apps spec.
- The Apps contract drift eval MUST fail when builder links or either reference
  acceptance case are removed.
- Typechecking, formatting, generated contract checks, focused tests, and the
  full suite MUST pass before readiness is claimed.
