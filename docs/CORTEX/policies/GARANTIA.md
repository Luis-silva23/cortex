# Garantia de OS — regra oficial do CÓRTEX

Decidida pelo dono em 2026-09-27. Código: `apps/api/src/services/warranty.service.ts`, gancho em
`service-order.service.ts::transitionStatus`, rotas `apps/api/src/routes/warranties.routes.ts` e o corpo de
`POST /service-orders/:id/status`. Schema: `service_orders.warrantyDecision`, `service_order_warranties`,
`warranty_claims` (migração `20260927100000_policies_and_new_domains`, RLS FORCE por empresa + filial).

## Quando a decisão é tomada

- Na transição **ENTREGA → ENCERRADA** (o encerramento administrativo/financeiro, que já exige pagamento).
- Com `warranty.enabled` **e** `warranty.requireDecisionOnClose` (padrão: ambos ligados), encerrar sem informar a decisão
  é recusado: **400 `WARRANTY_DECISION_REQUIRED`**. A OS continua em ENTREGA.
- Decisões possíveis (`warranty` no corpo): `{ "decision": "NONE" }` (sem garantia) ou `{ "decision": "GRANTED", ... }`.
- Garantia desligada na política (`warranty.enabled = false`): a tela não pede decisão; enviar `GRANTED` é recusado com
  **409 `WARRANTY_DISABLED`**; `NONE` é aceito.
- Decisão exigida desligada: pode encerrar sem decisão (`warrantyDecision` fica nulo).
- Decisão enviada em outra transição: **400 `WARRANTY_ONLY_ON_CLOSE`**.
- Tudo na **mesma transação** do encerramento (status, `warrantyDecision`, km de saída e a linha da garantia): não existe
  OS encerrada sem a decisão exigida nem garantia órfã. **Uma garantia por OS** (unique em `serviceOrderId`;
  `WARRANTY_ALREADY_EXISTS` 409 se colidir).

## Dados da garantia (`decision: GRANTED`)

| Campo | Regra |
|---|---|
| `coverage` | `SERVICE`, `PART` ou `SERVICE_AND_PART` |
| `durationValue` + `durationUnit` | inteiro ≥ 1; `DAYS` (até 3650), `MONTHS` (até 120), `YEARS` (até 10). Atalhos na tela: 2 meses, 3 meses, 6 meses, 1 ano, personalizado |
| `kmLimit` | opcional (1 a 1.000.000). Com prazo e km, **vale o que ocorrer primeiro** |
| `startKm` | opcional; padrão = km de saída da OS ou, sem ele, km de entrada. Menor que o km de entrada → 400 `INVALID_START_KM`. Informado no encerramento e sem km de saída gravado, vira o km de saída da OS |
| `coveredItemIds` | opcional; padrão = todos os itens da OS do tipo coberto. Item de outra OS → 400 `WARRANTY_ITEM_NOT_IN_OS`; item de tipo diferente → 400 `WARRANTY_ITEM_TYPE_MISMATCH`; nada a cobrir → 400 `WARRANTY_NO_COVERED_ITEMS` |
| `conditions`, `notes` | texto livre (até 2000) |

Gravado: OS, cliente, veículo, filial da OS, itens cobertos (cópia: id, tipo, descrição, quantidade), início, validade,
km inicial, km limite (`kmUntil = startKm + kmLimit`), condições, observações, quem registrou (`createdBy`).

### Início e validade

- **Início = data da ENTREGA** (`deliveryDate`, gravada na transição para ENTREGA), não a do encerramento. Motivo: a
  entrega é quando o serviço termina e o veículo volta ao cliente — o CDC (art. 26 §1º) conta a garantia "a partir da
  entrega efetiva do produto ou do término da execução dos serviços". O encerramento só acontece depois do pagamento e
  pode ser dias depois; usar a data dele alongaria indevidamente a garantia (ou, no mínimo, a tornaria dependente do
  financeiro). Sem `deliveryDate` (dado antigo), vale o momento do encerramento.
- **Validade = fim do último dia** (23:59:59 no fuso da empresa, política `company.timezone`).
  - Meses/anos sem estourar o mês (`addMonthsClamped`): 31/01 + 1 mês = 28/02 (29/02 em ano bissexto); 29/02 + 1 ano = 28/02.
  - Dias: dia da entrega + N (o dia da entrega não conta — CC art. 132): 01/03 + 90 dias = 30/05.

### Vigência — o que ocorrer primeiro

`vigente = agora ≤ validade  E  (sem limite de km  OU  km atual < km limite)`

- Atingir o km limite (igual) já encerra a garantia.
- Na consulta, o "km atual" é o informado (`?km=`) ou, sem ele, o último odômetro conhecido do veículo
  (`motorcycles.kilometerReading`, que só avança). A resposta traz `status` (`ACTIVE`/`EXPIRED`), `expiredBy`
  (`DATE`/`KM`) e `evaluatedKm`.

## Consulta (pós-venda)

