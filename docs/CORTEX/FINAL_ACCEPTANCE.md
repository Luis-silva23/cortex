# Aceite final — critérios objetivos

Situação em **2026-10-04** (Central de Ajuda e Suporte, sobre a consolidação das políticas). Cada critério tem requisito, teste, evidência, resultado e status.
Atualização de 2026-10-04 (painel com gráficos de linha, login com banco indisponível e grupo A): API unitários **955/955 (97 suítes)**, integração **1239/1239 (85 suítes)** (depois do ajuste de fuso, as 4 suítes que chamam o painel: 139/139), Admin Web **522/522**, PDV lógica **20/20**,
`tsc` limpo nos seis apps, `db:check-rls` OK, `backup:verify` 18 verificações, HML `profiles` 185, `profiles-extra` 121, `payments` 37, `rls` 26, `invariants` 45 — tudo reexecutado e verde. Os demais números abaixo são da rodada anterior e
**não foram reexecutados**: smoke do Electron e e2e de navegador, mais as suítes HML de pressão (`security`, `concurrency`, `workshop-concurrency`) e `ui-profiles`, deixadas de fora de propósito nesta máquina.
Números da rodada anterior (Central de Ajuda), toda verde: API unitários 922/922 (94 suítes);
integração (Postgres 18 + Redis reais, RLS pelo papel da aplicação) 1235/1235 (85 suítes); Admin Web **495/495**; PDV lógica
**20/20**; `tsc` limpo em API, Admin Web, Super Admin, PDV, mobile e TV; smoke do Electron OK; `backup:verify` com 18 verificações;
RLS em dev: todas as invariantes OK (91 tabelas, todas com RLS e FORCE, 105 policies); 203 links conferidos, 0 quebrados.
Caminhadas no navegador real: [2026-09-27/politicas](../evidencias/2026-09-27/politicas/), [2026-09-28](../evidencias/2026-09-28/)
(`walk-round2`, 18/18). Para a Central de Ajuda, as caminhadas de 2026-10-04 viraram **testes de navegador no repositório**
(`apps/e2e`, 18/18 em 3 arquivos, Chrome real contra o ambiente de desenvolvimento e a empresa demo; não rodam no CI porque
precisam dos servidores no ar). O dado de demonstração agora inclui uma garantia (OS encerrada da Alfa), e os botões "OS → Garantia" e
"Pós-venda › Garantias" foram verificados no navegador.

> **Nota de 2026-10-05.** Os números e a situação acima são os de **2026-10-04** e não foram refeitos por completo. Desde então: API unitários 994/994 (99 suítes), Admin Web 538/538 (31) e 4 suítes de integração 71/71 foram executados em 2026-10-05 ([CURRENT_STATE](CURRENT_STATE.md)); o Dashboard gerencial foi implementado e homologado; a **base** de canais de venda existe (sem integração real); o banco tem 95 modelos e 26 migrações. As linhas "91 tabelas, 105 policies" e "93 policies, FORCE em 85/85" abaixo são contagens de datas diferentes (2026-10-04 e 2026-09-28); a última conferência no banco real foi a de 2026-10-04, antes das tabelas de canais. Critérios novos (Dashboard, Canais) não têm linha própria nesta tabela: ver [MAPA_DE_ESTADO](MAPA_DE_ESTADO.md).

Status: ✅ aprovado · ⚠️ aprovado com limitação externa (descrita) · ⏳ depende de decisão do dono · ❌ reprovado.

