# Matriz de permissões — CÓRTEX (derivada do código)

> **Como ler**
> 1. Cada linha é uma ação real da API; as colunas são os papéis do enum `UserType` (`packages/database/prisma/schema.prisma:303`).
> 2. ✅ = a API aceita · ❌ = a API recusa (403) · `perm:x` = só se o usuário tiver a permissão `x` por um perfil (UserRole→Role→Permission). O SUPER_ADMIN ignora sempre (`middleware/permission.ts:22`).
> 3. "(filial)" = a RLS restringe à filial do token quem não é SUPER_ADMIN nem COMPANY_ADMIN (`rls_company_branch_match`, `prisma/migrations/0_init/migration.sql:2002`).
> 4. "Onde é imposto" usa caminhos relativos a `apps/api/src/` (rotas em `routes/`). Quando não há nada escrito, vale só `authMiddleware` + `tenantIsolation`.
> 5. **[DECISÃO NECESSÁRIA]** = regra ambígua ou lacuna. **[DIVERGÊNCIA UI×API]** = a tela mostra algo que a API nega, ou o contrário. Nada aqui foi inventado: o que não está no código não aparece como regra.

## Camadas de imposição (ordem de execução)

| Camada | Mecanismo | Onde |
|---|---|---|
| 1. UI (só UX) | `isManagerOrAbove`/`isCompanyAdminOrAbove`, `roles` do menu, módulos desligados | `admin-web/lib/role-gates.ts`, `components/layout/Sidebar.tsx:64-88`, `lib/navigation.ts:8` |
| 2. Gate da API | `authMiddleware` (JWT; rejeita token com `mfaPending`) → `companyScoped()` (SA precisa de `X-Company-Id`/`?companyId=`) → `tenantIsolation` (contexto RLS) → `requireModuleEnabled` (o SA ignora) → `requireUserType`/`denyUserTypes` → `requirePermission` | `middleware/auth.ts`, `middleware/tenant.ts:92,151`, `middleware/module.ts:227`, `middleware/permission.ts:12` |
| 3. Service | dupla autorização (senha e MFA de um 2º usuário, `rateLimitAuthorizer`), filial do requisitante, regras de papel específicas | `services/dual-authorization.service.ts:31`, `services/sale.service.ts`, `services/cash-register.service.ts`, `services/service-order.service.ts:505` |
| 4. RLS Postgres | isolamento por empresa em tudo; por filial em vendas, caixa, OS, orçamentos, estoque, inventário, avaria, compras, fiscal, produtos, AP/AR, pagamentos e comissões | `prisma/migrations/0_init/migration.sql:2184-2324`, `…/20260921120000_branch_rls_for_derived_financial` |

**Fatos globais que valem para todas as tabelas abaixo**
- **Perfis padrão [CORRIGIDO].** Não há seed de `Permission`/`Role`. O COMPANY_ADMIN tem um padrão **enumerado** em código (`COMPANY_ADMIN_PERMISSIONS`, `middleware/permission.ts`): `finance:manage|pay|reverse`, `purchases:manage|approve|receive`, `stock:adjust|transfer`, `data:import`. São as operações administrativas contidas na própria empresa (escopo = token + RLS). Não é curinga: permissão nova não entra sem decisão, e `backup:*` fica fora (só SUPER_ADMIN). MANAGER/OPERATOR/MECHANIC **não têm padrão**, só o que um perfil granular atribuído conceder (menor privilégio). VIEWER nunca passa em `requirePermission` (`READ_ONLY_ROLE`). Prova: `test/integration/default-profiles.integration.test.ts`.
- **[CORRIGIDO]** `requirePermission` recusa VIEWER (papel somente-leitura; o middleware só protege escrita) mesmo que um perfil granular lhe dê a permissão — `READ_ONLY_ROLE` 403. MECHANIC segue sem trava de papel aqui (as rotas financeiras aplicam `denyUserTypes('MECHANIC')`).
- **[CORRIGIDO]** Escopo do perfil: `UserRole` com filial só concede a permissão quando o token opera naquela filial; sem filial, vale na empresa. Token de empresa inteira recebe só perfis sem filial (menor privilégio). Cache de permissões por (usuário, filial).
- `requireBranchAccess`, `requireSameCompany` e `requireAllPermissions` (`permission.ts:51,120,151`) **não são usados** por nenhuma rota.
- SUPER_ADMIN em rota `companyScoped` precisa informar a empresa (`tenant.ts:108-136`). Nas rotas de plataforma ele opera sem empresa.

---

## Clientes (`/customers`, sem módulo)

| Ação | SUPER_ADMIN | COMPANY_ADMIN | MANAGER | OPERATOR | MECHANIC | VIEWER | Onde é imposto | Observação |
|---|---|---|---|---|---|---|---|---|
| visualizar (lista, busca, detalhe, stats) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | customers.routes.ts:35-89 | Dados pessoais abertos a todo o tenant |
| criar | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | customers.routes.ts:116 | "Novo Cliente" só aparece para quem pode (`canRegisterCustomer`) [CORRIGIDO] |
| editar / excluir | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | customers.routes.ts:145,165 | A UI esconde com `isManagerOrAbove` (customers/page.tsx:72): coerente |
| importar em lote | ✅ | perm:data:import | perm:data:import | perm:data:import | perm:data:import | perm:data:import | import.routes.ts:28 | **[CORRIGIDO 2026-10-04]** o botão "Importar" (clientes e produtos) some para o VIEWER (`canImportData`); os demais papéis continuam vendo, a permissão final é da API. A importação já grava auditoria (`auditSummary`) |