- `GET /api/warranties?customerId=&motorcycleId=&serviceOrderId=&status=ACTIVE|EXPIRED&km=&limit=` — qualquer usuário da
  oficina (módulo OFICINA). Ordem: validade mais distante primeiro.
- `GET /api/warranties/:id?km=` — detalhe com ocorrências, OS, cliente e veículo. Não encontrado/fora do escopo: 404
  `WARRANTY_NOT_FOUND`.
- `GET /api/service-orders/:id` traz `warranty` (com ocorrências) — cartão "Garantia" da tela da OS.
- Exibição (Admin Web → Pós-venda → Garantias):
  `GARANTIA VIGENTE · OS #1842 · Serviço: troca de kit relação · Validade: 27/12/2026 · KM: até 45.350`.

## Ocorrências de garantia

- `POST /api/warranties/:id/claims { description, kmAtClaim? }` — oficina (SA, CA, MG, OP, MC; VIEWER 403). Vinculada à
  OS original. Confere a vigência **na data e no km da ocorrência**:
  - fora do prazo → **409 `WARRANTY_EXPIRED`** "…o prazo terminou em dd/mm/aaaa";
  - km ≥ limite → **409 `WARRANTY_EXPIRED`** "…o limite de X km foi atingido (informado: Y km)";
  - garantia com limite de km e sem `kmAtClaim` → 400 `WARRANTY_KM_REQUIRED`;
  - `kmAtClaim` menor que o km inicial → 400 `INVALID_KM`.
  - O km informado atualiza o odômetro do veículo (só para cima), como na revisão.
- `PATCH /api/warranties/claims/:id { status, decisionNotes, newServiceOrderId? }` — **gerência+** (SA, CA, MG; demais 403).
  - Máquina: `OPEN → ACCEPTED | REJECTED`; `ACCEPTED → RESOLVED`; REJECTED/RESOLVED são finais. Fora disso: 409
    `WARRANTY_CLAIM_INVALID_TRANSITION`. Guarda atômica (`updateMany where status` + contagem → 409 `WARRANTY_CLAIM_CHANGED`).
  - `decisionNotes` obrigatório (≥ 5 caracteres); grava quem decidiu e quando.
  - `newServiceOrderId` (OS de retorno): da mesma empresa (senão 404 `RETURN_SERVICE_ORDER_NOT_FOUND`), do mesmo veículo
    (400 `RETURN_SERVICE_ORDER_MISMATCH`), diferente da OS original (400 `RETURN_SERVICE_ORDER_IS_ORIGINAL`); não vale para
    recusa (400 `WARRANTY_CLAIM_RETURN_OS_ON_REJECT`).

## Auditoria

- Encerramento: `UPDATE ServiceOrder` com `{ action: STATUS, toStatus, warrantyDecision, warranty: {id, coverage, prazo,
  início, validade, km} }`.
- Ocorrência: `CREATE WarrantyClaim` (`OPEN_WARRANTY_CLAIM`, km, descrição). Decisão: `UPDATE WarrantyClaim`
  (`DECIDE_WARRANTY_CLAIM`, status, notas, OS de retorno).

## Escopo e isolamento

- Empresa e filial vêm do token; RLS FORCE em `service_order_warranties` e `warranty_claims`. A garantia pertence à filial
  da OS: usuário de outra filial não a vê (404) nem registra ocorrência; a administração da empresa (sem filial) vê todas.
  Outra empresa: 404.

## Configuração (políticas, `GET /api/policies/effective`)

| Chave | Padrão | Filial pode sobrescrever |
|---|---|---|
| `warranty.enabled` | `true` | sim |
| `warranty.requireDecisionOnClose` | `true` | sim |
| `warranty.defaultDurationValue` | vazio (tela sugere 3) | sim |
| `warranty.defaultDurationUnit` | `MONTHS` | sim |
| `warranty.defaultKmLimit` | vazio (sem km) | sim |

## Provas

- `apps/api/test/integration/warranty.integration.test.ts` (16 casos, Postgres/RLS reais): sem decisão recusado; NONE;
  3 meses OU 3.000 km com início na entrega, validade 27/12, km, itens e auditoria; fim de mês 31/01 → 28/02; km inicial;
  itens inválidos; permissões; política desligada/opcional; consulta vigente/expirada; km no limite; ocorrência dentro e
  fora (prazo e km); km obrigatório; decisão por gerência com transições e OS de retorno; isolamento empresa/filial.
- `apps/api/src/services/warranty.service.test.ts` (datas/fuso/o que ocorrer primeiro) e
  `apps/admin-web/lib/warranty.test.ts` (montagem do corpo e texto da tela).

## Pendências / decisões em aberto

- Garantia é da filial da OS: um cliente atendido em outra filial não enxerga a garantia lá (RLS por filial). Se a
  garantia deve valer na rede, é preciso decidir o escopo de leitura (empresa inteira para consulta).
- A garantia já nasce expirada se a OS for encerrada depois do fim do prazo contado da entrega — hoje é aceito (é o fato);
  a tela mostra "Prazo encerrado".
- Não há cancelamento/edição da garantia depois de registrada (é evidência); correção exigiria regra própria.
