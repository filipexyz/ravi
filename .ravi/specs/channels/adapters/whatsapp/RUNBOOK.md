# WhatsApp Adapter Runbook

## NATS Ownership Warning (read first)

On every host upgraded from an Omni-based install, the PM2 process `omni-nats`
**is Ravi's NATS**. It holds `SESSION_PROMPTS`, `RAVI_EVENTS` and
`CHANNEL_INBOUND`, and Ravi connects to `nats://127.0.0.1:4222`.

- **Never** stop, delete or restart `omni-nats` (no `pm2 stop|delete|restart omni-nats`).
- **Never** run `omni stop` (it stops `omni-nats` too), `omni start`,
  `omni restart` or `omni install` (`install` deletes and recreates `omni-nats`).
- The only Omni-side commands this runbook uses are
  `omni instances disconnect <uuid>` and, optionally, `pm2 stop omni-api`.

`ravi setup` follows the same rule: it reuses whatever NATS already answers
(`omni-nats` on those hosts) and starts its own `ravi-nats` (PM2, nats-server
2.11.8) only when nothing answers. `ravi daemon status` shows which process
owns NATS (`infrastructure.nats.processName` in `--json`).

## Prerequisites

- NATS answers on the NATS URL (`ravi-nats` or, on upgraded hosts, `omni-nats`).
- `ravi daemon start` is running. It consumes `CHANNEL_INBOUND` and relays QR
  codes to the CLI.
- `ravi channels start` is running (PM2 process `ravi-channels`). The daemon
  does not start it. Start or restart it after the daemon: the runner refuses a
  bundle that differs from the live daemon's.
- `ffmpeg` is on the runner's PATH for voice notes; `sharp` is installed for
  sticker conversion.

## New Account

1. Connect:

   ```bash
   ravi instances connect <name> --agent <agent>
   ```

   This mints the instance UUID, creates the `channels` row (provider
   `whatsapp`, named `<name>` or a sanitized name with `defaults.instance`),
   emits `ravi.config.changed`, retries for up to 15 s while the runner hot-adds
   the channel, and prints QR codes until the phone links (120 s).
2. Scan the QR code from WhatsApp > Linked devices. `--json` returns on the
   first QR code.
3. Verify:

   ```bash
   ravi instances status <name> --json   # transport "whatsapp", status "connected"
   ravi channels status                  # runner ready, <name> connected
   ```

4. Send a DM to the account and confirm the agent answers.

## Upgrade A Host That Served WhatsApp Through Omni

Read the NATS ownership warning first. Migrate in a planned window: between
step 3 and step 5 each instance is silent (see below).

1. Deploy the new bundle. The first process that opens the router DB:
   - creates `channel_group_metadata` and copies the old `omni_group_metadata`
     rows once (the old table is kept);
   - backfills a `channels` row (provider `whatsapp`, enabled = instance
     enabled) for every canonical-WhatsApp instance, keeping its
     `instances.instance_id` (the Omni UUID). The channel name may be sanitized;
     `ravi channels list` shows it.
   A daemon still running the old bundle keeps working until it restarts.
2. Disable the instances you will not migrate now, so the runner does not hold
   them in `pairing_required`:

   ```bash
   ravi instances disable <name>   # also disables its WhatsApp channel
   ```

