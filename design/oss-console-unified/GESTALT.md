# Gate UX — antes da implementação

03/11/2026. Referência renderizada: Console original preservado no estudo,
AppShell + OnboardingScreen com adapters de dados sintéticos. Capturas 1440×900
e 390×900 em /tmp/oss-console-before-{1440,390}.png. Não são produção.
Skills aplicadas: Emil Design Engineering, Vercel React Best Practices e Web
Interface Guidelines (fonte primária consultada em 03/11/2026).

## Objetivo e sequência

Operador quer instalar Ravi, associá-lo ao Console e verificar que está disponível
para gestão. Ação principal: associar a instalação identificada, depois testar e
concluir. Ordem: instalador escolhe ambiente separado → browser humano autenticado
confirma máquina/chave → instalação estabelece saída → teste produz recibo →
Instalação concluída → Gerenciar instalações. Nomes, fingerprints e estados vêm
do backend real. Descoberta não concede autoridade. Campos e instruções vencidos
desaparecem após conclusão; dados de falha permanecem para retomada com mesmo intent.
Canais e pessoas são opcionais; acesso é explícito. Conversa pertence ao Desktop
futuro, sem CTA ou deep-link.

## Diagnóstico Gestalt

- Hierarquia: cabeçalho e tabs atuais funcionam; cinco cartões iguais competem
  com a conclusão. Priorizar estado e próximo passo, um primário por fase.
- Proximidade: título/descrição de cada cartão estão bem juntos; ações de revisão
  deslocam o operador para telas diferentes. Manter prova e ação na mesma região.
- Similaridade: botões secundários uniformes ajudam consistência mas sugerem
  obrigatoriedade igual para credenciais opcionais. Separar conclusão de extensões.
- Região comum: cartões delimitam tarefas, porém excesso fragmenta uma única
  associação. Uma região para identidade + confirmação + resultado.
- Continuidade/alinhamento: grade de 768px e alinhamento esquerdo são preservados;
  sem novo shell. Campos empilham em mobile, CTA continua visível no fluxo.
- Figura-fundo: canvas quente e cartões brancos funcionam. Preto só na próxima
  ação, verde para resultado confirmado; não marcar sucesso por formulário salvo.
- Fechamento: revisar não prova conexão. Estado final explícito com recibo e destino
  de gestão. Guia desaparece persistindo conclusão no servidor.
- Simetria: ritmo de espaços é consistente; preservar sem impor pares de cartões
  que deem destaque igual a tarefas opcionais.
- Destino comum: estado de conexão, operação e erro pertencem à mesma instalação;
  atualização conjunta via query invalidação, não contadores dispersos.
- Pragnanz: reduzir cinco revisões a associar → verificar → concluir. Termos de
  SSH/bridge/custódia ficam fora da ação comum; detalhes de confiança são revelados
  quando ajudam a confirmar a máquina e seu alcance.

## Qualidade visual e interação

Densidade atual baixa mas muito vertical (mobile >1400px). Manter largura e
espaçamento de campos, reduzir cartões redundantes. Escala tipográfica e
contraste seguem tokens atuais. Tabs continuam URLs e scroll horizontal contido;
não adicionar navegação lateral. Skeleton não imita sucesso; erro inline explica
retomada, estado vazio explica comando de associação, loading mantém contexto.
Rotação/revogação não são chamadas conexão. Foco visível, labels, aria-live
para resultado, controle nativo, alvos de toque, sem animação obrigatória e
sem overflow horizontal. Dados remotos em TanStack Query com identidade/org na
chave; rascunhos locais não guardam credenciais em storage do browser.

| Before | After | Why |
| --- | --- | --- |
| Cinco cartões iguais de revisão | Uma tarefa principal e resultado verificável | Hierarquia orientada à instalação |
| Checkbox confirma leitura | Recibo de teste confirma a instalação | Fechamento corresponde ao objetivo |
| Conversas no topo | Gestão sem chat | Desktop será a superfície de conversa |
| Credenciais e SSO no caminho inicial | Configurações disponíveis, opcionais | Divulgação progressiva |
| Instalação por SSH/chave | CLI abre confirmação contextual e saída autenticada | Elimina cadastro técnico desnecessário |

Validação posterior obrigatória: desktop/mobile, luz/escuro, teclado, Axe,
erro/retomada, permissão negada/revogada e conclusão persistida.

### Ajuste proporcional após render real — contraste

A auditoria Axe do onboarding com shell real (1440 px) identificou contraste
insuficiente no token `ink-3` das abas, Docs e legenda do comando. A hierarquia
permanece adequada, mas a baixa legibilidade interfere na navegação. Antes da
alteração: escurecer o texto secundário no tema claro e clareá-lo no escuro,
sem alterar composição, espaçamentos ou identidade. O código de conexão passa
a usar o CodeBlock/CopyButton existente, evitando seleção manual em 390 px.
Validar novamente todas as telas da jornada e os dois temas.

Na largura 390 px, o seletor de organização oculta seu texto visual. Acrescentado nome acessível ao botão existente para manter a mesma ação disponível por leitor de tela.

## Gate incremental — primeiro acesso e canais (antes do código)

Render real reinspecionado: `ravi-unified-browser-BD8d20/setup-before-390.png`
e `managed-1440.png`, login/DB próprios. O primeiro acesso possui título, cartão,
campo e ação bem agrupados, porém exige transporte manual de código mesmo quando
um instalador pode abrir o browser. A gestão mantém a identidade real do Console,
mas ainda não oferece gestão dos adapters da instalação.

Objetivo: entrar no Console pelo link do instalador; opcionalmente configurar o
adapter nativo de uma instalação. Ações: continuar para login; depois consultar
conexões → escolher conta/nome → aplicar → consultar recibo. Prova e formulário
desaparecem quando concluídos; falha preserva intenção e dados. Conversa ausente.

Hierarquia: preservar um primário por etapa; canal fica em expansão secundária.
Proximidade/região comum: conexão, resultado e erro dentro do cartão da máquina.
Similaridade: mesmos Field/Input/Button/Panel; não criar shell ou aba competidora.
Continuidade/alinhamento: mesma coluna, sem deslocar a navegação; campos em uma
coluna móvel. Figura-fundo: tokens atuais, nunca badge de sucesso por mero envio.
Fechamento: estado confirmado somente após recibo; resultado incerto só consulta.
Simetria: manter ritmo de espaços sem exigir cartões opcionais de igual peso.
Destino comum: operação/resultado atualizam juntos na chave org+pessoa+máquina.
Pragnanz: ocultar o código transportado pelo link e revelar somente a tarefa de
canal escolhida; não confundir identidade da máquina com autorização humana.

Densidade e tipografia atuais são adequadas; reduzir um campo no primeiro acesso
com link válido. Nome acessível, foco, submit por teclado, aria-live e mensagens
inline são necessários. Loading não remove valores, erro não cria nova operação,
vazio explica falta de conexão disponível. Nenhum token do bot entra no browser.
Validar 1440/390, claro/escuro, Axe e estados pendente/erro/sucesso após implementar.

| Before | After | Why |
| --- | --- | --- |
| Campo obrigatório de código | Link preenche prova; campo apenas no fallback | Remove cópia no caminho comum |
| Só conexão/revogação na instalação | Gestão opcional dos adapters na mesma região | Mantém contexto da máquina |
| Nenhum estado do pedido de canal | Operação e recibo explícitos | Evita declarar efeito ao apenas enfileirar |
