# Acceptance Cases

Estes briefs testam o método da skill. Eles não pedem credenciais reais nem
autorizam chamadas externas. A implementação de referência deve usar fake HTTP.

## Caso A — Google Search Console

### Fontes oficiais

- Visão geral: <https://developers.google.com/webmaster-tools>
- Pré-requisitos e OAuth: <https://developers.google.com/webmaster-tools/v1/prereqs>
- Search Analytics query:
  <https://developers.google.com/webmaster-tools/v1/searchanalytics/query>
- Sitemaps list:
  <https://developers.google.com/webmaster-tools/v1/sitemaps/list>
- Limites: <https://developers.google.com/webmaster-tools/limits>

### Brief

Crie um app `search-console` cujo CLI real exponha inicialmente:

- `sites`: lista propriedades acessíveis;
- `analytics`: consulta um property URL por intervalo, dimensões e offset;
- `sitemaps`: lista sitemaps de uma propriedade;
- `health`: inspeciona somente metadata local da conexão.

O client usa `https://www.googleapis.com/webmasters/v3`, OAuth 2 por uma
conexão brokered e scopes read-only na primeira fase. `siteUrl` deve ser
codificado como path data. A consulta de analytics preserva `rowLimit` e
`startRow`; a saída não pode prometer cobertura completa porque a API retorna
linhas principais sob limites internos.

### Evidência esperada

- operação matrix e schemas para sites/analytics/sitemaps/health;
- ausência de tokens e fluxo OAuth ad hoc;
- permission separada para read e eventual write futuro;
- credencial ausente falha antes do fetch;
- fake HTTP confirma método, path encoding, body, offset e erro sanitizado;
- `ravi search-console analytics --json` atravessa o App Router;
- storage/events/artifacts/UI têm decisão explícita, mesmo quando `não`.

## Caso B — Open-Meteo Forecast

### Fonte oficial

- Forecast API: <https://open-meteo.com/en/docs>

### Brief

Crie um app `weather` cujo CLI real exponha inicialmente:

- `forecast`: recebe latitude, longitude, timezone e uma allowlist curta de
  variáveis horárias;
- `health`: valida configuração local sem chamar rede.

O client usa `https://api.open-meteo.com/v1/forecast`. A fase inicial não
precisa de OAuth nem de secret. Isso deve permanecer uma decisão explícita:
não crie broker ou permission sensível quando a fonte pública não exige.

### Evidência esperada

- validação de coordenadas e allowlist de variáveis;
- JSON estável independentemente de ordem de query;
- fake HTTP confirma query encoding, timezone e erro do provider;
- `context.allow` vazio quando o CLI não chama outra superfície Ravi;
- `ravi weather forecast --json` atravessa o App Router;
- nenhuma regra específica de Google está embutida no builder.

## Critério de independência

O mesmo fluxo, checklist e gates devem servir aos dois casos. Diferenças de
OAuth, quotas, recursos e risco pertencem aos apps e aos seus clients, não ao
framework do builder.