## Motos (`/motorcycles`, sem módulo)

| Ação | SA | CA | MANAGER | OPERATOR | MECHANIC | VIEWER | Onde | Observação |
|---|---|---|---|---|---|---|---|---|
| visualizar | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | motorcycles.routes.ts:14,29 | |
| criar | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | motorcycles.routes.ts:47 | Mesma regra de Clientes: o balcão/oficina cadastra a moto do cliente (antes OPERATOR criava cliente e abria OS, mas a moto dava 403) [CORRIGIDO]. "Nova Moto" só para quem pode |
| editar / excluir | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | motorcycles.routes.ts | |

## Produtos / Categorias / Preços / Descontos / Parcelamento / Convênios

| Ação | SA | CA | MANAGER | OPERATOR | MECHANIC | VIEWER | Onde | Observação |
|---|---|---|---|---|---|---|---|---|
| visualizar produto (lista, código, saldo, movimentos) | ✅ | ✅ (filial) | ✅ (filial) | ✅ (filial) | ✅ (filial) | ✅ (filial) | products.routes.ts:18-94 | Produto com `branchId` nulo aparece para todos |
| criar / editar / excluir produto (inclui preço) | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | products.routes.ts:125 | A UI usa `isManagerOrAbove` (products/page.tsx:80): coerente |
| categorias: ver / escrever | ✅/✅ | ✅/✅ | ✅/✅ | ✅/❌ | ✅/❌ | ✅/❌ | categories.routes.ts:17,37 | |
| regras de desconto: ver e escrever (módulo VENDAS) | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | discount-rules.routes.ts:49 | Inclusive o GET. O menu esconde abaixo de MANAGER (Sidebar.tsx:85): coerente |
| políticas de parcelamento: ver | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | installment-policies.routes.ts:14 | |
| políticas de parcelamento: escrever | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | installment-policies.routes.ts:23 | Mais estrito que o resto do cadastro |
| convênios (partners): ver / escrever | ✅/✅ | ✅/✅ | ✅/✅ | ✅/❌ | ✅/❌ | ✅/❌ | partners.routes.ts:15-24,38 | |

## Estoque / Transferências / Inventário / Avarias (módulo ESTOQUE)

| Ação | SA | CA | MANAGER | OPERATOR | MECHANIC | VIEWER | Onde | Observação |
|---|---|---|---|---|---|---|---|---|
| visualizar movimentos, saldo, relatório | ✅ | ✅ | ✅ (filial) | ✅ (filial) | ✅ (filial) | ✅ (filial) | stock.routes.ts:40-80 | |
| pré-visualizar importação | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | stock.routes.ts:101 | Só casa produtos, não grava |
| movimento / ajuste / inventário direto no ledger | ✅ | perm:stock:adjust | perm:stock:adjust | perm:stock:adjust | perm:stock:adjust | perm:stock:adjust | stock.routes.ts:132,163,220 | **Sem trava de papel**: um VIEWER/MECHANIC com a permissão ajusta estoque. Quem não é CA/SA só mexe na própria filial (stock.routes.ts:20-31). **[DIVERGÊNCIA UI×API]** o diálogo de ajuste aparece para todos (inventory/page.tsx:88) |
| transferência via ledger | ✅ | perm:stock:transfer | perm:stock:transfer | perm:stock:transfer | perm:stock:transfer | perm:stock:transfer | stock.routes.ts:187 | Mesma observação |
| importar estoque em lote | ✅ | perm:data:import | idem | idem | idem | idem | import.routes.ts:28,298 | |
| transferência: criar / enviar / receber | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | transfers.routes.ts:21,23,106,125 | **O MECHANIC movimenta estoque.** A RLS de `transfers` é só por empresa (0_init:2312) e o service não confere filial. **[DECISÃO NECESSÁRIA]** |
| transferência: aprovar / rejeitar / cancelar | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | transfers.routes.ts:67,85,145 | A UI usa `isManagerOrAbove` (inventory/transfers/[id]/page.tsx:63): coerente |
| inventário: abrir / lançar contagem | ✅ | ✅ | ✅ (filial) | ✅ (filial) | ✅ (filial) | ❌ | inventory.routes.ts:22,26,67 | |
| inventário: fechar (aplica ajuste) / cancelar | ✅ | ✅ | ✅ (filial) | ❌ | ❌ | ❌ | inventory.routes.ts:92,110 | A UI é coerente (inventory/sessions/[id]/page.tsx:60) |
| avaria: ver | ✅ | ✅ | ✅ (filial) | ✅ (filial) | ✅ (filial) | ✅ (filial) | damage.routes.ts:49,64 | |
| avaria: registrar / estornar | ✅ | ✅ | ✅ (filial) | ❌ | ❌ | ❌ | damage.routes.ts:21,75 | A UI é coerente (damage/page.tsx:58) |

