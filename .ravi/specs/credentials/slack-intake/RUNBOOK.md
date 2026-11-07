# Request a credential

Use a Slack-sourced authenticated turn on a configured direct Socket Mode account.
The agent needs `mutate:credentials.requests:<target>`, and the linked human needs
`mutate:credentials.secrets:<target>`. The request command requires its concrete
target capability, including for an otherwise administrative caller. Provision
permission separately through the existing approval process;
this command never grants it.

```bash
ravi credentials request env:ANTHROPIC_API_KEY --user UEXAMPLE --reason "Enable the requested API access" --json
ravi credentials request env:ANTHROPIC_API_KEY --user UEXAMPLE --reason "Enable the requested API access" --json --execute
ravi credentials request connection:slack:secondary --user UEXAMPLE --reason "Access the requested workspace" --label "Secondary workspace" --json --execute
```

The first command is a dry-run (exit 3). The recipient opens the ephemeral button,
checks the destination and supplies the API token. A Slack connection shows
separate app-token and bot-token fields; the handler assembles the existing
provider format internally.
Never put token examples with real values in commands, chat or diagnostics.

On expiry, cancellation or failed submission, request a fresh invitation. Existing
targets are refused: rotation remains a separate protected operation. Provider
secrets default to private local files (0700 directory, 0600 files), on Linux and
macOS. Keychain and Vault are optional `--backend` choices. Keychain's stdin
command has a native 4096-byte line limit; larger bundles use file or Vault.
After an env write, reconcile the managed processes through the existing restart
workflow; storage success does not prove runtime activation.

Inspect `credential_intake_requests` and `credential_intake_audit` for states and
fingerprints only. Do not dump secret stores or raw Slack envelopes. An interrupted
pending write requires operator reconciliation before another request for the
same target; never retry a write blindly when its outcome is unknown.

Rollback: revert the feature and stop issuing requests. No routes, agents, grants
or live credentials are changed by deployment. Previously stored secrets remain
owned by their normal env/credential backend lifecycle.
