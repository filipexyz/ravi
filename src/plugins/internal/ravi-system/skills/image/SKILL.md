---
name: image
description: |
  Gera imagens via OpenAI (gpt-image-2 padrão) ou Gemini. Use quando o usuário pedir:
  - Gerar uma imagem a partir de texto
  - Editar/transformar uma imagem existente
  - Criar logos, ilustrações, arte
  - Mockups de UI, infográficos, ads
---

# Image

## TL;DR

```bash
ravi image generate "<prompt>"
```

Comportamento padrão:
- **Async**: retorna na hora um `artifact_id`, geração roda em background
- **Auto-send**: se a sessão tem chat de origem, a imagem é enviada lá automaticamente quando completar
- **Lifecycle events**: a sessão é notificada de completed/failed sem precisar de polling
- **Provider/modelo**: `openai` + `gpt-image-2` (configurável por instância)

NÃO faça polling. NÃO use `--sync`. NÃO use `--send` se há chat de origem. Os eventos chegam sozinhos.

## Comandos

| Comando | Uso |
|---|---|
| `ravi image generate "prompt"` | Comando principal — gera 1 imagem |
| `ravi image atlas split <atlas>` | Corta atlas/contact sheet em N crops |

## Casos de uso

### 1. Gerar imagem nova
```bash
ravi image generate "purple cat floating in space, cinematic lighting"
```

### 2. Editar imagem existente
```bash
ravi image generate "remove background, add sunset" --source /tmp/photo.png
```

### 3. Aspect ratio e tamanho
```bash
ravi image generate "instagram story" --aspect 9:16 --size 2K
```

### 4. Múltiplas imagens consistentes (atlas)
Pra reduzir custo e manter estilo coerente, gere 1 atlas e divida:
```bash
ravi image generate "atlas 3x2 grid, 6 product variants, no gutter, no margin, photorealistic" \
  --aspect 3:2 --size 4K
# após completar:
ravi image atlas split /path/to/atlas.png \
  --cols 3 --rows 2 \
  --names red,blue,green,yellow,black,white \
  --send
```

`--mode raw` é o default e corta exato; use `--mode trim` apenas se o atlas saiu com gutter.

## Opções principais (`generate`)