## Vendas / PDV (módulo VENDAS; MECHANIC negado no arquivo inteiro)

| Ação | SA | CA | MANAGER | OPERATOR | MECHANIC | VIEWER | Onde | Observação |
|---|---|---|---|---|---|---|---|---|
| visualizar vendas / stats | ✅ | ✅ | ✅ (filial) | ✅ (filial) | ❌ | ✅ (filial) | sales.routes.ts:19,22-61 | |
| criar venda | ✅ | ✅ | ✅ (filial) | ✅ (filial) | ❌ | ❌ | sales.routes.ts:86,89 | Desconto acima da regra do papel ou convênio com aprovação exige um autorizador MANAGER/CA/SA com senha e MFA (sale.service.ts:20,226) |
| cancelar venda | ✅* | ✅* | ✅* | ✅* | ❌ | ❌ | sales.routes.ts:120 (+`rateLimitAuthorizer`) | *Pede a venda quem estiver na lista; **autoriza** outro usuário MANAGER/CA/SA (sale.service.ts:17,577). Autoautorização é bloqueada (dual-authorization.service.ts:44) |
| devolver venda | ✅* | ✅* | ✅* | ✅* | ❌ | ❌ | sales.routes.ts:157 | Mesma dupla autorização (sale.service.ts:760). A UI é coerente (`lib/sales.ts:52`) |

## Pagamentos / Caixa (módulo VENDAS; MECHANIC negado)

| Ação | SA | CA | MANAGER | OPERATOR | MECHANIC | VIEWER | Onde | Observação |
|---|---|---|---|---|---|---|---|---|
| ver pagamentos | ✅ | ✅ | ✅ (filial) | ✅ (filial) | ❌ | ✅ (filial) | payments.routes.ts:19,22,42 | |
| processar pagamento | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | payments.routes.ts:68,72 | |
| reconciliar | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | payments.routes.ts:69,98 | |
| cancelar / estornar pagamento | ✅ | perm:finance:reverse | perm:finance:reverse | perm:finance:reverse | ❌ | perm:finance:reverse | payments.routes.ts:116,130 | **Sem `auditLog`** nas duas rotas. Um VIEWER com a permissão estorna |
| ver caixa (atual, histórico, fechamento) | ✅ | ✅ | ✅ (filial) | ✅ (filial) | ❌ | ✅ (filial) | cash-register.routes.ts:26,29-98 | O service também filtra por filial (cash-register.service.ts:487) |
| abrir / fechar caixa, reforço (DEPOSIT) | ✅ | ✅ | ✅ (filial) | ✅ (filial) | ❌ | ❌ | cash-register.routes.ts:123-165 | `/movement` com WITHDRAWAL é recusado no service. OPERATOR só opera o próprio caixa; MANAGER, os da filial (`assertCanOperateRegister`) [CORRIGIDO] |
| sangria (retirada) | ✅* | ✅* | ✅* | ✅* (filial) | ❌ | ❌ | cash-register.routes.ts:202 (+`rateLimitAuthorizer`) | *O autorizador é MANAGER/CA/SA e diferente de quem pede (cash-register.service.ts:9,352) |

## Financeiro (módulo FINANCEIRO; MECHANIC negado)

| Ação | SA | CA | MANAGER | OPERATOR | MECHANIC | VIEWER | Onde | Observação |
|---|---|---|---|---|---|---|---|---|
| ver contas a pagar e a receber, fluxo de caixa | ✅ | ✅ | ✅ (filial) | ✅ (filial) | ❌ | ✅ (filial) | financial.routes.ts:21,45,111,186 | **[DECISÃO NECESSÁRIA]** o `GET /dashboard/financial` é só MANAGER+ (dashboard.routes.ts:40), mas as listas brutas ficam abertas a OPERATOR/VIEWER |
| lançar conta (AP/AR) | ✅ | perm:finance:manage | perm | perm | ❌ | perm | financial.routes.ts:57,123 | |
| pagar / receber | ✅ | perm:finance:pay | perm | perm | ❌ | perm | financial.routes.ts:73,139 | |
| cancelar / estornar | ✅ | perm:finance:reverse | perm | perm | ❌ | perm | financial.routes.ts:85,96,153,171 | **[DIVERGÊNCIA UI×API]** os botões Pagar/Receber/Cancelar/Estornar aparecem sem nenhuma checagem (financial/page.tsx:376-385). Numa instalação nova, só o SA passa |

## Compras (módulo COMPRAS; MECHANIC negado)

