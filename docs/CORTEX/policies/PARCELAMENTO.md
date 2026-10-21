# Parcelamento — divisão em centavos inteiros

> Vigente desde 2026-10-06. Implementação única: `packages/shared/utils/installments.ts` (usada pela API e pelo PDV). Provas: `apps/api/src/services/installments.test.ts` (20), `apps/api/test/integration/installments.integration.test.ts` (PostgreSQL real), `apps/pdv-desktop/scripts/installment-preview.test.ts` (3), `apps/api/src/architecture/domain-separation.test.ts` (5).

## Domínios: Venda → Parcelas → Liquidação → Fiscal

| Domínio | O que é | Onde vive | Não faz |
|---|---|---|---|
| **Venda** | o valor a receber (`sales.totalAmount`) | `sale.service.ts` | não divide em parcelas |
| **Parcelas** | divisão financeira do valor em N partes, **em centavos inteiros** | `shared/utils/installments.ts` (cálculo puro) + política `installment_policies` (máximo por forma/filial) + persistência onde existe (folha do convênio) | não sabe de recebimento, taxa nem tributo |
| **Liquidação** | o recebimento/baixa de cada parte (caixa, conciliação, folha) | `payment.service.ts`, `cash-register`, `employee-agreement` | não recalcula a divisão |
| **Fiscal** | obrigações e cálculo tributário do documento | `fiscal.service.ts` + adaptador de provedor, **só chamado pela rota fiscal** | não participa da venda, do cálculo de parcelas nem do recebimento |

A separação é **protegida por teste** (`domain-separation.test.ts`): só `routes/fiscal.routes.ts` importa o serviço fiscal; o cálculo de parcelas, `payment.service`, `sale.service` e `installment-policy.service` não têm tributo nem "fiscal" no código; `Sale`, `SaleItem` e `Payment` não têm coluna tributária; o PDV não tem campo tributário.

## A regra

- Todo valor monetário vira **inteiro de centavos** (`toCents`) antes de qualquer conta; a divisão é aritmética inteira; só depois volta a reais (`inteiro / 100`). **Nenhuma soma de parcelas em ponto flutuante.**
- `base = floor(total / n)` centavos em todas as parcelas; o **resto** (`total % n`, sempre menor que n) vai **1 centavo para cada uma das ÚLTIMAS parcelas**. A soma é **exatamente** o total.
- Valor com **fração de centavo** (R$ 10,005) é **recusado** (400), nunca arredondado em silêncio. O ruído do double (`33.33 × 3 = 99.99000000000001`) não é fração de centavo.

| Total | Parcelas | Resultado | Soma |
|---|---|---|---|
| R$ 100,00 | 1x | 100,00 | 100,00 |
| R$ 100,00 | 2x | 50,00 + 50,00 | 100,00 |
| **R$ 100,00** | **3x** | **33,33 + 33,33 + 33,34** | **100,00** |
| R$ 10,00 | 3x | 3,33 + 3,33 + 3,34 | 10,00 |
| R$ 100,01 | 3x | 33,33 + 33,34 + 33,34 | 100,01 |
| R$ 99,99 | 12x | 9 × 8,33 + 3 × 8,34 | 99,99 |
| R$ 0,03 | 3x | 0,01 + 0,01 + 0,01 | 0,03 |

## Recusas (API: 400 com código)

| Caso | Resposta |
|---|---|
| parcelas 0, negativa, fracionária, NaN | `400` na borda (`installments` inteiro ≥ 1) e `INSTALLMENTS_INVALID` no serviço |
| valor menor que R$ 0,01 por parcela (R$ 0,01 em 2x, **R$ 0,01 em 3x**) | `400 INSTALLMENTS_INVALID` (`INSTALLMENT_TOO_SMALL` na função compartilhada). Foi pedido o exemplo "R$ 0,01 em 3x = 0,00 + 0,00 + 0,01"; **a regra em vigor recusa** parcela zerada (título sem valor, divergência com o adquirente). Mudar isso é **decisão 117** — não foi alterado |
| valor zero ou negativo | recusado (pagamento exige valor positivo; `splitInstallments` também recusa) |
| valor com fração de centavo | `400` (`amount`/`receivedAmount` em centavos exatos) |
| acima do máximo da política da empresa/filial (sem política: só 1x) | recusado (política `installment_policies`) |

## O que está persistido (e o que não está)

- **Convênio de funcionário:** as parcelas **ficam gravadas** (`employee_payroll_deductions.amount`, uma por competência), e o teste de integração prova que a soma gravada é exatamente o total (33,33 / 33,33 / 33,34).
- **Cartão de crédito:** o pagamento grava o **valor total** e a **quantidade** de parcelas (`payments.installments`); o **cronograma de recebimento por parcela não é persistido** — o parcelamento no cartão é do adquirente/maquininha (modo manual). O PDV mostra "3x de R$ 33,33 (última de R$ 33,34)" com a mesma função. Persistir um cronograma de recebíveis do cartão (datas, taxa do adquirente, antecipação) depende de **decisão de negócio e de provedor** — **não foi inventado**.
- **Comprovante:** o cupom do PDV não imprime parcelas; nada a recalcular ali.

## Mudança de comportamento (registrada)

Antes, `splitInstallments` (convênio) usava ponto flutuante e dava o centavo que sobrava às **primeiras** parcelas (R$ 100,00 em 3x = 33,34 + 33,33 + 33,33), diferente do combinado. Agora o resto vai para as **últimas**. Parcelas de folha já gravadas **não** foram alteradas; só as novas seguem a regra nova.

## Política configurável e juros (auditoria 2026-10-14)

`InstallmentPolicy` (por empresa/filial/forma de pagamento; filial vence empresa; sem política = 1x) limita o **número máximo de parcelas**; só COMPANY_ADMIN/SUPER_ADMIN alteram, com auditoria. **Não existe cálculo de juros**: `interestFreeInstallments` é gravado e não é lido por nenhuma regra de cobrança; o total é o da venda, dividido em centavos (resíduo nas últimas parcelas). Não há vigência (só `isActive`), nem aprovação por segunda pessoa. A tela do Admin Web agora avisa isso. Modelo de juros/taxa = **decisão 119**; recebimento do cartão = 114.
