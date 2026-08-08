# Audio agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/audio --mode rules --json`.
2. Reproduce with `--json` and read `error.code` first.
3. Exit `3`: only `generate --send` and `tts` should reach this path. Review
   the scalar options and target-presence metadata in the delivery/trigger
   plan, then re-run with `--execute` if approved.
4. Exit `1` on text validation: fix the text/`--text-file` combination (only
   one of them, relative `.md`/`.txt` inside the cwd).
5. TTS emitted but nothing played: the brake is not involved — inspect the
   downstream pipeline with `ravi audio pending --json --include-failed`.
6. If `generate --send` reaches ElevenLabs or delivery without `--execute`, or
   `tts` emits without it, check that `contractDryRun` runs before
   `generateAudio` / `nats.emit(RAVI_TTS_TOPIC)`.

## Validation

```bash
bun test src/cli/commands/media-json.test.ts
```

Live checks:

```bash
ravi audio generate "olá" --json                      # generates directly
ravi audio generate "olá" --send --json               # expect exit 3 + delivery plan
ravi audio generate "olá" --send --json --execute     # generates and sends
ravi audio tts "olá" --json                           # expect exit 3, no ravi.tts emit
ravi audio voices --json --fields voiceId,name        # compact listing
ravi audio pending --json --fields id,status          # compact listing
```