## Segurança
| Requisito | Teste | Evidência | Resultado | Status |
|---|---|---|---|---|
| Empresa/filial isoladas no banco (RLS FORCE) | `tenant-branch-matrix` (444 casos), `rls-invariants`, `rls-platform-users`, `db:check-rls` | [DATABASE](DATABASE.md) — 93 policies, FORCE em 85/85 tabelas (2026-09-28, com as 4 da consolidação) | passa; checker sem falhas em dev (2026-10-04: 91 tabelas, 105 policies) | ✅ |
| Uma única leitura ampliada filial→empresa, auditada (mesma empresa, só leitura, contexto restaurado) | `company-wide-read.test` (4) | CODE_MAP "RLS" | passa | ✅ |
| Ids forjados (corpo/query/cabeçalho) não mudam o escopo | `super-admin-company-context`, `branch-on-create`, `special-actions-scope` | contracts/tenant-branch-scope §6 | passa | ✅ |
| Permissões por papel e perfil, menor privilégio | `rbac`, `default-profiles`, `permission-role-scope`, `mechanic-read-scope` | contracts/permission-matrix | passa | ✅ |
| Sessão: rotação de refresh, revogação imediata, bloqueio | `refresh-token-reuse`, `logout-revokes-access`, `user/company-deactivation-sessions` | [SECURITY](SECURITY.md) | passa | ✅ |
| Segredos cifrados (MFA, fiscal), migração `enc:v1` | `mfa-secret-at-rest`, `fiscal-config-secrets`, `secret-migration`, `secret-box.test` | `secrets:encrypt --check` = 0 em dev e teste | passa | ✅ |
| `DATA_ENCRYPTION_KEY` obrigatória, fora do repositório e dos logs | `secret-box.test` (sem chave/curta falha); varredura de arquivos rastreados | SECURITY; CI gera a chave por execução | nenhum `.env` real rastreado | ✅ |
| Erro técnico nunca chega ao usuário; logs sem segredo | `translate-errors.test`, `errorHandler.test` | sondas reais (page inválida, Prisma, Zod) | passa | ✅ |
| Limite de tentativas com Redis fora | `advancedRateLimit.redis-down.test` (vermelho antes) | [caos](../evidencias/2026-09-27/02-resiliencia-caos-controlado.md) | 5×401 depois 429 | ✅ |
| Produção com migrações, segredos e expurgo de auditoria antiga | — | [ROADMAP](ROADMAP.md) P1–P3 | sem acesso ao ambiente | ⚠️ |

## Backend
| Requisito | Teste | Evidência | Resultado | Status |
|---|---|---|---|---|
| Regras de negócio com guarda de concorrência | `concurrency`, `*-race`, `agenda-rules`, `payment-exceptions` | BUSINESS_RULES | passa | ✅ |
| Mensagens em PT-BR | `translate-errors.test` (varre o código) | sondas reais | passa | ✅ |
| Limites de payload/paginação/filtros | `paginationLimit.test`, `dateQuery` | SECURITY "Limites" | 5 MB, limit ≤ 100, page ≥ 1 | ✅ |
| Integrações externas reais (TEF/PSP, SEFAZ, SMS/e-mail) | fluxos provados com provedor falso só em teste | ARCHITECTURE "Adaptadores" | não existem provedores contratados | ⚠️ |

## Banco
| Requisito | Teste | Evidência | Resultado | Status |
|---|---|---|---|---|
| Migrações aplicam do zero e são idempotentes | suíte de integração recria `lnsystem_test` | DATABASE §2 | passa | ✅ |
| Backup restaura de verdade | `npm run backup:verify` | DATABASE "Backup" | 18/18 (2026-09-26) | ✅ |
| Auditoria append-only | `audit-log-append-only` | DATABASE §5 | passa | ✅ |

## Frontend (Admin Web / Super Admin)
| Requisito | Teste | Evidência | Resultado | Status |
|---|---|---|---|---|
| Identidade CÓRTEX, tokens, KPIs neutros, 404 | `design-*.test` (418 testes no app) | evidências 2026-09-24/25 | passa | ✅ |
| Telas respeitam papel e módulo (URL direta) | `role-gates`, `navigation`; jornada do mecânico | 2026-09-25/09 | passa | ✅ |
| Responsivo a 390 px sem rolagem horizontal | varredura no navegador | 2026-09-25/10, 18, 19 | ok | ✅ |
| Build valida tipos/lint | `tsc --noEmit` limpo | ROADMAP P6 | `next build` ainda ignora | ⚠️ |

