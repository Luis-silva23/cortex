# Contrato: Módulos (SystemModule) × Licença

> Fonte: **somente código** (leitura em 2026-09-24). Nada aqui é intenção de produto; onde o código não decide,
> está marcado **[LACUNA]** ou **[DECISÃO NECESSÁRIA]**. Pendências já registradas: `docs/CORTEX/historico/registro-de-auditoria-2026-09-14-a-25.md` §E8.
> Caminhos relativos à raiz do monorepo; `api/` = `apps/api/src/`, `web/` = `apps/admin-web/`.

> **Atualização de 2026-10-05 (o restante é de 2026-09-24).** Existe um **oitavo módulo, `CANAIS`** (canais externos de venda), e ele é o **único opt-in**:
> `DEFAULT_DISABLED_MODULES = ['CANAIS']` em `module-settings.service.ts` — sem linha de configuração vale como **desligado** (os outros seguem "sem linha = habilitado").
> Gate: `router.use(requireModuleEnabled('CANAIS'))` em `routes/sales-channels.routes.ts`; o SUPER_ADMIN segue isento do gate. Desligado, nenhum canal aparece no Dashboard. Ver [CANAIS](../CANAIS.md).
> As linhas "Módulos desligáveis" e "Default" abaixo descrevem os sete módulos originais.

## 1. Mecânica comum

| Item | O que o código faz | Onde |
|---|---|---|
| Módulos desligáveis | `ESTOQUE, COMPRAS, VENDAS, FINANCEIRO, FISCAL, OFICINA, POS_VENDA`. Cadastros, auth, usuários/perfis e configurações não são módulos. | `packages/database/prisma/schema.prisma:165-173` (comentário 155-164); `api/services/module-settings.service.ts:6` |
| Persistência | `CompanyModuleSetting` (`companyId`, `branchId?`, `module`, `isEnabled`, `disabledBy/At/Reason`, `reenabledBy/At`). Uma linha company-wide (`branchId NULL`) e uma por filial (override). | `schema.prisma:645-662` |
| Default | Sem linha = **habilitado** (opt-out). Prioridade: override da filial > company-wide > habilitado. | `module-settings.service.ts:66-84` |
| Gate | `requireModuleEnabled(module)` → `403 AuthorizationError` com `code: MODULE_DISABLED`. Vale para **todos os métodos** (inclusive GET). | `api/middleware/module.ts:18-39` |
| Isenção | `SUPER_ADMIN` nunca é bloqueado. | `module.ts:25-27` |
| Filial avaliada | A do **token** (`user.branchId`), não a filial-alvo da operação. | `module.ts:29` |
| Onde é aplicado | `router.use(...)` no arquivo de rotas do módulo, ou por rota (dashboard, import). `routes/index.ts` não aplica gate. | ver §2 |
| Checagem em services/jobs | **Nenhuma.** `isModuleEnabled` só é chamado pelo middleware. | grep `isModuleEnabled` → só `module.ts` e o service |
| Outros clientes | PDV desktop, mobile e TV não leem o estado dos módulos (nenhuma referência a `module-settings`). Dependem só do 403 da API. | `apps/pdv-desktop`, `apps/mobile`, `apps/tv` |

## 2. Matriz por módulo

### ESTOQUE
| Aspecto | Conteúdo |
|---|---|
| Rotas bloqueadas quando desligado | `/stock/*` (`api/routes/stock.routes.ts:37`), `/inventory/*` (`inventory.routes.ts:13`), `/damage/*` (`damage.routes.ts:13`), `/transfers/*` (`transfers.routes.ts:13`), `POST /import/stock` (`import.routes.ts:298`), `GET /dashboard/stock` (`dashboard.routes.ts:59`) |
| Menu/tela Admin Web | Itens "Estoque e Transferências" (`/dashboard/inventory`) e "Avarias" (`/dashboard/damage`) somem (`web/components/layout/Sidebar.tsx:74-75`) |
| Escritas cruzadas que **não** respeitam o módulo **[LACUNA]** | Venda grava `StockMovement` na criação/cancelamento/devolução (`api/services/sale.service.ts:343, 622, 823`); OS baixa estoque ao adicionar peça e ao entrar em EXECUCAO (`service-order.service.ts:327, 459`); recebimento e devolução de compra (`purchase-order.service.ts:317, 442`); import de produtos grava estoque inicial (`import.routes.ts:153`, rota `/import/products` sem gate) |
| Leituras que vazam com módulo desligado **[LACUNA]** | `GET /products/:id/stock` e `GET /products/:id/movements` (`products.routes.ts:76, 94`), sem gate |
| Licença relacionada | Nenhuma |

