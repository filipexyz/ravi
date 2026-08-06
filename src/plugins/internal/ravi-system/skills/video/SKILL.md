---
name: video
description: |
  Analisa vídeos do YouTube ou arquivos locais. YouTube usa legendas primeiro e Gemini como fallback. Use quando o usuário quiser:
  - Assistir/analisar um vídeo do YouTube
  - Transcrever um vídeo
  - Entender o conteúdo de um vídeo
  - Extrair informações de um vídeo
---

# Video Analysis

Analisa vídeos do YouTube usando legendas/captions via `yt-dlp` como caminho padrão por custo e latência. Usa Gemini como fallback quando não há legenda, quando a extração falha, ou quando o usuário pede análise visual/resumo via `--strategy gemini` ou `--force-analyze`. Arquivos locais seguem via Gemini.

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction, ...}}`.

Taxonomia de saída: `0` sucesso · `1` erro de execução (ex.: strategy inválida) · `2` erro de uso · `3` freio de escrita — não é erro: nada foi cobrado; o envelope traz `dryRun:true`, o `plan` com o modelo Gemini que seria faturado e o campo `freeAlternative` com o caminho grátis.

Onde o freio existe: qualquer análise que PODE cair no Gemini pago é dry-run por default — `--strategy gemini`, `--force-analyze`, o default `auto` (fallback possível) e arquivos locais exigem `--execute`. O único caminho garantidamente grátis/local é `--strategy subtitles`, que roda direto, sem `--execute`.

Checklist antes de responder sobre vídeo:

- Se um transcript resolve, tentei primeiro o caminho grátis `--strategy subtitles`?
- Tratei exit 3 como freio (revisei o `plan` e o `freeAlternative`) e não como falha?
- Confirmei que o gasto Gemini é intencional antes de repetir com `--execute`?

## Como usar

### Analisar vídeo do YouTube (caminho grátis primeiro)
```bash
ravi video analyze "https://www.youtube.com/watch?v=VIDEO_ID" --strategy subtitles
```

Só legendas: grátis, local, roda sem `--execute`. Se o vídeo não tiver legenda, o comando falha e aí sim vale pagar o Gemini.

### Analisar com fallback automático (pode faturar Gemini)
```bash
ravi video analyze "https://www.youtube.com/watch?v=VIDEO_ID" --execute
```

Sem `--execute`, o modo `auto` é dry-run (exit 3): o plano mostra o modelo Gemini que seria cobrado.

Por padrão, URLs do YouTube tentam `pt-BR`, `pt` e `en` em legendas manuais/automáticas antes de chamar Gemini.

### Analisar com output específico
```bash
ravi video analyze "https://www.youtube.com/watch?v=VIDEO_ID" -o ./video-analysis.md --execute
```

### Analisar com prompt custom
```bash
ravi video analyze "https://www.youtube.com/watch?v=VIDEO_ID" -p "Foque nos argumentos técnicos apresentados" --execute
```

Prompt custom é aplicado no caminho Gemini. Se precisar garantir resumo, tópicos ou descrição visual, force Gemini:

```bash
ravi video analyze "https://www.youtube.com/watch?v=VIDEO_ID" --strategy gemini --execute
```

### Analisar arquivo local
```bash
ravi video analyze /path/to/video.mp4 --execute
```

Arquivo local sempre passa pelo Gemini (pago) — por isso exige `--execute`.

## O que é extraído

O comando salva um `.md` no diretório atual com:

- **Título** do vídeo
- **Duração** e **capítulos**, quando disponíveis no YouTube
- **Resumo** completo do conteúdo
- **Tópicos** principais abordados
- **Transcrição** de toda a fala
- **Descrição visual** timestamped (o que acontece visualmente)

No caminho por legendas, o comando não gera resumo/tópicos/descrição visual para evitar chamada ao modelo; ele prioriza título, duração, capítulos e transcrição fiel.

## Fluxo recomendado

1. Rode `ravi video analyze <url> --strategy subtitles` (grátis) ou `ravi video analyze <url> --execute` (pode faturar Gemini) — gera o `.md`
2. Leia o arquivo gerado com a tool Read
3. Interprete e responda ao usuário baseado no conteúdo

## Limitações

- Só vídeos **públicos** do YouTube (não funciona com privados/não listados)
- Caminho de legenda requer `yt-dlp` instalado no ambiente
- Vídeos muito longos (>1h) podem demorar ou exceder limites de token
- Requer `GEMINI_API_KEY` configurada no `~/.ravi/.env` apenas quando cair em Gemini ou quando usar arquivo local
- Formatos locais suportados: mp4, mpeg, mov, avi, flv, webm, wmv, 3gpp

## Configuração

A variável `GEMINI_API_KEY` precisa estar no `~/.ravi/.env`. O modelo padrão é `gemini-2.5-flash`, configurável via `GEMINI_VIDEO_MODEL`.
