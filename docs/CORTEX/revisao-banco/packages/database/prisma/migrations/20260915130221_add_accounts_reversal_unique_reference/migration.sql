-- Achado de auditoria de integração: `reversePayable`/`reverseReceivable`
-- (financial.service.ts) só se protegiam contra estorno duplicado via um
-- `findFirst` + `create` sem transação nem lock — o próprio código já
-- documentava a janela de corrida teórica sob concorrência (clique duplo,
-- retry de cliente) e a deixava sem correção no banco. Mesma classe do
-- problema já resolvido para CashRegister/Inventory via índice único
-- parcial: sem isto, duas chamadas de estorno simultâneas para a mesma
-- conta paga podiam ambas ler "nenhum estorno ainda" e ambas criar um
-- lançamento negativo, duplicando o efeito no fluxo de caixa.
CREATE UNIQUE INDEX accounts_payable_one_reversal_per_reference ON public.accounts_payable USING btree ("referenceId") WHERE ("referenceType" = 'Reversal');

CREATE UNIQUE INDEX accounts_receivable_one_reversal_per_reference ON public.accounts_receivable USING btree ("referenceId") WHERE ("referenceType" = 'Reversal');
