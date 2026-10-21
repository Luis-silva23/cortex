# Agenda — regra oficial do CÓRTEX

Decidida pelo dono em 2026-09-27; capacidade configurável em 2026-09-28. Código: `apps/api/src/services/appointment.service.ts`,
capacidade em `apps/api/src/services/agenda-capacity.service.ts`, rotas `apps/api/src/routes/appointments.routes.ts`,
horário de funcionamento em `business-hours.service.ts`, autorização de segunda pessoa em `dual-authorization.service.ts`.
Schema: `appointments.completedWithoutConfirmation/completionAuthorizedBy/completionReason` (migração
`20260927100000_policies_and_new_domains`); `appointments.durationMinutes` (5..1440), `appointments.mechanicId` (sem FK) e
a tabela `agenda_unavailabilities` (RLS empresa+filial) na migração `20260928100000_consolidation_cash_agenda_supplier_returns`.
Telas: Admin Web `app/dashboard/post-sale/page.tsx` (aba Agenda) + `components/agenda/CompleteAppointmentDialog.tsx` +
`components/agenda/AgendaCapacity.tsx` + `lib/api/agenda.ts`; mobile `apps/mobile/src/screens/AgendaScreen.tsx`.

> Regra do dono (2026-09-28): "A capacidade operacional não deve ser uma regra universal fixa do CÓRTEX. Cada
> empresa/filial deve poder configurar sua capacidade. […] A empresa define a capacidade que consegue atender. O CÓRTEX
> fornece o mecanismo."

## Confirmação é do cliente

A loja **propõe** o horário; a confirmação definitiva é do **cliente/responsável pelo veículo** (já vigente: o
funcionário registra quem confirmou e por qual canal). Remarcar zera a confirmação.

## Concluir sem a confirmação do cliente

`POST /api/appointments/:id/complete` `{ notes?, authorization?: { authorizerNumericId, authorizerPassword,
authorizerMfaCode?, reason } }`

