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

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction, ...}}`.

Taxonomia de saída: `0` sucesso · `1` erro de execução (validação de texto/arquivo) · `2` erro de uso · `3` freio de escrita — não é erro: nada foi cobrado; o envelope traz `dryRun:true` e `plan` com voz/modelo/velocidade RESOLVIDOS e o tamanho do texto (o que seria faturado).

Onde o freio existe: `audio generate` e `audio tts` gastam DINHEIRO de API externa (ElevenLabs) e são dry-run por default — exigem `--execute`. Revise o `plan` (voz/modelo/chars) e repita com `--execute`. `audio voices`, `audio pending` e `audio blob` são leitura, sem freio.

Compact mode: `audio voices` e `audio pending` aceitam `--fields a,b,c` (ex.: `--fields voiceId,name`).

Checklist antes de responder sobre áudio:

- Tratei exit 3 como freio (revisei voz/modelo/tamanho no `plan`) e não como falha?
- Confirmei que o gasto é intencional antes de repetir com `--execute`?
- Usei `--fields` nas listagens para não arrastar objetos inteiros?

## Como usar

### Gerar áudio simples
```bash
ravi audio generate "Olá, eu sou o Ravi!" --execute
```

Sem `--execute` o comando é um dry-run (exit 3) que mostra o plano de cobrança — nada é gerado.

### Com voz específica
```bash
ravi audio generate "Hello world" --voice JBFqnCBsd6RMkjVDRZzb --execute
```

### Com velocidade alterada
```bash
ravi audio generate "Texto rápido" --speed 1.5 --execute
```

### Com idioma forçado
```bash
ravi audio generate "Bom dia a todos" --lang pt --execute
```

### Gerar e enviar direto no chat
```bash
ravi audio generate "Mensagem de voz" --send --execute
```

### Gerar a partir de arquivo de texto
```bash
ravi audio generate --text-file roteiro.md --lang fr --send --execute
```

`--text-file` só aceita arquivos relativos ao diretório atual, sem `..`, e apenas extensões `.md` ou `.txt`. Use isso para textos longos em vez de `$(cat ...)`, heredoc, `python -c` ou substituição de shell.

### Com caption custom ao enviar
```bash
ravi audio generate "Conteúdo importante" --send --caption "Escuta isso" --execute
```

### Modelo turbo (mais rápido, menos expressivo)
```bash
ravi audio generate "Quick response" --model eleven_turbo_v2_5 --execute
```

### Salvar em diretório específico
```bash
ravi audio generate "Narração" -o /tmp/audios --execute
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
| `--text-file <path>` | Lê texto de arquivo relativo `.md` ou `.txt` | nenhum |
| `--execute` | Executa a geração paga; sem ela é dry-run (exit 3) | dry-run |

## Retorno

O comando retorna o path do áudio gerado + o comando pra enviar:
```
✓ Audio saved: /tmp/ravi-audio-1234567890.mp3
  Send to chat: ravi media send "/tmp/ravi-audio-1234567890.mp3" --execute
```

Se usar `--send`, o Ravi entrega direto via `omni send` em vez de só publicar um evento interno. O retorno passa a refletir ack/erro real da entrega e preserva thread/topic quando existir no contexto.

## Fluxo recomendado

1. Rode `ravi audio generate "texto" --execute` — gera o MP3 (sem `--execute` é só o plano, exit 3)
2. Para textos longos, salve em `.md` ou `.txt` no diretório atual e use `--text-file caminho-relativo.md`
3. Se precisa enviar pro chat, use `--send` ou copie o comando `ravi media send` do output
4. Pra português, use `--lang pt` pra melhor pronúncia

## Limitações

- Requer `ELEVENLABS_API_KEY` no `~/.ravi/.env`
- Textos muito longos podem demorar
- Voices customizadas precisam do voice ID específico

## Configuração

- `ELEVENLABS_API_KEY` — obrigatória, no `~/.ravi/.env`
- `ELEVENLABS_VOICE_ID` — voice padrão (opcional)