## PDV
| Requisito | Teste | Evidência | Resultado | Status |
|---|---|---|---|---|
| App empacotado carrega e reporta a versão certa | `smoke:electron` | saída do smoke | OK | ✅ |
| Jornada completa (caixa, venda, devolução, sangria, fechamento) | `walk-pdv-full` | 2026-09-25/01–05 | ok | ✅ |
| Sem rede: não finge concluir; ao voltar, uma venda | `walk-offline` | 2026-09-27/03–04 | 5→5, depois 5→6 | ✅ |
| Estados de pagamento reais; nunca "concluída" sem confirmação; resposta perdida não cobra de novo | `payment-flow.test` (7), `walk-agent5` (27 verificações) | politicas/pdv-03, 07, 08, 09, 19 | ok | ✅ |
| MFA no login do PDV (TOTP e recuperação) | `walk-mfa-agent5` (8) | politicas/pdv-20, 24 | ok | ✅ |
| Convênio no caixa (só com política ligada; bloqueado/limite visíveis) | `walk-agent5`, integração `agreements` | politicas/pdv-12, 15, 17 | ok | ✅ |
| Desconto acima do livre pede autorizador; fechamento com pendência/forçado | `discount-cash-fiscal-policies` (29) | politicas/desconto-caixa-fiscal-01–06 | ok | ✅ |
| Convênio indisponível (política da filial ou filiais do convênio) aparece cinza com mensagem humana; manipular o pedido não habilita | `agreements` (bloco por filial), `walk-round2` | 2026-09-28/01 | ok | ✅ |
| Impressora/leitor físicos; vínculo do equipamento com MFA | — | PDV.md | sem hardware; vínculo conferido só no código | ⚠️ |

## Oficina
| Requisito | Teste | Evidência | Resultado | Status |
|---|---|---|---|---|
| Orçamento → OS → entrega → pagamento com estoque, contas e comissão | `workshop-authorization`, `service-order-payment-states`, `walk-oficina` | 2026-09-25/06–08 | ok | ✅ |
| Orçamento: vencido por política, encerrar em lote, reabrir, histórico, duplicado do mesmo veículo | `quote-lifecycle` (10, todos vermelhos no código antigo) | politicas/orcamento-agenda-01–09 | ok | ✅ |
| Garantia decidida no encerramento; vigência prazo × km; ocorrência ligada à OS | `warranty` (16), `warranty.service.test` | politicas/garantia-cliente-01–05 | ok | ✅ |
| Desconto na OS (mão de obra sem livre), pagamento da OS não grava total velho | `discount-cash-fiscal-policies`, `service-order.service.test` | politicas/desconto-caixa-fiscal-09, 10 | ok | ✅ |
| Cadastro de cliente: CPF/CNPJ válido, duplicado por dígitos, contato preferencial coerente | `customer-registration` (9) | politicas/garantia-cliente-08, 09 | ok | ✅ |
| Desconto em orçamento, separação de funções, garantia por rede | — | DECISIONS 13, 26–29 | decisão | ⏳ |

## Financeiro
| Requisito | Teste | Evidência | Resultado | Status |
|---|---|---|---|---|
| Contas a pagar/receber, estorno único, isolamento por filial | `financial-write-gates`, `tenant-branch-matrix` | contracts §9 | passa | ✅ |
| Desconto por política (5% peça/produto, 0% serviço), auditado em `discount_events` | `discount-policy.service.test` (12), `discount-cash-fiscal-policies` | [DESCONTO](policies/DESCONTO.md) | ok | ✅ |
| Convênio de funcionário e de empresa: limite sob concorrência, parcelas, folha, bloqueio, isolamento | `agreements` (27) | politicas/convenios-cobranca-04, 05, 09 | ok | ✅ |
| Cobrança **manual** (uma tentativa por canal, histórico, sem envio automático) | `agreements` (cobrança) | politicas/convenios-cobranca-07, 08 | ok | ✅ |
| Rotina de contas vencidas marcava 0 linhas (sem contexto RLS) | provado com teste temporário antes/depois | [FINANCEIRO](policies/FINANCEIRO.md) | corrigido | ✅ |
| Convênio autorizado pela administração; uso por filial (empresa + filial + convênio + usuário + permissão) | `agreements` (30) | 2026-09-28/04, 05 | ok | ✅ |
| Estorno de estorno; lançar juros/multa (valores já configuráveis por conveniada), devoluções de convênio, provedor oficial | — | DECISIONS 6, 30–37 | decisão | ⏳ |

