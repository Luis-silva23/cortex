# Orçamento — regra oficial do CÓRTEX

Decidida pelo dono em 2026-09-27. Código: `apps/api/src/services/quote.service.ts`, rotas
`apps/api/src/routes/quotes.routes.ts`, rotina `expire-overdue-quotes` (`apps/api/src/config/scheduler.ts` +
`scheduled-jobs.ts`). Schema (sem mudança nesta rodada): `quotes.closedAt/closedBy/closeReason` e `quote_events`
(migração `20260927100000_policies_and_new_domains`, RLS FORCE por empresa + filial). Telas: Admin Web
`app/dashboard/quotes/**`, `lib/quotes.ts`, `lib/api/quotes.ts`.

## Fluxo

**ORÇAMENTO** (`DRAFT`) → **AGUARDANDO APROVAÇÃO** (`SENT`) → **APROVADO** (`APPROVED`) → **ORDEM DE SERVIÇO**
(`CONVERTED`). Recusa do cliente: `REJECTED`. Encerrado sem resposta: `EXPIRED` (rótulo "Encerrado").

O fluxo anterior (criar, versionar, enviar, decidir, converter) foi preservado. Mudou só o que envolve o encerramento:
orçamento `EXPIRED` não pode ser reenviado, decidido nem versionado (**409 `QUOTE_CLOSED`**) — volta ao fluxo só pela
reabertura. As gravações de `send`/`decide`/`addVersion` passaram a ter guarda de estado: um encerramento simultâneo
não é desfeito por elas.

## Vencido (sem resposta do cliente)

- Só orçamento `SENT` tem prazo. O prazo conta do **envio da versão vigente** ou da **última reabertura** (o mais
  recente) — a reabertura reinicia a contagem sem reescrever o `sentAt` (data real do envio é histórico).
- Vence após `quote.expirationDays` dias (padrão **5**; a filial pode ter valor próprio). Dias corridos de 24 h.
- A API devolve em cada orçamento (lista, detalhe, relacionados): `overdue`, `respondBy`, `daysWithoutResponse`;
  no detalhe também `expirationDays` e `reopenAllowed`.
- `GET /api/quotes?overdue=true` filtra os vencidos (prazo calculado pela política da filial de cada orçamento).

## Encerrar (manual, em lote)

`POST /api/quotes/close` `{ "ids": [..], "reason": "..." }` — perfis de escrita de orçamento (todos menos VIEWER).

| Situação do orçamento | Resultado do item (`outcome`) |
|---|---|
| `DRAFT` (nunca enviado) | `CLOSED` — encerra a qualquer momento |
| `SENT` vencido | `CLOSED` |
| `SENT` ainda no prazo | `NOT_ALLOWED` ("Ainda dentro do prazo de resposta do cliente…") |
| `EXPIRED` | `ALREADY_CLOSED` (nenhum evento novo) |
| `APPROVED` / `REJECTED` / `CONVERTED` | `NOT_ALLOWED` (já tem decisão ou virou OS) |
| inexistente, de outra empresa ou de filial fora do alcance (RLS) | `NOT_FOUND` |

- Resposta 200: `{ reason, results: [{ id, quoteNumber, fromStatus, outcome, message }], summary: { closed,
  alreadyClosed, notAllowed, notFound } }`. Um item recusado não impede os outros.
- Cada item grava numa transação própria com **guarda de estado** (o status lido e, para `SENT`, a condição de vencido):
  dois encerramentos simultâneos do mesmo orçamento produzem um único evento; um envio/decisão no meio do caminho
  faz o item voltar como `NOT_ALLOWED`.
- Grava `status = EXPIRED`, `closedAt`, `closedBy`, `closeReason` e o evento `quote_events` **`CLOSED`**
  (`fromStatus`, `toStatus`, `reason`, `performedBy`, empresa e filial).
- Motivo obrigatório (mín. 5): **400 `REASON_REQUIRED`**. Sem ids: **400 `QUOTE_IDS_REQUIRED`**. Mais de 100:
  **400 `TOO_MANY_QUOTES`**. VIEWER: **403**.
- Auditoria: `UPDATE/Quote` com `{ action: 'CLOSE_QUOTES', reason, summary, results }`. Aceita `Idempotency-Key`.

## Encerramento automático (opcional)

- `quote.autoExpire` (padrão **desligado**). Ligado, a rotina diária `expire-overdue-quotes` (01:10) encerra os `SENT`
  vencidos daquela filial: status `EXPIRED`, `closedBy = 'SYSTEM'`, evento **`EXPIRED`** com `performedBy = 'SYSTEM'`
  e motivo "Sem resposta do cliente há N dias ou mais (encerramento automático)". Mesma guarda de estado.
- Desligada, a rotina não muda nada (o encerramento é só manual).

## Reabrir

`POST /api/quotes/:id/reopen` `{ "reason": "..." }` (mín. 5) — mesmos perfis.