- **Confirmado pelo cliente:** conclui sem autorização. A gravação só vale se ainda estiver `CONFIRMED`.
- **Não confirmado**, com `agenda.requireCustomerConfirmation` (padrão **ligado**, vale para a empresa inteira):
  - sem `authorization` → **409 `APPOINTMENT_NOT_CONFIRMED`** (a tela abre o pedido de autorização);
  - motivo com menos de 10 caracteres → **400 `REASON_REQUIRED`** (ou erro de validação do campo);
  - autorizador verificado por `verifyDualAuthorization`: precisa ter um dos perfis de
    `agenda.completionAuthorizerRoles` (padrão `MANAGER`, `COMPANY_ADMIN`), **não pode ser quem solicita**, conta ativa
    e não bloqueada, senha correta e MFA quando ele tiver. Falha → **403 `AUTHORIZATION_FAILED`** com a mensagem
    (própria pessoa, perfil sem permissão, credencial inválida…);
  - tentativas com credencial de autorizador passam pelo limitador anti-força-bruta `authorizer` (o mesmo de cancelar
    venda/sangria): após 3 falhas em 5 min, **429** para aquele solicitante;
  - autorizado: `status = COMPLETED`, `completedWithoutConfirmation = true`, `completionAuthorizedBy` (id do
    autorizador), `completionReason`; evento `COMPLETED` com "Concluído SEM confirmação do cliente — autorizado por
    <nome> (#código): <motivo>" e `performedBy` = quem solicitou. A gravação só vale se ainda estiver `PROPOSED`.
- **Política desligada:** conclui sem autorização, mas grava `completedWithoutConfirmation = true` (sem autorizador) e o
  evento diz que a política não exige a confirmação.
- **Não dá para contornar pela API:** os dois caminhos gravam com guarda de estado (`CONFIRMED` × `PROPOSED`); confirmar
  ou remarcar no meio vira **409 `APPOINTMENT_STATUS_CHANGED`**, nunca uma conclusão pelo caminho errado.
- Auditoria: `UPDATE/Appointment` com `{ action: 'COMPLETE_APPOINTMENT', status, completedWithoutConfirmation,
  completionAuthorizedBy, completionReason }` (a senha nunca vai para a auditoria). Eventos de segurança
  `APPOINTMENT_COMPLETION_*` no log do sistema. Aceita `Idempotency-Key`.

## Duração do atendimento (janela)

- `POST /api/appointments` e `POST /:id/reschedule` aceitam `durationMinutes` (inteiro 5..1440, opcional) e
  `mechanicId` (opcional). **Todo caminho que define horário** (propor e remarcar) aplica as regras abaixo.
- Duração efetiva = `durationMinutes` do agendamento → política `agenda.defaultDurationMinutes` → um horário
  (`agenda.slotMinutes`). Janela = **[início, início + duração)** — quem termina às 10:00 não colide com quem começa às
  10:00.
- Grava-se só a duração **informada** (vazio continua vazio = segue a política da filial; se a política mudar, os
  agendamentos sem duração própria passam a ocupar a nova duração). Ao remarcar: campo ausente = mantém; `null` = limpa.
- `GET /api/appointments` devolve também `effectiveDurationMinutes` e `mechanic { id, name }` para as telas.

## Horário de funcionamento

- Com `agenda.respectBusinessHours` (padrão ligado) **e** horário de funcionamento cadastrado (empresa ou filial, com
  exceções de calendário), propor ou remarcar fora do funcionamento → **409 `OUTSIDE_BUSINESS_HOURS`**.
- **Escolha (2026-09-28): a janela INTEIRA precisa caber** num período de funcionamento do mesmo dia. Antes só o início
  era conferido. Início fechado → a mensagem de sempre ("Fora do horário de funcionamento (08:00–18:00)", "Intervalo das
  12:00 às 13:00", "Sem funcionamento…"); início aberto mas o fim passa → "o atendimento de 60 min (17:30–18:30) termina
  depois do fechamento (18:00)…" ou "…passa pelo intervalo das 12:00 às 13:00…". Terminar exatamente no fechamento é
  aceito. Consequência: com a duração padrão (60 min), 17:30 com fechamento às 18:00 e 11:30 com almoço às 12:00 agora
  são recusados (informe uma duração menor).
- **Sem horário cadastrado nada é bloqueado.** Fuso: política `company.timezone`.
- Implementação: `windowOpenIn`/`isWindowOpen` em `business-hours.service.ts` (a lógica de `isOpenAt` virou a função
  pura `openAtIn`, sem mudar o comportamento).

## Capacidade (todas por filial, vazio = sem limite / não controlado)

Configuradas em Configurações › Políticas (grupo Agenda); todas `branchOverridable`. Contam só agendamentos **ativos**
(`PROPOSED`/`CONFIRMED`) da **mesma filial** (agendamento sem filial conta com os outros sem filial); cancelado,
concluído e não compareceu não ocupam nada. Remarcar não conta o próprio agendamento.

| Política | Regra | Recusa |
|---|---|---|
| `agenda.slotMinutes` (60) | tamanho do horário, alinhado à meia-noite local (10:37 cai em 10:00–11:00) | — |
| `agenda.maxPerSlot` | quantos agendamentos **começam** no mesmo horário (recepção) — inalterado | **409 `SLOT_FULL`** |
| `agenda.boxCount` | atendimentos **simultâneos** pela duração de cada um: o **pico** de ocupação dentro da janela nova precisa ficar abaixo do número de boxes | **409 `NO_BOX_AVAILABLE`** |
| `agenda.maxPerDay` | agendamentos no **dia local** (fuso `company.timezone`) do início | **409 `DAY_FULL`** |
| `agenda.maxPerMonth` | agendamentos no **mês local** do início | **409 `MONTH_FULL`** |
| `agenda.defaultDurationMinutes` | duração quando o agendamento não informa | — |

- Boxes: com 1 box, um atendimento de 90 min às 10:00 ocupa os horários de 10:00 e de 11:00 (11:00 recusado, 11:30
  aceito). Com 2 boxes, 10:00–10:30 + 10:30–11:00 + 10:00–11:00 cabem (pico 2); um quarto entre 10:15 e 10:45 não.
- Dia/mês no fuso: 23:30 de segunda em Manaus (UTC−4) é terça 00:30 em São Paulo — conta na segunda com fuso Manaus e
  na terça com fuso São Paulo.

## Mecânico previsto

- `mechanicId` precisa ser usuário **`MECHANIC` ativo da mesma empresa** e com acesso à filial do agendamento (da
  própria filial ou da empresa toda) → senão **400 `INVALID_MECHANIC`** ("Mecânico não encontrado nesta empresa…", "…está
  inativo…", "…é de outra filial…"). Ao remarcar, só é revalidado se for trocado.
- **Conflito:** o mesmo mecânico com outro agendamento ativo que se sobrepõe à janela, **em qualquer filial** →
  **409 `MECHANIC_CONFLICT`** ("O mecânico escolhido já tem um atendimento em DD/MM/AAAA das 10:00 às 11:00. Escolha outro
  horário ou outro mecânico."). A mensagem não expõe cliente nem filial do outro atendimento.
- Para enxergar o atendimento do mecânico em outra filial (o RLS esconde de um usuário de filial), a leitura da agenda
  **daquele mecânico** é feita dentro da transação com o contexto "empresa toda" da **mesma empresa**
  (`companyWideRead`: `set_config` local de `app.user_type`/`app.current_branch_id`, restaurado logo depois; só lê
  horários filtrados por `companyId + mechanicId`). Provado com RLS ativo: sem isso o mesmo mecânico era reservado duas
  vezes (201 em vez de 409).

## Indisponibilidade

- Tabela `agenda_unavailabilities`: filial (obrigatória), `mechanicId` (vazio = **a filial inteira**), `startsAt`,
  `endsAt` (> início), `reason` (obrigatório), `createdBy`.
- Janela sobreposta a uma indisponibilidade da filial → **409 `AGENDA_UNAVAILABLE`** ("A agenda da filial está
  indisponível em DD/MM/AAAA das 13:00 às 15:00 (Treinamento da equipe). Escolha outro horário."); do mecânico escolhido
  (vale em qualquer filial) → **409 `MECHANIC_UNAVAILABLE`**.
- `GET /api/appointments/unavailabilities?branchId&mechanicId&from&to` — leitura para todos do tenant; usuário de filial
  vê só a dele.
- `POST /api/appointments/unavailabilities` `{ branchId?, mechanicId?, startsAt, endsAt, reason }` — **só MANAGER,
  COMPANY_ADMIN, SUPER_ADMIN** (403 para os demais). Filial validada contra a empresa do token (usuário de filial =
  a dele; outra → 403 `BRANCH_FORBIDDEN`; filial de outra empresa → 400 `BRANCH_NOT_FOUND`; sem filial → 400
  `BRANCH_REQUIRED`). Motivo obrigatório (mín. 3 caracteres), fim depois do início, mecânico validado como acima.
  Agendamentos já marcados no período **não** são cancelados: a resposta traz `overlappingAppointments` e a tela avisa
  para remarcar. Auditoria `CREATE/AgendaUnavailability` `{ action: 'CREATE_AGENDA_UNAVAILABILITY', … reason }`.
- `DELETE /api/appointments/unavailabilities/:id` — mesma restrição de perfil; gerente de filial só remove a da própria
  filial (404 para as outras; outra empresa 404). Vale para indisponibilidade passada ou futura. Auditoria
  `DELETE/AgendaUnavailability` `{ action: 'REMOVE_AGENDA_UNAVAILABILITY', … }` com o que foi removido.

## Disponibilidade por horário (telas)

`GET /api/appointments/availability?date=AAAA-MM-DD&branchId?&mechanicId?&durationMinutes?` → `{ date, branchId,
timezone, slotMinutes, durationMinutes, limits, dayCount, monthCount, slots: [{ start, end, time, booked, available,
code, reason }] }`. Cada horário do dia (local) é avaliado com as MESMAS regras da gravação (funcionamento → indisponível
→ mecânico → horário → box → dia → mês); `code`/`reason` = a primeira recusa, igual à que a API daria ao gravar.
Usuário de filial = a filial dele (outra → 403). A resposta é uma foto: a gravação confere de novo sob trava.

## Sem corrida (trava)

- Contagem e gravação na **mesma transação**. A trava passou de filial+horário para **por filial**
  (`pg_advisory_xact_lock(4210, filial)`): com duração, boxes, dia e mês, pedidos em horários **diferentes** disputam a
  mesma vaga, e a trava por horário deixava os dois passarem (provado: com a trava antiga as corridas abaixo passam do
  limite). Com mecânico, também `pg_advisory_xact_lock(4211, empresa|mecânico)` (o mesmo mecânico em duas filiais).
  Ordem fixa filial → mecânico (um mecânico por pedido): sem ciclo de espera. Custo: propostas/remarcações da mesma
  filial passam uma de cada vez (milissegundos).
- Provas: 6 simultâneas em horários diferentes com limite 2 por dia → exatamente 2; 5 simultâneas sobrepostas por
  duração em slots diferentes com 1 box → exatamente 1; 4 simultâneas com o mesmo mecânico → 1; 5 no mesmo horário com
  limite 2 → 2 (teste anterior).

## Quem pode

Propor, confirmar, remarcar, cancelar, concluir e "não compareceu": todos os perfis menos VIEWER (inalterado). A
conclusão sem confirmação exige, além disso, o autorizador acima. Disponibilidade e lista de indisponibilidades: todos do
tenant. Criar/remover indisponibilidade: MANAGER, COMPANY_ADMIN, SUPER_ADMIN.

## Erros HTTP

| Código | HTTP | Quando |
|---|---|---|
| `APPOINTMENT_NOT_CONFIRMED` | 409 | concluir não confirmado sem autorização |
| `AUTHORIZATION_FAILED` | 403 | autorizador inválido (própria pessoa, perfil, senha, MFA, conta) |
| `OUTSIDE_BUSINESS_HOURS` | 409 | a janela não cabe no funcionamento cadastrado |
| `AGENDA_UNAVAILABLE` | 409 | janela sobre indisponibilidade da filial inteira |
| `MECHANIC_UNAVAILABLE` | 409 | janela sobre indisponibilidade do mecânico escolhido |
| `MECHANIC_CONFLICT` | 409 | mecânico com outro atendimento ativo sobreposto |
| `SLOT_FULL` | 409 | horário lotado (`agenda.maxPerSlot`) |
| `NO_BOX_AVAILABLE` | 409 | sem box livre na janela (`agenda.boxCount`) |
| `DAY_FULL` | 409 | dia lotado (`agenda.maxPerDay`) |
| `MONTH_FULL` | 409 | mês lotado (`agenda.maxPerMonth`) |
| `INVALID_MECHANIC` | 400 | mecânico de outra empresa/filial, inativo ou que não é mecânico |
| `INVALID_UNAVAILABILITY` / validação | 400 | fim antes do início, sem motivo, duração fora de 5..1440, data inválida |
| `BRANCH_FORBIDDEN` | 403 | usuário de filial pedindo outra filial |
| `BRANCH_NOT_FOUND` / `BRANCH_REQUIRED` | 400 | filial de outra empresa / indisponibilidade sem filial |
| `APPOINTMENT_STATUS_CHANGED` | 409 | mudou de situação durante a ação |
| `REASON_REQUIRED` / validação | 400 | motivo curto, código/senha ausentes |
| — | 429 | excesso de tentativas de autorizador |

Ordem das recusas (a primeira que valer): funcionamento → indisponível da filial → indisponível do mecânico → conflito
do mecânico → horário → box → dia → mês. Toda mensagem diz o que aconteceu e o que fazer.

## Telas

- **Admin Web (Pós-venda → Agenda):** "Concluir" tenta concluir; se a API responder `APPOINTMENT_NOT_CONFIRMED`, abre
  "Concluir sem confirmação do cliente" (código e senha do responsável, MFA opcional, motivo). Propor/remarcar têm
  **duração (min, vazio = padrão da filial)** e **mecânico (opcional)**; remarcar vem preenchido com os do agendamento.
  Painel de horários do dia (`components/agenda/AgendaCapacity.tsx`): filial (só para quem é da empresa toda), dia,
  duração e mecânico → cada horário livre é um botão que abre a proposta preenchida; ocupado aparece **cinza com o
  rótulo do motivo** (texto completo da API no `title` e para leitor de tela). Linha informa a capacidade configurada
  (boxes, x/limite no dia e no mês). "Indisponibilidades": lista das futuras; gerência registra (início, fim, filial
  inteira ou mecânico, motivo) e remove — ao registrar sobre agendamentos existentes a tela avisa quantos são. A lista
  mostra duração e mecânico de cada agendamento. Só tokens do design.
- **Mobile (AgendaScreen):** mostra a duração efetiva e o mecânico de cada agendamento; "Concluir" com o mesmo pedido de
  autorização em modal; outras recusas em alerta. (Propor/remarcar com duração/mecânico e a grade de horários ainda não
  existem no app — verificado só por `type-check`, sem aparelho.)

## Testes que provam

- Integração: `apps/api/test/integration/agenda-capacity-completion.integration.test.ts` — 11 testes (funcionamento
  com expediente/intervalo/domingo e sem cadastro/política desligada; limite 2 por horário + remarcar + cancelado libera;
  5 simultâneas → 2; slot de 30 min; conclusão sem autorização 409; autorização inválida 403 e bloqueio 429; motivo
  curto 400; autorizado por gerente com campos, evento e auditoria sem senha; confirmado conclui sem autorização e
  política desligada; corrida concluir × remarcar). Rodados contra o código anterior (versão de 10 testes, antes de o
  caso "motivo curto" virar teste próprio): 8 de 10 falham; os 2 que passavam são casos de controle ("sem horário nada
  bloqueia" e a corrida). O arquivo existente
  `agenda-rules.integration.test.ts` continua passando.
- Unitários: `apps/api/src/services/appointment.service.test.ts` (slot no fuso, funcionamento pela janela, box com
  duração, capacidade com trava, remarcar sem contar a si, os caminhos de conclusão) e
  `apps/api/src/services/agenda-capacity.service.test.ts` (pico de boxes, dia/mês em Manaus × São Paulo, ordem e texto
  das recusas, janela × fechamento/intervalo). Admin: `apps/admin-web/lib/agenda-capacity.test.ts`.
- Integração da capacidade: `apps/api/test/integration/agenda-capacity-resources.integration.test.ts` — 20 testes
  (90 min ocupa dois horários; duração padrão da política; pico de boxes e cancelado libera; remarcar aumentando a
  duração; duração inválida; janela × fechamento/intervalo; DAY_FULL e MONTH_FULL em Manaus × São Paulo e remarcar para
  dia lotado; três corridas; conflito de mecânico e remarcar trocando de mecânico; mecânico de outra empresa/inativo/
  outra filial/não mecânico; mecânico da empresa toda com atendimento em outra filial; indisponibilidade da filial e do
  mecânico; permissões, validação e auditoria; isolamento entre filiais e empresas; disponibilidade por horário com e sem
  mecânico). Rodada no banco com RLS ativo (papel da aplicação) e no banco de teste com superusuário.

## DECISÃO NECESSÁRIA (não definido — não foi inventado)

- **`maxPerSlot` × duração:** hoje conta quantos agendamentos **começam** no horário (a leitura original da regra); a
  ocupação ao longo da duração é controlada por `boxCount`. Se o dono quiser que "capacidade por horário" também conte
  quem ainda está em atendimento, é uma mudança de regra.
- **Box por atendimento:** o box é um número por filial (pico simultâneo), não um recurso nomeado (box 1, elevador 2)
  nem um tipo de box por serviço.
- **Duração por tipo de serviço:** não há catálogo de serviço → duração; vale a do agendamento ou a padrão da filial.
- **Intervalo de almoço:** a janela não pode atravessar o intervalo (escolha desta rodada, coerente com "a janela
  inteira precisa caber"). Se o dono aceitar atendimento que continua durante o almoço, é outra regra.
- **Mecânico obrigatório?** Hoje é opcional; sem mecânico não há conflito por pessoa, só capacidade da filial.
- **Encaixes:** não há "encaixe" acima do limite (nem quem poderia autorizá-lo).
- **Capacidade diferente por dia/horário** (ex.: sábado com menos vagas) e **antecedência mínima** para agendar.
- **Agendamentos já existentes** acima de um limite recém-configurado, ou dentro de uma indisponibilidade criada depois,
  continuam válidos (a regra vale para novas propostas/remarcações; a tela avisa quantos há na indisponibilidade).
- **Duração padrão retroativa:** agendamentos sem duração própria seguem a política vigente — mudar
  `agenda.defaultDurationMinutes` muda a ocupação deles. Congelar a duração na proposta seria outra decisão.
- **Remover indisponibilidade** é permitido à gerência a qualquer tempo (passada ou futura), auditado — sem regra extra.

## Limitações conhecidas

- O slot é alinhado à meia-noite local; se `slotMinutes` não divide 24 h, o último horário do dia é mais curto.
- Horário de verão: o fuso atual do Brasil não tem; com fuso que tenha, o horário da virada pode ter slot irregular e a
  janela é medida em minutos corridos.
- A disponibilidade (`/availability`) é uma foto; a gravação confere de novo sob trava.
- Agendamento sem filial (empresa toda) não recebe indisponibilidade de filial (toda indisponibilidade tem filial).
