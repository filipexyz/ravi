---
name: voice
description: |
  Chamadas de voz sobre sessões do Ravi (`ravi voice`). Use quando o usuário quiser:
  - Falar com uma sessão por voz (push-to-talk, live, hands-free)
  - Parear um celular ou app com uma chave de aparelho
  - Criar perfis de voz, limites de custo, ou checar os motores
  - Construir um app de voz com o SDK ou o kit `@ravi-os/voice`
---

# Voz

Uma chamada fica em cima de uma sessão que já existe. O que a pessoa fala vira um turno da sessão (mesmo agente, memória, ferramentas e aprovações); a resposta volta como uma frase falada curta e o texto completo fica na sessão.

## Regras

- Agentes não abrem chamadas nem falam nelas (`VOICE_AGENT_TURN_REFUSED`, exit 3). Quem fala é o operador, um aparelho pareado ou um convidado.
- Aprovação é só por toque: `ravi voice calls approve <call> <approval> --execute`. Por voz, só cancelar ou negar.
- `cancel-turn` cancela só o turno desta chamada; `end` encerra a chamada e o trabalho em andamento continua na sessão.
- Chaves de aparelho aparecem uma vez. Nunca cole chave em chat.

## Comandos

```bash
ravi voice engines check                         # o que falta para cada motor
ravi voice targets list                          # sessões que este chamador pode chamar
ravi voice calls start <sessão> --mode push|live|handsfree|mock [--profile <id>]
ravi voice calls send <call> "texto"             # digitar na chamada
ravi voice calls push <call> --audio <arquivo>   # push-to-talk
ravi voice calls transcript <call>
ravi voice calls silence <call>
ravi voice calls cancel-turn <call>
ravi voice calls end <call>
ravi voice devices pair --contact <id> --label "iPhone" --session main --execute
ravi voice devices revoke <device>
ravi voice profiles create <id> --language pt --voice <id> --max-daily-cost 5
```

## Motores

| Modo | Precisa |
|---|---|
| `push` | `GROQ_API_KEY` ou `OPENAI_API_KEY`, e `ELEVENLABS_API_KEY` |
| `live` | `RAVI_VOICE_OPENAI_API_KEY` (GPT-Live por WebRTC) |
| `handsfree` | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` e o worker `ravi-voice` rodando |
| `mock` | nada (só texto) |

## Apps

SDK: `ravi.voice.calls.*` e o stream `voiceCall(call)` (abre com `call.snapshot`, retoma com `after=<seq>`). Kit de navegador: `@ravi-os/voice` (`createRaviVoice`, `pushToTalk`, `autoplayReplies`, `connectLive`, `joinRoom`). Guia: https://docs.ravi.bot/guides/voice