- Só `EXPIRED`; volta para **`SENT`** (aguardando aprovação) quando a versão vigente foi enviada e não decidida, ou
  **`DRAFT`** quando o encerrado era um rascunho nunca enviado. Evento **`REOPENED`**; prazo de resposta reinicia.
- `quote.allowReopen` (padrão ligado) desligado: **409 `QUOTE_REOPEN_DISABLED`**.
- **`REJECTED` não reabre** (**409 `QUOTE_NOT_REOPENABLE`**): a recusa está gravada na versão (decisão do cliente);
  o caminho é uma **nova versão** (`POST /:id/versions`, que já leva REJECTED → DRAFT) com a nova proposta — reabrir
  para "aguardando aprovação" mentiria sobre uma versão já decidida.
- Outro orçamento em aberto para o mesmo veículo: **409 `OPEN_QUOTE_EXISTS`** com `existingQuoteId`.
- O registro do encerramento anterior **não é apagado** (`closedAt/closedBy/closeReason` ficam como "último
  encerramento"; o histórico completo está em `quote_events`). Depois de reaberto segue normal: decisão → OS.
- Auditoria `UPDATE/Quote` `{ action: 'REOPEN_QUOTE', reason, status }`. Aceita `Idempotency-Key`.

## Cliente voltou com o mesmo veículo

- `GET /api/quotes/related?customerId=&motorcycleId=` → `{ open: [...], closed: [...] }`: abertos (`DRAFT`, `SENT`,
  `APPROVED`) e encerrados/recusados dos últimos 180 dias, com `overdue` e `canReopen`. Sem os dois parâmetros:
  **400 `CUSTOMER_AND_MOTORCYCLE_REQUIRED`**.
- A tela "Novo orçamento" mostra "Orçamentos existentes para este veículo" com **Continuar** (aberto) e **Reabrir**
  (encerrado, se a política permite).
- **Sem duplicado:** criar orçamento para veículo que já tem um em aberto → **409 `OPEN_QUOTE_EXISTS`** com
  `existingQuoteId`, `existingQuoteNumber`, `existingStatus`. Só `confirmNew: true` (booleano literal) cria mesmo assim
  (a tela oferece "Criar outro mesmo assim"). A checagem roda sob a mesma trava da numeração (advisory lock 4204 por
  empresa), inclusive na reabertura: duas criações simultâneas para o mesmo veículo não passam juntas.

## Erros HTTP

| Código | HTTP | Quando |
|---|---|---|
| `OPEN_QUOTE_EXISTS` | 409 | criar (sem `confirmNew`) ou reabrir com outro aberto no mesmo veículo |
| `QUOTE_CLOSED` | 409 | enviar/decidir/versionar orçamento encerrado |
| `QUOTE_NOT_REOPENABLE` | 409 | reabrir o que não está encerrado (ou recusado) |
| `QUOTE_REOPEN_DISABLED` | 409 | política não permite reabrir |
| `QUOTE_STATUS_CHANGED` | 409 | o orçamento mudou de situação durante a reabertura |
| `QUOTE_NOT_FOUND` | 404 | reabrir inexistente/fora do alcance |
| `REASON_REQUIRED`, `QUOTE_IDS_REQUIRED`, `TOO_MANY_QUOTES`, `CUSTOMER_AND_MOTORCYCLE_REQUIRED` | 400 | entrada inválida |

## Testes que provam

- Integração (Postgres/Redis reais): `apps/api/test/integration/quote-lifecycle.integration.test.ts` — 10 testes:
  duplicado + `confirmNew`; 3 criações simultâneas → 1; lista/filtro de vencidos; lote com os 4 resultados + evento +
  auditoria + outra empresa intocada; 2 encerramentos simultâneos → 1 evento; 400/403; encerrado não reenviado nem
  decidido → reabrir → decisão → OS (e a rotina não re-expira logo após reabrir); reabertura desligada / recusado /
  outro aberto; relacionados (e isolamento entre empresas); rotina automática desligada × ligada e prazo por política.
  Rodados contra o código anterior: os 10 falham.
- Unitários: `apps/admin-web/lib/quotes.test.ts` (seleção de encerráveis, rótulo de vencido, ações/passos de EXPIRED);
  suítes existentes de `quote.service`/`quotes.routes` continuam passando.

## Limitações conhecidas

- Com usuário de filial, a checagem de duplicado e os relacionados enxergam só a própria filial (RLS): um orçamento
  aberto do mesmo veículo em outra filial não bloqueia.
- O prazo é em dias corridos de 24 h a partir do envio (não considera horário de funcionamento nem feriados).
- A rotina automática não grava linha em `audit_logs` (o registro é o evento `EXPIRED` + log do job).
- Quem pode encerrar/reabrir = os mesmos perfis que já escrevem orçamento (inclui OPERATOR e MECHANIC). Restringir
  a Gerência é **DECISÃO NECESSÁRIA** se o dono quiser.