### COMPRAS
| Aspecto | Conteúdo |
|---|---|
| Rotas bloqueadas | `/purchase-orders/*` (`purchase-orders.routes.ts:20`) |
| Menu | "Compras" (`Sidebar.tsx:72`). "Fornecedores" (`/suppliers`) **não** pertence a módulo (sem gate, sem `module` no menu, `Sidebar.tsx:73`) |
| Escritas cruzadas | COMPRAS escreve em outros módulos: estoque no recebimento/devolução (acima) e `Invoice` (nota de entrada) no recebimento (`purchase-order.service.ts:348`), sem checar ESTOQUE/FISCAL **[DECISÃO NECESSÁRIA]** se a nota de entrada é FISCAL |
| Licença | Nenhuma |

### VENDAS
| Aspecto | Conteúdo |
|---|---|
| Rotas bloqueadas | `/sales` (`sales.routes.ts:17`), `/payments` (`payments.routes.ts:17`), `/cash-register` (`cash-register.routes.ts:24`), `/discount-rules` (`discount-rules.routes.ts:13`), `/partners` (`partners.routes.ts:13`), `/installment-policies` (`installment-policies.routes.ts:12`), `GET /dashboard/sales` e `/dashboard/pdv` (`dashboard.routes.ts:20, 95`) |
| Menu | "Vendas" e "Descontos" (`Sidebar.tsx:71, 85`) |
| Escritas cruzadas | Venda escreve em ESTOQUE (acima). Venda **não** cria conta a receber (sem `accountsReceivable` em `sale.service.ts`); pagamento e caixa são do próprio VENDAS (`payment.service.ts:212, 304`) |
| Leituras sem gate **[LACUNA]** | `GET /dashboard/ceo` agrega vendas sem gate de módulo (`dashboard.routes.ts:126`, `dashboard.service.ts:489-499`); `POST /fiscal/documents` lê a venda só com gate FISCAL (`fiscal.routes.ts:87`) |
| Motos | `/motorcycles` sem gate (cadastro) — `index.ts:98`; E8 registra que não pertence a módulo |
| Licença | Nenhuma |

### FINANCEIRO
| Aspecto | Conteúdo |
|---|---|
| Rotas bloqueadas | `/financial/*` (`financial.routes.ts:19`), `GET /dashboard/financial` (`dashboard.routes.ts:37-39`) |
| Menu | "Financeiro" (`Sidebar.tsx:77`) |
| Escritas cruzadas **[LACUNA]** | `POST /service-orders/:id/payment` (gate só OFICINA) cria `AccountsReceivable` PAID e `MechanicCommission` (`service-order.service.ts:579, 605`) com FINANCEIRO desligado |
| Leituras sem gate | Job de relatório agrega contas a pagar (`api/jobs/report.job.ts:172, 319, 336`) sem checar módulo |
| Licença | Nenhuma |

### FISCAL
| Aspecto | Conteúdo |
|---|---|
| Rotas bloqueadas | `/fiscal/*` (`fiscal.routes.ts:13`) |
| Menu | "Fiscal" (`Sidebar.tsx:76`) |
| Escritas cruzadas | `Invoice` no recebimento de compra (ver COMPRAS). Nenhuma emissão automática de NF a partir da venda foi encontrada |
| Licença | Nenhuma |

### OFICINA
| Aspecto | Conteúdo |
|---|---|
| Rotas bloqueadas | `/service-orders` (`service-orders.routes.ts:20`), `/quotes` (`quotes.routes.ts:29`), `/mechanics` (`mechanics.routes.ts:13`), `/commission-rules` (`commission-rules.routes.ts:19`), `GET /dashboard/workshop` (`dashboard.routes.ts:76`) |
| Menu | "Oficina", "Orçamentos", "Mecânicos e Comissões" (`Sidebar.tsx:78-83`) |
| Escritas cruzadas | OFICINA escreve em ESTOQUE e FINANCEIRO (acima) |
| Licença | Nenhuma |

### POS_VENDA
| Aspecto | Conteúdo |
|---|---|
| Rotas bloqueadas | `/revisions` (`revisions.routes.ts:15`), `/follow-ups` (`follow-ups.routes.ts:20`), `/appointments` (`appointments.routes.ts:21`) |
| Menu | "Pós-venda / Agenda" (`Sidebar.tsx:84`) |
| Escritas cruzadas | Só dentro do próprio módulo (`appointment.service.ts:76, 190` atualiza `FollowUp`). Nenhum outro módulo cria revisão/follow-up automaticamente |
| Licença | Nenhuma |