3. Restart both processes on the same bundle, daemon first:

   ```bash
   ravi daemon restart -m "whatsapp runner upgrade" && ravi channels restart
   ravi daemon status              # runtime alignment; nats owner
   ```

   - Start order does not lose events: both processes create `CHANNEL_INBOUND`
     and the `ravi-whatsapp-*` durables.
   - From now on the daemon ignores every Omni WhatsApp event (log: "Ignoring
     Omni event for a WhatsApp channel type; migrate with ravi instances
     connect").
   - The runner starts one runtime per enabled, bound instance in
     `pairing_required` (no creds yet, no socket). `ravi channels status`
     reports the runner as `starting` until every enabled WhatsApp instance is
     paired. This is expected.
4. Stop the instance on the Omni side:

   ```bash
   omni instances disconnect <uuid>
   ```

   If no Telegram/Discord instance uses Omni you may also run
   `pm2 stop omni-api`. **Never** touch `omni-nats`. Optionally remove the old
   linked device on the phone (WhatsApp > Linked devices).
5. Pair on the runner and scan the QR code:

   ```bash
   ravi instances connect <name>
   ```

   Session keys, chats, contacts, routes, the history ledger and the group cache
   carry over (same UUID, same account name, same `whatsapp-baileys` channel
   type).
6. Verify:
   - `ravi instances status <name>` → connected;
   - send a test DM and check the agent answers in the same session as before
     (`ravi sessions list`);
   - `ravi daemon logs` shows no "Ignoring Omni event for a WhatsApp channel
     type" for that UUID after step 4;
   - `ravi channels status` → `ready` once every enabled instance is paired.
7. Move triggers. Triggers on Omni subjects
   (`message.received.whatsapp-baileys.>`, `reaction.received.whatsapp-baileys.>`,
   `instance.*.whatsapp-baileys.*`) stop firing. List them with
   `ravi triggers list` and move each by kind:
   - message triggers → `ravi.channel.inbound.whatsapp.message.>`. `data` is
     now a `WhatsAppInboundEvent` (`src/channels/whatsapp/events.ts`), so
     rewrite `data.*` filters (for example `data.payload.content.type`,
     `data.payload.chatId`) and add `data.ingestMode == "realtime"` to skip
     history-sync messages. The CLI warns that the subject is outside the
     catalog and accepts it; the trigger runner's plain NATS subscription
     receives the runner's JetStream publishes;
   - reaction triggers → `ravi.inbound.reaction`;
   - instance lifecycle triggers → `ravi.instances.>` (unregistered
     instances) or `ravi.whatsapp.>` (`qr`, `connected` pairing relay).
     Disconnects are only on `ravi.channel.inbound.whatsapp.connection.>`.

`twilio-whatsapp` and `gupshup` instances are not migrated: the runner speaks
Baileys only, their Omni events are dropped and their sends fail with
`CHANNEL_PROVIDER_UNSUPPORTED`.

### Silent Window

Between step 3 and step 5 an instance is silent: its inbound is ignored (Omni
events are dropped, the runner has no socket yet) and outbound fails with the
runner's `PAIRING_REQUIRED` / `NOT_CONNECTED`. Schedule the window and tell the
account's users.

## Rollback

**There is no rollback to Omni for WhatsApp** (owner decision). A paired
instance stays on the runner.

A code rollback (redeploying the previous bundle) is possible. Its effects:

- The `channels` rows remain. PR #590 code treats them as its native WhatsApp
  transport; pre-#590 code has no WhatsApp driver and reports them as
  unsupported in `ravi channels status`.
- The old binary still finds `omni_group_metadata` (never renamed or dropped).
  Rows written by the new binary are only in `channel_group_metadata`; it is a
  cache and refills.
- `~/.ravi/whatsapp/auth.db` is not read by older bundles, so they need a new
  pairing. Going forward again reuses `auth.db`: no re-pair unless the device
  was logged out or paired elsewhere in between.
- Emergency re-pair on Omni works only with a pre-#590 bundle:
  `ravi channels set <name> enabled false`, then `omni instances connect`.
  Never `omni install|start|restart|stop` (NATS ownership warning).

## Disconnect, Logout, Disable

- `ravi instances disconnect <name>`: closes the socket and keeps the creds. It
  persists across runner restarts (health `disconnected` /
  `manual_disconnect`) until `ravi instances connect <name>`.
- `ravi instances logout <name> --execute`: wipes the creds and unlinks the
  device when the instance is connected (dry-run without `--execute`, exit 3).
  A new QR pairing is needed. When it was not connected (after `disconnect`,
  while connecting, or when the runner did not answer) the CLI says so: remove
  the linked device on the phone (WhatsApp > Linked devices).
- `ravi instances disable|enable <name>`: also turns the WhatsApp channel off or
  on; disable keeps the creds.
- `ravi instances delete <name>`: logs out (runner, else a local wipe of
  `auth.db` rows), soft-deletes the instance and disables its WhatsApp
  channel, so the runner stops it and stays `ready`.
- `ravi instances restore <name>`: restores the instance and re-enables its
  channel when the instance is enabled; pair it again with
  `ravi instances connect <name>` when delete wiped the creds.

## Debug

- `WHATSAPP_RUNNER_UNAVAILABLE`: no runner answered the RPC. Run
  `ravi channels status`, then `ravi channels start` or
  `ravi channels restart`, and repeat the command.
- `INSTANCE_CONNECT_TIMEOUT` during pairing: the daemon is not relaying
  `CHANNEL_INBOUND`. Check `ravi daemon status`.
- `WHATSAPP_NOT_BOUND`: the instance has no enabled WhatsApp channel or no
  UUID. Run `ravi instances connect <name>`.
- `INSTANCE_NOT_FOUND` on a send: the target ref matches no instance record
  (for example an unmapped UUID). Nothing is sent to the bridge.
- `LEGACY_BRIDGE_NOT_CONFIGURED`: a Telegram/Discord instance and Omni is not
  configured (`OMNI_API_URL`/`OMNI_API_KEY` or `~/.omni/config.json`).
- A `400 INVALID_REQUEST` naming the schema version: the runner and the daemon
  run different bundles. Restart both on the same bundle.
- Health `starting` / `pairing_required`: no stored creds; run
  `ravi instances connect <name>`.
- Health `disconnected` / `manual_disconnect`: someone ran
  `ravi instances disconnect`; reconnect with `ravi instances connect <name>`.
- Health `disconnected` / `connection_replaced`: another process holds the
  same creds. Look for a second runner (`pm2 jlist`, another host on the same
  DB) or an Omni instance still connected, and stop it; the runtime does not
  reconnect on its own.
- Health `disconnected` / `logged_out`: the phone removed the device. Pair
  again.
- Health `disconnected` / `qr_reset_failed`: the QR-cycle auth reset failed;
  `ravi instances connect <name>` starts a fresh cycle.
- Health `failed` / `missing_dependency`: the runner cannot load Baileys
  (`dist/vendor/baileys.js` missing). Rebuild (`bun run build`) or reinstall.
- Old messages answered or ignored after a socket gap: offline backlog older
  than `defaults.offlineStaleMs` (default 10 minutes) is history-sync and never
  prompts. Tune it with `ravi channels set <channel> defaults '<json>'`; the
  value replaces the whole defaults object, so start from
  `ravi channels show <channel> --json` and keep `instance` and the other keys.
- No inbound at all: inspect the stream and the WhatsApp durables:

  ```bash
  nats stream info CHANNEL_INBOUND --server nats://127.0.0.1:4222
  nats consumer report CHANNEL_INBOUND --server nats://127.0.0.1:4222
  nats sub "ravi.channel.inbound.whatsapp.>" --server nats://127.0.0.1:4222
  ```

- RPC traffic: `nats sub "_RAVI.channels.whatsapp.rpc.>"`. `ravi events stream`
  hides both subject families unless `--filter` selects them.
- Auth state: `~/.ravi/whatsapp/auth.db` (0600). Do not edit it while the runner
  is running; use `ravi instances logout` to wipe creds.
- Runner tuning env (`WHATSAPP_*`) must be in `~/.ravi/.env` or the PM2
  environment; `ravi channels restart` carries only the listed keys.
