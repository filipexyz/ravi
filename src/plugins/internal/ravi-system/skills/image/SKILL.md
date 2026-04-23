---
name: image
description: |
  Gera imagens via Gemini ou OpenAI. Use quando o usuário quiser:
  - Gerar uma imagem a partir de texto
  - Editar/transformar uma imagem existente
  - Criar logos, ilustrações, arte
  - Gerar e enviar imagem direto no chat
---

# Image Generation

Gera imagens usando o provider configurado para a sessão/instância ou passado no CLI.
Não existe fallback automático entre providers: se OpenAI falhar, o comando falha; para usar Gemini, rode explicitamente com `--provider gemini`.

## Como usar

### Gerar imagem simples
```bash
ravi image generate "a purple cat floating in space"
```

### Gerar com OpenAI Image2
```bash
ravi image generate "system diagram for Ravi image generation" --provider openai --model gpt-image-2
```

### Modo quality (3 Pro — mais detalhado, mais lento)
```bash
ravi image generate "product photo of sneakers" --mode quality
```

### Modo fast (3.1 Flash — padrão, rápido)
```bash
ravi image generate "abstract art" --mode fast
```

### Editar imagem existente (source)
```bash
ravi image generate "remove the background and add a sunset" --source /tmp/photo.png
```

### Aspect ratio e tamanho
```bash
ravi image generate "instagram story background" --aspect 9:16 --size 2K
```

### Alta resolução 4K
```bash
ravi image generate "landscape wallpaper" --aspect 16:9 --size 4K
```

### Gerar e enviar direto no chat
```bash
ravi image generate "coffee shop interior" --send
```

### Salvar em diretório específico
```bash
ravi image generate "product mockup" -o /tmp/mockups
```

## Opções

| Flag | Descrição | Default |
|------|-----------|---------|
| `--provider <provider>` | `gemini` ou `openai` | default da sessão/instância/config |
| `--model <model>` | Modelo do provider (`gpt-image-2`, etc) | default configurado |
| `--mode <type>` | `fast` (3.1 Flash) ou `quality` (3 Pro) | `fast` |
| `--source <path>` | Imagem de referência pra edição | — |
| `--aspect <ratio>` | `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `9:16`, `16:9`, `21:9` | auto |
| `--size <size>` | `1K`, `2K`, `4K` | `1K` |
| `--quality <quality>` | OpenAI: `low`, `medium`, `high`, `auto` | por mode/default |
| `--format <format>` | OpenAI: `png`, `jpeg`, `webp` | `png` |
| `--compression <0-100>` | OpenAI jpeg/webp compression | provider default |
| `--background <mode>` | OpenAI: `transparent`, `opaque`, `auto` | provider default |
| `-o, --output <dir>` | Diretório de saída | `/tmp` |
| `--send` | Envia pro chat automaticamente | `false` |
| `--caption <text>` | Caption ao enviar (com `--send`) | prompt |

## Retorno

O comando retorna o path da imagem gerada + o comando pra enviar:
```
✓ Image saved: /tmp/ravi-image-1234567890.png
  Artifact: art_xxx
  Send to chat: ravi media send "/tmp/ravi-image-1234567890.png"
```

Se usar `--send`, o Ravi envia direto via `omni send` e só considera sucesso depois que o pedido de entrega foi aceito pelo Omni. Quando existir thread/topic no contexto, ela é preservada.

## Fluxo recomendado

1. Rode `ravi image generate "prompt"` — gera a imagem
2. Se precisa enviar pro chat, use `--send` ou copie o comando `ravi media send` do output
3. Pra editar uma imagem: passe `--source` com o path da imagem original

## Limitações

- Modelos são preview — podem mudar
- Requer a API key do provider selecionado no `~/.ravi/.env`
- Prompts podem ser bloqueados por filtros de segurança
- Source image: PNG, JPEG, WebP, GIF

## Configuração

- `GEMINI_API_KEY` — obrigatória, no `~/.ravi/.env`
- `GEMINI_IMAGE_MODEL` — override do modelo (ignora --mode)
- `OPENAI_API_KEY` — obrigatória para `--provider openai`
- `OPENAI_IMAGE_MODEL` — override do modelo OpenAI
- `RAVI_IMAGE_PROVIDER` / `RAVI_IMAGE_MODEL` — defaults globais por env

## Artifacts

Toda imagem gerada é registrada automaticamente em `ravi artifacts` com:

- arquivo bruto copiado para o blob store local
- `sha256`, tamanho e MIME
- provider, model, prompt, duração e usage/tokens quando disponível
- sessão, agent, canal e chat quando houver contexto Ravi
- metadata, metrics, lineage, input e output estruturados

Para inspecionar:

```bash
ravi artifacts list --kind image
ravi artifacts show <artifact-id> --json
```

### Default por instância
```bash
ravi instances set main defaults '{"image_provider":"openai","image_model":"gpt-image-2","image_quality":"auto","image_format":"png"}'
```

### Default global
```bash
ravi settings set image.provider openai
ravi settings set image.model gpt-image-2
```