| Ação | SA | CA | MANAGER | OPERATOR | MECHANIC | VIEWER | Onde | Observação |
|---|---|---|---|---|---|---|---|---|
| visualizar pedidos | ✅ | ✅ | ✅ (filial) | ✅ (filial) | ❌ | ✅ (filial) | purchase-orders.routes.ts:22-40 | |
| criar / cancelar | ✅ | perm:purchases:manage | perm | perm | ❌ | perm | purchase-orders.routes.ts:52,82 | |
| aprovar | ✅ | perm:purchases:approve | perm | perm | ❌ | perm | purchase-orders.routes.ts:70 | |
| receber (gera estoque) / devolver | ✅ | perm:purchases:receive | perm | perm | ❌ | perm | purchase-orders.routes.ts:100,121 | **[DIVERGÊNCIA UI×API]** Novo/Aprovar/Receber só consideram o status do pedido (purchases/page.tsx:111; purchases/[id]/page.tsx:250-252) |

## Fornecedores (`/suppliers`, sem módulo)

| Ação | SA | CA | MANAGER | OPERATOR | MECHANIC | VIEWER | Onde | Observação |
|---|---|---|---|---|---|---|---|---|
| visualizar | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | suppliers.routes.ts:15,30 | O MECHANIC vê fornecedores, embora Compras seja negado a ele |
| criar / editar / excluir | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | suppliers.routes.ts:50 | A UI é coerente (suppliers/page.tsx:53) |

## Oficina / OS (módulo OFICINA)

| Ação | SA | CA | MANAGER | OPERATOR | MECHANIC | VIEWER | Onde | Observação |
|---|---|---|---|---|---|---|---|---|
| visualizar OS / checklist | ✅ | ✅ | ✅ (filial) | ✅ (filial) | ✅ (filial) | ✅ (filial) | service-orders.routes.ts:32,48,216 | |
| criar OS, itens (baixam estoque em EXECUÇÃO+), status, previsão, checklist | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | service-orders.routes.ts:30,60-192 | **[DECISÃO NECESSÁRIA]** o MECHANIC pode cancelar ou finalizar qualquer OS da filial. `PUT /estimated-delivery` não tem `auditLog` (:155). **[DIVERGÊNCIA UI×API]** a tela não esconde as ações do VIEWER |
| atribuir mecânico | ✅ | ✅ | ✅ | ✅ | só a si e em OS livre | ❌ | service-orders.routes.ts:127 + service-order.service.ts:505-523 | O alvo precisa ser `userType=MECHANIC` |
| registrar pagamento da OS (cria AR quitada) | ✅ | perm:finance:pay | perm | perm | **perm** | perm | service-orders.routes.ts:179 | **Sem `denyUserTypes`**: um MECHANIC com a permissão lança dinheiro. Sem `auditLog`. Encerrar exige pagamento (service-orders/[id]/page.tsx:140), então **numa instalação nova só o SA encerra OS**. **[DECISÃO NECESSÁRIA]** |

## Orçamentos (`/quotes`, módulo OFICINA)

| Ação | SA | CA | MANAGER | OPERATOR | MECHANIC | VIEWER | Onde | Observação |
|---|---|---|---|---|---|---|---|---|
| visualizar | ✅ | ✅ | ✅ (filial) | ✅ (filial) | ✅ (filial) | ✅ (filial) | quotes.routes.ts:31,47 | |
| criar / versionar / enviar | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | quotes.routes.ts:66-102 | A UI é coerente (`lib/quotes.ts:37`) |
| aprovar ou recusar (`/decide`) / converter em OS | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | quotes.routes.ts:112,127 | **[DECISÃO NECESSÁRIA]** o MECHANIC registra a aprovação do cliente e gera a OS. O `branchId` vem do corpo, limitado apenas pela RLS de OS |

## Agenda / Revisões / Pós-venda (módulo POS_VENDA)

| Ação | SA | CA | MANAGER | OPERATOR | MECHANIC | VIEWER | Onde | Observação |
|---|---|---|---|---|---|---|---|---|
| visualizar revisões, follow-ups, agenda | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | revisions.routes.ts:17,40; follow-ups.routes.ts:23-55; appointments.routes.ts:23,45 | |
| criar revisão | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | revisions.routes.ts:56 | |
| follow-up: criar / contatar / aceitar / recusar / cancelar | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | follow-ups.routes.ts:71 | **[DIVERGÊNCIA UI×API]** "Novo Follow-up" aparece para o VIEWER (post-sale/page.tsx:336) |
| agendamento: criar / confirmar / reagendar / cancelar / concluir / no-show | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | appointments.routes.ts:63 | Mesma divergência na tela (post-sale/page.tsx:533) |

## Comissões (módulo OFICINA)

| Ação | SA | CA | MANAGER | OPERATOR | MECHANIC | VIEWER | Onde | Observação |
|---|---|---|---|---|---|---|---|---|
| ver comissões | ✅ | ✅ | ✅ | ✅ (todas) | só as próprias | ✅ (todas) | mechanics.routes.ts:18-22,36 | **[DECISÃO NECESSÁRIA]** OPERATOR e VIEWER veem as comissões de todos os mecânicos |
| pagar comissão | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | mechanics.routes.ts:49 | Usa `userType`, não `perm:finance:pay`: **modelo inconsistente** com o Financeiro. **[DIVERGÊNCIA UI×API]** o botão aparece para OPERATOR/VIEWER (mechanics/page.tsx:212) |
| regras de comissão: ver e escrever | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | commission-rules.routes.ts:22 | |

