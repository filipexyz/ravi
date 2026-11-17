# Operate a remote credential destination

The CLI, transport and helper are implemented in this change. They are not
installed or configured on a remote server by deployment. All values below are
placeholders; no credential value belongs in these commands or the agent chat.

## 1. Discover metadata and register explicitly

Use a simple, literal alias in a local SSH config. Discovery does not connect,
load includes, run commands or inherit a personal SSH identity. Dynamic/proxy
configuration is unsupported in this first profile; provide a separate simple
config for this destination rather than weakening the transport.

```bash
ravi credentials destinations discover --config /absolute/operator/ssh-config --json
ravi credentials destinations register api-prod --ssh-alias api-host --config /absolute/operator/ssh-config --host-key "ssh-ed25519 <VERIFIED_SERVER_PUBLIC_KEY>" --identity-file /absolute/private/api-writer-key --user apiwriter --path /srv/api/.env --remote-target api --keys PAYMENTS_API_TOKEN --label "API production" --json
```

The register command validates and prints a safe plan with exit 3. The host and
port come from the alias; the service user and dedicated key are required
separately. Verify the server key through an existing trusted channel; an
unauthenticated `ssh-keyscan` result alone does not verify the server identity.
When the operator approves this exact boundary, repeat with `--execute`.
Registration is add-only and installs no credentials, grants or remote files.

```bash
ravi credentials destinations list --json --limit 30
ravi credentials destinations list --json --limit 30 --cursor <nextCursor>
ravi credentials destinations show api-prod --json
ravi credentials destinations export-helper --out /absolute/operator/ravi-credential-writer --json
```

Listing returns `items`, the returned `total`, and `page` metadata. Use
`page.nextCursor` for continuation; the default is 30, the maximum is 500, and
ordering is by destination ID ascending. An empty or final page has no next
cursor. Registration between pages does not duplicate already visited IDs.

Helper export creates a new local executable file and refuses overwrite. It
does not transfer or install the helper. The following provisioning is an
operator deployment action after selecting the real destination.

## 2. Provision a restricted receiver

Use a Linux/POSIX receiver with Python 3. The application/service identity that
owns and consumes the mode-0600 env file may serve as the dedicated writer
identity; it must not be the agent tool execution identity. The agent must not
have an alternate shell, sudo, ability to modify that application's executable
code, or another way to make the application disclose its environment.

Install the exported helper at `/usr/local/libexec/ravi-credential-writer`,
owned by root and not writable by the writer or agent. Install policy at the
fixed `/etc/ravi/credential-writer.json`, outside every agent checkout, owned by
root and not group/world writable. Keep its parent directories operator-owned.

Example policy (metadata only):

```json
{
  "version": 1,
  "stateDir": "/var/lib/ravi-credential-writer",
  "targets": [
    {
      "id": "api",
      "envPath": "/srv/api/.env",
      "keys": ["PAYMENTS_API_TOKEN"],
      "profile": "dotenv-single-line-v1"
    }
  ]
}
```

The service identity owns the state directory (0700), its files (0600), and the
env file (0600). No symlinks or hardlinks are allowed. The destination directory
must permit the service identity's atomic replacement while remaining unwritable
by the agent or unrelated users. A config entry never grants filesystem rights.

Make the receiver the exclusive writer of this env file. The application reads
it, and deployment tools must leave it in place. An additional writer is allowed
only if it acquires the same receiver lock for its complete read/write operation.
Otherwise stop and coordinate writes before editing; do not run an independent
deployment/template rewrite alongside intake. Version checks catch changes seen
before commit but cannot provide atomic compare-and-swap against an editor that
ignores the lock between the last check and rename. Root/host administrators can
bypass these controls and are outside the guarantee.

Use a new SSH key dedicated to this operation. Keep its private half accessible
only to the trusted intake/transport service, not to agent tools. Keep authorized
public keys in an operator-owned location; do not let the agent add another key.
For this key use the restricted forced-command form:

```text
restrict,command="/usr/local/libexec/ravi-credential-writer" ssh-ed25519 <DEDICATED_WRITER_PUBLIC_KEY>
```

Enforce the same restriction for the whole service account, for example through
an operator-managed `sshd_config` Match User block:

```text
Match User apiwriter
    ForceCommand /usr/local/libexec/ravi-credential-writer
    DisableForwarding yes
    PermitTTY no
    PermitUserRC no
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AuthorizedKeysFile /etc/ssh/authorized_keys/%u
```

Review these settings against the host's OpenSSH configuration before applying.
The helper reads only its fixed policy path and ignores `SSH_ORIGINAL_COMMAND`.
Do not install a generic shell wrapper, copy env files with SCP, or pass a secret
through a remote command line.

## 3. Request, commit and recover

Provision the existing exact issuer/human permissions separately. The agent
requests the registered remote destination/key through the private Slack intake;
the human verifies environment, host, file and variable before entering a token.
There is no agent-facing command to supply or retrieve the value.

```bash
ravi credentials request remote:api-prod:PAYMENTS_API_TOKEN --user UEXAMPLE --reason "Configure the requested payment integration" --json
ravi credentials request remote:api-prod:PAYMENTS_API_TOKEN --user UEXAMPLE --reason "Configure the requested payment integration" --json --execute
```

The fixed transport performs preflight and prepare with metadata. The receiver
binds target, key, request, file version, destination version and expiry to a
single-use nonce. Commit sends the secret only on the same private connection
after the handler revalidates authorization. The writer accepts 1–8192 bytes in
the single-line ASCII token alphabet `[A-Za-z0-9._:/+=-]`, with a 1 MiB env file
limit. Unsupported content or an existing key requires a separate operator
workflow. Frames and lock acquisition time out after five seconds; request TTL
is at most ten minutes. The bounded receiver ledger refuses new work at capacity
instead of silently dropping replay/recovery records.

On timeout or lost acknowledgement, reconcile by the original request ID:

```bash
ravi credentials request-status remote:api-prod:PAYMENTS_API_TOKEN <requestId> --json
```

This is an authorized mutation, not an unrestricted status lookup: it checks the
same agent/session/channel/thread and live human authority, reconciles intake
state, and can create a durable receiver fence for a missing/reserved request.
`not_found` becomes failure only after that fence prevents a delayed prepare.
A stored receipt is success even when UI delivery failed. `uncertain` means
verify durable state through the trusted service before any fresh request;
never ask the agent to read the env or retry a write blindly. Lock/version
conflicts preserve the existing file and require a fresh preflight/request.

Saving is not activation. Reload the application through its existing controlled
deployment procedure and verify its health without dumping the environment.
Neither registration nor intake restarts any service automatically.

## Rollback

Stop issuing invitations and remove the dedicated transport authorization through
the operator's normal process. Reverting the code does not erase credentials or
receiver audit/state. Do not delete the env, overwrite another variable or remove
recovery state as a shortcut. Existing secrets keep their application lifecycle.
