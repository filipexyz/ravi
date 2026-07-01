---
name: meetings
description: |
  Opera reunioes nativas do Ravi. Use quando precisar:
  - Fazer um agent entrar em Google Meet como participante visivel
  - Gravar/capturar uma reuniao e gerar artifact raw meet.md
  - Rodar modo live com runtime nativo do Ravi e agent registrado
  - Finalizar runs do meet-recorder em artifacts do Ravi
  - Auditar eventos, transcricao, midias e diagnosticos de uma meeting
---

# Ravi Meetings

`ravi meetings` e a superficie nativa para agents entrarem em reunioes,
capturarem contexto bruto e devolverem um artifact reutilizavel pelo Ravi.

Use esta skill quando o usuario pedir para entrar numa call, gravar Meet,
testar live mode, analisar um artifact de reuniao, publicar `meet.md`, ou
debugar o fluxo de meeting provider.

## Regras Principais

- Nao grave reuniao escondido. O bot deve entrar como participante visivel.
- Nao burle lobby, consentimento, politica do Meet ou permissao de midia.
- Nao peca nem exponha credenciais.
- Nao use `prox calls` como referencia para o fluxo de meetings; meetings e um
  provider/canal proprio do Ravi.
- O P0 do artifact final e raw: sem resumo, sem decisoes geradas por IA e sem
  pendencias inventadas antes do agent consumidor pedir isso.
- O artifact final deve preservar transcricao completa, timestamps, speakers
  quando disponiveis, referencias de audio/video e diagnosticos.

## Modelo Mental

Fluxo esperado:

```text
ravi meetings join
  -> meeting.join artifact pending/running
  -> sessao nativa meet-* quando --live
  -> google-meet provider visivel
  -> captura/transcricao/midia
  -> ravi meetings finalize
  -> meeting.raw artifact com meet.md e transcription.json
  -> session de origem recebe handoff
```

`join` e assincrono por padrao. Nao bloqueie esperando a call terminar a menos
que o usuario peca explicitamente `--sync` ou voce esteja fazendo diagnostico
curto controlado.

Para acompanhar lifecycle, use:

```bash
ravi artifacts events <artifact-id> --json
```

## Entrar Em Uma Reuniao

Comando basico:

```bash
ravi meetings join \
  --provider google-meet \
  --url https://meet.google.com/abc-defg-hij \
  --name Ravi \
  --json
```

O retorno contem um artifact `meeting.join` e, quando finalizar, a propria
sessao recebe o handoff com o `meeting.raw` final.

## Login Google Meet

O provider usa um perfil Chrome persistente. A conta Google usada e a conta
logada nesse perfil, nao necessariamente a conta do Chrome aberto manualmente.

Perfil default:

```bash
~/.ravi/meet-recorder/chrome-profile
```

Para autenticar ou trocar a conta de um perfil:

```bash
ravi meetings login \
  --provider google-meet \
  --profile-dir ~/.ravi/meet-recorder/chrome-profile-ravi \
  --url https://meet.google.com/abc-defg-hij
```

Depois use o mesmo perfil no join:

```bash
ravi meetings join \
  --provider google-meet \
  --url https://meet.google.com/abc-defg-hij \
  --profile-dir ~/.ravi/meet-recorder/chrome-profile-ravi \
  --json
```

Use profiles separados para contas diferentes. Nao autentique esse perfil com
Chrome aberto manualmente; use `ravi meetings login`, que abre o Chrome pelo
mesmo caminho Playwright do recorder.

Use `--dry-run --json` antes de um comando novo, arriscado ou com muitas flags:

```bash
ravi meetings join \
  --provider google-meet \
  --url https://meet.google.com/abc-defg-hij \
  --name Ravi \
  --dry-run \
  --json
```

## Live Mode

Live mode exige um agent registrado no Ravi:

