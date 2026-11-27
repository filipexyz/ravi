# NATS Role Credentials / RUNBOOK

## Debug Flow

1. A process fails to connect with `NatsCredentialError`: read the file it names under `<state>/nats/`; fix the mode with `chmod 600` or rewrite the credentials. Do not delete the file to get around it on a locked server: the process would lose access.
2. The daemon log line `Connected to NATS` says `role` and `authenticated`. `authenticated: false` on a host that has credentials means the file for that role is missing.
3. Before locking, confirm daemon, channels and Omni connect with a credential. Keep the previous `server.conf` to roll back.
4. To roll back a lock, restore the previous `server.conf` and restart `ravi-nats`; clients reconnect on their own.
