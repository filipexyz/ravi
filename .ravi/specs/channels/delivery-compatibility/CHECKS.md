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
  produce a supports cohort and allow all five fixture operations, even though
  that relative filename does not exist in the controller cwd. The publisher's
  argv1Raw MUST equal the kernel value exactly; changing raw spelling is rejected.
- A script that actually differs from the expected bundle MUST produce an
  unsupported cohort and zero recovery, pull, claim, send and prune callbacks.
  Replacing the declared bundle by a symlink to another script (even with the
  same bytes) MUST also be unsupported.
- Removing the absolute bundle after boot MUST return unknown with an ENOENT
  diagnostic, without throwing from verification or inspect/acquire. Both real
  consumers MUST keep all five operation counters at zero. Repairing the file
  MUST NOT revalidate a permit previously rejected during this failure.
- Removing only an empty consumer cwd MUST NOT invalidate a boot whose absolute
  bundle is intact: controller verification does not observe/resolve raw cwd.
- Run focused tests with the production-state blocking preload:
  `bun test --timeout 20000 --preload ./src/test/isolated-runtime-preload.ts src/channels/delivery-contract.test.ts src/channels/delivery-boot.test.ts src/channels/delivery-activation.test.ts`.
