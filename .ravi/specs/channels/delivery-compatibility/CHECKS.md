# Delivery compatibility checks

- `delivery-contract.test.ts` verifies exact-version comparison, required
  features, malformed/absent floors and readonly inspection without creation.
- `delivery-boot.test.ts` verifies self publication and independent live OS
  process/bundle observation, orphan evidence and identity mismatches.
- `delivery-activation.test.ts` launches two real ready subprocesses with valid
  Threads readiness but protocol 1 against active 2 in one member. Both MUST
  report zero recovery, pull, claim, send and prune, with uncertain present and
  absent; the installed database MUST remain unchanged.
- The aggregate tests MUST reject missing declarations and orphan files, and
  revoke an existing permit after a real child is replaced or the floor changes.
- Only a newly acquired permit for the supporting replacement cohort may invoke
  the five isolated fixture callbacks; no real provider or broker is contacted.
- A real consumer started with a relative script from another directory MUST
  produce a supports cohort and allow all five fixture operations. Absolute and
  symlink spellings of the same entrypoint MUST verify as well.
- A script that actually differs from the expected bundle MUST produce an
  unsupported cohort and zero recovery, pull, claim, send and prune callbacks.
- Removing an observed entrypoint MUST produce an explicit observation error
  preserving its cause, not silent unknown. Revalidation MUST invalidate its
  permit, even if the path is restored; no callback may execute on that permit.
- Removing only the empty cwd of a live isolated consumer MUST report
  `PROCESS_CWD_UNAVAILABLE` with its cause from both process and boot observers.
- Run focused tests with the production-state blocking preload:
  `bun test --timeout 20000 --preload ./src/test/isolated-runtime-preload.ts src/channels/delivery-contract.test.ts src/channels/delivery-boot.test.ts src/channels/delivery-activation.test.ts`.