```bash
ravi meetings join \
  --provider google-meet \
  --url https://meet.google.com/abc-defg-hij \
  --name Ravi \
  --live \
  --agent <agent-id> \
  --json
```

Contrato:

- `--agent <id>` e obrigatorio no uso correto de live mode.
- O system prompt vem do agent registrado no Ravi.
- `--context <text>` e livre e opcional. Use para contexto manual da call.
- `--include-session-context` e opcional. So use quando o usuario pedir para
  levar o contexto recente da sessao atual.
- `--initial-prompt <text>` pertence a sessao nativa do Ravi. Use
  `--initial-prompt-delay <seconds>` quando o usuario definir o tempo.
- Live mode cria uma sessao normal do Ravi (`meet-google-meet-*`) com
  `channel=meet` e provider `google-meet`.
- O meet-recorder e apenas bridge/captura do Google Meet; ele nao recebe prompt,
  tools, modelo ou runtime direto.

Exemplo com contexto e fala inicial:

```bash
ravi meetings join \
  --provider google-meet \
  --url https://meet.google.com/abc-defg-hij \
  --name Ravi \
  --live \
  --agent ravi-meet-v0 \
  --context "Teste live do Ravi Meet com contexto manual." \
  --include-session-context \
  --initial-prompt "Entrei com contexto e estou pronto para validar." \
  --initial-prompt-delay 3 \
  --json
```

## Tools No Runtime Nativo

Tools do live mode sempre usam allowlist explicita e passam pelo runtime nativo
da sessao Ravi.

Nunca use:

```bash
--tools all
--tools '*'
```

Use apenas as tools necessarias para a call:

```bash
ravi meetings join \
  --provider google-meet \
  --url https://meet.google.com/abc-defg-hij \
  --name Ravi \
  --live \
  --agent ravi-meet-v0 \
  --tools tasks_list,tasks_show,artifacts_show \
  --json
```

## Finalizar Artifact

Quando um run ja existe em disco, finalize com:

```bash
ravi meetings finalize \
  --run-dir /path/to/run \
  --json
```

Por default, o finalize pode fazer transcricao post-call do audio quando houver
midia e quando isso for parte do contrato do provider. Use
`--no-post-transcribe` so para diagnostico ou quando o usuario pedir para pular.

O resultado esperado e:

- artifact `meeting.raw` registrado no Ravi;
- `meet.md` raw;
- `transcription.json` quando houver transcricao estruturada;
- referencias a midias por path, id ou link;
- diagnosticos de captura e provider.

## Leitura Do Artifact

Quando o usuario pedir para "ler o meet.md" ou continuar trabalho pos-call:

1. Abra o `meet.md` do artifact final.
2. Use o arquivo como fonte raw de verdade.
3. Nao resuma automaticamente se o pedido foi apenas para entregar/mostrar o
   raw artifact.
4. Se for gerar resumo, decisoes, backlog ou tasks, deixe claro que isso e uma
   transformacao posterior feita pelo agent consumidor.

Para auditar a origem:

```bash
ravi artifacts show <artifact-id> --json
ravi artifacts events <artifact-id> --json
```

## Streams E Midia

Para streams separadas, prefira o caminho de captura WebRTC do provider quando
disponivel. Nao substitua por gravacao de tela se o requisito e preservar tracks
separadas.

O `meet.md` deve referenciar cada midia capturada. O run dir tambem pode conter:

- `webrtc-tap/manifest.json`;
- tracks individuais `.webm`;
- diagnosticos do provider/captura;
- screenshots e snapshots de diagnostico do Meet UI.

## Debug Operacional

Se a call falhar ou parecer travada:

1. Veja os eventos do artifact `meeting.join`.
2. Leia o `metadata.json` do run dir se ja existir.
3. Confirme `admissionStatus`, `failures`, `nextSteps` e media refs.
4. Rode novamente com `--dry-run --json` antes de repetir um join.

Nao reexecute em loop. Corrija a causa observavel primeiro.
