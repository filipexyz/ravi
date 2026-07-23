---
id: channels/roadmap
title: "Roadmap Slack Nativo"
kind: capability
domain: channels
capabilities:
  - slack
  - runner
  - credentials
tags:
  - migration
  - slack
  - roadmap
status: active
normative: true
---

# Roadmap Slack Nativo

## Objetivo

O Ravi MUST subir Slack como canal nativo sem depender semanticamente do Omni.

A feature final MUST rodar Slack no processo `ravi channels`, resolver credenciais via broker, ingerir inbound por Socket Mode, publicar prompts para sessões Ravi e entregar outbound por boundary durável.

## Fases

### Fase 0 - Consolidação

- Criar branch/worktree de integração a partir da `origin/dev` atual.
- Portar apenas as partes úteis da branch `codex/slack-native-runtime`.
- Portar o runner/outbound da branch `codex/channels-runner-outbound`.
- Atualizar specs antes de promover comportamento live.

### Fase 1 - Credenciais

- Criar domínio `src/credentials`.
- Persistir apenas metadata e `secret_ref`.
- Resolver segredo real via backend `keychain` local ou `vault`.
- Expor CLI `ravi credentials`.
- Proibir `read-secret` público.

### Fase 2 - Runner

- Criar `ravi channels` como processo separado.
- Criar PM2 process `ravi-channels`.
- Criar `CHANNEL_OUTBOUND` como WorkQueue durável.
- Adicionar consumer outbound no runner.
- Adicionar status/health de adapters.

### Fase 3 - Slack Adapter

- Rodar Socket Mode no runner.
- Deduplicar envelopes/eventos.
- Normalizar inbound `message`.
- Persistir chat, thread, message e participant.
- Publicar prompt via `publishSessionPrompt`.
- Respeitar policy de thread.

### Fase 4 - Outbound

- Gateway MUST transformar resposta runtime de canal nativo em job durável.
- Runner MUST consumir job e chamar adapter Slack.
- Delivery result MUST emitir evento `ravi.session.<session>.delivery`.
- Outbound MUST preservar `emitId`, target, thread e idempotency key.

### Fase 5 - Smoke Real

- Cadastrar connection Slack.
- Subir `ravi channels`.
- Testar DM, canal e thread.
- Reiniciar apenas `ravi channels`.
- Confirmar ausência de duplicidade e vazamento de segredo.

## Critérios De Pronto

- `bun test` focado de credentials, channels e Slack passa.
- `bun run typecheck` passa.
- `bun run build` passa.
- `ravi channels status --json` mostra PM2/processo corretamente.
- `ravi credentials connections list --json` não mostra segredo bruto.
- Slack inbound gera prompt em sessão Ravi.
- Slack outbound responde na thread correta.
- Restart do `ravi channels` não exige restart do `ravi daemon`.
