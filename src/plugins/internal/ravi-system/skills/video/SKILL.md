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

Taxonomia de saída: `0` sucesso · `1` erro de execução · `2` erro de uso · `3` bloqueio por política. `video analyze` não usa o bloqueio de confirmação: valida a entrada e inicia a análise diretamente.

Onde o freio existe: não há `--execute` em `video analyze`. O caminho de legendas e o Gemini rodam diretamente; custo externo sem estimativa e limite configurado não cria confirmação por si só. `--strategy subtitles` proíbe o fallback para Gemini e é a opção previsível quando a chamada paga não é desejada.

Checklist antes de responder sobre vídeo:

- Se um transcript resolve, tentei primeiro o caminho grátis `--strategy subtitles`?
- Escolhi `--strategy subtitles` quando a tarefa não autorizava fallback para Gemini?
- Tratei falha de legendas como erro de execução, sem retry automático para um provider pago?

## Como usar

### Analisar vídeo do YouTube (caminho grátis primeiro)
```bash
ravi video analyze "https://www.youtube.com/watch?v=VIDEO_ID" --strategy subtitles
```

Só legendas: grátis, local, roda sem `--execute`. Se o vídeo não tiver legenda, o comando falha e aí sim vale pagar o Gemini.

### Analisar com fallback automático (pode faturar Gemini)
```bash
ravi video analyze "https://www.youtube.com/watch?v=VIDEO_ID"
```

O modo `auto` tenta legendas e pode usar Gemini como fallback, sem uma segunda chamada de confirmação.

Por padrão, URLs do YouTube tentam `pt-BR`, `pt` e `en` em legendas manuais/automáticas antes de chamar Gemini.

### Analisar com output específico
```bash
ravi video analyze "https://www.youtube.com/watch?v=VIDEO_ID" -o ./video-analysis.md
```

### Analisar com prompt custom
```bash
ravi video analyze "https://www.youtube.com/watch?v=VIDEO_ID" -p "Foque nos argumentos técnicos apresentados"
```

Prompt custom é aplicado no caminho Gemini. Se precisar garantir resumo, tópicos ou descrição visual, force Gemini:

```bash
ravi video analyze "https://www.youtube.com/watch?v=VIDEO_ID" --strategy gemini
```

### Analisar arquivo local
```bash
ravi video analyze /path/to/video.mp4
```

Arquivo local passa pelo Gemini e roda diretamente.

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

1. Rode `ravi video analyze <url> --strategy subtitles` (sem fallback) ou `ravi video analyze <url>` (pode usar Gemini) — gera o `.md`
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
