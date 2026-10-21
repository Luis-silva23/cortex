> **Histórico — congelado em 2026-09-25.** Antes em `docs/tech-debt.md`. Registro integral, rodada a rodada, das
> auditorias de 2026-09-14 a 2026-09-25 (achados, commits, incidentes, decisões). Mantido sem cortes para rastreabilidade.
> Item marcado aqui como pendente pode ter sido resolvido depois: o estado atual está em
> [CURRENT_STATE](../CURRENT_STATE.md), as decisões em [DECISIONS](../DECISIONS.md) e o que falta em [ROADMAP](../ROADMAP.md).
> Caminhos citados neste arquivo usam a organização antiga — ver o mapa em [README](../README.md#caminhos-antigos).

---

# Dívida técnica registrada

Itens conhecidos que **não** foram resolvidos de propósito, cada um com onde está, por que importa e o
gatilho para resolver. Só entra aqui o que foi verificado no código; o que é decisão de produto pendente
está marcado como tal (não foi inventada regra).

Última revisão: 2026-09-21 (rodada de segurança/consistência: Configurações, módulos, MECHANIC, cache, estoque).

---

## A. Resolver ANTES da preparação de produção

### A1. Lista de empresas sem paginação
- **Onde:** `apps/api/src/routes/company.routes.ts:27` → `companyService.findAll()`
  (`apps/api/src/services/company.service.ts:9`, `prisma.company.findMany` sem `take`/`skip`).
- **Por quê:** o payload cresce linearmente com o número de tenants, sem teto. Nas demais listas o padrão
  já é `paginationLimit` (teto de 100) + `{ page, limit, total, pages }` (ver `quotes`, `damage`).
- **Como resolver:** aplicar o mesmo padrão e ajustar os consumidores (conferir `apps/super-admin` ao
  paginar — a resposta muda de formato).
- **Decisão:** não bloqueou a UI de Orçamentos; entra na lista de pré-produção.

### A2. Lista de ativações pendentes sem paginação
- **Onde:** `apps/api/src/routes/activation.routes.ts:73` → `activationService.listPendingActivations()`
  (`apps/api/src/services/activation.service.ts:88`, `prisma.activation.findMany`).
- **Por quê / como resolver:** idem A1.

### A3. Build do Admin Web não valida tipos nem lint
- **Onde:** `apps/admin-web/next.config.js` (`eslint.ignoreDuringBuilds` e `typescript.ignoreBuildErrors`
  ligados). O `next build` imprime "Skipping validation of types / Skipping linting".
- **Por quê:** um erro de tipo só aparece se alguém rodar `npx tsc --noEmit` à mão (é o que se fez nesta
  entrega: limpo).
- **Como resolver:** rodar `tsc --noEmit` no CI do admin-web e desligar os dois flags quando o backlog de
  erros antigos permitir.

---

## B. Decisão registrada: criação de `customers` aberta a OPERATOR e MECHANIC

`POST /customers` aceita SUPER_ADMIN, COMPANY_ADMIN, MANAGER, **OPERATOR, MECHANIC** (só VIEWER é barrado).
`PUT`/`DELETE` exigem Gerência+. Ficou assim porque o PDV usa. Revisão feita com evidência:

| Papel | Chamador real que exige a criação |
| --- | --- |
| OPERATOR | PDV desktop: `CustomerSearchModal.tsx` → `api.createCustomer` (e a fila offline `offline.service.ts`). |
| MECHANIC | Nenhum no PDV/mobile/TV. **Mas** a UI de Orçamentos (esta entrega) deixa MECHANIC criar orçamento, e o seletor de cliente oferece "Cadastrar novo cliente" → `/dashboard/customers/new` → `POST /customers`. Fechar para MECHANIC quebraria esse fluxo. |

- **Mantida.** Motivos: (1) o modelo `Customer` só guarda identidade/contato (`name`, `document`, `email`,
  `phone`, `mobile`, endereço, `notes`) — não há dado financeiro nem de crédito nele; (2) a criação tem
  `auditLog(CREATE, 'Customer')`; (3) alterar/apagar continua restrito a Gerência+, então um cadastro ruim
  feito por papel operacional só é corrigido por quem tem mais alçada; (4) a lista de clientes é
  paginada e filtrada por tenant (RLS).
- **Riscos residuais (reais, ligados a qualidade de dado e não a autorização):**
  - `document` não é validado (dígito verificador de CPF/CNPJ) nem normalizado: a unicidade
    `@@unique([companyId, document])` e o `findByDocument` comparam a string exata, então
    `123.456.789-00` e `12345678900` viram dois clientes.
  - Não há limite de volume de criação por usuário (só o rate limit global da API).
- **Gatilho para reavaliar:** aparecer duplicidade de cliente em produção, ou um app de mecânico que passe
  a não precisar cadastrar cliente (aí MECHANIC pode sair da lista).
- **Se decidir apertar:** trocar a lista em `customers.routes.ts` (linha do `POST`) e ajustar
  `customers.routes.test.ts`; o seletor de cliente do orçamento já degrada bem (mostra o link, a API
  responde 403 e a tela exibe o erro).

---

## C. Design System (CÓRTEX — Lógica de Negócios)

### C1. Tokens derivados da especificação escrita, não do arquivo oficial
- Os arquivos oficiais do CÓRTEX **não estão no repositório**. Os tokens (tema claro, escuro e automático;
  base preto/naval, cinza e off-white; verde/vermelho/amarelo só em indicador semântico) foram derivados da
  descrição fornecida. **Validar contra o oficial** e ajustar só os valores em
  `apps/admin-web/app/globals.css`, `tailwind.config.js` e `lib/theme.ts` (os componentes consomem tokens).

### C2. Camada de compatibilidade `.dark` para telas antigas
- `globals.css` tem um bloco longo de regras `.dark` que reescreve classes Tailwind fixas
  (`bg-white`, `text-gray-*`, etc.) usadas pelas telas anteriores ao tema. É transitório: remover à medida
  que cada tela migrar para os tokens (`bg-card`, `text-foreground`, …).

### C3. Dashboards existentes fora do padrão
- KPIs com ícones coloridos e roxo, e cores fixas nos gráficos (recharts), contradizem "KPIs neutros /
  cor só em indicador semântico". Não foram alterados (fora do escopo de Orçamentos); migrar para tokens.

### C4. Sem testes de componente / e2e no repositório
- O `jest` do Admin Web (`apps/admin-web/jest.config.js`) roda lógica pura em node (`lib/quotes.test.ts`).
  Não há jsdom/Testing Library/Playwright. O fluxo de Orçamentos foi validado no navegador real
  (Chrome DevTools), mas isso não fica como teste repetível. Introduzir Playwright para
  criar → enviar → aprovar → converter.
- `jest`/`ts-jest` do Admin Web vêm **hoisted** do workspace (mesmas versões de `apps/api`), sem constar em
  `apps/admin-web/package.json`. Funciona hoje; declarar como `devDependencies` na próxima vez que o
  lockfile for regenerado, para o pacote não depender de outro workspace.

---

## D. Orçamentos — regras de negócio que não existem (não foram inventadas)

| # | Situação | Efeito na UI |
| --- | --- | --- |
| D1 | **Desconto/autorização:** o backend fixa `discountAmount = 0` e não tem regra nem autorização de desconto em orçamento. Precisa de decisão de produto (limite por papel? dupla autorização como na devolução de venda?). | "Desconto" aparece sempre `R$ 0,00`, somente leitura. |
| D2 | `EXPIRED` existe no enum, mas nada o define. | A tela só sinaliza "vencido" comparando `validUntil` com hoje. |
| D3 | `addVersion` ignora `validUntil`/`notes` (só recebe itens). | "Nova versão" edita só os itens; validade e observações ficam as da criação. |
| D4 | "Enviar" apenas grava `sentAt` + status `SENT`; não há canal (WhatsApp/e-mail). | A tela diz isso explicitamente ("o aviso ao cliente é feito por você"). |
| D5 | `approvedAt` é preenchido em **qualquer** decisão (aprovar ou recusar); o nome induz a erro. | A tela usa `isApproved` para diferenciar; considerar renomear para `decidedAt`. |
| D6 | `QuoteItem.productId` é escalar sem FK no schema. | O serviço valida que o produto é da mesma empresa; não há integridade referencial no banco. |
| D7 | Erros da API de orçamentos saem em inglês (`Cannot convert a quote with status …`). | Exibidos como vêm. Traduzir na API ou mapear na tela. |
| D8 | `addVersion` permitido em `APPROVED` no backend. | A tela não oferece (deixaria o orçamento aprovado com última versão sem envio). Decidir se o backend deve bloquear. |

---

## E. Achados da varredura de contrato do Admin Web (oficina, fiscal, estoque, financeiro, cadastros)

Marcação: **[verificado]** = conferido no código nesta revisão; **[relato]** = veio do relatório da
varredura e não foi reverificado — confirmar antes de agir.

### E1. Decisões de produto pendentes
| # | Situação | Efeito hoje |
| --- | --- | --- |
| E1a | **Permissões RBAC sem seed [CORRIGIDO: padrão enumerado do COMPANY_ADMIN em `COMPANY_ADMIN_PERMISSIONS`; demais papéis só por perfil granular — `default-profiles.integration.test.ts`].** `requirePermission` só libera SUPER_ADMIN (`middleware/permission.ts:22`); os demais dependem de Role→Permission no banco, e o único código que cria permissão é o `role.service.ts` (por ação de admin). Não existe seed no repositório. Rotas que exigem `finance:pay`, `finance:reverse`, `purchases:manage`, `purchases:approve`, `data:import`. | Um COMPANY_ADMIN recebe 403 `INSUFFICIENT_PERMISSIONS` nessas telas a menos que alguém tenha criado e atribuído um perfil. **Não confirmado:** se o banco de produção já tem esses perfis. Decidir os perfis padrão e semeá-los. |
| E1b | **Estornar o estorno [verificado].** `financial.service.ts` só exige `status PAID` e "ainda não estornado"; não recusa `referenceType 'Reversal'`. | A tela não oferece "Estornar" no lançamento de estorno (`lib/financial.ts`). Decidir se desfazer estorno é operação válida; se não for, bloquear na API. |
| E1c | **Emissão fiscal não confere `sale.status` [verificado].** `fiscal.service.ts::emitDocument` só exige a venda existir na filial e não haver documento ativo; uma venda `CANCELLED`/`RETURNED`/`PENDING` emite NFC-e. | Sem proteção na API nem na tela. Decidir quais status podem emitir (proposta: `PAID`) — é regra de compliance, não foi assumida. |
| E1d | Usuário sem `branchId` → acesso a todas as filiais (`checkBranchAccess`, `permission.ts`) [verificado]. | Pode ser intencional (COMPANY_ADMIN); confirmar para os demais papéis. |
| E1e | ~~`GET /users` aberto a qualquer papel~~ **Resolvido (commit ade609c):** SUPER_ADMIN/COMPANY_ADMIN/MANAGER veem o cadastro completo; os demais recebem só `id`, `name`, `userType`, `isActive`; perfis de outro usuário só para gerência+. | Resta **[decisão necessária]:** MANAGER enxerga `numericId`/e-mail/telefone de todos (precisa do `numericId` para o fluxo de autorizador?) — confirmar. |
| E1f | **Cancelar documento fiscal [decisão necessária].** Emitir e cancelar agora exigem SUPER_ADMIN/COMPANY_ADMIN/MANAGER/OPERATOR (VIEWER e MECHANIC fora — commit 4d9c752). Cancelar é ato de efeito legal. | Decidir se o cancelamento deve ser só de gerência+ (e se OPERATOR emite). |

### E2. Lacunas de API que a tela contorna
- Emissão fiscal oferece só as 50 vendas mais recentes (o endpoint de vendas não filtra por "sem
  documento fiscal") [relato].
- Destino de transferência limitado pela RLS para papéis não-admin [relato].
- Cancelamento fiscal: o adapter devolve `PENDING` sem provedor real integrado [relato].
- ~~Ajuste avulso de estoque sem `branchId`~~, ~~cadastro de filial por SUPER_ADMIN sem `companyId`~~ e
  ~~cliente desativado sem reativação~~: **resolvidos** (commits 7c864e8, 56ad800/2c92b60, 66a0d1c).

### E3. Telas com listas de limite fixo (sem paginação)
Lista de OS, mecânicos e painéis de pós-venda usam `limit 50` sem paginação; emissão fiscal, avarias e
financeiro já paginam (`lib/list-pagination.ts`). Ações de pós-venda só fazem `console.error` em caso de
erro (sem feedback ao usuário). A aba Usuários de Configurações lista só a primeira página (20) [relato].

### E4. Rate limiter compartilhado por cancelamento/devolução/retirada
`rateLimitMFA` (3 tentativas/5 min, bloqueio de 30 min) conta requisições **inválidas** também e é
compartilhado entre cancelar venda, devolver e retirada [verificado nesta sessão: bloqueio de 429 durante os
testes reais]. Um operador que erra a senha do autorizador nos três fluxos soma no mesmo contador.

### E5. Higiene do banco de desenvolvimento
Empresas de teste antigas ("Integration Test Co modsettingsA/B", "RedTeam IDOR Co A/B") ficaram no banco de dev
por falta de teardown (aparecem no seletor de empresas do SUPER_ADMIN); provável causa de uma falha
intermitente de CNPJ (agora o fixture usa 6 dígitos aleatórios, `randomCnpjLike()`). Remover na próxima
limpeza do ambiente de dev.

### E6. MECHANIC — o que foi fechado e o que é decisão de produto
**Fechado [verificado, testes reais]** (commits 4d9c752, ade609c, 6dad7ce): item de OS com preço/quantidade
negativos; reatribuir OS de outro mecânico (desvio de comissão); ler comissões alheias; ler vendas,
pagamentos, caixa, financeiro, compras, fiscal e dashboards de dinheiro; emitir/cancelar documento fiscal;
diretório de usuários completo. O mobile e a TV não chamam nenhuma rota restringida.

**[decisão necessária] — não assumido:**
- **Custo do produto e dados pessoais do cliente para MECHANIC.** `GET /products` devolve `costPrice`; clientes
  vêm completos (documento, e-mail, nascimento, endereço). Mascarar (LGPD, mínimo necessário)? O seletor de
  cliente da OS mostra o CPF hoje.
- **"Minhas OS".** MECHANIC lê e move o status de QUALQUER OS da filial (inclusive cancelar); o mobile e a TV
  também listam todas. Restringir quebra as duas listas.
- **Quem define o preço da mão de obra.** Hoje o mecânico digita e a comissão dele incide sobre isso.
  Tabela de serviços, aprovação de gerência ou teto?
- **Orçamento: o mesmo usuário cria, aprova (`decide`) e converte em OS**, e a conversão copia o preço manual
  (contorna o `salePrice` do catálogo) — separação de funções?
- **Estoque:** MECHANIC abre inventário, conta e solicita/envia/recebe transferência entre filiais.
- **Fluxo de moto nova:** o MECHANIC cria cliente (seção B) mas `POST /motorcycles` é MANAGER+ — não fecha o
  cadastro de um cliente novo sozinho.
- **VIEWER lê financeiro/vendas** (papel "só leitura"): intencional?
- ~~**Payments, contas a pagar/receber e comissões só tinham RLS por empresa, não por filial**~~ **[VERIFICADO e
  CORRIGIDO 2026-09-21, ver F1]** — reproduzido com HTTP + Postgres reais (20 falhas na matriz) e fechado por
  migration. **Clientes e fornecedores seguem só por empresa — decisão de produto (F2), não assumida.**

### E7. Sessão, MFA e auditoria
- **Access token de quem foi desativado segue válido até expirar (15 min)** [verificado]: o `authMiddleware`
  só verifica o JWT (não consulta o banco). A desativação já revoga os refresh tokens (commit 87c6437).
- **Audit já gravado com segredo de MFA [verificado: 1 linha no banco de dev, contagem read-only em
  2026-09-21; produção não medida]:** antes do commit 58290e7, `POST /mfa/setup` gravava segredo TOTP, QR code e códigos de backup em `audit_logs.new_value`
  (legível por gerência+) e nos jobs do Redis. **Ação operacional:** em produção, expurgar `new_value` das
  linhas `entity='User'` geradas por `/mfa/setup` e regenerar o MFA dos usuários afetados.
- `mfaSecret` é gravado em texto puro (cifrar em repouso?) [relato]; `POST /mfa/disable` só tem o rate limit
  global [relato]; ~~`updateUserSchema` aceitava `companyId`/`password`~~ (resolvido, commit aba62be); um
  COMPANY_ADMIN pode desativar/excluir a si mesmo ou o último admin [relato];
  `deleteRole` de perfil de sistema lança `Error` puro (500) [relato].
- Backup: só SUPER_ADMIN, mas `create/restore/delete` não têm `auditLog` e `create` devolve o `filePath` do
  servidor [relato].

### E8. Módulos — decisões pendentes
- **Ligar/desligar:** quem religa um módulo que o SUPER_ADMIN desligou (plano/licença)? Hoje o COMPANY_ADMIN
  religa qualquer um [relato].
- **Desligar com pendências** (caixa aberto, transferência em trânsito, OS/pedido abertos): nada verifica, e o
  gate cobre o router inteiro — fechar caixa e receber transferência passam a dar 403 [relato].
- **Efeitos cruzados:** venda/OS/compra gravam estoque e contas a receber por dentro dos services, então
  desligar ESTOQUE/FINANCEIRO não impede essas escritas [relato]. Suppliers e motorcycles não pertencem a módulo.
- **UI de módulos para SUPER_ADMIN:** a aba ficou só do COMPANY_ADMIN; escolher a empresa é um fluxo do painel
  de plataforma (a API exige `companyId` do SUPER_ADMIN) [verificado].
- O estado de módulos fica em cache de 5 min e é lido sob o escopo RLS de quem chegou primeiro: com override
  por filial pode servir o estado errado a outra filial [relato; hoje a UI nunca cria override por filial].
- A Sidebar carrega o estado dos módulos uma vez: fica desatualizada até recarregar após alternar [relato].

### E9. Ambiente e design
- **Portas [verificado em package.json]:** Admin Web = 3002, **super-admin = 3000**, API = 3001. O
  "localhost:3000" das Configurações é o painel de plataforma (super-admin), não o Admin Web — as Configurações
  de empresa estão em `localhost:3002/dashboard/settings`.
- Dashboards: ícones de KPI em verde/vermelho onde há leitura de estado possível e telas antigas com classes
  `gray`/`blue` fixas seguem cobertas pela camada `.dark` (seção C2). Roxo, gradiente e a paleta categórica dos
  gráficos foram removidos (commit 94b5c55).

---

## F. Auditoria integral — rodada de 2026-09-21

Marcação: **[VERIFICADO]** reproduzido por mim (HTTP/Postgres/Redis reais, ou leitura de código citada);
**[CORRIGIDO]** + **[TESTADO]** = há teste que falha no código antigo e passa no novo; **[RELATO]** = veio de
agente/leitura e **não** foi reproduzido — não é fato; **[DECISÃO NECESSÁRIA]** = regra de negócio/compliance que
não foi assumida; **[BLOQUEIO EXTERNO]** = depende de ambiente/provedor que não existe aqui.

### F1. Corrigido nesta rodada (um commit por correção)
| Commit | Achado [VERIFICADO] | Correção / prova |
| --- | --- | --- |
| c83b9d0 | **Cache Redis sem escopo de filial/empresa.** `GET /products/:id/stock` lia o cache (chave só com o produto) **antes** de conferir a empresa: a empresa B lia o saldo de um produto da A; `?branchId=` forjado gravava o saldo parcial do operador sob a chave que o administrador lê depois; lista/detalhe de produtos e o dashboard de estoque usavam chave só por empresa (quem chegava primeiro definia o que os outros viam). | Chaves passam a incluir o escopo de quem pede (`all` \| `b:<filial>`; `utils/cache-scope.ts`). [TESTADO] `cache-branch-scope.integration.test.ts`: 3 de 4 casos falham no código original. |
| ddcb9de | **RLS por filial ausente** em `payments`, `mechanic_commissions`, `accounts_payable`, `accounts_receivable`: o operador/gerente da A1 lia NSU/autorização, comissões e contas da A2. | Migration `20260921120000_branch_rls_for_derived_financial` (**exige `prisma migrate deploy` nos outros ambientes**; rollback documentado no cabeçalho). [TESTADO] matriz `tenant-branch-matrix.integration.test.ts` (444 casos: empresa A/B × filial 1/2 × papéis, GET por id de 17 tipos de registro, 15 listagens, escritas cruzadas, `companyId`/`branchId` forjados): 25 falhas antes, 0 depois. |
| 6a68877 | **SUPER_ADMIN sem `companyId` em rota de empresa.** O JWT do SA não tem empresa; `user.companyId` (undefined) é ignorado pelo Prisma: 26 listas devolviam dados de **todas** as empresas misturados, `POST` de empresa vazava erro do Prisma **com o caminho de arquivo do servidor**, e `POST /users` de OPERATOR sem `companyId` gravava usuário órfão (201). | `companyScoped()` em `routes/index.ts`: SA precisa de `?companyId=` ou `X-Company-Id` (`COMPANY_CONTEXT_REQUIRED` 400; malformado 400; inexistente 404). Rotas de plataforma (empresas, licenças, dispositivos, backup, observabilidade, auditoria, usuários, filiais, módulos, `/dashboard/super-admin`) seguem globais. Usuário comum ignora o alvo (o token manda). [TESTADO] `super-admin-company-context.integration.test.ts` (59 casos; 51 falham no código original) + unit. |
| 8221692 | **Agendamento/follow-up/revisão nasciam com `branchId NULL`** (as rotas repassavam o corpo cru; o admin-web não envia): a "Agenda de hoje" da TV e os cards do mobile (filtram `branchId = filial`) ficavam vazios, o registro ficava visível a todas as filiais e um `branchId` de outra empresa passava. | `utils/branch-context.ts`: usuário de filial grava na dele (outra filial no corpo → 403); COMPANY_ADMIN/SA escolhem filial **da própria empresa** (validada) ou deixam sem filial. [TESTADO] `branch-on-create.integration.test.ts` (21 casos; 12 falhavam). **Não há backfill:** registros antigos com `branchId NULL` continuam "da empresa toda" (não dá para inferir a filial) e a TV/mobile, que filtram por igualdade, não os veem — ver F2. |
| 73546a3 | **Credencial de dispositivo (JWT de ~10 anos) em texto puro em `audit_logs`** e na fila Redis (`POST /activations/:id/approve` devolve `credential` em `data`; a regex de redação não cobria). **`unblockDevice` promovia a ACTIVE um dispositivo bloqueado ainda PENDING** (sem aprovação nem credencial). | Redação cobre `credential`/`authorization`/`cookie`; unblock devolve ao estado anterior (ACTIVE se houve ativação APPROVED, senão PENDING). [TESTADO] unit (falhavam antes). **Ação operacional:** em produção, linhas antigas de `audit_logs` com `entity='Activation'` podem conter credenciais válidas → revogar/reemitir os dispositivos ou expurgar o `new_value`. |
| da69930 | **Bloquear empresa não tinha efeito:** `POST /companies/:id/toggle-active` invertia `Company.isActive`, que nada lia — os usuários seguiam logando e renovando o acesso. | Login/refresh/pós-MFA recusam empresa desativada (403 "Empresa desativada", só depois da senha correta); desativar revoga os refresh tokens da empresa; reativar devolve o acesso. [TESTADO] `company-deactivation-sessions.integration.test.ts` (3 de 6 falhavam). Limite: access token já emitido vale até expirar (15 min, ver E7). |
| a2bb2c8 | **`POST /sales` (achados na tela real do PDV):** venda de balcão **sem cliente** (`customerId: null`, o caso comum) devolvia 400 com JSON cru do zod; `partnerId` **não existia no schema** (o zod o descartava: o convênio que o operador via no total nunca era aplicado, e um convênio de outra empresa passava); quantidade zero/negativa, desconto negativo, percentual >100 e desconto maior que o total eram aceitos; `createSale` vendia **produto inativo**. | Schema (`packages/shared`) e serviço endurecidos. [TESTADO] `sale-input-validation.integration.test.ts` (15 casos; 13 falhavam). |
| 0c47973 | **PDV empacotado abria em branco** (`BrowserRouter` sob `file://`), **impressão morta** (`ipcRenderer` importado no renderer com `contextIsolation`), `webContents.print` sem esperar (retorno sempre `success`), **refresh rotacionado descartado** (no 2º vencimento o token revogado era reapresentado e a API revogava TODAS as sessões — provado com a API real) e senha errada tratada como sessão expirada. | `HashRouter`, ponte `window.electron.printer`, single-flight + `setTokens`, `/auth/*` fora do renovar-e-repetir. [TESTADO] `npm run smoke:electron` (Electron real): passa no novo, **falha no original** (janela em branco). |
| 6b5a131 | **Busca de produto por NOME derrubava a tela inteira** (`result.data` de `{products}`, sem error boundary); histórico de vendas nunca listava (`{sales}`); toasts espúrios ("Product not found" a cada busca por nome, "No open cash register found" com caixa fechado); **F3/F4/F5 mortos com o foco no campo de busca** (quase sempre) e F5 recarregava a janela do Electron; produto inativo entrava no carrinho; erro de validação em JSON cru. | Chaves reais, `ErrorBoundary`, `quietStatuses`, teclas de função valem com foco em campo (com modal aberto só ESC age), `isActive=true` na busca. [VERIFICADO na UI real] cada cenário; sem teste automatizado de UI (o PDV não tem infra além do smoke do Electron). |
| 6563134 | **Logout não limpava carrinho e caixa em memória:** o gerente que entrava depois do operador (sem recarregar) via o carrinho dele e o POS reaproveitava o caixa dele — vendia **no caixa de outra pessoa**. | `logout` e `login` zeram os stores. [VERIFICADO na UI real] carrinho vazio após a troca. |
| 29ec072 / 10e7083 | **Login com senha errada (Super Admin e Admin Web) recarregava a página e esvaziava o formulário sem mostrar o motivo** — o 401 de `/auth/login` (e de `/auth/verify-mfa`, código MFA errado) caía no ramo "sessão expirada" do interceptor (limpa tokens + `window.location.href='/login'`). No SA também não havia single-flight (N requisições em 401 reapresentavam um refresh revogado → todas as sessões revogadas). | `/auth/*` fora do renovar-e-repetir, single-flight no SA, `apiErrorMessage`, sem redirect de `/login` para `/login`. [VERIFICADO na UI real] sem reload, e-mail mantido e a mensagem do servidor aparece ("Credenciais inválidas", "Conta bloqueada. Tente novamente em 29 minutos", "Rate limit exceeded…"). Sem teste automatizado de UI (não há infra no SA/Admin Web para isso). |
| baf04a3 / 9c67d53 | **Mobile e TV: falha de rede derrubava a sessão** — `loadSession` apagava os tokens em qualquer erro e o `tryRefresh` devolvia `null` em qualquer falha (rede, 5xx, 429): abrir o app sem sinal deslogava, e o painel de TV de parede que reinicia sem rede/API perdia o login (reconfigurar exige senha e TOTP no controle remoto). **TV: `app.json` sem `isTV`** — o plugin só liga o modo TV com `EXPO_TV` ou `isTV:true` (lido no código do plugin), então `expo run:android` gerava app de celular. **Painel da TV com `Promise.all`** — uma chamada falhando (módulo Pós-venda desligado → 403) congelava as três colunas. | Só 401/403 do servidor encerra a sessão; timeout de 15 s; `/auth/*` fora do renovar-e-repetir; `isTV:true`; `allSettled` por coluna. **[NÃO VALIDADO em aparelho — sem SDK/emulador]:** verificado apenas por `tsc`, leitura de código e `expo config` carregando com o parâmetro. |
| 4b2100e | Suíte de integração instável: `Too many database connections opened` (cada arquivo cria um `PrismaClient` e nunca o fechava; ~31 arquivos estouram `max_connections=100`). | `setupFilesAfterEnv` desconecta ao fim de cada arquivo. Integração 31/31 (726 testes), 0 erros de conexão. |

**Incidente de dados no banco de dev, causado por mim [VERIFICADO] — leia:**
1. O `afterAll` do primeiro rascunho de `sale-input-validation` fazia `stockMovement.deleteMany({ where: { productId: inactiveProductId } })` sob bypass de RLS. Quando o `beforeAll` falhou, a variável ficou `undefined` e **o Prisma ignora `undefined` no `where`** → **todas as movimentações de estoque de todas as empresas do banco de dev foram apagadas** (`stock_movements` = 0). Nada de produção; empresas afetadas: as de teste/demonstração de sessões anteriores ("Empresa A/B Ltda", "Smoke Inv Co", "RedTeam IDOR Co A/B", "Integration Test Co …"), que agora mostram saldo 0. **Não há backup a restaurar.** O teste foi corrigido (só apaga por `companyId`+marcador; o resto sai no `destroyWorld`) e os outros `deleteMany` que escrevi foram revisados.
2. Minhas contagens de "0 empresas / 0 linhas" desta rodada usaram `prismaUnsafeBypassRLS.$queryRawUnsafe` **sem `set_config`** — com `FORCE ROW LEVEL SECURITY` isso enxerga zero linhas. Uma versão anterior deste documento afirmava "nenhuma empresa sintética sobrou (0 em `companies`)": **era falso**. Lição: leitura de contagem só com o contexto de SUPER_ADMIN aplicado.
3. Existiam 12 empresas sintéticas `world-A/B` vazadas (teardown que falhava no meio); foram removidas com o mesmo `destroyFixture`. Ficam no banco, e **não são minhas para apagar**: "Empresa A Ltda", "Empresa B Ltda", "Smoke Inv Co" ×2, "RedTeam IDOR Co A/B", "Integration Test Co modsettingsA/B" (decidir o descarte — ver E5). A `Integration Test Co pdv-audit` (demo do PDV) é removida no fim da auditoria.
4. Os 2 usuários órfãos criados pelas sondas (bug do `POST /users`) foram removidos pelo id.

### F2. [DECISÃO NECESSÁRIA] — não assumido
- **Tabelas que seguem só com RLS por empresa** (verificado no mapa de policies): `customers`, `motorcycles`,
  `suppliers`, `categories`, `partners`, `installment_policies`, `discount_rules`, `commission_rules`,
  `transfers`, `invoices`, `tef_payments`. Presumo cadastro/configuração da empresa toda; confirmar caso a caso
  se alguma deve isolar por filial (documentos fiscais e TEF nascem de venda de uma filial).
- **BALCÃO e CAIXA não existem como papel** (`UserType`: SUPER_ADMIN, COMPANY_ADMIN, MANAGER, OPERATOR, MECHANIC,
  VIEWER). Hoje são todos OPERATOR. Criar papéis distintos ou é só um perfil (Role) sobre OPERATOR?
- **SUPER_ADMIN no Admin Web não tem seletor de empresa** (F1/6a68877): telas de dados de empresa devolvem 400
  `COMPANY_CONTEXT_REQUIRED` para o SA. A administração de plataforma vive no app Super Admin, que não chama
  rotas de empresa; se o SA deve "entrar" numa empresa, é feature nova (seletor + `X-Company-Id`).
- **Registros antigos de pós-venda com `branchId NULL`** (F1/8221692): manter "da empresa toda", ou o cliente
  atribui filial a mão? A TV/mobile filtram por igualdade e não mostram os NULL — decidir se devem mostrar
  "minha filial **ou** sem filial".
- **A credencial da TV é um login comum** [VERIFICADO no código pelo agente, não executado]: não existe papel/escopo
  de "display"; o token vale para tudo que o `userType` permite. Decidir papel dedicado (`DISPLAY`) + endpoint
  `/tv/panel` só-leitura com projeção mínima (hoje a lista devolve o cliente inteiro).
- **Janela de 15 min do access token de usuário desativado / empresa bloqueada** (E7): aceitar, ou adicionar
  checagem de revogação no `authMiddleware` (custo: 1 leitura Redis por requisição).
- **Sem regra de desconto cadastrada = desconto livre [VERIFICADO no código e na UI]:** `checkSaleDiscount` devolve
  `allowed: true` quando a empresa não tem `DiscountRule` (`discount.service.ts:47`) — um OPERATOR deu 50% sem
  autorização numa empresa sem regra. Com a regra criada, o fluxo de autorização funciona (auto-autorização
  bloqueada, senha errada recusada, gerente aprova). Decidir o padrão: livre, ou teto por papel obrigatório.
- **Dono do caixa [VERIFICADO no código]:** `createSale` só confere que o caixa é da empresa/filial e está aberto —
  não que pertence ao vendedor (há índice único de UM caixa aberto por usuário, o que sugere posse 1:1). Vender no
  caixa de outro operador (gerente ajudando) é permitido ou proibido? Não assumido.
- **Caixa "esperado" soma cartão/PIX [VERIFICADO no código, comentário explícito em `payment.service.ts`]:** todo
  pagamento (qualquer forma) vira movimento `SALE` e o fechamento compara a contagem do dinheiro físico com esse
  total — a diferença de fechamento incluirá sempre cartão/PIX. É decisão contábil (conciliar gaveta × total de
  vendas); confirmar antes de mudar.
- **Login: conta bloqueada revela que o e-mail existe [VERIFICADO na UI real]:** após 3 senhas erradas a resposta
  vira "Conta bloqueada. Tente novamente em N minutos" — só existe para contas reais (e-mail inexistente responde
  sempre "Credenciais inválidas"; `numericId` é sequencial). Enumeração de contas é um trade-off conhecido de
  lockout com mensagem; decidir entre mensagem uniforme (pior para o usuário legítimo) e manter. O limite por IP
  ("Rate limit exceeded. Please try again in 3600 seconds.", em inglês) bloqueou o IP inteiro por 1 h após 5 logins.
- **Super Admin com MFA não consegue entrar [VERIFICADO por leitura]:** `app/login/page.tsx` responde "MFA ainda não é
  suportado nesta tela de login" — habilitar MFA num SA o tranca fora do painel (e a API não impõe MFA ao SA).
  Suportar o desafio MFA no login do SA e decidir se é obrigatório para SUPER_ADMIN.
- **Mensagens de erro do servidor em inglês** ("Insufficient stock…", "Invalid authorizer credentials") aparecem
  como toast no PDV; só as de auth e as do cliente estão em português. Padronizar (i18n) ou traduzir no cliente.
- **Visual do PDV fora da paleta CÓRTEX** (fundo azul em gradiente, botões coloridos); o modal de pagamento fica com
  o título cortado em alturas pequenas (~780 px). Passada de responsividade/visual do PDV ainda não feita.

### F3. [RELATO] — pistas dos agentes, ainda NÃO reproduzidas por mim (não tratar como fato)
- **PDV (Electron) — ainda NÃO reproduzido** (o resto do relato foi verificado e corrigido, ver F1): logout forçado
  deixa `DeviceSession` ACTIVE; F4/F8 divergentes do README (na tela, F4 = Desconto, coerente com o pedido);
  PIX pendente exibido como finalizado; venda+pagamento sem atomicidade/chave de idempotência do lado do PDV
  (a rota `POST /sales` já usa o middleware `idempotency()`); arredondamento e parcelas; comprovante de sangria
  perdido; sem rate limit da senha do autorizador de desconto em `POST /sales`; o PDV nunca checa `userType`.
  **Verificado por leitura, não corrigido:** MFA não é suportado no PDV (`LoginPage` recusa "MFA ainda não
  suportada") — usuário com MFA habilitado não consegue usar o PDV. Fluxos ainda não exercitados na UI: devolução,
  retirada (sangria) com dupla autorização, cliente (F3), PIX/cartão/parcelas. **Impressão física não validada
  [BLOQUEIO EXTERNO: sem impressora térmica].**
- **Super Admin (Next) — ainda NÃO reproduzido** (o login/refresh foi verificado e corrigido, ver F1; o painel
  autenticado não foi percorrido porque não tenho a senha do SA de dev): sem UI de aprovar/rejeitar ativação; lista
  de usuários truncada em 20; `/health` 503 quebra a página; sem UI de editar/bloquear/excluir empresa (a API de
  bloqueio agora funciona, ver F1/da69930); `License.status` não imposto no login (só na solicitação de dispositivo);
  licença de 1 ano fixa; contagem de dispositivos inclui REVOKED [relato; o limite em `requestActivation`, que li,
  já conta só PENDING/ACTIVE/BLOCKED — a tela não foi conferida]; backup vaza erro cru e não tem `auditLog`; tokens em `localStorage`, guarda só no
  cliente, sem `error.tsx`/CSP; KPIs coloridos/gradiente; painel de login em azul (fora da paleta CÓRTEX).
- **Mobile/TV — ainda NÃO corrigido (lido no código, sem aparelho):** a Agenda do mobile chama `getAppointments`
  sem `from` (ordena por data ascendente sem paginação: depois de 50 agendamentos os próximos nunca aparecem) e a
  lista de OS traz as 50 mais novas de qualquer status sem paginação; confirmar/cancelar agendamento sem `catch`/
  aviso e sem diálogo de confirmação; TV sem tela de logout e sem manter a tela acesa (`expo-keep-awake`); TV lê as
  100 OS mais novas e filtra "em andamento" em memória; MFA só TOTP (sem backup code); `zustand` não declarado no
  `package.json` da TV (funciona por hoisting); `API_URL` padrão `http://` (release em Android 9+ tende a bloquear
  HTTP claro); botão de MFA sem "voltar"; lista de OS mostra o status cru (`EXECUCAO`).

### F4. [BLOQUEIO EXTERNO] / limites de validação desta rodada
- **Android/Android TV não foram validados visualmente:** não há Android SDK nem emulador nesta máquina. O que
  foi verificado é por código/API (contratos, RLS, escopo de filial). Foco por D-pad, teclado na TV, rolagem,
  launcher de TV e tela apagada **não** foram testados.
- **Fiscal:** nada foi simulado. Emissão/cancelamento dependem de provedor real (adapter devolve `PENDING`);
  regras de status emitível seguem em E1c/E1f.
- **PDV validado como usuário real só no renderer (navegador contra a API real) e no Electron real para o
  carregamento** (`smoke:electron`). Não foi exercitado o fluxo completo dentro da janela do Electron (impressão,
  leitor de código de barras, `safeStorage`).
- **Teste de integração intermitente [VERIFICADO]:** `concurrency.integration.test.ts` › "15 aberturas de OS
  simultâneas na mesma filial" exige ≥60% de sucesso (9 de 15) com retry/jitter na numeração e obteve 8 em 2 de 4
  execuções da rodada final (e passou nas demais, inclusive em todas as rodadas completas anteriores). Não há
  duplicata nem erro cru (as outras asserções passam) — é o limiar estatístico do teste sob contenção; não mexi em
  `service-order.service`. Avaliar se a política de retry (máx. 5 tentativas) é suficiente ou se o limiar deve cair.
- **Rate limiter de login** (5 tentativas/15 min por IP): 30+ logins de teste o dispararam e foi preciso apagar a
  chave `ratelimit_auth:::1` do Redis de dev. Em loja com vários PDVs atrás do mesmo IP o limite é apertado (E4).
- Isolamento por RLS foi comprovado **contra o Postgres real de desenvolvimento**; a role de conexão e o `FORCE
  ROW LEVEL SECURITY` de produção não foram medidos. Para medir: `DATABASE_URL=… npm run db:check-rls` (somente
  leitura) no ambiente de produção/staging depois de `prisma migrate deploy` (ver G4).

---

## G. Rodada de recuperação — regressão visual/rota, proteção do banco (2026-09-21, 2ª parte)

### G1. "Regressão visual" e `/pos` 404 — o que o Git prova [VERIFICADO]
- **Nenhum commit de design mudou.** Branch única `master` (119 commits lineares), `reflog` sem `reset`/`checkout`/
  `merge`/`rebase`, sem stash/remoto. Desde o último commit visual do Admin Web (94b5c55) o **único** arquivo alterado
  em `apps/admin-web` é `lib/api.ts` (interceptor de login). O trabalho CÓRTEX existe **só no Admin Web**
  (48149df temas/tokens, f01cafc, 588c580, 94b5c55); `pdv-desktop` e `super-admin` só têm o commit inicial nos
  arquivos visuais — **nunca foram redesenhados** (o "azul antigo" do PDV e o login do SA são o visual original
  deles). O título "LN System Cloud - Admin" existe desde o commit inicial.
- **Causa do que se viu:** para testar o PDV no navegador eu o servi na **porta 3002 (a do Admin Web)** — o CORS de dev
  só liberava 3000/3002 e o Vite do PDV (5173) seria bloqueado. Dois frontends dividiram a porta (IPv6 `::1` =
  Vite/PDV, `::` = Next/Admin): daí "LN System PDV" onde devia haver o Admin e `/pos` 404 (o Next não tem `/pos`;
  a rota `/pos` é do PDV). Erro de ambiente meu, não regressão de código.
- **Correção:** CORS de dev libera 5173 (`resolveDevCorsOrigins`, 9598240); PDV com porta própria (`dev:web`,
  `--strictPort`) e roteador por protocolo (agente "pdv"); mapa de portas e regra "uma porta por frontend" em
  `docs/identidade-e-ambiente.md` (agente "design"). Guardas de design automáticas: ver relatório dos agentes.
- **Decisão de marca pendente (dono):** há três nomes em uso — "LN System PDV", "LN System Cloud - Admin/Super Admin"
  e "CÓRTEX" (nome do design system). Não alterei nada; o documento de identidade lista o que cada app exibe hoje.

### G2. Proteção do banco de desenvolvimento contra teste destrutivo [CORRIGIDO/TESTADO]
- **Auditoria:** 54 operações destrutivas em 16 arquivos de teste/helper. **Alto risco (mesma classe do incidente):**
  `stock-adjustment-branch` (`deleteMany` por `productId` sem `companyId`), `rbac` (`deleteMany({ roleId })` apagaria todos
  os vínculos de perfil se `roleId` faltasse; `Role` já apaga em cascata) e os helpers `destroyFixture`/`destroyWorld`
  (dependiam de `companyId` nunca ser `undefined`). Os demais já eram escopados por `companyId`/`in`/`delete` por id.
- **Travas (fbc4669):** suíte de integração roda em banco **dedicado** `lnsystem_test` (derivado do `DATABASE_URL` ou
  `TEST_DATABASE_URL`) e **recusa iniciar** se o nome não contiver "test" ou for o do dev; Redis de teste separado
  (`REDIS_DB=1`); middleware `$use` no Prisma dos testes: `deleteMany`/`updateMany`/`delete`/`update` com `undefined`
  em qualquer profundidade do `where`, ou `deleteMany`/`updateMany` com `where` vazio, **lançam** (vale também para o
  cliente estendido que o código da aplicação usa); `destroyFixture`/`destroyWorld` só apagam empresa **sintética**
  ("Integration Test Co …") com id válido — empresa de demonstração ("CÓRTEX Demo …") e as antigas são protegidas.
  **Prova em banco real:** `destructive-guard.integration.test.ts` (9 casos; inclui o incidente original) + varredura
  estática (todo `deleteMany`/`updateMany` de teste exige `companyId`/`id`). Suíte inteira: 32/735 no banco novo, 0
  disparos indevidos do guard (nenhum código da aplicação passa `undefined` em `deleteMany`/`updateMany` nas rotas testadas).
- **Demo separado do teste (41260e2):** `npm run demo:seed` (idempotente) cria 3 empresas "CÓRTEX Demo …" (Alfa A1/A2,
  Beta B1/B2, Sandbox de Módulos) com usuários **dedicados** por papel e por filial e um SA de E2E com MFA; senha
  aleatória em `apps/api/.demo/` (gitignorada — nenhuma credencial versionada). `npm run demo:tools` (mint de sessão
  por app, TOTP, limpar rate limit, desbloquear): o login real tem rate limit de 5/15 min por IP, então E2E com 14+
  perfis **não** pode logar pela tela toda vez; o fluxo de login é testado pela tela com poucas tentativas.

### G3. Empresas antigas no banco de dev — classificação (NÃO apagadas; aguardam sua autorização)
| Empresa | Evidência | Classe | Recomendação |
| --- | --- | --- | --- |
| Empresa A Ltda / Empresa B Ltda | docs `1111…/2222…`, e-mails `@empresa-a.com`/`@empresa-b.com` (não `@test.local`), 3+1 usuários, 5 vendas, auditoria em 14/09 | **demonstração/possivelmente sua** | **manter**; tiveram o estoque zerado pelo incidente (`stock_movements`) |
| Smoke Inv Co ×2 | `SMK…`, `@test.local`, 0 usuários, 0 dados, sem auditoria | sintética | remover se autorizado |
| RedTeam IDOR Co A/B | `redteam-*-<timestamp>@test.local`, 1 usuário cada, sem auditoria | sintética | remover se autorizado |
| Integration Test Co modsettingsA/B | `@test.local`, teardown antigo, sem auditoria | sintética | remover se autorizado |

Critério proposto para remoção futura: e-mail da empresa **e** de todos os usuários em `@test.local`, nome de gerador
conhecido, sem `audit_logs`. Nada é removido sem sua autorização explícita.

### G4. Migrações/RLS em outros ambientes [VERIFICADO] — ver `docs/migracoes-e-rls.md`
Cadeia aplica do zero (`lnsystem_test`), `migrate deploy` idempotente, diff de schema dev×novo **vazio**, RLS idêntico
(60 policies/61 tabelas/7 funções), `FORCE RLS` em todas as tabelas e role sem SUPERUSER/BYPASSRLS.
`npm run db:check-rls` confere qualquer ambiente (somente leitura) e roda como teste (`rls-invariants…`, 09b0a7e).
**Ainda a fazer por você:** rodar `prisma migrate deploy` + `npm run db:check-rls` em staging/produção (não tenho acesso).

---

## H. Rodada de finalização — 2026-09-24/25

Contratos normativos em `docs/contracts/` (permissões, escopo tenant/filial, máquinas de estado, módulos/licença,
auditoria) e mapa em `docs/CODE_MAP.md`. Evidências em `docs/evidencias/2026-09-24/`.

### H1. [CORRIGIDO] — cada item com teste que falha no código antigo (Postgres/Redis reais)
| Commit | Achado |
| --- | --- |
| 4046de0 | Cache de módulos lido sob o RLS de quem chegou primeiro (override de outra filial sumia) + corrida leitura×invalidação. |
| d9bd838 | Numeração de venda/OS/compra/orçamento perdia registros sob concorrência (advisory lock por série). |
| 3845cc6 | COMPANY_ADMIN alterava permissões de **perfil de sistema** (compartilhado entre empresas). |
| 15d17ec | `branchId` de outra empresa aceito na criação de OS, compra, caixa, contas e usuário. |
| 2e22f03 | Limite de tentativas chaveado por IP (`user.id` inexistente no JWT): 3 cancelamentos de um operador bloqueavam a loja e o MFA de todos; sucessos consumiam tentativa. |
| 5d002c0 / 66787a1 | PDV: 2º operador da filial nunca abria caixa (`registerNumber` fixo); valores "R$ 10.00". |
| b55ec80 | Cancelar após devolução parcial repunha/estornava em dobro; devoluções seguidas estornavam mais que o pago. |
| a5fdc8c | Venda cancelada recebia pagamento concorrente e voltava a PAID. |
| fc73f45 | Duplo "Receber" transferência lançava dois TRANSFER_IN (e "Enviar" tinha o mesmo defeito). |
| ffaa3f2 | Transições simultâneas da OS baixavam peças duas vezes; OS cancelada recebia pagamento/comissão. |
| 82a11ad | Reforços de caixa simultâneos se sobrescreviam no `expectedAmount`. |
| 180aa9a | Emissões fiscais simultâneas da mesma venda geravam dois documentos. |
| a3ef667 | Aprovar ativação pendente reativava dispositivo REVOKED/BLOCKED (credencial nova). |
| 6035969 / 1028191 | Diálogo sem role/aria-modal/foco; menu não refletia módulo desligado; URL direta de módulo desligado quebrava. |
| 44e7e90 / 4cf2c9d / 41de896 / 85fe44d | Paleta oficial do quadro de marca, Montserrat, marca CÓRTEX, 404 própria, guardas de design automáticas. |
| d12cfa1 | VIEWER com perfil granular pagava/estornava; perfil atribuído a uma filial valia na empresa toda. |
| 1669ed2 / cfdfa62 | `audit_logs` apagável/alterável por qualquer papel da empresa — agora append-only (expurgo só pelo agendador, com flag). |
| 5ff86f8 / 97c8dc7 | Auditoria gravava `newValue` nulo; faltavam eventos (estorno/cancelamento de pagamento, pagamento de OS, importação, backup, login via MFA, falha de login). |
| 517cd8a / 736144c | Regras definidas: rateio do desconto na devolução; OS só é paga em PRONTO/ENTREGA. |
| 7ded46a | COMPANY_ADMIN sem perfil não pagava OS, não recebia conta nem ajustava estoque — perfil padrão enumerado (menor privilégio). |
| 42c4a5d | Jornada PDV: outro OPERATOR fechava o caixa do colega (HTTP 200); comprovante da retirada sumia e o formulário reabria vazio. |
| 752f5a3 | Jornada PDV: access token seguia válido 15 min após o logout; dois logins no mesmo segundo geravam o mesmo token. |

### H2. [DECISÃO NECESSÁRIA] (novas nesta rodada)
- ~~Rateio de desconto na devolução~~ — **definido** (2026-09-25): rateio proporcional ao valor líquido pago, ver business-state-machines.md "Devolução".
- ~~Em que status a OS pode ser paga~~ — **definido** (2026-09-25): PRONTO e ENTREGA, ver business-state-machines.md "OS — pagamento".
- **DRAFT fiscal abandonado:** um rascunho com mais de 10 min deixa de bloquear nova emissão da venda; não há rotina que o
  marque como abandonado.
- ~~Perfis padrão~~ — **definido** (2026-09-25): COMPANY_ADMIN com lista administrativa enumerada; demais papéis só por
  perfil granular (permission-matrix.md, "Camadas de imposição").

### H3. [RELATO] — levantado pelos agentes de contrato, ainda não reproduzido
- ~~VIEWER/escopo de filial do perfil; auditoria nula/ausente; audit_logs apagável~~ — reproduzidos e corrigidos (H1).
- Auditoria: `oldValue` não é capturado genericamente (exige leitura prévia por entidade) — [DECISÃO NECESSÁRIA] em
  `docs/contracts/audit-event-matrix.md`.
- Mensagens de erro de negócio em inglês chegam ao operador ("Insufficient stock…", "Nothing left to return on this
  sale", "Sale is already fully paid…") — [VERIFICADO] na jornada do PDV; tradução na origem pendente (vários testes
  conferem o texto).
- Módulos: escritas cruzadas ignoram o módulo (venda/OS/compra gravam estoque com ESTOQUE desligado); licença suspensa/
  vencida não bloqueia login; `maxUsers` não imposto — `docs/contracts/module-license-matrix.md`.
- Precedência header×query do contexto do SUPER_ADMIN diverge entre `middleware/tenant.ts` e `utils/tenant-scope.ts`.
- ~~`middlewares/mfaCheck.ts` e `middlewares/dataProtection.ts` nunca importados~~ — removidos (código morto).

### H5. Portão da Fase 1 (2026-09-25) [VERIFICADO]
API unit 763/763 · integração 801/801 (Postgres/Redis reais) · Admin Web 409/409 · tsc de admin-web, super-admin,
pdv-desktop, mobile, tv · jornadas reais PDV, Balcão/Oficina e Mecânico (docs/evidencias/2026-09-25) · git limpo.
Achados das jornadas corrigidos: caixa de outro operador (42c4a5d), comprovante da sangria (42c4a5d), token após logout
(752f5a3), moto pelo balcão (b0240fd), moeda "R$ 50.00" (70e5308), URL direta de tela proibida (ae5de66), limite geral
por IP (0a9da5f), rolagem a 390 px e KPIs coloridos (aad2f12).

### H4. [LIMITAÇÃO]
- Sem Android SDK/emulador: Mobile/TV validados só por tsc/leitura. Sem impressora térmica, SEFAZ/certificado nem
  gateway TEF/PIX. O arquivo Figma não está referenciado no repositório (referência visual = quadro de marca enviado).
- GateGuard: exceção por `GATEGUARD_EXEMPT_GLOBS` exigiria reiniciar a sessão; mantido sem exceção (fatos declarados
  antes de cada arquivo novo).