## Fiscal (módulo FISCAL; MECHANIC negado)

| Ação | SA | CA | MANAGER | OPERATOR | MECHANIC | VIEWER | Onde | Observação |
|---|---|---|---|---|---|---|---|---|
| configuração fiscal (ver e salvar; guarda certificado/CSC) | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | fiscal.routes.ts:31,53 | A UI é coerente (fiscal/page.tsx:388) |
| ver documentos | ✅ | ✅ | ✅ (filial) | ✅ (filial) | ❌ | ✅ (filial) | fiscal.routes.ts:99,119 | |
| emitir / cancelar documento | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | fiscal.routes.ts:22,79,136 | **[DIVERGÊNCIA UI×API]** "Tentar emitir" aparece para o VIEWER (fiscal/page.tsx:245) |

## Usuários / Perfis / Permissões (rotas de plataforma, sem `companyScoped`)

| Ação | SA | CA | MANAGER | OPERATOR | MECHANIC | VIEWER | Onde | Observação |
|---|---|---|---|---|---|---|---|---|
| listar / ver usuário | ✅ completo | ✅ completo | ✅ **só a própria filial** (+ usuários sem filial e COMPANY_ADMIN) | diretório | diretório | diretório | user.routes.ts:62,82,108 + RLS `users_select` (2026-10-16) | "Diretório" = id, nome, papel e situação. O próprio usuário vê o cadastro completo. Antes o gerente listava e-mail, telefone e MFA de **todas** as filiais |
| criar / editar / excluir / desbloquear / redefinir senha / ativar | ✅ | ✅ (própria empresa) | ❌ | ❌ | ❌ | ❌ | user.routes.ts:119-244 | Só o SA cria ou promove SUPER_ADMIN (:133,173). **[DECISÃO NECESSÁRIA]** um CA pode redefinir a senha, rebaixar ou desativar outro CA |
| ver / alterar **vínculos de filial** (`GET`/`PUT /users/:id/branches`) | ✅ lê e grava | ✅ lê e grava (própria empresa) | ✅ lê só os **próprios** | só os próprios | só os próprios | só os próprios | user.routes.ts, `user-branch.service.ts`; RLS `user_branches` + gatilho `user_branches_guard` (2026-10-15) | **Só SA/CA gravam** (idempotente, máx. 50, auditado). Gerente não concede filial a si nem a outro. Vínculo para SA/CA é recusado (já veem a empresa). Remover o vínculo revoga **na próxima requisição**, com o mesmo token |
| ver perfis / permissões de um usuário | ✅ | ✅ | ✅ | só o próprio | só o próprio | só o próprio | user.routes.ts:265,294 | |
| atribuir / revogar perfil a usuário | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | user.routes.ts:315,336 | Atribuir a si mesmo é bloqueado (role.service.ts:161). Dois CAs podem atribuir um ao outro |
| perfis: CRUD, vincular permissão | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | roles.routes.ts:24 | **Lacuna:** o CA pode vincular ou desvincular permissão em **perfil de sistema** (`companyId` nulo), o que afeta outras empresas (role.service.ts:108-141; RLS `role_permissions` aceita, 0_init:2278) |
| permissões: listar / criar (nome livre) / excluir | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | permissions.routes.ts:11 | O menu "Usuários e Perfis" é CA+ (Sidebar.tsx:87): coerente |

## Filiais / Empresas / Licenças / Dispositivos

| Ação | SA | CA | MANAGER | OPERATOR | MECHANIC | VIEWER | Onde | Observação |
|---|---|---|---|---|---|---|---|---|
| filiais: ver | ✅ (todas) | ✅ | ✅ (RLS: a própria) | ✅ (própria) | ✅ (própria) | ✅ (própria) | branch.routes.ts:39,67 | RLS `branches_select` (2026-10-16); escrita só empresarial no banco também |
| filiais: criar / editar / ativar / excluir | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | branch.routes.ts:87-155 | A UI é coerente (branches/page.tsx:66) |
| empresas: tudo | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | company.routes.ts:19 | |
| licenças: ver | ✅ (todas) | ✅ (da empresa) | ✅ | ✅ | ✅ | ✅ | license.routes.ts:23,46-56 | |
| licenças: criar / aprovar / suspender / reativar / cancelar | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | license.routes.ts:70-137 | |
| ativação: solicitar dispositivo | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | activation.routes.ts:24,36 | Licença validada contra a empresa. Sem `auditLog` |
| ativação: pendentes / aprovar / rejeitar; dispositivos: listar / bloquear / desbloquear / revogar | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | activation.routes.ts:71-199 | |
| dispositivos de uma licença | ✅ | ✅ (da empresa) | ✅ **só os da própria filial** | ❌ | ❌ | ❌ | activation.routes.ts `GET /devices/:licenseId` (`requireUserType` SA/CA/MANAGER, 2026-10-16) + RLS `devices_isolation` | Antes qualquer papel listava os equipamentos de todas as filiais |
| encerrar sessão de dispositivo à força | ✅ | ✅ | ✅ **só de equipamento da própria filial** (403 `BRANCH_FORBIDDEN` nos demais; 404 se invisível) | ❌ | ❌ | ❌ | activation.routes.ts:229 (2026-10-16) | Antes o gerente encerrava a sessão de equipamento de outra filial |
| heartbeat do dispositivo | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | activation.routes.ts:280 | **O handler não confere a empresa do device**; depende só da RLS `devices_isolation` |

