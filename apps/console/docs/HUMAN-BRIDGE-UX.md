# Conversas privadas — análise anterior à implementação

Inspeção em 30/10/2026 das capturas renderizadas `verified-keys-1280.png` e
`verified-keys-390.png`, entrega `staging/pr2-vps-test/evidence`, base Fleet
2d049c9. A tela nova ainda não existe. Este registro antecede alterações de UX.

Objetivo: conversar com um agente na instalação escolhida, como a pessoa que
entrou no Console. Ordem natural: escolher instalação/projeto/agente, criar
conversa, enviar, acompanhar, eventualmente cancelar ou decidir uma ação.
Configuração de conexão desaparece do caminho diário após o vínculo estar pronto.

- Hierarquia: cartões atuais têm títulos legíveis, mas Settings e muitas abas
  competem com a tarefa. Conversas ganha página própria e um único composer.
- Proximidade e região comum: contexto, histórico e composer pertencem à mesma
  conversa; aprovação fica em cartão junto do turno, não em alerta global.
- Similaridade: respostas usam padrão consistente; botão primário só para envio
  ou confirmação em foco. Configuração permanece secundária.
- Continuidade/alinhamento: coluna de leitura estável, autor antes do texto,
  mensagens ordenadas; lista lateral no desktop. Nada salta entre colunas ao enviar.
- Figura/fundo: conservar superfície clara e bordas discretas; ação pendente
  precisa contraste textual e ícone, não apenas cor.
- Fechamento: recibo identifica envio aceito; término substitui atividade.
  Desconexão mostra reconectando e preserva mensagem/identidade da tentativa.
- Simetria: não forçar bolhas simétricas de larguras iguais; texto longo precisa
  largura de leitura, enquanto controles mantêm alinhamento previsível.
- Destino comum: mensagem, atividade, cancelamento e aprovação mudam com o mesmo
  turno; sem estado global que pareça afetar outras conversas.
- Pragnanz: uma conversa privada com um agente. SSH, JWT, cursores e chave de
  contexto não aparecem no fluxo humano; detalhes técnicos ficam no runbook.

Densidade: reduzir títulos redundantes e cartões vazios. Ritmo de 16/24px,
texto base legível, labels menores sem baixo contraste; histórico usa espaço
vertical disponível. Em 390px, lista e conversa são etapas, com Voltar visível;
não repetir a faixa de abas administrativas cortada da referência. Controles
devem caber sem scroll horizontal e manter alvos de toque de 44px.

Estados: carregamento com rótulo; vazio com Nova conversa; falta de acesso com
ação indisponível sem enumerar dados; falha de envio mantém texto e a tentativa;
recibo perdido permite consultar/repetir a mesma chave; reconexão retoma eventos
duráveis. Cancelar não promete desfazer efeitos já concluídos. Aprovação informa
ação, prazo e resultado, nunca sugere concessão permanente. Encerramento desativa
decisões antigas. Informação adicional por disclosure, sem esconder identidade.

Acessibilidade: labels reais, ordem de foco contexto → histórico → composer,
status `aria-live` sem reler todo histórico, erro associado ao campo, sem enviar
durante composição IME; Enter envia e Shift+Enter quebra linha. Validar teclado,
desktop 1280, mobile 390, texto longo, vazio, carregamento, sem acesso, reconexão,
cancelamento, aprovação pendente/decidida/expirada antes do aceite final.

Diagnóstico/composição apresentados na thread antes do código. Validação da implementação em 31/10/2026: página Next real com login OIDC
local; respostas do protocolo bridge simuladas somente para estados visuais.
Capturas `staging/human-bridge-test/evidence/bridge-approval-{1280,390}.png`
inspecionadas. Hierarquia, proximidade e região comum correspondem à composição;
sem overflow horizontal, alvos de toque de 44px. Passaram carregamento com retry,
repetição do mesmo envio após perda de recibo, cancelamento, decisão e estado de
reconexão (13 asserts). Corrigido carregamento que ficava infinito após erro.
Isso valida a interface, não substitui integração real do broker/VPS.
Os overlays da captura pertencem ao ambiente local de desenvolvimento.

Segunda validação:14asserts passaram, incluindo remoção do histórico visível após
perda de acesso. Troca do UUID do viewer reinicializa seleção, mensagens e tentativa.
