# Regras de negócio

O que o código **faz hoje**. Estados, transições e perfis de cada documento estão nas
[máquinas de estado](contracts/business-state-machines.md); quem pode fazer o quê, na
[matriz de permissões](contracts/permission-matrix.md). Aqui ficam as regras transversais e as desta rodada. O que não
está definido pelo dono aparece como **[DECISÃO NECESSÁRIA]** e está listado em [DECISIONS](DECISIONS.md#pendentes).

## Vendas e devolução

- Venda nasce PENDING com o estoque já baixado; pagamento aprovado leva a PARTIALLY_PAID/PAID. Cancelamento e devolução
  exigem autorizador (gerente+), motivo e são auditados; guardas impedem estorno em dobro e venda encerrada reaberta.
- Devolução: estorno rateado pelo valor líquido pago (definido em 2026-09-25).
- Detalhes e lacunas: [máquinas de estado §1](contracts/business-state-machines.md#1-venda-salestatus-pending-paid-partially_paid-cancelled-returned).

## Pagamentos

- **Dinheiro:** `amount` é o valor aplicado à venda; `receivedAmount` o entregue; `changeAmount` o troco. Caixa e venda
  usam só o aplicado.
- **Cédulas (opcional, por empresa com override por filial):** ligado, o dinheiro exige a composição de cédulas/moedas do
  Real somando o recebido; o fechamento mostra a composição.
- **Cartão sem integração (MANUAL):** confirmado pelo operador na maquininha. **PIX sem provedor:** PENDING até
  conciliação — nunca "venda finalizada".
- **Provedor externo (TEF/PSP):** intenção primeiro (PENDING com `transactionId`, saldo reservado), terminal recebe o
  valor da venda, liquidação com guarda; sem resposta fica PENDING; mesma chave não cobra duas vezes; reconciliação
  manual e por job (5 min) aplica uma única vez. Cancelar um pendente pergunta ao provedor primeiro.
- **Exceção: provedor aprova depois que a venda foi cancelada ou devolvida** (definido tecnicamente em 2026-09-26):
  - o pagamento é registrado como **APPROVED** com os dados do provedor e a nota `[EXCEÇÃO]` — nunca apagado, nunca
    recusado de mentira;
  - a venda **não muda** (continua cancelada/devolvida) e **nada entra no caixa** (o dinheiro está no provedor);
  - abre uma `payment_exception` (`APPROVED_ON_CLOSED_SALE`), uma só por pagamento, visível em
    `GET /payments/exceptions` (gerência+);
  - tratamento por pessoa autorizada (`finance:reverse`, auditado): **estorno no provedor** (só marca REFUNDED com a
    confirmação dele; sem confirmação, nada muda e pode tentar de novo; provedor sem estorno → tratar fora e registrar)
    ou **registro manual** com justificativa (mínimo 10 caracteres);
  - cancelamento e estorno **comuns** desse pagamento são recusados (409 `PAYMENT_IN_EXCEPTION`), inclusive depois de
    tratada — nada dele entrou no caixa, então "reverter" criaria saída sem entrada;
  - **Regra do dono (2026-09-27):** venda cancelada **não recebe pagamento** (409 `SALE_CLOSED_FOR_PAYMENT`) e não
    reabre; nova compra = nova venda. A aprovação tardia do provedor é **inconsistência de integração**: registrada e
    tratada por pessoa autorizada em Financeiro › **Conciliação** — sem reabrir, sem marcar paga, sem crédito, estorno ou
    venda automáticos ([CAIXA](policies/CAIXA.md#venda-cancelada-e-pagamento-regra-definitiva)).
  - Prova: `payment-exceptions.integration.test.ts` (venda cancelada/devolvida, cancelamento e reconciliação simultâneos,
    provedor indisponível, estorno indisponível, resposta atrasada, nova tentativa, duplicidade, cancelamento/estorno comum
    recusado).

## Caixa

- Um caixa aberto por operador; só o dono, a gerência da filial ou o admin operam o caixa. Reforço/sangria com guarda
  (movimentos simultâneos somam certo); sangria com autorizador e comprovante.
- **Fechamento (2026-09-27):** pendência (pagamento pendente, venda em aberto — por política) bloqueia o fechamento
  normal com 409 e a lista; o **forçado** é só Gerente/Admin, com motivo, e grava pendências, valores, operador,
  autorizador e resumo dos movimentos. Nada é escondido ou apagado ([CAIXA](policies/CAIXA.md)).
- **Esperado × informado (regra definitiva, 2026-09-28):** o fechamento considera todo o movimento do caixa — dinheiro
  (com fundo, reforços e sangrias), cartão, PIX, convênios — por forma de pagamento; o operador informa o realizado de
  cada forma; com divergência, motivo obrigatório (política). O resumo gravado traz esperado, informado, diferença,
  operador, período, vendas, formas, motivo, quem fechou e autorizador ([CAIXA](policies/CAIXA.md)).

## Desconto

- Até **5%** em peça/produto sem autorização (sempre auditado em `discount_events`); acima, Gerente/Admin autoriza;
  **serviço/mão de obra sem livre**; solicitante ≠ autorizador; motivo obrigatório. Vale para venda (PDV) e OS; a regra
  por papel (`DiscountRule`) só restringe mais. Limites e papéis por política ([DESCONTO](policies/DESCONTO.md)).

## Fiscal

- Venda cancelada, pendente ou parcialmente paga **não** é emitida (409); operações habilitadas por política
  (`fiscal.enabledOperations`). Devolução fiscal: [DECISÃO NECESSÁRIA] ([FISCAL](policies/FISCAL.md)).

## Devolução ao fornecedor

- Solicitação → aprovação (perfil da política, ≠ solicitante; **retira o estoque**) → envio → resultado (crédito,
  reposição, reembolso ou recusa do fornecedor) → histórico. Cancelar devolve o estoque. Nada é apagado. Não é garantia
  ao cliente ([DEVOLUCAO-FORNECEDOR](policies/DEVOLUCAO-FORNECEDOR.md)).

## Convênios e cobrança

- Convênio de **funcionário** (limite fixo ou % do salário por mês, parcelas por competência, desconto em folha,
  espelho) e de **empresa conveniada** (prazo, limite, vencimento, atraso, bloqueio). Bloqueado não compra; histórico e
  dívida continuam. Convênio é autorizado pela administração e pode valer só em filiais escolhidas; indisponível, o PDV
  mostra cinza com a mensagem ([CONVENIOS](policies/CONVENIOS.md), [FINANCEIRO](policies/FINANCEIRO.md)).
- **Cobrança só manual:** Gerente/Admin clica [ENVIAR COBRANÇA] e escolhe WhatsApp e/ou e-mail; cada canal é uma
  tentativa registrada. Sem robô, envio automático ou chatbot ([COBRANCA](policies/COBRANCA.md)).

## Estoque

- Saldo = livro de movimentações: entradas (compra, devolução, transferência recebida, produção) somam |qtd|; saídas
  (venda, transferência enviada, perda) subtraem |qtd|; ajuste soma a quantidade com sinal; **inventário fixa** o saldo.
  Ordem por data e id. Calculado no banco (`stock-ledger.ts`).
- Produto sem movimentação = "não inventariado" (não conta como estoque baixo).
- Venda, baixa de peça, ajuste, transferência e avaria conferem o saldo com trava na mesma transação; estoque negativo só
  em produto marcado `allowNegativeStock`.
- Ajuste e movimento exigem filial; inventário: um em andamento por filial.

## Importação (produtos, clientes, estoque)

- Até **5.000 linhas** por arquivo (413 acima disso); CSV UTF-8/BOM ou Windows-1252, separador `;` ou `,`, vírgula
  decimal aceita.
- Cada importação vira um **lote** (`import_batches`) com o resultado por linha (importada, sem alteração, erro, aviso);
  movimentos de estoque apontam para o lote. `?dryRun=true` simula tudo sem gravar.
- Cada linha na sua transação: produto + estoque inicial juntos. Repetição dentro da planilha (SKU, CPF/CNPJ, produto) é
  recusada apontando a primeira linha; CPF/CNPJ comparado pelos dígitos e com dígito verificador.
- Estoque inicial exige filial; administrador escolhe uma filial da própria empresa (validada).
- Linhas numeradas como na planilha (cabeçalho = linha 1). `Idempotency-Key`; auditoria com o resumo do lote.

## Oficina e orçamentos

- OS só é paga em PRONTO ou ENTREGA (definido em 2026-09-25); OS cancelada não recebe pagamento nem comissão.
- Encerrar a OS exige a **decisão de garantia** (sem garantia ou serviço/peça/ambos, prazo, km — o que ocorrer primeiro);
  ocorrência sempre ligada à OS original ([GARANTIA](policies/GARANTIA.md), [OFICINA](policies/OFICINA.md)).
- Orçamento sem resposta por **5 dias** (política) fica vencido; encerrar em lote com motivo; reabrir por política;
  histórico nunca apagado; mesmo veículo com orçamento aberto → continuar ([ORCAMENTO](policies/ORCAMENTO.md)). Desconto
  em orçamento e separação de funções: [DECISIONS](DECISIONS.md#pendentes).

## Agenda e pós-venda

- A loja **propõe** o horário; o **cliente confirma** (ou o dono do negócio registra a confirmação dele). Confirmar exige
  **canal** (telefone, WhatsApp, e-mail, SMS, presencial) e **quem confirmou** (≥ 2 caracteres); só a partir de PROPOSED.
- Transições com guarda (`PROPOSED`/`CONFIRMED` → …): duas confirmações simultâneas = uma 200 e uma 409; confirmar ×
  cancelar sempre termina coerente. Remarcar volta a PROPOSED (a confirmação anterior deixa de valer).
- "Não compareceu" só depois do horário marcado. Cancelar devolve o pós-venda a PENDING; cancelar o pós-venda cancela o
  agendamento ativo. Novo agendamento depois de um encerrado substitui o antigo (evento "Substitui o agendamento X").
- O agendamento precisa ser do mesmo cliente e da mesma moto do pós-venda (400 `FOLLOW_UP_MISMATCH`).
- **Comunicação com o cliente é registro manual** (canal + resultado): nenhum provedor de mensagens está acoplado; o
  envio real (WhatsApp/SMS/e-mail) entraria como adaptador novo sem mudar a regra.
- **Concluir sem confirmação do cliente** exige autorização de responsável interno (≠ solicitante), auditada.
- **Capacidade configurável por empresa/filial** (2026-09-28): duração do atendimento, boxes simultâneos, limite por
  horário/dia/mês, mecânico (sem conflito em nenhuma filial) e indisponibilidades; a janela inteira precisa caber no
  horário de funcionamento. Recusas 409 com o motivo e o que fazer ([AGENDA](policies/AGENDA.md)).
- **[DECISÃO NECESSÁRIA]:** concluir não fecha o pós-venda; capacidade por recurso (boxes, mecânicos, duração, encaixes).

## Revisões

- Próxima revisão = data da revisão + intervalo em meses, **sem estourar o mês** (31/01 + 1 mês = 28/02 ou 29/02).
- Data da revisão válida e no máximo 24 h no futuro (tolerância de fuso para "hoje"); recomendações até 2.000
  caracteres; listagem até 100 por página.

## Monitoramento

- Limites por métrica (latência e erros da API, CPU/RAM/disco, rede e perda, equipamentos offline, banco, Redis, filas,
  jobs atrasados) com padrão do produto; o Super Admin sobrescreve **por empresa ou filial** (efetivo: filial → empresa
  → global → padrão), dentro de um teto por métrica (ex.: disco ≤ 98%), com motivo (≥ 5 caracteres), histórico e
  auditoria. Atenção < crítico.
- Alerta registra origem, empresa, filial, equipamento, métrica, valor, limite, início, fim e situação; um aberto por
  origem+tipo; reabre só após 10 min; fecha sozinho quando normaliza. "Sem dados" não abre alerta nem aparece como
  "normal"; heartbeat parado abre `DEVICE_OFFLINE`.

## Central de Ajuda e chamados

Regras completas e contratos em [SUPPORT](SUPPORT.md).

- Obrigatórios: assunto, módulo, tipo e descrição; prioridade, anexos e contexto são opcionais. Empresa, filial,
  usuário e perfil do solicitante vêm da autenticação, nunca do formulário.
- Situações: Aberto, Em análise, Aguardando você, Aguardando suporte, Resolvido, Encerrado. Resposta do suporte →
  Aguardando você; resposta da empresa → Aguardando suporte. **Encerrado é final** (abre-se outro citando o número);
  só Resolvido reabre. Só quem abriu encerra.
- Histórico e mensagens nunca são editados nem apagados.
- Visibilidade: solicitante vê os seus; quem tem `support:view_company` vê os da empresa; usuário de filial sem essa
  permissão vê os da filial. VIEWER também abre chamado.
- Anexos: PNG, JPG, PDF e log; 2 MB; 10 por chamado; sem executável nem HTML; sem URL pública.
- Número de cartão completo no texto é recusado. Sem SLA, sem IA, sem chatbot; aviso só dentro do sistema.

## Telemetria do PDV

- O PDV envia a versão do **aplicativo** (a do `package.json`) e, separada, a do **runtime** (Electron · Node · Chrome).
  Antes a versão do Electron aparecia como se fosse a do app.