| Flag | Descrição |
|---|---|
| `--aspect <ratio>` | `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `9:16`, `16:9`, `21:9` |
| `--size <size>` | `1K`, `2K`, `4K` (default `1K`) |
| `--source <path>` | Imagem de referência pra edição (PNG/JPEG/WebP/GIF) |
| `--caption "<texto>"` | Caption ao enviar (default = prompt) |
| `--quality <level>` | `low`, `medium`, `high`, `auto` (default `auto`) |
| `--format <fmt>` | `png`, `jpeg`, `webp` |
| `--background <mode>` | `transparent`, `opaque`, `auto` |

### Quality lever
- Comece com `--quality low` quando latência importa (ad iteration, mockup rápido)
- Use `medium` ou `high` pra texto pequeno, infográfico denso, retrato close-up, identidade
- `auto` é seguro pra maioria dos casos

## Opções avançadas (raras)

| Flag | Quando usar |
|---|---|
| `--provider gemini` | Forçar Gemini em vez de OpenAI |
| `--model <model>` | Override do modelo do provider |
| `--sync` | **Só** quando o script local precisa do path do arquivo |
| `--send` | Forçar envio quando contexto não tem chat origem |
| `-o <dir>` | Salvar em diretório específico (default `/tmp`) |
| `--compression <0-100>` | jpeg/webp output compression |

## Prompting — fundamentos do gpt-image-2

Esses padrões vieram de teste em produção do OpenAI Image2. Aplique conforme a tarefa:

### Estrutura + objetivo
Escreva na ordem: **background/cena → subject → detalhes-chave → constraints**. Inclua o uso pretendido (ad, UI mock, infográfico) — isso seta o "modo" e nível de polimento. Pra prompts complexos, use seções rotuladas curtas em vez de um parágrafo longo.

### Formato de prompt
Qualquer formato funciona se a intenção for clara: prompt mínimo, parágrafo descritivo, JSON-like, instruction-style, tag-based. Pra sistemas em produção, prefira template skimmable em vez de sintaxe esperta.

### Especificidade + quality cues
Seja concreto sobre **materiais, formas, texturas e meio visual** (photo, watercolor, 3D render). Adicione "alavancas de qualidade" só quando precisar:
- `film grain`
- `textured brushstrokes`
- `macro detail`

Pra fotorrealismo, **inclua a palavra `photorealistic` no prompt** — isso engaja o modo fotorrealista do modelo. Alternativas: `real photograph`, `taken on a real camera`, `professional photography`, `iPhone photo`. Specs detalhadas de câmera (lens, ISO, etc) são interpretadas livremente — use mais pra look/composição que pra simulação física exata.

### Composição
- **Framing**: close-up, wide, top-down
- **Ângulo**: eye-level, low-angle, dutch tilt
- **Luz/mood**: soft diffuse, golden hour, high-contrast, neon
- **Layout**: "logo top-right", "subject centered with negative space on left"

Pra cenas wide, cinematic, low-light, chuva ou neon, adicione **escala, atmosfera e cor** explícitas — senão o modelo troca mood por surface realism.

### Pessoas, pose e ação
Descreva escala, body framing, olhar e interação com objetos:
- `full body visible, feet included`
- `child-sized relative to the table`
- `looking down at the open book, not at the camera`
- `hands naturally gripping the handlebars`

### Constraints (o que mudar vs preservar)
Explicite exclusões e invariantes:
- `no watermark`, `no extra text`, `no logos/trademarks`
- `preserve identity / geometry / layout / brand elements`

Pra edits cirúrgicos: **`change only X` + `keep everything else the same`**, e repita a preserve-list em cada iteração. Se for surgical, diga também: `do not alter saturation, contrast, layout, arrows, labels, camera angle, or surrounding objects`.

### Texto na imagem
- Coloque texto literal em **aspas** ou **CAIXA ALTA**
- Especifique tipografia: font style, size, color, placement
- Pra palavras difíceis (nomes de marca, grafia incomum), **soletre letra-por-letra**
- Use `--quality medium` ou `high` pra texto pequeno, painel denso, multi-font

### Múltiplas imagens (compositing)
Referencie cada input por índice e descrição:
- `Image 1: product photo. Image 2: style reference.`
- `Apply Image 2's style to Image 1`
- `Put the bird from Image 1 on the elephant in Image 2`

### Iterar em vez de sobrecarregar
Comece com prompt limpo e refine com mudanças pequenas single-shot:
- `make lighting warmer`
- `remove the extra tree`
- `restore the original background`

Use referências como `same style as before` ou `the subject` pra leverage de contexto. Re-especifique detalhes críticos se eles começarem a deriva.

## Defaults (configurar uma vez)

Por instância:
```bash
ravi instances set main defaults '{"image_provider":"openai","image_model":"gpt-image-2","image_quality":"auto","image_format":"png"}'
```

Global:
```bash
ravi settings set image.provider openai
ravi settings set image.model gpt-image-2
```

## Inspecionar artifacts (debug)

Toda imagem é registrada em `ravi artifacts`. Pra inspeção manual:
```bash
ravi artifacts list --kind image
ravi artifacts show <artifact-id> --json
ravi artifacts events <artifact-id> --json
```

## Limitações
- API key obrigatória no `~/.ravi/.env`: `OPENAI_API_KEY` (default) ou `GEMINI_API_KEY`
- Prompts podem ser bloqueados por filtros de segurança
- Modelos são preview — podem mudar comportamento

## Não fazer

- ❌ Polling em loop esperando o artifact
- ❌ `--sync` sem motivo claro (trava a sessão até o provider responder)
- ❌ `--send` quando a sessão já tem chat de origem (auto-send acontece)
- ❌ Prompt único gigante quando dá pra iterar em passos
- ❌ Specs de câmera ultra-precisas esperando simulação física exata