## Módulos (`/module-settings`, sem gate de módulo)

| Ação | SA | CA | MANAGER | OPERATOR | MECHANIC | VIEWER | Onde | Observação |
|---|---|---|---|---|---|---|---|---|
| ver estado efetivo | ✅ | ✅ (qualquer filial) | ✅ (própria filial) | ✅ | ✅ | ✅ | module-settings.routes.ts:34-44 | |
| ativar / desativar, ver histórico | ✅ (`companyId` explícito) | ✅ | ❌ | ❌ | ❌ | ❌ | module-settings.routes.ts:55,58,74 | **[DIVERGÊNCIA UI×API]** (intencional) a aba só aparece para o CA (settings/page.tsx:52); o SA usa o fluxo de plataforma. O SA nunca é bloqueado por módulo (module.ts:234) |

## Auditoria (`/audit-logs`)

| Ação | SA | CA | MANAGER | OPERATOR | MECHANIC | VIEWER | Onde | Observação |
|---|---|---|---|---|---|---|---|---|
| ver logs / por entidade / detalhe | ✅ (todas; `?companyId=`) | ✅ (empresa) | ✅ **só ações de usuários da própria filial** (RLS `audit_logs_select`) | ❌ | ❌ | ❌ | audit-logs.routes.ts:12,25,47,58 | Resolvido em 2026-10-16 (decisão 147): a auditoria não tem `branchId`, a filial vem do **autor**. Lacunas de `auditLog`: pagamento cancelar/estornar, pagamento da OS, previsão da OS, importação, backup |

## Relatórios / Dashboards (`/dashboard`)

| Ação | SA | CA | MANAGER | OPERATOR | MECHANIC | VIEWER | Onde | Observação |
|---|---|---|---|---|---|---|---|---|
| **gerencial** (`/management/summary`, `/management/timeseries`) **[2026-10-05; 2026-10-16]** | ✅ | ✅ (empresa consolidada ou `?branchId=` de filial **da empresa**; outra empresa/inexistente 404) | ✅ **só a filial do token** (`?branchId=` de outra filial → **403 `BRANCH_FORBIDDEN`**) | ❌ | ❌ | ❌ | dashboard.routes.ts `scopedBranchId` (`MANAGEMENT_ROLES`, módulo VENDAS) | Antes o servidor ignorava o pedido do gerente e devolvia a própria filial com 200; agora é erro explícito (decisão 145). A RLS isola também as derivadas. Contas e OS do resumo seguem FINANCEIRO e OFICINA |
| vendas / estoque (`/sales`, `/stock`) **[CORRIGIDO 2026-10-05; escopo 2026-10-16]** | ✅ | ✅ | ✅ (só a própria filial; outra → 403) | ❌ | ❌ | ❌ | dashboard.routes.ts `scopedBranchId` | Antes OPERATOR e VIEWER recebiam vendas e o valor de estoque a custo (a tela os escondia). Teste de integração: 403 para OPERATOR, VIEWER e MECHANIC |
| PDV (`/pdv`) | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | dashboard.routes.ts:147 (`denyUserTypes('MECHANIC')`) | Dia da própria filial; segue aberto a OPERATOR e VIEWER |
| financeiro (`/financial`, módulo FINANCEIRO) | ✅ | ✅ | ✅ (só a própria filial) | ❌ | ❌ | ❌ | dashboard.routes.ts `scopedBranchId` | Módulo desativado → 403 `MODULE_DISABLED` para todos, inclusive gerente e administrador (só o SA ignora o gate) |
| oficina (módulo OFICINA) | ✅ | ✅ | ✅ (só a própria filial) | ✅ (própria) | ✅ (própria) | ✅ (própria) | dashboard.routes.ts `scopedBranchId` | Pedir outra filial → 403 para os papéis de filial |
| CEO (receita por filial) **[CORRIGIDO 2026-10-05]** | ✅ (`?companyId=`) | ✅ | ✅ | ❌ | ❌ | ❌ | dashboard.routes.ts:178 (`MANAGEMENT_ROLES`) | Antes aberto a OPERATOR e VIEWER; fechado junto com `/sales` e `/stock` |
| super-admin | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | dashboard.routes.ts:113 | |
| tela "Relatórios" | — | — | — | — | — | — | admin-web/app/dashboard/reports/page.tsx | Estática, sem chamada à API. `api.getDashboardStats` chama `/dashboard/stats`, que **não existe** (admin-web/lib/api.ts:185) |

## Canais de venda (`/sales-channels`, módulo CANAIS — desligado por padrão) **[2026-10-05]**

