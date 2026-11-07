# Runbook

1. Build both matching Ravi and Fleet revisions. Keep the existing reviewed
   enrollment, runtime/issuer pins, dedicated socket permissions and restricted
   SSH account. The wire version changes; mixed bridge-v2/gateway revisions fail closed.
2. Apply the Console delivery metadata migration only in an approved rollout.
   No channel connector, production restart or permission change is implied.
3. Validate a disposable installation with two subjects: creation, send/retry,
   history, SSE reconnect, exact approval, cancellation, revocation and denial
   from ordinary local admin paths. Native model validation is a separate gate.
4. Session configuration additionally requires Console `runtime.sessions.configure`.
   Exposing another command requires a reviewed resource resolver and policy action;
   adding it to an installation's command catalog does not itself authorize it.
5. Investigate an uncertain operation using its original operation ID. Do not
   allocate a new ID and resend an effect. Keep receipt and execution journals.
6. Roll back both application revisions together if authorized. Disable admission
   before changing versions; preserve all data and let outstanding leases expire.
