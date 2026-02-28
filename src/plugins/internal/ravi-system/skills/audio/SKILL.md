---
name: audio
description: |
  Gera áudio (TTS) via ElevenLabs. Use quando o usuário quiser:
  - Converter texto em fala
  - Gerar áudio narrado
  - Enviar mensagem de voz gerada
  - Criar podcast/narração
---

# Audio Generation (TTS)

Gera áudio a partir de texto usando ElevenLabs Text-to-Speech.

## Como usar

### Gerar áudio simples
```bash
ravi audio generate "Olá, eu sou o Ravi!"
```

### Com voz específica
```bash
ravi audio generate "Hello world" --voice JBFqnCBsd6RMkjVDRZzb
```

### Com velocidade alterada
```bash
ravi audio generate "Texto rápido" --speed 1.5
```

### Com idioma forçado
```bash
ravi audio generate "Bom dia a todos" --lang pt
```

### Gerar e enviar direto no chat
```bash
ravi audio generate "Mensagem de voz" --send
```

### Com caption custom ao enviar
```bash
ravi audio generate "Conteúdo importante" --send --caption "Escuta isso"
```

### Modelo turbo (mais rápido, menos expressivo)
```bash
ravi audio generate "Quick response" --model eleven_turbo_v2_5
```

### Salvar em diretório específico
```bash
ravi audio generate "Narração" -o /tmp/audios
```

## Opções

| Flag | Descrição | Default |
|------|-----------|---------|
| `--voice <id>` | Voice ID do ElevenLabs | env `ELEVENLABS_VOICE_ID` ou default |
| `--model <model>` | `eleven_multilingual_v2`, `eleven_turbo_v2_5` | `eleven_multilingual_v2` |
| `--speed <speed>` | Velocidade 0.5-2.0 | `1.0` |
| `--lang <code>` | Idioma ISO 639-1 (`pt`, `en`, `es`) | auto-detect |
| `--format <fmt>` | `mp3_44100_128`, `mp3_22050_32`, `pcm_16000` | `mp3_44100_128` |
| `-o, --output <dir>` | Diretório de saída | `/tmp` |
| `--send` | Envia pro chat automaticamente | `false` |
| `--caption <text>` | Caption ao enviar (com `--send`) | início do texto |

## Retorno

O comando retorna o path do áudio gerado + o comando pra enviar:
```
✓ Audio saved: /tmp/ravi-audio-1234567890.mp3
  Send to chat: ravi media send "/tmp/ravi-audio-1234567890.mp3"
```

## Fluxo recomendado

1. Rode `ravi audio generate "texto"` — gera o MP3
2. Se precisa enviar pro chat, use `--send` ou copie o comando `ravi media send` do output
3. Pra português, use `--lang pt` pra melhor pronúncia

## Limitações

- Requer `ELEVENLABS_API_KEY` no `~/.ravi/.env`
- Textos muito longos podem demorar
- Voices customizadas precisam do voice ID específico

## Configuração

- `ELEVENLABS_API_KEY` — obrigatória, no `~/.ravi/.env`
- `ELEVENLABS_VOICE_ID` — voice padrão (opcional)
