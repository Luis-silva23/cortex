# PDV — pagamento, convênio no caixa e usabilidade operacional

Frente de caixa `apps/pdv-desktop` (Electron + Vite/React). Este documento descreve o comportamento **vigente** depois
da rodada de 2026-09-27 (agente 5). Segurança do login (MFA): [SEGURANCA-PDV.md](SEGURANCA-PDV.md).

Arquivos principais: `src/components/PaymentModal.tsx`, `src/components/AgreementPaymentPanel.tsx`,
`src/services/payment-flow.ts` (regras puras), `src/store/checkout.store.ts` (venda em andamento),
`src/pages/POSPage.tsx`, `src/pages/SalesPage.tsx`, `src/services/printer.service.ts`.

## 1. Estados do pagamento

A venda **nunca** aparece como concluída sem o servidor devolver o pagamento `APPROVED`. Qualquer outra situação — ou
nenhuma resposta — é mostrada como não concluída.

| Estado na tela | Quando | Ações |
|---|---|---|
| Aguardando pagamento (`FORM`) | modal aberto, escolhendo a forma | Confirmar Pagamento (Enter), Cancelar/ESC |
| Aguardando a maquininha (`CARD_CONFIRM`) | Débito/Crédito com provedor `MANUAL` (sem TEF): venda já registrada, operador passa o cartão | **Maquininha APROVOU** (registra, com código de autorização/NSU opcional), **Maquininha RECUSOU** (nada é registrado), Voltar. ESC não fecha |
| Processando (`PROCESSING`) | requisição em andamento | nenhuma — botões travados, ESC/X não fecham |
| Aprovado → concluído (`APPROVED`) | servidor devolveu `APPROVED` | imprime (sem desfazer a venda) e fecha; o POS mostra o aviso **VENDA Nº X CONCLUÍDA**, troco em destaque e o que aconteceu com o cupom |
| Recusado (`DECLINED`) | `REJECTED`, maquininha recusou, ou regra do servidor recusou (ex.: limite do convênio) | "PAGAMENTO RECUSADO — VENDA NÃO CONCLUÍDA" + motivo; Escolher forma de pagamento |
| Cancelado (`CANCELLED`) | pagamento pendente cancelado | "PAGAMENTO CANCELADO — VENDA NÃO CONCLUÍDA"; Escolher forma de pagamento (mesma venda) |
| Não confirmado (`UNCONFIRMED`) | `PENDING` (PIX/terminal) **ou** sem resposta/5xx/"já em processamento" | "PAGAMENTO NÃO CONFIRMADO — VENDA NÃO CONCLUÍDA" + hora da última verificação; **Verificar de novo**; se pendente: **Cancelar pagamento pendente** e **Sair (venda fica pendente)**; se sem resposta: Voltar. ESC não fecha |

**Verificar de novo**
- Sem resposta: reenvia **a mesma tentativa** (mesma `Idempotency-Key` e mesmo `transactionId`) — o servidor devolve o
  pagamento já gravado ou processa uma única vez.
- Pendente: gerência (`MANAGER`, `COMPANY_ADMIN`, `SUPER_ADMIN`) chama `POST /payments/:id/reconcile` (consulta o
  provedor); operador consulta `GET /payments/transaction/:id` (a rota de reconciliação é só gerência+).
- **Cancelar pagamento pendente** chama `POST /payments/:id/cancel` (permissão `finance:reverse`). Sem a permissão, a
  tela explica e o pagamento continua pendente. Cancelado, a venda continua aberta para receber de outra forma.
- **Sair (venda fica pendente)**: limpa o carrinho e o POS mostra **VENDA Nº X NÃO CONCLUÍDA — pagamento pendente**.
  No Histórico a venda aparece com os pagamentos (`Aguardando confirmação`) e pode ser **cancelada com autorizador**.

**Resposta perdida depois de o servidor gravar.** Se a venda já foi paga por uma tentativa cuja resposta se perdeu (ou
o saldo está reservado por um pagamento pendente), a API recusa uma nova cobrança; o PDV então lê a venda
(`GET /sales/:id`) e mostra o que de fato aconteceu (concluída ou não confirmada) — nunca cobra outra vez.

Regras puras e testes: `src/services/payment-flow.ts`, `scripts/payment-flow.test.ts` (`npm run test:logic`).