### Sem módulo (sempre ligados)
`/customers`, `/products`, `/categories`, `/suppliers`, `/motorcycles`, `/import/products`, `/import/customers`, `/users`, `/roles`, `/permissions`, `/branches`, `/companies`, `/licenses`, `/activations`, `/backup`, `/audit-logs`, `/observability`, `/module-settings`, `GET /dashboard/ceo`, `GET /dashboard/super-admin` (`api/routes/index.ts:55-117`). No menu: Dashboard, Produtos, Clientes, Motos, Fornecedores, Filiais, Usuários, Relatórios, Configurações (`Sidebar.tsx:67-89`).

## 3. Quem liga/desliga

| Pergunta | Código | Onde |
|---|---|---|
| Endpoint | `POST /module-settings/:module` `{ isEnabled, branchId?, reason? }` | `api/routes/module-settings.routes.ts:74-121` |
| Papéis | `SUPER_ADMIN` e `COMPANY_ADMIN` (MANAGER e abaixo: 403) | `module-settings.routes.ts:55` |
| Empresa-alvo | COMPANY_ADMIN: sempre a do token. SUPER_ADMIN: `?companyId` ou `body.companyId`, obrigatório (400 sem ele) | `module-settings.routes.ts:19-26, 92-95` |
| Company-wide × filial | API aceita `branchId` (override) para os dois papéis; valida que a filial é da empresa | `module-settings.service.ts:154-162` |
| UI Admin Web | Aba "Módulos" só para `COMPANY_ADMIN`; alterna **apenas company-wide** (nunca envia `branchId`) | `web/app/dashboard/settings/page.tsx:52, 314, 332` |
| UI SUPER_ADMIN | Nenhuma (o app super-admin não chama `/module-settings`) **[LACUNA]** (E8) | — |
| Motivo | Obrigatório para desligar (≥ 3 caracteres); religar não pede motivo | `module-settings.routes.ts:103-105` |
| Hierarquia SUPER_ADMIN × COMPANY_ADMIN | Não existe: o modelo não guarda "desligado pela plataforma"; COMPANY_ADMIN religa o que o SUPER_ADMIN desligou **[DECISÃO NECESSÁRIA]** (E8) | `schema.prisma:645-662` |
| Leitura do estado efetivo | `GET /module-settings` aberto a qualquer usuário autenticado; não-admin recebe o efetivo da filial do token | `module-settings.routes.ts:34-50` |
| Histórico | `GET /module-settings/history` (admin). Linha guarda só o **último** motivo; cada mudança vai para o audit log com módulo/filial/estado/motivo | `module-settings.routes.ts:58-87` |
| Tela de histórico | `api.getModuleSettingsHistory()` existe mas nenhuma tela o chama **[LACUNA]** | `web/lib/api.ts:1077` |

## 4. Cache e invalidação

| Camada | Comportamento | Onde |
|---|---|---|
| API (Redis) | Chave `company:{id}:module-settings`, TTL 5 min; entrada carrega a "geração" lida antes do SELECT | `api/services/cache.service.ts:32, 326, 330`; `module-settings.service.ts:39-56` |
| Invalidação | Todo toggle incrementa `…:module-settings:gen` (TTL 24 h) e apaga a chave; entrada com geração antiga é ignorada | `module-settings.service.ts:58-64, 195` |
| Escopo da leitura | Lê as linhas da empresa inteira em contexto RLS `COMPANY_ADMIN` da própria empresa (não do usuário que chegou primeiro) | `module-settings.service.ts:48-53` |
| Redis fora | `cacheService.get` devolve `null` em erro → lê do banco a cada request | `cache.service.ts:49-61` |
| Sidebar | Busca o estado **uma vez** no mount; falha = mostra tudo (fail-open só de UX) | `Sidebar.tsx:102-118` |
| Tela de Configurações | Recarrega a própria lista após alternar; a Sidebar **não** é atualizada até recarregar a página **[LACUNA]** (E8) | `settings/page.tsx:315, 335` |

> Nota sobre E8: o item "cache lido sob o escopo RLS de quem chegou primeiro" está **desatualizado** — o código atual
> lê sob contexto de administração da empresa e usa geração (`module-settings.service.ts:22-38, 48`).

