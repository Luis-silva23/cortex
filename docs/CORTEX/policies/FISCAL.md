# Política fiscal — emissão de documento de venda

> Regra decidida pelo dono em 2026-09-27. Implementação: `apps/api/src/services/fiscal.service.ts`
> (`emitDocument`, `assertSaleEmittable`), `apps/api/src/routes/fiscal.routes.ts`; Admin Web `app/dashboard/fiscal/page.tsx`.

## Regra vigente

| Situação da venda | Emissão de documento de VENDA |
|---|---|
| `PAID` (concluída) | permitida |
| `CANCELLED` | **recusada — 409 `FISCAL_SALE_CANCELLED`**: a venda não ocorreu. Nunca se cria nota nova por causa do cancelamento. |
| `PENDING` / `PARTIALLY_PAID` | **recusada — 409 `FISCAL_SALE_NOT_COMPLETED`**: pagamento não confirmado = venda não concluída |
| `RETURNED` | **inalterado** (continua aceitando como antes) — ver DECISÃO NECESSÁRIA |

- Política `fiscal.enabledOperations` (padrão `['SALE']`, filial pode sobrescrever): sem `SALE` → **409
  `FISCAL_OPERATION_DISABLED`** com mensagem apontando Configurações › Políticas › Fiscal.
- A situação da venda é conferida antes e **de novo dentro da transação**, com `SELECT … FOR SHARE` na linha da venda
  (depois da trava por venda): um cancelamento concorrente não deixa emitir para a venda cancelada.
- Usuário de filial emite só na própria filial (a filial do corpo só vale para administração sem filial).
- A emissão real continua dependendo do provedor fiscal (hoje `UnconfiguredFiscalAdapter` → documento PENDENTE).

## Telas

- Admin Web › Fiscal: "Tentar emitir para uma venda" só oferece **vendas pagas** (`isSaleOfferedForEmission`,
  lista pedida com `status=PAID`). Cancelada, pendente, parcialmente paga e devolvida não aparecem.

## DECISÃO NECESSÁRIA

Diretriz do dono (2026-09-28): **não inventar agora** política fiscal de devolução; a arquitetura fica preparada
(operações por política, adaptador de provedor). Princípios que valem: venda cancelada não gera documento de uma venda
inexistente; operação fiscal real segue o fluxo fiscal aplicável; **nunca** simular emissão nem afirmar integração com
SEFAZ/provedor que não exista (hoje: `unconfigured-adapter`). Devolução de compra ao fornecedor também fica fora do
sistema fiscal até haver provedor e orientação ([DEVOLUCAO-FORNECEDOR](DEVOLUCAO-FORNECEDOR.md)).

- **Venda devolvida (`RETURNED`)**: devolução fiscal é operação própria (nota de devolução/entrada, operação
  `RETURN` do catálogo). Hoje `emitDocument` continua aceitando `RETURNED` como antes e a tela não a oferece.
  Falta decidir: emitir documento de devolução (qual tipo/CFOP) e se a emissão de venda para devolvida deve ser recusada.
- **Venda cancelada que já tinha documento autorizado**: o cancelamento da venda não cancela o documento fiscal
  automaticamente (fluxo `POST /fiscal/documents/:id/cancel` separado, com prazo do provedor). Decidir se o
  cancelamento da venda deve exigir/disparar o cancelamento do documento.

## IBS, CBS e Split Payment — estado (2026-10-06)

Revisado no código (entidades, migrações, serviço, rotas, adaptador, tela, política): **não existe nenhuma implementação de IBS, CBS ou Split Payment**, e **não foi inventada uma parcial**. O que existe é o módulo Fiscal **de documento de venda**, administrativo:

| Parte | Estado |
|---|---|
| Configuração fiscal por empresa/filial (`fiscal_configs`: séries NFC-e/NF-e, ambiente, certificado/CSC cifrados) | **implementado** (Admin Web › Fiscal; só administração; segredos `enc:v1`) |
| Documento fiscal (`fiscal_documents`: estado, número/série únicos por filial, chave, protocolo, cancelamento) e emissão/cancelamento com regras de venda, concorrência e política `fiscal.enabledOperations` | **implementado** (provado) |
| Emissão **real** (SEFAZ/intermediário, certificado, XML/DANFE) | **parcial → pendente de provedor:** só o `UnconfiguredFiscalAdapter` ("honesto": nunca finge autorizar) |
| Contrato do adaptador (`FiscalProviderAdapter`, `taxes` por item como estrutura livre, sem alíquota fixa) | **preparado arquiteturalmente** |
| **Cadastro tributário** (regime do emitente existe em `Company.taxRegime`; **não há** NCM/CFOP/CST/CSOSN, alíquotas ou regra tributária por produto/operação) | **pendente** |
| **IBS** e **CBS** (cálculo, destaque, alíquotas, transição 2026–2033, créditos) | **pendente — dependente de regulamentação** (Reforma Tributária) e de decisão tributária do dono/contador; não há tabela, campo nem cálculo |
| **Split Payment** (repartição do pagamento entre tributo e vendedor na liquidação) | **pendente — dependente de regulamentação e de integração** (adquirente/PSP/instituição financeira); hoje o pagamento é manual/adaptador `MANUAL` |

**Princípios já respeitados (e protegidos por teste, `domain-separation.test.ts`):** o Fiscal é **administrativo/configurável** — a empresa configura antes; o **operador do PDV não digita dado tributário** (o PDV não tem campo tributário e `Sale`/`SaleItem`/`Payment` não têm coluna tributária); o cálculo de parcelas e o recebimento **não conhecem** tributo; só a rota fiscal chama o serviço fiscal. **Quando** IBS/CBS/Split forem regulamentados, o encaixe previsto é: (1) cadastro tributário **administrativo** por produto/operação (nova tabela própria, não campo na venda); (2) camada de cálculo tributário dedicada que preenche `taxes` do item **antes** do adaptador; (3) Split como **extensão da liquidação** (o adaptador de pagamento devolve a repartição), nunca dentro do cálculo de parcelas nem da venda. Nada disso foi construído: dependia de regra legal e de provedor que o projeto não tem.

## Erros

| HTTP | code | Quando |
|---|---|---|
| 409 | `FISCAL_SALE_CANCELLED` | venda cancelada |
| 409 | `FISCAL_SALE_NOT_COMPLETED` | venda pendente/parcialmente paga |
| 409 | `FISCAL_OPERATION_DISABLED` | `SALE` fora de `fiscal.enabledOperations` |
| 400 | — | já existe documento ativo/em emissão para a venda (inalterado) |

## Testes que provam

- `apps/api/src/services/fiscal.service.test.ts` (+5: cancelada, pendente, parcialmente paga, política, cancelada
  entre a leitura e a trava).
- `apps/api/test/integration/discount-cash-fiscal-policies.integration.test.ts` (3, Postgres real) — **falham no
  código anterior** (rodado contra a versão do HEAD e restaurado).
- `apps/admin-web/lib/fiscal.test.ts` (`isSaleOfferedForEmission`, 6 casos).