## 2. Prevenção de venda e cobrança duplicadas

| Risco | Proteção |
|---|---|
| Duplo clique / Enter repetido no Confirmar | trava síncrona (`useRef`) além do botão desabilitado; uma operação por vez |
| Resposta da criação da venda perdida → reenviar criava outra venda | `POST /sales` com `Idempotency-Key` estável para o mesmo corpo; reenvio devolve a mesma venda. Erro de regra (4xx) libera a chave (a próxima tentativa, ex. depois de abrir o caixa, não repete o erro gravado) |
| Fechar o modal (ESC/X/Cancelar) depois de a venda existir e finalizar de novo criava **outra** venda | a venda em andamento fica no `checkout.store` (memória, por operador) e é reaproveitada enquanto o carrinho for o mesmo; o POS avisa "Venda Nº X já registrada e aguardando pagamento" |
| ESC no POS fechava o pagamento por fora, inclusive durante o processamento | o POS não fecha mais o modal; o modal decide (bloqueia em processamento, maquininha e não confirmado) |
| Resposta do pagamento perdida → reenviar cobrava de novo | `POST /payments` com `Idempotency-Key` = `transactionId` da tentativa; reenvio da mesma tentativa reusa a chave; tentativa nova (outra forma/valor, ou após recusa/cancelamento) ganha chave nova |
| Busca por nome com resultado único deixava a lista aberta → clique adicionava o item em dobro | a lista fecha ao adicionar automaticamente |
| Enter repetido na busca (leitor/operador) adicionava duas vezes | trava da busca em andamento |
| Troca de operador herdando venda em andamento | logout/login zeram carrinho, caixa e `checkout.store` |

Carrinho alterado depois de a venda existir: uma **nova** venda é registrada para o carrinho novo e a anterior fica
Pendente no Histórico (aviso explícito na tela) — ver DECISÃO NECESSÁRIA 1.

## 3. Convênio no caixa

Formas **Convênio funcionário** e **Convênio empresa** aparecem no pagamento só quando
`employeeAgreement.enabled` / `companyAgreement.enabled` estão ligados em `GET /policies/effective` (políticas da
empresa; não variam por filial).

- Funcionário: busca por nome, CPF ou matrícula (`GET /employee-agreements/lookup?q=`, mínimo 2 caracteres); lista CPF
  mascarado, matrícula, limite, usado, disponível e parcelas máximas; escolhe as parcelas (1..máximo). Enter no campo
  escolhe o único resultado utilizável e nunca confirma o pagamento sem conveniado.
- Empresa: busca (`GET /agreement-companies/lookup?q=`), mostra disponível ("sem limite definido" quando nulo) e prazo.
- Conveniado bloqueado/inativo **aparece**, com o motivo, e não pode ser escolhido; disponível menor que a venda também
  (motivo "Disponível R$ X — menor que a venda").
- Pagamento: `POST /payments` com `EMPLOYEE_AGREEMENT` + `employeeAgreementId` + `installments`, ou
  `COMPANY_AGREEMENT` + `agreementCompanyId` (servidor revalida tudo).
- Erros em PT-BR pelo código: `AGREEMENT_DISABLED`, `AGREEMENT_LIMIT_EXCEEDED`, `AGREEMENT_BLOCKED`,
  `AGREEMENT_INACTIVE`, `AGREEMENT_REQUIRED`, `INSTALLMENTS_INVALID`; rota ausente (404) → "Busca de convênios
  indisponível neste servidor".

O seletor "Convênio" do painel direito do POS é outra coisa: **desconto de parceiro** (`Partner`), não forma de
pagamento — ver DECISÃO NECESSÁRIA 4.

## 4. Atalhos vigentes (o que está na tela é o que funciona)

| Tecla | Ação | Observação |
|---|---|---|
| F2 | foca a busca de produto | vale com foco em qualquer campo |
| F3 | cliente | |
| F4 | desconto global | (fluxo de desconto é do agente de descontos) |
| F5 | quantidade do último item | nunca recarrega a janela |
| **F10** | **Finalizar venda** (novo — antes só havia o botão) | |
| ESC | fecha o painel do topo; no pagamento, só quando não esconde cobrança em andamento/incerta | |
| Enter | na busca adiciona; no pagamento confirma | trava contra repetição |

