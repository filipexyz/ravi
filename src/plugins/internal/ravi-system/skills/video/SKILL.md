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

## Como usar

### Analisar vídeo do YouTube
```bash
ravi video analyze "https://www.youtube.com/watch?v=VIDEO_ID"
```

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

1. Rode `ravi video analyze <url>` — gera o `.md`
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
