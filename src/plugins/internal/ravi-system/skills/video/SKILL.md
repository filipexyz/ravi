---
name: video
description: |
  Analisa vídeos do YouTube ou arquivos locais via Gemini. Use quando o usuário quiser:
  - Assistir/analisar um vídeo do YouTube
  - Transcrever um vídeo
  - Entender o conteúdo de um vídeo
  - Extrair informações de um vídeo
---

# Video Analysis

Analisa vídeos usando a API do Gemini. Suporta URLs do YouTube (públicos) e arquivos locais.

## Como usar

### Analisar vídeo do YouTube
```bash
ravi video analyze "https://www.youtube.com/watch?v=VIDEO_ID"
```

### Analisar com output específico
```bash
ravi video analyze "https://www.youtube.com/watch?v=VIDEO_ID" -o ./video-analysis.md
```

### Analisar com prompt custom
```bash
ravi video analyze "https://www.youtube.com/watch?v=VIDEO_ID" -p "Foque nos argumentos técnicos apresentados"
```

### Analisar arquivo local
```bash
ravi video analyze /path/to/video.mp4
```

## O que é extraído

O comando salva um `.md` no diretório atual com:

- **Título** do vídeo
- **Resumo** completo do conteúdo
- **Tópicos** principais abordados
- **Transcrição** de toda a fala
- **Descrição visual** timestamped (o que acontece visualmente)

## Fluxo recomendado

1. Rode `ravi video analyze <url>` — gera o `.md`
2. Leia o arquivo gerado com a tool Read
3. Interprete e responda ao usuário baseado no conteúdo

## Limitações

- Só vídeos **públicos** do YouTube (não funciona com privados/não listados)
- Vídeos muito longos (>1h) podem demorar ou exceder limites de token
- Requer `GEMINI_API_KEY` configurada no `~/.ravi/.env`
- Formatos locais suportados: mp4, mpeg, mov, avi, flv, webm, wmv, 3gpp

## Configuração

A variável `GEMINI_API_KEY` precisa estar no `~/.ravi/.env`. O modelo padrão é `gemini-2.5-flash`, configurável via `GEMINI_VIDEO_MODEL`.