Com um modal aberto, F-keys do POS não agem (só ESC). Depois de adicionar item, escolher/fechar cliente e concluir a
venda, o foco volta ao campo de busca (leitor de código de barras sempre pronto).

## 5. Perda de conexão

- Busca de produto/cliente: cache local só de leitura (inalterado).
- Venda, pagamento e caixa **nunca** são enfileirados: "Sem conexão com o servidor — a operação NÃO foi concluída".
- Sem resposta no **pagamento**: estado "não confirmado" com Verificar de novo (mesma tentativa). Sem resposta na
  **criação da venda**: volta ao formulário; confirmar de novo devolve a mesma venda (idempotência).
- Prova: `walk-offline.js` (sem rede não grava nada; rede de volta = 1 venda) e `walk-agent5.js` D e G.

## 6. Impressão

`printerService.printSaleReceipt` passa a usar a impressora e a opção "imprimir automaticamente" salvas em
Configurações (antes gravadas e nunca lidas) e devolve o que aconteceu, mostrado no aviso da venda: "Cupom impresso",
"Cupom não impresso: impressão automática desligada", "Cupom NÃO impresso: impressora … não respondeu" ou, fora do
aplicativo instalado, "a impressão só funciona no aplicativo PDV instalado". Falha de impressão nunca desfaz a venda.
[LIMITAÇÃO] sem impressora térmica aqui: só os caminhos "sem ponte" e "desligada" foram exercitados.

## 7. Avaliação tela a tela (2026-09-27)

| Tela | Avaliado | Corrigido | Registrado |
|---|---|---|---|
| Login | MFA, mensagens, MAC | 2ª etapa TOTP/recuperação; ID só aceita dígitos; Enter repetido não dispara 2 tentativas | — |
| POS | atalhos, busca, leitor, cliente, duplicidade | F10 finalizar; lista de resultado único fecha; trava da busca; foco volta à busca após cliente; "remover" cliente; aviso da última venda (troco/cupom/pendente); aviso de venda registrada aguardando pagamento; "Estoque: N/A" para estoque zero → valor real | veículo na venda (DECISÃO 3) |
| Pagamento | estados, idempotência, cartão, PIX, convênio | tudo da seção 1–3 | — |
| Histórico | venda pendente | pagamentos com situação no detalhe; cancelar (com autorizador) também venda Pendente/Parcial; filtro "Parcialmente pagas" | — |
| Caixa (sangria/reforço) | fluxos | nada (tela do agente de caixa) | risco (lido no código, não reproduzido): Enter repetido no reforço pode registrar dois reforços (sem trava síncrona e `/cash-register/movement` sem `idempotency()`); erro do reforço mostra toast duplicado; card "Vendas do Dia" soma reforços/retiradas |
| Configurações | impressora, servidor, marca | impressora/auto-impressão aplicadas; URL da API vira somente leitura (o campo editável não tinha efeito); marca CÓRTEX | DECISÃO 5 |
| Troca de operador | logout | confirmado: limpa carrinho, caixa e venda em andamento | — |

## 8. DECISÕES NECESSÁRIAS

1. **Venda registrada e abandonada** (carrinho alterado, ou "Sair" com PIX pendente): hoje fica PENDENTE com estoque
   baixado até a gerência cancelar no Histórico. Expirar automaticamente? Travar o carrinho enquanto houver venda
   registrada? (Relacionado a "não há expiração de venda PENDING" em business-state-machines §1.)
2. **Cancelar pagamento pendente no PDV**: exige `finance:reverse` (o operador comum não tem). Permitir ao operador
   cancelar o **próprio** pendente, ou pedir autorizador no PDV (como na retirada)?
3. **Veículo na venda de balcão**: a venda do PDV não tem moto vinculada (só cliente). Vincular?
4. **Nome "Convênio"** no painel do POS (desconto de parceiro) confunde com "Convênio funcionário/empresa" (forma de
   pagamento). Renomear para "Parceiro (desconto)"?
5. **Servidor da API por terminal**: trocar o servidor em tempo de execução (Configurações) ou só na instalação (hoje)?
6. **Tecla de finalizar**: adotado F10; confirmar se a loja prefere outra (F12 abre ferramentas do navegador no modo dev).