## Compras — devolução ao fornecedor
| Requisito | Teste | Evidência | Resultado | Status |
|---|---|---|---|---|
| Solicitação → aprovação (retira estoque) → envio → resultado → histórico; aprovador ≠ solicitante; cancelamento devolve o estoque | `supplier-returns` (16), `stock-ledger` | 2026-09-28/06–08 | ok | ✅ |
| Crédito financeiro e NF de devolução de compra | — | DECISIONS 41–42 | decisão / sem provedor | ⏳ |

## Estoque
| Requisito | Teste | Evidência | Resultado | Status |
|---|---|---|---|---|
| Saldo correto (todos os tipos, inventário, filiais, empates) | `stock-ledger` (SQL = regra em memória) | DATABASE "Livro de estoque" | passa | ✅ |
| Sem venda contra estoque inexistente sob concorrência | `concurrency`, `stock-adjustment-branch` | — | passa | ✅ |
| Importação com prévia, erros por linha, duplicidade, lote, limite | `import-batches`, `import-routes`, `excel-parser.test`; `walk-import` | 2026-09-27/05–06 | passa | ✅ |

## Pagamentos
| Requisito | Teste | Evidência | Resultado | Status |
|---|---|---|---|---|
| Dinheiro (troco, cédulas), cartão manual, PIX pendente | `cash-payment-change`, `payment-settings-cash-breakdown`; `walk-cedulas`, `walk-pix` | 2026-09-25/13–15 | passa | ✅ |
| Provedor: sem resposta fica pendente, nova tentativa não cobra de novo, reconciliação única | `payment-terminal-reconciliation` | contracts §2 | passa | ✅ |
| Aprovação com venda encerrada vira exceção; cancelamento/estorno comum recusado | `payment-exceptions` (14 testes, 3 vermelhos antes da última correção) | BUSINESS_RULES | passa | ✅ |
| Venda cancelada não recebe pagamento; aprovação tardia vira inconsistência tratada na Conciliação | `discount-cash-fiscal-policies`, `payment-exceptions` | politicas/desconto-caixa-fiscal-13b, 14 | ok | ✅ |
| Adaptador falso só em teste | varredura: `registerPaymentProvider` só em 2 testes de integração | ARCHITECTURE | ok | ✅ |

## Caixa
| Requisito | Teste | Evidência | Resultado | Status |
|---|---|---|---|---|
| Dono do caixa, movimentos simultâneos, fechamento | `cash-register-owner`, `cash-movement-race`, `cash-register.service*.test` | 2026-09-25/04 | passa | ✅ |
| Pendência bloqueia o fechamento normal; forçado com motivo, autorizador e retrato; reforço sem duplicar | `discount-cash-fiscal-policies` (7 vermelhos no código antigo), `cash-register.service.close-race.test` | politicas/desconto-caixa-fiscal-05, 06 | ok | ✅ |
| Esperado × informado com todo o movimento (dinheiro, cartão, PIX, convênios), por forma; motivo com divergência; resumo gravado | `cash-close-by-method` (8, vermelhos antes), `cash-close.test` (5), `walk-round2` | 2026-09-28/02 | ok | ✅ |

## Fiscal
| Requisito | Teste | Evidência | Resultado | Status |
|---|---|---|---|---|
| Venda cancelada, pendente ou parcial não é emitida; operações por política | `fiscal.service.test`, `discount-cash-fiscal-policies` (3 vermelhos no código antigo) | politicas/desconto-caixa-fiscal-15 | ok | ✅ |
| Devolução fiscal; nota já autorizada de venda cancelada; provedor SEFAZ | — | DECISIONS 7; ROADMAP | decisão / sem provedor | ⏳ |

## Políticas, empresa e horário
| Requisito | Teste | Evidência | Resultado | Status |
|---|---|---|---|---|
| Política por empresa/filial com origem, motivo, histórico, auditoria; chave de autorizador não varia por filial | `policies-foundation` (20), `lib/policies.test` (14) | politicas/configuracoes-05, 07 | ok | ✅ |
| Cadastro real da empresa (CNPJ/CPF só Super Admin; vazio limpa; mensagens com o nome do campo) | `policies-foundation`; caminhada `walk-settings` (21/21) | politicas/configuracoes-01, 02, 08 | ok (achado e corrigido na caminhada) | ✅ |
| Horário semanal, intervalo, exceções (feriado/fechamento/horário especial), filial própria | `policies-foundation` | politicas/configuracoes-06 | ok | ✅ |