| Ação | SA | CA | MANAGER | OPERATOR | MECHANIC | VIEWER | Onde | Observação |
|---|---|---|---|---|---|---|---|---|
| listar, criar, editar nome/ativação, salvar ou remover credencial, testar conexão, ver eventos | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | sales-channels.routes.ts:20-21 (`requireModuleEnabled('CANAIS')` + `requireUserType('SUPER_ADMIN','COMPANY_ADMIN')`) | Módulo desligado → 403 `MODULE_DISABLED`. A credencial nunca é devolvida (nem cifrada). Criar, editar e credencial gravam `audit_logs` (entidade `SalesChannel`, sem segredo); o teste de conexão grava `channel_events`. **Não há rota pública de webhook** |

### Administração da Commerce API (mesmas regras do módulo CANAIS: COMPANY_ADMIN e SUPER_ADMIN; os demais 403) **[2026-10-05]**

| Ação | SA | CA | MANAGER | OPERATOR | MECHANIC | VIEWER | Onde | Observação |
|---|---|---|---|---|---|---|---|---|
| credenciais do canal: listar, criar, trocar, revogar | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | sales-channels.routes.ts (`/:id/api-credentials`) | O segredo só aparece na criação/troca; auditoria `ChannelApiCredential` sem segredo; canal de outra empresa → 404 |
| pedido externo: aceitar (reservar), converter em venda, mudar entrega | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | sales-channels.routes.ts (`/:id/orders/:orderId/{accept,convert,fulfillment}`) | Só COMPANY_ADMIN e SUPER_ADMIN; outro canal/empresa → 404; auditado (`ExternalOrder`, `Sale`, `Fulfillment`). **[2026-10-05]** |
| caixa de saída do canal: listar, reenviar, cancelar; sincronizar estoque, preço e catálogo | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | sales-channels.routes.ts (`/:id/outbox`, `/:id/outbox/:rowId/{retry,cancel}`, `/:id/sync/:kind`) | Só COMPANY_ADMIN e SUPER_ADMIN; outro canal/empresa → 404; auditado (`ChannelOutbox`, `SalesChannel`). **[2026-10-06]** |
| produtos publicados: listar, publicar, despublicar | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | `/:id/products` | Auditoria `ChannelProductLink` |
| pedidos recebidos: listar, detalhar, recusar, cancelar | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | `/:id/orders` | Só pedido `RECEIVED` muda de estado; auditoria `ExternalOrder` com motivo |

