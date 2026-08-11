---
name: stickers
description: |
  Gerencia a biblioteca oficial de stickers do Ravi. Use quando o usuário quiser:
  - Adicionar, listar, mostrar, remover ou enviar stickers
  - Entender quando stickers aparecem no prompt
  - Configurar opt-in de stickers por agent
  - Verificar suporte WhatsApp-only para envio de stickers
---

# Sticker Library

Stickers são uma surface separada de resposta no Ravi:

- texto normal
- reação emoji (`ravi react send`)
- silêncio (`@@SILENT@@`)
- sticker (`ravi stickers send`)

Use stickers com parcimônia. Se o sticker for a resposta inteira, envie o sticker e depois responda exatamente `@@SILENT@@`, sem texto adicional.

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?}}`.

Taxonomia de saída:

- `0` sucesso.
- `1` erro de execução — `STICKER_NOT_FOUND` traz `suggestions` com ids/labels reais do catálogo local; `STICKER_MEDIA_NOT_FOUND` indica arquivo de mídia sumido; canal sem capability falha aqui também.
- `2` erro de uso (flag/argumento inválido).
- `3` freio de escrita — não é erro: nada foi enviado/removido; o envelope traz `dryRun:true` e `plan` (sticker, alvo, filename). Revise e repita com `--execute`.

Onde o freio existe: `stickers send` (chega num chat vivo, não dá pra desfazer) e `stickers remove` (deleta entrada do catálogo, sem undo) são dry-run por default e exigem `--execute`. `stickers add` grava na hora, sem freio (config local reversível com `remove`). `list`/`show` são leitura.

Compact mode: `stickers list` aceita `--fields a,b,c` (ex.: `--fields id,enabled`).

Checklist antes de responder sobre stickers:

- Tratei exit 3 como freio (revisei sticker e alvo no `plan`) e não como falha?
- Consultei `suggestions` do envelope (ou `ravi stickers list --json`) antes de declarar not-found?
- A validação de canal falhou? Então o canal não suporta stickers — não insista.

## Capability Gate

Stickers só existem para canais com capability explícita. O suporte inicial de envio é WhatsApp.

Não diga que Matrix, TUI ou outros canais suportam stickers. Nesses canais o prompt não deve oferecer instruções de stickers e `ravi stickers send` deve falhar.

## Opt-in Por Agent

O prompt só recebe a seção `Stickers` quando:

1. o canal atual suporta stickers,
2. o agent tem stickers habilitados,
3. existe pelo menos um sticker enabled, permitido para o canal e para o agent.

Habilite no agent:

```bash
ravi agents set main defaults '{"stickers":{"enabled":true}}'
```

Launchers avançados também podem habilitar somente uma sessão com `runtimeSessionParams.stickers.enabled=true`.

## Catálogo

O catálogo tipado vive fora do prompt:

```bash
~/.ravi/stickers/catalog.json
```

Campos:

- `id`
- `label`
- `description`
- `avoid`
- `channels`
- `agents`
- `media`
- `enabled`

O prompt recebe apenas Markdown curto com IDs e descrições naturais. Nunca injete base64, binário, paths locais ou JSON no prompt.

## Comandos

Adicionar:

```bash
ravi stickers add wave "/path/to/wave.webp" \
  --label "Wave" \
  --description "Use for a friendly quick hello." \
  --avoid "Do not use during serious incidents." \
  --channels whatsapp \
  --json
```

Listar e inspecionar:

```bash
ravi stickers list --json
ravi stickers show wave --json
```

Remover (freado — sem `--execute` é dry-run, exit 3):

```bash
ravi stickers remove wave --json --execute
```

Enviar no chat WhatsApp atual (freado — sem `--execute` é dry-run, exit 3):

```bash
ravi stickers send wave --json --execute
```

Enviar com alvo explícito:

```bash
ravi stickers send wave --channel whatsapp --account main --to "5511999999999@s.whatsapp.net" --json --execute
```

Listagem compacta:

```bash
ravi stickers list --json --fields id,enabled
```

## Envio

`ravi stickers send` resolve o alvo pelo contexto da sessão atual ou por `--session`.

O evento emitido é:

```bash
ravi.stickers.send
```

O gateway valida capability de canal e usa o caminho omni de mídia com tipo `sticker`.
