# WhatsApp Overlay Manual Validation

Checklist curto para validar a navegação do cockpit do WhatsApp Overlay em uma sessão real do WhatsApp Web.

## Pré-condições

- Extensão carregada com o build/local source atual.
- Sidebar do Ravi visível no WhatsApp Web.
- Pelo menos um chat com sessão ligada no cockpit.
- Busca nativa do WhatsApp funcionando.

## Casos

### 1. Chat já aberto

Passos:

- Escolher no sidebar um item que já corresponde ao chat aberto no centro.
- Clicar em `Abrir chat`.

Esperado:

- notice de sucesso: `X já estava aberto`
- nenhum salto para outro chat

### 2. Row visível na lista nativa

Passos:

- Escolher um item cujo chat esteja visível na lista da esquerda.
- Clicar em `Abrir chat`.

Esperado:

- a row correta é clicada
- o centro muda para o chat esperado
- o notice só fecha em sucesso depois da confirmação real do chat aberto

Não aceitável:

- notice de sucesso só porque houve clique
- chat errado aberto por título parecido

### 3. Fallback via busca nativa

Passos:

- Escolher um item cujo chat não esteja visível na lista.
- Clicar em `Abrir chat`.

Esperado:

- o overlay usa a busca nativa
- espera a row aparecer
- clica na row correta
- confirma o chat aberto antes de mostrar sucesso

### 4. Falha explícita

Passos:

- Testar um item com vínculo ruim, título ambíguo ou chat inexistente.

Esperado:

- o overlay não fica em silêncio
- aparece erro explícito, por exemplo:
  - `não achei X`
  - `achei X, mas não consegui clicar na row`
  - `achei X, mas o WhatsApp não confirmou a abertura`

## Sinais úteis durante a validação

- `latestPageChat.chatId` deve bater com o chat aberto quando a row selecionada muda
- a row selecionada não deve depender de fallback por título no chat ativo
- notice de sucesso precisa representar abertura confirmada, não só interação DOM

## Resultado

Marcar o ciclo como validado só quando os quatro casos acima estiverem cobertos sem falha silenciosa.