## Agenda, Revisões e Pós-venda
| Requisito | Teste | Evidência | Resultado | Status |
|---|---|---|---|---|
| Loja propõe, cliente confirma com canal e nome; transições com guarda | `agenda-rules` (6 vermelhos antes) | 2026-09-26/04 | passa | ✅ |
| Próxima revisão sem estourar o mês; validações | `revision.service.test`, `revisions-agenda` | BUSINESS_RULES | passa | ✅ |
| Comunicação sem acoplamento a provedor | leitura de código (registro manual) | DECISIONS | ok | ✅ |
| Concluir sem confirmação exige autorizador ≠ solicitante; limite por horário; horário de funcionamento | `agenda-capacity-completion` (11; 8 vermelhos no código antigo) | politicas/orcamento-agenda-10, 12, 13 | ok | ✅ |
| Capacidade configurável: duração, boxes, dia, mês, mecânico, indisponibilidades, corrida sob trava | `agenda-capacity-resources` (20), `agenda-capacity.service.test` | 2026-09-28/09 | ok | ✅ |
| Regras além do mecanismo (encaixe, box nomeado, duração por serviço…), concluir fechando o pós-venda | — | DECISIONS 10–11 | decisão | ⏳ |

## Central de Ajuda e Suporte
| Requisito | Teste | Evidência | Resultado | Status |
|---|---|---|---|---|
| Empresa vê só os seus chamados (empresa, filial, `support:view_company`); IDOR e `companyId`/`branchId` forjados recusados | `support.integration.test.ts` | [SUPPORT](SUPPORT.md#provas) | passa | ✅ |
| Histórico e mensagens imutáveis; RLS FORCE | `support.integration.test.ts` (RLS, append-only) | SECURITY | passa | ✅ |
| Anexo só PNG/JPG/PDF/log, por bytes, sem executável/HTML, sem URL pública | `support-attachment.test.ts`, integração | SUPPORT | passa | ✅ |
| Número de cartão completo recusado em chamado e mensagem | `support-sensitive.test.ts`, integração, navegador | SUPPORT | passa | ✅ |
| Leitura da plataforma é explícita e auditada | integração (`LEITURA_PELA_PLATAFORMA`) | SECURITY | passa | ✅ |
| Admin Web e Console de Suporte no navegador real: busca, contexto, criar, responder, badge, encerrar, histórico, 390 px | roteiro de navegador (Chrome, 2026-10-04) | [SUPPORT](SUPPORT.md#provas) | 24/24, sem erro de página nem 5xx | ✅ |
| Console: criar/renomear categoria (nome curto recusado), criar/validar/editar/publicar/despublicar artigo; artigo publicado aparece na busca da empresa | roteiro de navegador 2 (Chrome, 2026-10-04) | [SUPPORT](SUPPORT.md#provas) | 14/14, sem erro de página nem 5xx | ✅ |
| "Relatar problema" no PDV monta o contexto certo (tela, caixa, venda, pagamento); texto curto e cartão recusados; envio válido grava origem PDV | `scripts/support-report.test.ts` (5), roteiro de navegador 2 | FRONTEND | passa; chamado criado no navegador e removido | ✅ |
| Recusa 4xx do servidor renova a chave de idempotência; sem resposta/5xx mantém a mesma (achado no navegador: 422 ao reenviar com texto corrigido) | `support-report.test.ts` (vermelho antes da correção) | SUPPORT | passa | ✅ |
| Botões "Relatar problema" contextuais: OS e cobrança | `apps/e2e` `support-contextual-buttons` (Chrome) | FRONTEND | passa | ✅ |
| Botões "OS → Garantia" e "Pós-venda › Garantias" no navegador (contexto, módulo e botão de envio desabilitado) | `apps/e2e` `support-contextual-buttons`, com a garantia da demonstração (`demo:seed`, idempotente, só em OS encerrada) | FRONTEND | passa (a 1ª execução falhou: o seed pôs a garantia numa OS aberta, onde o cartão não aparece; seed corrigido e autorreparável) | ✅ |
| HTML/script no assunto do chamado e no corpo de artigo não executa; empresa B não abre o chamado da empresa A pela tela nem pela API | `apps/e2e` `support-ticket-flow`, `support-console-pdv` | SUPPORT | passa | ✅ |
| Duplo clique em "Enviar chamado" no PDV cria um único chamado; após recusa 4xx o reenvio usa chave nova | `apps/e2e` `support-console-pdv` | SUPPORT | passa (1 chamado, origem PDV) | ✅ |
| SLA, aviso por e-mail/WhatsApp, configurações do Console, terminal TEF real | — | ROADMAP | não existem (decisão: fora do escopo) | ⚠️ |

## Mobile e Android TV
| Requisito | Teste | Evidência | Resultado | Status |
|---|---|---|---|---|
| Compila e consome os contratos da API | `tsc` mobile e TV | MOBILE, ANDROID_TV | limpo | ✅ |
| Funciona em aparelho/TV (foco, D-pad, tela acesa) | — | sem SDK/emulador | não testado | ⚠️ |

## Monitoramento e Telemetria
| Requisito | Teste | Evidência | Resultado | Status |
|---|---|---|---|---|
| Empresas → Filial com dados reais; "sem dados" ≠ normal | `monitoring.service.test`, `monitoring-thresholds-alerts` | 2026-09-25/16–19 | passa | ✅ |
| Limites só pelo Super Admin, com teto, motivo, histórico | `monitoring-thresholds-alerts` | 2026-09-26/02–03 | passa | ✅ |
| Alertas completos com deduplicação e recuperação | idem | 2026-09-26/01 | passa | ✅ |
| Versão do app separada do runtime | `smoke:electron` (vermelho antes) | smoke | passa | ✅ |
| API indisponível detectada de fora | — | a própria API não se mede quando cai | exige sonda externa | ⚠️ |

## Auditoria
| Requisito | Teste | Evidência | Resultado | Status |
|---|---|---|---|---|
| Eventos com conteúdo, segredos mascarados, append-only | `audit-content`, `audit.payload.test`, `audit-log-append-only` | contracts/audit-event-matrix | passa | ✅ |

## Performance
| Requisito | Teste | Evidência | Resultado | Status |
|---|---|---|---|---|
| Sem N+1 no relatório/painel/jobs de estoque; saldo no banco | `stock-ledger`, `dashboard.service.test` (1 consulta) | 2026-09-27/01 | 371 → 34 ms | ✅ |
| Listas paginadas com teto | `paginationLimit.test` | SECURITY | ok | ✅ |
| Listas sem paginação restantes (empresas, ativações, transferências) | — | ROADMAP | crescem devagar | ⚠️ |

## Resiliência
| Requisito | Teste | Evidência | Resultado | Status |
|---|---|---|---|---|
| Redis fora: API segue, limite vale, auditoria não se perde | caos controlado + teste do limitador | 2026-09-27/02 | ok | ✅ |
| Postgres fora: 503 honesto, volta sozinha | caos controlado + `errorHandler.test` | 2026-09-27/02 | ok | ✅ |
| Rede do PDV cai no meio da venda | `walk-offline` | 2026-09-27/03–04 | ok | ✅ |
| Provedor indisponível, resposta atrasada, nova tentativa, duplicidade | `payment-exceptions`, `payment-terminal-reconciliation` | — | passa | ✅ |

## Documentação e Git
| Requisito | Teste | Evidência | Resultado | Status |
|---|---|---|---|---|
| Documentação consolidada em `docs/CORTEX`, sem perder conteúdo, links válidos | verificação de links (script) | [README](README.md) | 201 links relativos conferidos (arquivo e âncora, 2026-10-04, inclui SUPPORT), 0 quebrados | ✅ |
| Árvore limpa, só temporários reais removidos, evidências mantidas | `git status` | CHANGELOG | `git status` vazio após o commit final; temporários só no scratchpad (fora do repositório) | ✅ |
