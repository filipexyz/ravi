# Checks

- `src/permissions/contact-merge-grants.test.ts`: ordinary grant moves on merge; break-glass grant (admin:system:*, admin:system:<narrow>, execute:executable:*) is dropped; duplicate kept once; boot repair follows the merge chain, drops break-glass, removes never-merged orphans, is idempotent and leaves live contacts alone.