**Integration Gateway (`/integrations/v1/webhooks/:channelId`)** também não usa papéis: quem chama é o **provedor**, autenticado pela assinatura HMAC do webhook do canal (segredo `webhookSecret` da credencial). Ver [INTEGRATION_GATEWAY](../INTEGRATION_GATEWAY.md#3-entrada--webhook).

**Commerce API (`/commerce/v1`)** não usa papéis de usuário: quem chama é um **canal**, com escopos da credencial (`CATALOG_READ`, `ORDERS_READ`, `ORDERS_WRITE`, `PAYMENT_EVENTS_WRITE`). Ver [COMMERCE_API](../COMMERCE_API.md#0-implementação--estado-em-2026-10-05) e [SECURITY](../SECURITY.md#commerce-api-2026-10-05).

## Backup / Observabilidade / Saúde / Auth

| Ação | SA | CA | MANAGER | OPERATOR | MECHANIC | VIEWER | Onde | Observação |
|---|---|---|---|---|---|---|---|---|
| backup: criar / listar / restaurar / excluir / stats | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | backup.routes.ts | **Modo delegado (produção, decisão 152):** criar = **202** (a API só grava um *pedido*; o serviço `backup`, com a credencial própria, executa); listar/stats leem os **manifestos** publicados (somente leitura); **restaurar = 403 `RESTORE_DISABLED`** e **excluir = 403 `BACKUP_DELETE_DISABLED`** (restauração é procedimento de DBA em outro servidor). No modo local (desenvolvimento) o comportamento antigo permanece; restaurar ali também é recusado em produção. **Restaurar (local) não pede segundo fator** (auditoria gravada). **[DECISÃO NECESSÁRIA]** |
| observabilidade (métricas, jobs, logs, alertas) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | observability.routes.ts:19 | |
| health / ready / live | público | público | público | público | público | público | health.routes.ts:24,66,81 | |
| login / verificar MFA / refresh / logout | público | público | público | público | público | público | auth.routes.ts | `rateLimitAuth`/`rateLimitMFA`. Logout revoga o refresh **e o access token apresentado** (hash no Redis até o `exp`; `authMiddleware` recusa com 401) [CORRIGIDO]. Cada access token tem `jti` próprio. Redefinir senha, desativar usuário, bloquear empresa e reuso de refresh token (suspeita de roubo) revogam também os access tokens JÁ emitidos (marcador por usuário/empresa no Redis; `access-revoked-on-credential-change.integration.test.ts`) [CORRIGIDO]. Redis fora: a checagem não bloqueia (token vale até expirar, 15 min) — [LIMITAÇÃO] |
| MFA do próprio usuário (setup, verify, disable…) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | mfa.routes.ts:21-424 | Só a própria conta |
| concluir a **troca obrigatória** da senha temporária (`POST /auth/password-change/complete`) | público (credencial de troca) | público | público | público | público | público | auth.routes.ts | Não exige sessão: exige a **credencial de troca** (JWT de 10 min emitido pelo login com senha temporária; claims próprias, sem `userType`, recusada em qualquer outra rota) + senha atual + nova. `rateLimitAuth`; senha atual errada conta para o bloqueio por tentativas; sucesso revoga refresh e access tokens; auditado (decisão 157). |
| trocar a **própria** senha (`POST /auth/change-password`) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | auth.routes.ts | Só a própria conta; exige a senha atual; política de senha; revoga as sessões (decisão 157). |
| criar usuário / redefinir senha com **senha temporária** | ✅ (qualquer empresa) | ✅ (própria empresa) | ❌ | ❌ | ❌ | ❌ | user.routes.ts | `requirePasswordChange` (padrão ligado) marca `mustChangePassword`; papel de filial **não** altera `password`/`mustChangePassword` (gatilho `users_guard_privileged_columns`). Criação bloqueada com 409 `USER_LIMIT_REACHED` acima do `maxUsers` da licença ativa. |

---

## Resumo de lacunas priorizadas

1. ~~Não há seed de permissões~~ **[CORRIGIDO]**: o COMPANY_ADMIN tem o padrão enumerado (ver "Camadas de imposição") e paga/encerra OS, recebe/estorna, compra, ajusta estoque e importa. Os demais papéis dependem de perfil granular.
2. **`requirePermission` ignora o papel**: VIEWER (e MECHANIC em estoque e na OS) com a permissão escreve dinheiro ou estoque (stock.routes.ts:132-220, service-orders.routes.ts:179, financial/payments/purchase-orders para VIEWER).
3. ~~O perfil por filial não restringe~~ — corrigido (ver topo).
4. **O CA altera perfis de sistema**, afetando todas as empresas (role.service.ts:108-141).
5. **O MECHANIC movimenta estoque** (transferência criar/enviar/receber, contagem) e decide ou converte orçamentos.
6. ~~Faltam `auditLog` em estorno/cancelamento de pagamento, pagamento de OS, importação e backup~~ **[CORRIGIDO]** (conferido no código em 2026-10-04).
7. **A UI mostra ações que a API nega**: financeiro, compras, pagar comissão, ajuste de estoque, nova moto, novo cliente/importar, pós-venda, emissão fiscal e ações de OS para o VIEWER.

## Escopo por filial — resumo por perfil e módulo **[2026-10-16]**

A matriz completa por objeto (tabela × perfil × empresa/filial) e o contrato de erro dos dashboards estão em [tenant-branch-scope §9](tenant-branch-scope.md). Resumo do que a API **e** a RLS garantem hoje:

| Pergunta | COMPANY_ADMIN | MANAGER (filial A1) | OPERATOR / MECHANIC / VIEWER (A1) |
| --- | --- | --- | --- |
| Vê o dashboard consolidado da empresa? | ✅ | ❌ (recebe a própria filial) | ❌ (403; só `/pdv` e `/workshop` conforme a matriz) |
| Vê o detalhe de uma filial da empresa? | ✅ qualquer | ❌ só A1; outra → 403 `BRANCH_FORBIDDEN` | ❌ só A1 |
| Alcança outra empresa conhecendo ids/URLs/parâmetros? | ❌ 404 | ❌ 404 | ❌ 404 |
| Recebíveis (`FINANCEIRO`) com módulo desativado? | ❌ 403 `MODULE_DISABLED` | ❌ 403 | ❌ 403 |
| Ordens de serviço/orçamentos (`OFICINA`) com módulo desativado? | ❌ 403 | ❌ 403 | ❌ 403 |
| Liga um módulo desativado (API ou SQL direto)? | ✅ pela API de módulos | ❌ (RLS recusa `company_module_settings`) | ❌ |
| Muda o próprio `userType`/`branchId` (API ou SQL direto)? | — | ❌ (trigger `users_guard_privileged_columns`, SQLSTATE 42501) | ❌ |
| Concede perfil/permissão (API ou SQL direto)? | ✅ | ❌ (RLS de `user_roles`, `roles`, `permissions`, `role_permissions`) | ❌ |

**Gerente com mais de uma filial (2026-10-15, decisão 153):** as colunas acima valem para o **conjunto** de filiais vinculadas. Gerente de **A e B**: vê A e B (e a soma das duas no consolidado dele), nada de C; filial fora do conjunto → 403 `BRANCH_FORBIDDEN`; outra empresa → 404. A matriz completa (A, A+B, A+C, administrador, outra empresa) para dashboards, vendas, faturamento, convênios, usuários e auditoria está em [tenant-branch-scope §10](tenant-branch-scope.md). O vínculo não habilita módulo desativado nem poder administrativo.

Provas: `apps/api/test/integration/branch-scope-access.integration.test.ts` (28 testes, chamadas diretas à API e SQL com o papel real de execução, mais a prova vermelha contra a RLS antiga: 16 de 28 falharam), `dashboard-management.integration.test.ts`, `mfa-company-admin.integration.test.ts`.
