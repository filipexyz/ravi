---
id: credentials/remote-env
title: Restricted remote credential env writer
kind: capability
domain: credentials
capabilities:
  - remote-env
  - destination-registration
tags:
  - credentials
  - security
  - ssh
applies_to:
  - src/credentials/remote
  - src/cli/commands/credential-destinations.ts
  - src/cli/commands/credential-destinations.test.ts
  - src/credentials/intake.ts
  - src/channels/slack/credential-intake.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Restricted remote env writes

## Status and scope

The implementation ships a destination registry, a metadata-only administration
CLI, restricted SSH transport and a standalone receiver helper. Shipping this
code MUST NOT install a helper, create service accounts/SSH keys, expand grants,
register a real destination, write live credentials or activate an application.
The first receiver profile is `dotenv-single-line-v1`: add one allowlisted API
token key, preserving every unrelated byte. Rotation is a separate operation.

## Authority and destination identity

- The agent MUST supply only destination/key metadata. The secret MUST travel
  from the authenticated private intake handler directly to the fixed transport,
  never through model messages, agent tools, shell arguments, environment,
  artifacts, generic output, database rows or intermediary local `.env` files.
- Registration MUST require explicit dedicated service user, dedicated SSH
  identity path, verified host public key, exact absolute env path, receiver
  target ID and allowed variable names. Personal SSH `User` and `IdentityFile`
  MUST NOT become write authority through discovery.
- Alias discovery MUST parse bounded local config as data. It MUST NOT invoke
  SSH, `ssh -G`, `Match exec`, `Include`, proxy commands or local commands.
  Unsupported/dynamic configuration MUST be refused explicitly.
- Registry IDs MUST be add-only and versioned. An invitation MUST bind the
  destination version and complete target shown to the human; changing metadata
  MUST invalidate the invitation, not silently redirect the secret.
- Sender and receiver MUST enforce exact host/target/path/key policy. An SSH
  login by itself is not authorization to choose a path or overwrite a key.
- `credentials destinations` operations MUST remain `@CliOnly`, with explicit
  access and return contracts. `register` expands the trusted destination set
  and MUST require `--execute`; all safe validation MUST precede its dry-run.
  `export-helper --out` only creates a new local file and MUST refuse overwrite.
- Listing and inspection MUST expose safe metadata, omitting the private key
  path. No command in this group accepts a secret value, stdin secret or generic
  remote command. Registration MUST NOT install permission grants.

## SSH and receiver boundary

- Transport MUST use a fixed executable/argv, explicit host/port/service user,
  pinned host key and a dedicated identity, independent of personal SSH config.
  Agent forwarding, multiplexing, arbitrary commands, proxying and interactive
  authentication MUST NOT provide an alternate path.
- Receiver execution MUST be a forced command for a restricted account/key.
  The helper MUST ignore `SSH_ORIGINAL_COMMAND` and read only the fixed
  `/etc/ravi/credential-writer.json` policy, which MUST be operator-controlled
  outside the agent checkout and unmodifiable by the agent.
- The receiver MUST validate its policy, private state directory, exact env
  file and path components; symlinks, hardlinks, wrong owner, permissive modes
  and unsafe writable parent directories MUST fail closed.
- The process that runs agent tools MUST NOT have read access to the secret
  file or receiver state, write access to the helper/policy/SSH authorization,
  unrestricted SSH access, sudo/root, or application execution paths that can
  exfiltrate the loaded credential. Mode `0600` does not isolate the same UID.
  This is an installation condition, not a guarantee made by registration.

## One-key write and recovery

- The receiver MUST operate on one allowlisted key under a lock for the whole
  env file. It MUST compare the expected version under that lock and re-check
  key absence before commit. Existing keys, duplicate/ambiguous assignments,
  unsupported dotenv syntax and non-roundtrippable values MUST be refused.
- The receiver MUST be the exclusive writer of that env file, or every other
  writer MUST participate in the same lock protocol. Applications and deployment
  tools MUST NOT edit or replace the file independently. Version comparison
  detects drift observed before commit; it is not an atomic filesystem CAS
  against a noncooperating writer between the final check and rename. Host
  administrators/root are outside the isolation and concurrency guarantee.
- The receiver MUST preserve unrelated bytes, write a private temporary file
  in the destination directory, flush it, atomically publish and flush directory
  metadata. A successful receipt MUST correspond to durable commit evidence.
- Prepare/commit MUST bind request ID, target/key, expected file version,
  destination version, expiry and a single-use nonce on the same connection.
  Current issuer/human authorization MUST be rechecked before commit.
- Request IDs MUST support bounded status and idempotent replay. Timeout after
  commit or crash ambiguity MUST produce stored/uncertain status, never an
  unconditional fresh write or an assertion that a known write failed.
- `credentials request-status <target> <request-id>` MUST be classified as a
  mutation: it reconciles intake state and may durably fence a missing/reserved
  receiver request. It MUST require the same agent, session, channel/thread and
  currently authorized human as the original request. `not_found` may become
  terminal failure only after the receiver has durably fenced that request ID,
  preventing a delayed prepare from writing after the status response.
- Receipts MUST contain only opaque request/receipt/version metadata and the
  storage outcome. Raw file hashes/secret digests MUST NOT become public
  low-entropy guessing oracles. Secret-bearing failures MUST expose fixed codes,
  never raw stdout, stderr, parser input or nested error payloads.
- Saving MUST NOT restart the application. Success means stored; activation
  remains explicitly pending the normal operator deployment/reload process.

## Acceptance

The focused tests in `CHECKS.md` MUST pass without contacting a real host or
using real secrets. The implementation can ship independently of provisioning;
claims of end-to-end production readiness require a selected destination,
operator-installed restricted helper/policy and verified OS/SSH isolation.
