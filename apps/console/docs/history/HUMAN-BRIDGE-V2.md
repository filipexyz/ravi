> Histórico anterior à integração gateway; não descreve nem valida esta versão.

# Bridge Console → instalação Ravi — implementação v2

O humano autenticado escolhe instalação/projeto/agente e conversa em uma sessão
privada nova. Console apresenta UI, decide autorização e assina delegações;
modelo, ferramentas e execução continuam na instalação Ravi.

## Contrato e dependência

Requer [Ravi #761](https://github.com/filipexyz/ravi/pull/761) com `ravi-human-bridge/2`; o cliente não faz fallback para v1.
Ravi precisa de enrollment revisado e listener privado explicitamente habilitado.
Só Codex implementa o isolamento exigido pelo MVP; providers alternativos são
recusados. Histórico privado e controles passam pelo bridge autenticado, sem
acesso pelos comandos genéricos de sessões.
O SSH é somente transporte com hostkey fixada e comando forçado stdio. O usuário
SSH nunca representa o humano; não há shell arbitrário nem token administrativo
compartilhado enviado ao navegador.

`bridgeAgents` e `bridgeRules` estendem o documento versionado de autorização do
Console. Ausência dessas entradas concede zero ferramentas. Publicação usa o
fluxo existente draft/preview/publish/CAS. `deny` prevalece; `approval` exige owner
elegível e vale somente para a ação/digest/versão/turno/prazo vinculados.
Runtime verifica assinatura, nonce, replay, revisão e lease; não intersecta com
uma segunda policy de permissões local. Revogação de envio interrompe trabalho;
a perda de delegação expira em até30s mais tick250ms. Efeitos concluídos não são
revertidos. Outros canais do Ravi mantêm a autorização existente.

Bindings do servidor guardam pins e referências de cofre/transporte. OIDC de
humanos, Pages/Bases/Executor e credenciais existentes não são substituídos.
Nenhuma migration nova foi adicionada por este bridge. Policies anteriores sem
campos bridge continuam válidas e preservam seu digest. **Binários antigos não
conseguem carregar policies que contenham os novos campos/ações**: o schema strict
é aplicado em `readRevision`, inclusive nas decisões normais de autorização.
Compartilhar uma policy nova com um Console antigo pode interromper seu acesso
a projetos e a administração; não é apenas uma limitação de edição. Atualizar
todos os leitores desse armazenamento antes de salvar qualquer rascunho com
campos ou ações bridge: a administração antiga também carrega a revisão de
rascunho, mesmo quando a policy ativa ainda é compatível. Para rollback, publicar
pelo fluxo atual uma revisão sem campos/ações bridge e sem rascunho incompatível
antes de voltar o Console antigo, preservando auditoria e histórico. Revisões
históricas bridge podem continuar armazenadas, mas não devem ser selecionadas
para restauração pelo binário antigo. O ambiente de teste usa banco
isolado e não publica essas policies no Console anterior.

Resultado sanitizado legível por máquina: [HUMAN-BRIDGE-ACCEPTANCE.json](../HUMAN-BRIDGE-ACCEPTANCE.json).

## Provas

- Protocolos controlados: assinatura/replay, isolamento, idempotência, cursor,
  versão de conversa, owner/ação de aprovação e validade/revogação.
- UI renderizada1280/390, estados e análise Gestalt anterior: HUMAN-BRIDGE-UX.md.
- Ambiente privado:43checksPASS com dois usuários OIDC sintéticos, UI real,
  SSH, Ravi e DeepSeek reais; criação/envio/resposta, replay/reconexão, aprovação
  pela UI do owner com output real, cancelamento de processo e revogação viva.
- Revisão para publicação:20testes/103asserts de engine/SSH/bridge passaram;
  47 testes de banco foram ignorados nessa execução sem Postgres de teste.
  Typecheck passou. O E2E real anterior permanece prova separada.

Sem segredos, hostnames operacionais, dumps ou credenciais no repositório.
Publicar o PR não habilita o bridge nem altera produção. A dependência Ravi deve
estar disponível antes de habilitar conversas nesta versão do Console.