## 5. Licença × módulo

| Item | Código | Onde |
|---|---|---|
| Vínculo licença → módulos | **Não existe.** `License` tem `licenseType`, `status`, `maxDevices`, `maxUsers`, `maxBranches`; `LicenseType` (TRIAL/BASIC/PROFESSIONAL/ENTERPRISE) não é ligado a `SystemModule` **[DECISÃO NECESSÁRIA]** (plano define módulos?) | `schema.prisma:190-195, 975-1001` |
| `maxDevices` | Aplicado ao **solicitar** ativação (conta PENDING/ACTIVE/BLOCKED) | `api/services/activation.service.ts:43-54` |
| `maxBranches` | Aplicado ao criar filial, se houver licença ACTIVE | `api/services/branch.service.ts:43-51` |
| `maxUsers` | **Não aplicado** em lugar nenhum (só validator/tipo/tela) **[LACUNA]** | `packages/shared/validators.ts:15` |
| `status` (SUSPENDED/EXPIRED/CANCELLED) | Só bloqueia **nova solicitação** de ativação. Login e `authMiddleware` não consultam licença; suspender não derruba sessão nem bloqueia API **[LACUNA]** | `activation.service.ts:36-38`; `api/middleware/auth.ts` (sem referência a licença) |
| Quem gerencia | Só SUPER_ADMIN cria/aprova/suspende/reativa/cancela (auditado) | `api/routes/license.routes.ts:70-144` |

## 6. Comportamento ao desligar / religar (somente o que o código faz)

| Superfície | Ao desligar | Ao religar |
|---|---|---|
| Menu Admin Web | Item some **no próximo carregamento** da Sidebar (não em tempo real) | Item volta no próximo carregamento |
| URL direta (Admin Web) | A página **renderiza** (não há guarda de rota nem `middleware.ts` no admin-web); as chamadas de API dela recebem 403 `MODULE_DISABLED`; o interceptor do axios só trata 401 (`web/lib/api.ts:41-66`), então a mensagem depende de cada tela **[LACUNA]** | Volta a funcionar |
| API | 403 `MODULE_DISABLED` em todas as rotas gated, leitura e escrita, para todos exceto SUPER_ADMIN, logo após a invalidação | Liberada logo após a invalidação (geração) |
| PDV / mobile / TV | Sem aviso prévio; recebem o 403 da API | — |
| Dados | **Preservados**: `setEnabled` só grava a flag (`module-settings.service.ts:180-193`); nada é apagado, arquivado ou congelado | Os mesmos dados reaparecem; `disabledBy/At/Reason` não são limpos, `reenabledBy/At` são gravados |
| Pendências (caixa aberto, transferência em trânsito, OS/pedido abertos) | Nenhuma verificação; ficam inacessíveis (fechar caixa / receber transferência dão 403) **[DECISÃO NECESSÁRIA]** (E8) | Retomam de onde pararam |
| Escritas cruzadas | Continuam acontecendo (§2): venda/OS/compra movimentam estoque; OS gera conta a receber | — |
| Usuário sem filial no token | Só o company-wide vale para ele; override de filial é ignorado, e ele opera a filial desligada via `branchId` no corpo (ex.: transferências, inventário) **[LACUNA]** | — |
| Auditoria | Cada toggle gera `AuditLog` UPDATE `CompanyModuleSetting` com módulo, filial, estado e motivo | `module-settings.routes.ts:76-87` |

## 7. Resumo de lacunas / decisões

1. **[LACUNA]** Gate só na borda HTTP: estoque é escrito por VENDAS/OFICINA/COMPRAS/import e conta a receber por OFICINA com os módulos desligados (§2).
2. **[LACUNA]** Leituras de estoque em `/products/:id/stock|movements` e vendas em `/dashboard/ceo` ignoram o módulo.
3. **[LACUNA]** Gate usa a filial do token, não a filial-alvo; usuário company-wide escapa do override por filial.
4. **[DECISÃO NECESSÁRIA]** Hierarquia: COMPANY_ADMIN pode religar o que o SUPER_ADMIN desligou; licença/plano não define módulos.
5. **[LACUNA]** Licença suspensa/expirada não bloqueia uso; `maxUsers` não é aplicado.
6. **[DECISÃO NECESSÁRIA]** Desligar com pendências abertas (E8).
7. **[LACUNA]** Sem UI para override por filial, para SUPER_ADMIN e para o histórico; Sidebar não atualiza ao vivo.
