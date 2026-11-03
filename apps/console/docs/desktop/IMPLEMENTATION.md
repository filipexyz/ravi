# Original Desktop host

Fleet serves the complete ravi-desktop Vite artifact at `/desktop/<org>`, outside
Next layouts and Console tabs. OIDC session and organization membership gate the
HTML; assets require an authenticated session. The artifact manifest pins a clean
source revision and SHA-256 for each allowed asset; missing or modified files fail
closed. CSP permits only this origin's scripts and API transport.

Prepare a reviewed artifact before building the image:

```sh
RAVI_DESKTOP_BUN=/path/to/compatible/bun bun scripts/prepare-desktop.ts /path/to/clean/ravi-desktop FULL_COMMIT_SHA
bun run build
```

`.desktop` is generated and ignored by Git. Release packaging must include it and
record its manifest independently from the Fleet source SHA. Dockerfile.selfhost
copies it into the runtime image. A Console build without an artifact still runs
but returns 503 for Desktop. No source fetch, branch fallback or UI reconstruction.

Bootstrap selects current subject/org/project/installation using existing gateway
options. The people directory exposes only policy-eligible active members; a
non-directory reader gets only themselves. Team creation requires bridge send and
project write, validates all chosen people/agents, and repeats this validation
following signer I/O. Signed participants create a new explicit Ravi roster,
never converting a private conversation.

The gateway has finite mappings for Desktop work/session/computer/loops/channels.
Conversation read, runtime.sessions.configure and organization.installations
read/manage are distinct existing policy decisions. No default grant is expanded.
Personal connectors keep the existing session/feature/owner/OAuth paths; provider
availability derives from the same shared implemented-provider registry as Console.

Validation: isolated Postgres policy tests, paired real Ravi gateway test, and
`bun tests/fleet/run-postgres.ts --desktop-browser` with local PG/Next/OIDC/Chrome.
The browser test uses the actual pinned artifact and gateway response fixtures;
it is not proof of a real model or private SSH deployment. Private acceptance is
recorded separately in the console-infra staging runbook. No merge is authorized.
