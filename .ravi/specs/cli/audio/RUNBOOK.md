# Audio agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/audio --mode rules --json`.
2. Reproduce with `--json` and read `error.code` first.
3. Exit `3`: read `error.plan` — voice/model/speed are what ElevenLabs would
   bill. Confirm and re-run with `--execute`.
4. Exit `1` on text validation: fix the text/`--text-file` combination (only
   one of them, relative `.md`/`.txt` inside the cwd).
5. TTS emitted but nothing played: the brake is not involved — inspect the
   downstream pipeline with `ravi audio pending --json --include-failed`.
6. If a generate/tts billed without `--execute`, the brake regressed: check
   that `contractDryRun` runs before `generateAudio` / `nats.emit(RAVI_TTS_TOPIC)`
   in `src/cli/commands/audio.ts`.

## Validation

```bash
bun test src/cli/commands/media-json.test.ts
```

Live checks:

```bash
ravi audio generate "olá" --json                      # expect exit 3 + plan
ravi audio generate "olá" --json --execute            # bills ElevenLabs
ravi audio tts "olá" --json                           # expect exit 3, no ravi.tts emit
ravi audio voices --json --fields voiceId,name        # compact listing
ravi audio pending --json --fields id,status          # compact listing
```
