---
name: image
description: |
  Gera imagens via Gemini Nano Banana 2. Use quando o usuário quiser:
  - Gerar uma imagem a partir de texto
  - Editar/transformar uma imagem existente
  - Criar logos, ilustrações, arte
  - Gerar e enviar imagem direto no chat
---

# Image Generation

Gera imagens usando Gemini Nano Banana 2 (generateContent com IMAGE modality).

## Como usar

### Gerar imagem simples
```bash
ravi image generate "a purple cat floating in space"
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
| `--mode <type>` | `fast` (3.1 Flash) ou `quality` (3 Pro) | `fast` |
| `--source <path>` | Imagem de referência pra edição | — |
| `--aspect <ratio>` | `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `9:16`, `16:9`, `21:9` | auto |
| `--size <size>` | `1K`, `2K`, `4K` | `1K` |
| `-o, --output <dir>` | Diretório de saída | `/tmp` |
| `--send` | Envia pro chat automaticamente | `false` |
| `--caption <text>` | Caption ao enviar (com `--send`) | prompt |

## Retorno

O comando retorna o path da imagem gerada + o comando pra enviar:
```
✓ Image saved: /tmp/ravi-image-1234567890.png
  Send to chat: ravi media send "/tmp/ravi-image-1234567890.png"
```

## Fluxo recomendado

1. Rode `ravi image generate "prompt"` — gera a imagem
2. Se precisa enviar pro chat, use `--send` ou copie o comando `ravi media send` do output
3. Pra editar uma imagem: passe `--source` com o path da imagem original

## Limitações

- Modelos são preview — podem mudar
- Requer `GEMINI_API_KEY` configurada no `~/.ravi/.env`
- Prompts podem ser bloqueados por filtros de segurança
- Source image: PNG, JPEG, WebP, GIF

## Configuração

- `GEMINI_API_KEY` — obrigatória, no `~/.ravi/.env`
- `GEMINI_IMAGE_MODEL` — override do modelo (ignora --mode)
