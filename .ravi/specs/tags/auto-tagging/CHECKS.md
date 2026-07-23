# Auto-Tagging Rules / CHECKS

## Checks

- Rule validation MUST reject conditions outside the declared scope vocabulary.
- Apply targets MUST be reachable from the rule scope; unrelated asset tagging
  MUST fail validation.
- Reactive evaluations of the same state MUST NOT emit duplicate timeline
  events.
- Disable rule MUST stop future apply/remove actions while preserving existing
  audit history.
- Cycle guard MUST detect re-entry and report cascade depth instead of crashing
  or looping.
- Auto-tagging MUST NOT mutate access policy, lifecycle, or runtime routing.
- `ravi tag-rules validate` SHOULD pass for valid rules and fail for invalid
  scope/target combinations.
- `ravi tag-rules explain --target <type:id> --json` SHOULD explain the
  matched conditions and planned tag changes without mutating state.
