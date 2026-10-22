# Segurança

## Autenticação e sessão

- Login por e-mail e senha (**Argon2id**; hashes bcrypt antigos continuam aceitos e são migrados sozinhos no login válido — [decisão 121](DECISIONS.md)). Access token JWT de **15 min** (`JWT_EXPIRES_IN`), refresh de **7 dias**
  (`JWT_REFRESH_EXPIRES_IN`) com **rotação**: refresh reapresentado depois de trocado = possível roubo → todas as sessões
  do usuário são revogadas.
- Bloqueio de conta após **3** senhas erradas por **30 min** (`MAX_LOGIN_ATTEMPTS`, `LOCKOUT_TIME_MINUTES`); limite de
  tentativas por IP/usuário (abaixo).
- **Revogação imediata do access token** (Redis + PostgreSQL): logout, troca de senha, mudança de perfil, desativação do
  usuário e da empresa derrubam o token na hora. Cada revogação é gravada também em `access_revocations` (PostgreSQL). Com o
  Redis fora a checagem consulta o PostgreSQL (**não** aceita o token por falta de resposta); com os dois fora a API responde
  **503 `AUTH_UNAVAILABLE`** — nunca aceita, nunca 401. Detalhe e evidência: [decisão 107](DECISIONS.md) e a seção abaixo.
- Empresa desativada não entra nem renova sessão. Frontends: `/auth/*` fora do "renova e repete"; renovação single-flight.

## MFA

- **TOTP** (aplicativo autenticador) + **códigos de backup**. O segredo é gravado **cifrado** (`enc:v1`) e aberto só na
  hora de conferir o código.
- Desafio MFA no login do Admin Web, do Super Admin, do mobile, da TV **e do PDV**. O PDV recebe `mfaRequired` + `mfaToken`,
  descarta a senha da memória e valida o código (`LoginPage.tsx`, `POST /api/auth/verify-mfa`); ver
  [SEGURANCA-PDV](policies/SEGURANCA-PDV.md). *(Corrigido em 2026-10-05: este documento dizia que o PDV não suportava MFA; a decisão de
  2026-09-27 e o código dizem o contrário.)*
- **SMS e e-mail não existem em produção**: sem provedor, a rota responde 503 e orienta usar o autenticador (em
  desenvolvimento devolvem o código para testar o fluxo). Nada finge envio.
- Configurar/desligar MFA é auditado (sem o segredo, o QR ou os códigos no registro).

## Conta Super Admin de TI, MFA obrigatório e auditoria de permissões (2026-10-14)

- **Criação controlada, nunca por senha padrão.** A conta do Super Admin de TI nasce só por procedimento administrativo no
  servidor (`npm run admin:bootstrap`, [PRODUCAO §13](PRODUCAO.md#13-primeiro-super-admin-bootstrap-e-mfa)): simulação por
  padrão, `--apply` explícito, senha só por `BOOTSTRAP_SA_PASSWORD` ou prompt oculto (nunca argumento, nunca log, nunca
  migration), política de senha (12+ caracteres, 3 tipos, sem nome/e-mail, sem lista comum), em produção só com
  `ALLOW_SUPER_ADMIN_BOOTSTRAP=true`. **Idempotente**; **nunca promove outra conta** (e-mail de outro perfil é recusado);
  identificador de login (até 6 dígitos) só é usado se estiver livre — nunca troca por conta própria. A senha é gravada
  só como hash (**Argon2id**, decisão 121 — adotado em 2026-10-14; a versão anterior deste texto, "bcrypt custo 12, Argon2id não
  adotado", descrevia o estado de 2026-10-14 de manhã).
- **MFA obrigatório para Super Admin:** com `REQUIRE_MFA_PRIVILEGED` ligado (padrão em produção), o Super Admin sem MFA
  recebe **403 `MFA_ENROLLMENT_REQUIRED`** — só **depois** da senha correta (quem não sabe a senha continua vendo 401). O
  enrolamento é administrativo (`enroll-mfa`): segredo TOTP cifrado em repouso, só liga com um código válido, mostra o
  segredo e os códigos de backup **uma vez**. COMPANY_ADMIN passou a ser **obrigado** pela decisão 123 (`REQUIRE_MFA_COMPANY_ADMIN`,
  configuração pela tela; ver a seção seguinte) — a frase anterior, "COMPANY_ADMIN não é obrigado", valia até 2026-10-14 de manhã.
- **Auditoria de permissões:** atribuir/revogar perfil de usuário e conceder/revogar permissão de perfil gravam
  `PERMISSION_CHANGED` com autor, alvo, momento, empresa/filial e o que mudou (sem segredo). A recusa ao usuário sem
  permissão é **403** no servidor (a tela só traduz: "Usuário sem autorização. Entre em contato com o administrador.").
- **Limites honestos:** a conta **só existe depois do `--apply` verificado**; esta documentação não afirma que ela foi
  criada. Recuperação de acesso (esquecimento de senha/perda do autenticador do Super Admin) é procedimento de TI com
  acesso ao servidor — não há "esqueci a senha" por e-mail para conta privilegiada (sem provedor de e-mail).

## Sessão sem Redis, senha, MFA de administradores, privacidade e imagens (2026-10-14, decisões 107 e 120–123)

- **Dependência do Redis (decisão 107).** O que usa o Redis: cache (degrada para "sem cache"), limitadores de tentativa (contam em memória por instância se ele cair), revogação de access token, código de MFA por SMS/e-mail (não existem em produção) e filas (BullMQ, conexão própria). Só a **revogação** é decisão de segurança: Redis fora → PostgreSQL; os dois fora → 503; Redis de volta → as revogações vigentes são regravadas nele **antes** de ele voltar a ser a fonte. Distinção mantida: assinatura/expiração inválida = **401**; indisponibilidade = **503** (o aplicativo não desloga); falta de permissão = **403**. Teste: `session-revocation-redis-outage` (10/10, queda simulada nos comandos do cliente) **e ensaio ao vivo com o Redis real derrubado em desenvolvimento (2026-10-14)**: revogado seguiu 401, válido 200, revogação durante a queda valeu, login funcionou, e ao religar as chaves foram ressincronizadas; falta o ensaio com várias instâncias em staging.
- **Hash de senha (decisão 121).** Argon2id (19 MiB, t=2, p=1; `ARGON2_*`); bcrypt legado aceito e migrado no login válido (troca "compare-and-set"); sem redefinição geral, sem derrubar sessão; todo login paga o custo dos dois algoritmos (o tempo não revela e-mail nem conta migrada); reversão `PASSWORD_HASH_ALGORITHM=bcrypt`; senha e hash nunca em log.
- **MFA do administrador da empresa (decisão 123).** `REQUIRE_MFA_COMPANY_ADMIN` (padrão ligado em produção; a API não sobe em produção com `false`). Primeiro login sem MFA → 403 `MFA_ENROLLMENT_REQUIRED` + credencial de configuração de 10 min; configuração na tela (QR gerado no navegador), só código válido ativa, códigos de recuperação mostrados uma vez. Código TOTP **não vale duas vezes** (login e configuração); erro de código conta como tentativa e bloqueia (3 em 30 min, sem zerar ao reentrar com a senha); o perfil obrigado não desliga o próprio MFA; mudar de perfil **revoga as sessões** e a exigência vale pelo perfil atual (login e renovação); ninguém muda o próprio perfil. Recuperação: código de recuperação; novos códigos (senha + código); reinicialização pelo Super Admin (senha própria + motivo, auditada, derruba as sessões); Super Admin: `admin:bootstrap reset-mfa`. Risco aceito: senha roubada antes da primeira configuração permite configurar o próprio autenticador — configurar logo após criar a conta.
- **Pedidos de titular (decisão 120).** `/api/privacy` só para o COMPANY_ADMIN da empresa, com a própria senha, justificativa e no máximo 20 pedidos por hora; titular por `id`+`companyId` (outra empresa = 404). Exportação cifrada no registro do pedido (24 h, 3 downloads, apagada por rotina); anonimização irreversível numa transação, com retenção fiscal/garantia (PARCIAL) e bloqueio por cobrança em aberto; o registro do pedido nunca guarda o dado original. Trilha de auditoria, backups e evidência append-only de cobrança não são reescritos. Detalhe: [privacidade](../privacidade/TITULARES_E_INCIDENTES.md).
- **Imagem do produto (decisão 122).** Validada e saneada pelo **conteúdo** (PNG/JPEG/WebP; sem EXIF/GPS, sem bytes depois do fim, sem animação, 1 MB, 4096×4096), guardada sob RLS, entregue inerte (`nosniff`, CSP `sandbox`), escrita só Gerência+.

## Segundo fator de uso único, medição do Argon2id e riscos de banco (rodada final, 2026-10-14)

**Código MFA vale uma vez em TODO caminho (risco "dupla autorização aceita o mesmo código na janela de 30 s" — fechado).** O consumo mora num ponto só, [`services/mfa-consume.ts`](../../apps/api/src/services/mfa-consume.ts), e a garantia vem do banco/Redis, não de "ler e depois gravar" na aplicação (que duas requisições ou duas instâncias vencem juntas):

| Caminho | Como o uso único é garantido |
|---|---|
| TOTP (login, ativação, **dupla autorização** de retirada/cancelamento/desconto/agenda, novos códigos) | `UPDATE users SET mfaLastStep = <passo> WHERE id = … AND (mfaLastStep IS NULL OR mfaLastStep < <passo>)`: só UMA requisição afeta a linha; as outras recebem "já utilizado" |
| Código de recuperação (login, `/mfa/verify-backup`, **dupla autorização**) | compare-and-swap da lista inteira (`mfaBackupCodes = <lista lida>`); quem perde a corrida relê e, se o código já saiu da lista, é recusado (até 3 tentativas) |
| Código SMS/e-mail (Redis; não existem em produção) | script Lua atômico "se o valor confere, apaga" — código errado **não** queima o válido |

Prova (`dual-authorization-mfa-once`, Postgres e Redis reais, 7/7): 8 autorizações simultâneas com o mesmo TOTP → **1**; 3 retiradas de caixa simultâneas com o mesmo código → **1** movimentação; 6 usos simultâneos do mesmo código de recuperação → **1** e ele sai da lista; 3 códigos de recuperação diferentes ao mesmo tempo → os 3 passam; 5 verificações simultâneas do código do Redis → **1**. O erro de reuso na dupla autorização é "Código do autorizador já utilizado. Aguarde o próximo código do aplicativo." Limite: o passo seguinte (30 s depois) continua valendo; duas operações do mesmo autorizador em menos de 30 s exigem dois códigos distintos.

**Argon2id — parâmetros e medição (decisão 121).** Parâmetros em uso: m = 19 456 KiB (19 MiB), t = 2, p = 1 — o mínimo recomendado pela OWASP (`ARGON2_MEMORY_KIB`/`ARGON2_TIME_COST`/`ARGON2_PARALLELISM`). `npm run password:bench` (20 amostras sequenciais por perfil e um único pico com 3 verificações simultâneas; sem carga) nesta máquina de trabalho (Intel Core Ultra 7 165U, 14 núcleos lógicos, 15,5 GB, Windows 11, Node 22.14) deu:

| Perfil | Verificar (mediana / p95) | Gerar (mediana / p95) | Pico de memória (3 simultâneas) |
|---|---|---|---|
| Argon2id 19 MiB, t=2, p=1 (**em uso**) | 25,6 ms / 31,3 ms | 28,2 ms / 32,1 ms | +38 MB |
| Argon2id 46 MiB, t=1, p=1 (alternativa OWASP) | 48,0 ms / 66,0 ms | 41,0 ms / 70,4 ms | +92 MB |
| bcrypt, custo 12 (anterior) | 257,4 ms / 303,3 ms | 274,3 ms / 310,0 ms | não mede (memória pequena) |

Avaliação (**inferência técnica**, não medida no destino): os parâmetros em uso cumprem o mínimo recomendado e são ~10× mais rápidos que o bcrypt anterior neste hardware, com memória por login modesta — a defesa contra GPU/ASIC é maior que a do bcrypt porque o custo é de memória. Nesta máquina a verificação (26 ms) está **abaixo** da faixa usual de 50–100 ms; havendo folga no servidor, subir `ARGON2_TIME_COST`/`ARGON2_MEMORY_KIB` aumenta a margem sem trocar nada no código (hashes antigos migram sozinhos no login: `passwordNeedsRehash`). **Pendente (infraestrutura):** repetir `npm run password:bench` no servidor-alvo/contêiner Linux (a máquina de trabalho não representa o destino) e dimensionar memória pela concorrência de login (cada verificação em andamento usa `ARGON2_MEMORY_KIB`). O pico de uma verificação isolada aparece como 0 MB (abaixo da resolução da amostragem); só a medição com 3 simultâneas é significativa. Sem redefinição geral de senhas.

**Riscos de banco registrados em 2026-10-14 — todos tratados em 2026-10-15** (detalhe na seção "Revisão do banco" logo abaixo e em [REVISAO_BANCO_PENDENCIAS](REVISAO_BANCO_PENDENCIAS.md)): `refresh_tokens.token` em texto → guardado como SHA-256 (decisão 128); imutabilidade de livros e históricos só na aplicação → append-only por RLS em `stock_movements`, `cash_movements`, `policy_changes` e `service_order_status_history` (decisão 130; permanecem atualizáveis, por regra de negócio, `sale_items.returnedQuantity` e `revisions.notes`).

## Revisão do banco: RLS, chaves estrangeiras, histórico e papéis (2026-10-14/15, correção completa)

Detalhe, evidência e testes em [REVISAO_BANCO_PENDENCIAS](REVISAO_BANCO_PENDENCIAS.md); decisões 124–142 em [DECISIONS](DECISIONS.md); execução e falhas em [RELATORIO_EXECUCAO_REVISAO_BANCO](RELATORIO_EXECUCAO_REVISAO_BANCO.md).

- **A RLS da linha filha não protege a referência ao pai — corrigido em todo o banco.** A checagem de FK do PostgreSQL não passa pela RLS; a policy da filha só olha o `companyId` da **própria** linha. Reproduzido: uma sessão da empresa A gravava `product_barcodes`/`product_images` apontando para produto da empresa B. Agora **94 relações** têm FK composta `(companyId, X) → pai(companyId, id)`, **55 tabelas** têm FK composta de filial, **65** têm FK `companyId → companies` e **3** referências que não admitem FK composta têm trigger de mesma empresa (decisões 124, 129, 136). Referência cruzada entre empresas é recusada pelo banco (`P2003`).
- **Migration que adiciona FK sobre tabela `FORCE RLS` valida em branco.** Executada pelo dono sem contexto de empresa, a validação enxerga zero linhas e a FK é criada mesmo com dado violando (provado em experimento revertido). **Regra (decisão 127):** toda migration desse tipo traz uma **guarda** que lê com `set_config('app.user_type','SUPER_ADMIN',true)` e aborta; o dado legado nunca é "adivinhado" (linhas de empresa inexistente ficam com a FK `NOT VALID`). Provado em três bancos temporários com dado inconsistente.
- **Sessões (`refresh_tokens`) — corrigido (decisão 128).** `companyId` preenchido (só pelo usuário), policy sem o ramo `IS NULL`, e o refresh token guardado como **SHA-256** (`tokenHash`): um vazamento da tabela ou do backup não entrega sessão utilizável. O mesmo cálculo em SQL e na aplicação preservou as sessões existentes.
- **Logs e perfis/permissões globais** — corrigido (decisão 125, teste `rls-logs-roles-tighten`).
- **Livros imutáveis no banco (decisão 130).** `stock_movements`, `cash_movements`, `policy_changes`, `service_order_status_history` (e já `audit_logs`, `collection_attempts`, `discount_events`): UPDATE negado; DELETE só de Super Admin com `app.audit_purge = on` na mesma transação. Exceções por regra de negócio: `sale_items.returnedQuantity` e `revisions.notes` (anonimização LGPD).
- **Histórico não some em cascata (decisão 131).** `ON DELETE RESTRICT` em venda→pagamentos/itens, produto→livro, caixa→movimentos, OS→itens/histórico, orçamento, empresa→auditoria/licenças/LGPD/usuários/filiais. A API devolve **409** (`BRANCH_IN_USE`, `RECORD_IN_USE`) em vez de erro interno (decisão 137).
- **Papel da aplicação = dono das tabelas (decisão 132) — solução pronta, adoção pendente de infraestrutura.** `FORCE RLS` vale para o dono, mas quem executa SQL arbitrário com esse papel pode desligar a RLS. O modelo de **dois papéis** (dono só migra; execução só DML) está em `deploy/db-runtime-role.sql` e foi **provado** (`npm run db:role-split-check -- --suites`: DDL negado, RLS intacta, a suíte de integração completa (116 / 1614) passa como o papel sem posse). **Limite honesto:** o papel de execução ainda escolhe o contexto da RLS (`set_config('app.user_type', …)`) — fechar isso exigiria mover a decisão de contexto para fora da aplicação (mudança de arquitetura não feita).
- **`Idempotency-Key` expira de verdade (decisão 139).** Antes a mesma chave devolvia a resposta antiga para sempre; agora vale 24 h e o job expurga as vencidas.
- **Concorrência com FK composta (decisão 138).** Travar o pai **antes** de inserir o filho (o `INSERT` toma `FOR KEY SHARE`); ver `lockForPayment`.
- **Schema × banco.** `prisma migrate diff` está **vazio**; o SQL "SET/DROP DEFAULT, DROP SEQUENCE, DROP INDEX" visto na revisão externa era a saída desse diff com o schema antigo, **nunca uma migration** (decisão 126). Use só `prisma migrate deploy`; nunca `db push`/`migrate dev` contra banco compartilhado.

## Escopo por filial, travas de privilégio e papéis do banco (2026-10-16, finalização de produção)

Detalhe e matriz por perfil em [tenant-branch-scope §9](contracts/tenant-branch-scope.md) e [permission-matrix](contracts/permission-matrix.md); decisões 143–150 em [DECISIONS](DECISIONS.md); evidência em [RELATORIO_FINALIZACAO_PRODUCAO](RELATORIO_FINALIZACAO_PRODUCAO.md).

- **Regra de negócio:** COMPANY_ADMIN vê todas as filiais **da própria empresa** e o dashboard consolidado; o gerente (e os demais papéis de filial) vê **exclusivamente a filial a que está vinculado**; nenhum alcança outra empresa; módulo desativado (recebíveis, OS) continua negado **no backend**.
- **O que vazava (provado antes de corrigir; 16 de 28 testes falhavam contra a RLS antiga):** o gerente da filial A listava e-mail/telefone/MFA de **todos** os usuários da empresa, os equipamentos e a auditoria de todas as filiais, convênios e transferências de outras filiais, encerrava a sessão de equipamento alheio e — por SQL direto — mudava o próprio `userType` para COMPANY_ADMIN, concedia perfil a si, **ligava um módulo desativado** e criava/apagava filiais.
- **Correção em camadas:** rotas (`scopedBranchId` nos dashboards: 403 `BRANCH_FORBIDDEN` ao pedir outra filial, 404 `BRANCH_NOT_FOUND` para filial de outra empresa; convênios e equipamentos validam a filial), RLS (migração `20261016100000`: leitura regra **F**, escrita `rls_company_branch_write`) e travas (migração `20261016110000`: trigger `users_guard_privileged_columns`, escrita empresarial em perfis/permissões/módulos/filiais).
- **Compose sem superusuário na API (decisão 148).** Na imagem oficial do PostgreSQL o `POSTGRES_USER` é superusuário; uma API conectada assim **ignora a RLS inteira**. O compose agora cria dono, execução e backup como papéis sem superusuário (`deploy/postgres-init/10-roles.sh`, `after-migrate.sql`) e a API usa só o de execução. Reproduzido fora do Docker: o papel da API não consegue desligar a RLS, `TRUNCATE`, criar tabela nem ler `_prisma_migrations`.
- **Limite honesto (não resolvido):** a RLS defende contra **erro de filtro, IDOR e consulta feita no contexto do usuário** (o que os testes exercitam). Quem consegue executar SQL **arbitrário** na conexão da aplicação ainda pode chamar `set_config('app.user_type', …)` — o contexto é definido pela própria aplicação. Fechar isso exige mover a decisão de contexto para fora da aplicação (mudança de arquitetura não feita; já registrado na decisão 132). A primeira linha de defesa continua sendo não ter injeção de SQL.
- **Backup:** papel dedicado só leitura com BYPASSRLS; arquivo cifrado (AES-256, chave separada da `DATA_ENCRYPTION_KEY`); o script recusa rodar com papel sem BYPASSRLS. Risco registrado: a API recebe `BACKUP_DATABASE_URL` para o backup manual do Super Admin ([BACKUP_RECUPERACAO §10](BACKUP_RECUPERACAO.md)).

## Contexto de RLS assinado, credencial de backup isolada e vários filiais (2026-10-15, decisões 151–153)

- **Risco tratado:** SQL arbitrário na conexão da API podia escolher o contexto da RLS (`set_config('app.user_type','SUPER_ADMIN',…)`). Variável de sessão ou `SET LOCAL` **sozinhas não impedem** isso. A aplicação agora **assina** o contexto (HMAC-SHA256: empresa, filial ativa, filiais autorizadas, papel, usuário, instante) e o **banco confere** antes de aceitá-lo; sem assinatura válida a RLS nega tudo. Detalhe, garantias, **limites e risco residual**: [RLS_CONTEXTO_ASSINADO](RLS_CONTEXTO_ASSINADO.md).
- **Risco residual (resumo):** quem executa código no processo da API tem o segredo; SQL injetado numa requisição reaproveita a própria assinatura por até 120 s (mesmo contexto, nunca outro); superusuário e dono das tabelas ignoram a RLS (por isso a guarda de partida e o compose com papéis separados); relógio banco×API ±120 s; o segredo é ponto único (rotação em dois slots). **Não é uma barreira inviolável.**
- **A API em produção recusa subir** como superusuário/BYPASSRLS/dono das tabelas, com banco que não exige assinatura, com segredo que o banco rejeita, ou com credencial de backup no ambiente (`BACKUP_DATABASE_URL`/`BACKUP_MODE=local`).
- **Credencial de backup fora da API (decisão 152):** o papel com `BYPASSRLS` existe só no serviço `backup`; a API pede o backup (202), lista manifestos em somente leitura e **não restaura nem apaga** backup (403). O cofre do segredo de RLS **não vai no dump**.
- **Vários filiais por gerente (decisão 153):** o conjunto de filiais é dado do banco (`user_branches`), recalculado a cada requisição; claims, cabeçalhos e parâmetros não ampliam acesso; filial da mesma empresa sem acesso = 403 `BRANCH_FORBIDDEN`, outra empresa = 404; a RLS usa o conjunto assinado.
- **Cópia restaurada** pode ser **anonimizada** (decisão 155) antes de sair do ambiente seguro; o script recusa banco que possa ser o de produção.
- **Segredos:** nenhum valor foi escrito em arquivo, log, relatório ou artefato; `.env.example` traz só nomes e instruções.

## Senha temporária, troca de senha e limite de usuários (2026-10-18, decisões 157–158)

- **Senha temporária.** Usuário criado ou redefinido por administrador nasce com `mustChangePassword=true` (padrão; `requirePasswordChange:false` desliga). No login, com a senha certa, **nenhuma sessão é emitida**: a API devolve 403 `PASSWORD_CHANGE_REQUIRED` + uma **credencial de troca** (JWT de 10 min, claim própria `passwordChange`, **sem `userType`**, recusada por `authMiddleware` e por toda rota que não seja a troca; as credenciais de MFA e de enrolamento também não a substituem). Com MFA ativo o **segundo fator vem antes** da troca.
- **Rotas:** `POST /auth/password-change/complete` (pública, exige a credencial + senha atual + nova) e `POST /auth/change-password` (sessão + senha atual + nova). Senha atual errada **conta como tentativa de login** (bloqueio de 3 tentativas/30 min); sucesso zera as tentativas, **revoga refresh tokens e access tokens** (Redis + PostgreSQL) e é auditado sem a senha (`PASSWORD_CHANGED`/`PASSWORD_CHANGE_FAILED`).
- **Política da senha escolhida:** 10–128 caracteres, letra e número, diferente da atual, sem a parte local do e-mail, fora de lista curta de senhas comuns; **SUPER_ADMIN e COMPANY_ADMIN: 12+ caracteres e 3 tipos** (mesma régua da criação do Super Admin). Não há medidor de força nem promessa além disso.
- **Trava no banco:** o gatilho `users_guard_privileged_columns` agora também recusa a papel de filial a alteração de `password`, `mustChangePassword` e `passwordChangedAt` (nem por SQL direto).
- **Clientes sem tela de troca** (PDV, Balcão, app do mecânico, painel de TV) mostram a mensagem da API ("troque a senha no Admin Web"); não há como contornar por eles.
- **Limite de usuários da licença:** `maxUsers` é aplicado na criação e na reativação (409 `USER_LIMIT_REACHED`). Resíduo: duas criações simultâneas exatamente no limite podem admitir um usuário a mais (limite de plano, não de segurança).
- **Resíduo conhecido (granularidade de segundo):** a revogação de access token compara `iat` (em segundos) com o instante da revogação (`iat <= revokedAt`). Um token emitido **no mesmo segundo** da troca de senha é recusado (401); quem troca a senha e entra de novo leva mais que isso, mas automação muito rápida pode esbarrar — basta entrar de novo. Não foi afrouxado: aceitar o mesmo segundo reabriria uma janela em que token emitido **antes** da troca continuaria valendo.
- **Fora do escopo (decisão do proprietário):** recuperação de senha por e-mail (não há provedor de e-mail); a redefinição é do administrador.

## Isolamento e permissões

- RLS `FORCE` em todas as tabelas de empresa; contexto por requisição e por job. Matriz por tabela e casos de
  SUPER_ADMIN, usuário sem filial e ids forjados: [contracts/tenant-branch-scope](contracts/tenant-branch-scope.md).
- Papéis (SUPER_ADMIN, COMPANY_ADMIN, MANAGER, OPERATOR, MECHANIC, VIEWER) + perfis granulares por filial:
  [contracts/permission-matrix](contracts/permission-matrix.md). Usuários da plataforma (sem empresa) não aparecem para
  empresas (policy de `users` corrigida em 2026-09-26).
- Cache Redis não passa por RLS: toda chave de dado de empresa inclui empresa + escopo de visibilidade.
- **Chamados de suporte** ([SUPPORT](SUPPORT.md)): tabelas com RLS FORCE; mensagens e eventos append-only; `companyId`,
  `branchId` e `userId` só da autenticação (schema `.strict()`); entidade de contexto resolvida dentro do escopo do
  usuário; leitura do SUPER_ADMIN sobre chamado de empresa é explícita e auditada (`LEITURA_PELA_PLATAFORMA`); anexo
  validado por bytes, sem executável/HTML, entregue só a quem pode ver o chamado, como `attachment` com `nosniff` e
  `no-store`; número de cartão completo recusado no texto (e nunca registrado em log).

## Segredos

### `DATA_ENCRYPTION_KEY` — obrigatória

- Chave de 32 bytes em base64 que cifra os segredos em repouso (AES-256-GCM, formato versionado
  `enc:v1:<iv>:<tag>:<cifra>`). Gerar: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
  (ou `openssl rand -base64 32`).
- **A API não sobe sem ela** (ou com tamanho errado) — falha na partida, antes de atender.
- **Nunca** no repositório, em imagem, em log ou em mensagem de erro. Fica no `.env` de cada ambiente (gitignorado) ou no
  cofre de segredos da hospedagem. Na CI é gerada a cada execução. O `.env.example` traz só o nome.
- **Guardar junto do backup, em local separado.** Backup sem a chave = segredos irrecuperáveis (MFA precisa ser
  reconfigurado; senha do certificado e CSC digitados de novo). A conferência de restauração (`npm run backup:verify`)
  prova que os segredos abrem com a chave e **não** abrem com outra.
- Rotação de chave **não está implementada** (exigiria decifrar com a antiga e cifrar com a nova) — [ROADMAP](ROADMAP.md).

### O que é cifrado

| Dado | Onde | Como |
|---|---|---|
| Segredo TOTP | `users.mfaSecret` | `enc:v1` na configuração |
| Senha do certificado fiscal, CSC | `fiscal_configs.certificatePassword`, `cscToken` | `enc:v1` ao salvar; nunca devolvidos na leitura |
| Senhas de usuário | `users.password` | hash bcrypt |
| Credenciais de pagamento (TEF/PSP) | — | não ficam no banco: `payment_settings` guarda só o nome do provedor e o terminal |

Segredo antigo em texto puro: `npm run secrets:encrypt` (idempotente, seguro com a API no ar; `-- --check` só conta).
Provado em `secret-migration.integration.test.ts`. Conferido em 2026-09-27: 0 segredos em texto puro nos bancos de
desenvolvimento e de teste.

### Outras variáveis sensíveis

`JWT_SECRET`, `JWT_REFRESH_SECRET` (a API recusa valor ausente, de exemplo ou curto), `DATABASE_URL`,
`BACKUP_DATABASE_URL` (role de backup, BYPASSRLS), `RESTORE_ADMIN_URL` (DBA, só para a conferência de restauração),
`REDIS_PASSWORD`. Frontends só recebem a URL da API (`NEXT_PUBLIC_API_URL`, `VITE_API_URL`, `EXPO_PUBLIC_API_URL`).

## Auditoria e logs

- `audit_logs` **append-only** no Postgres (sem UPDATE; DELETE só pela rotina de retenção com flag). Campos sensíveis
  (senha, segredo, token, credencial, cookie, códigos de MFA, chaves) viram `[REDACTED]` antes de gravar e antes da fila.
  Eventos: [contracts/audit-event-matrix](contracts/audit-event-matrix.md).
- Log de requisições: rota, status, latência, empresa/filial — **nunca** corpo nem cabeçalhos.
- Erro interno que uma rota devolveria cru (texto do Prisma com caminho de arquivo, código e argumentos) é trocado por
  mensagem genérica na resposta; o detalhe vai ao log com o id da requisição e com os valores sensíveis mascarados.
- Pilha de erro só em `NODE_ENV=development`.

## Dashboards de gestão (2026-10-05)

`/api/dashboard/management/*`, `/sales`, `/stock` (valor de estoque a custo) e `/ceo` são de **SUPER_ADMIN (numa empresa), COMPANY_ADMIN e MANAGER**; OPERATOR, VIEWER e MECHANIC recebem 403 (antes a API entregava vendas e estoque a custo a OPERATOR e VIEWER). `/pdv` segue aberto a OPERATOR e VIEWER e `/workshop` ao MECHANIC. O gerente é limitado à própria filial pelo servidor; a RLS isola empresa e filial. Credenciais de canais de venda ficam cifradas (`enc:v1`) e nunca são devolvidas ([CANAIS](CANAIS.md)).

## Commerce API (2026-10-05)

`/commerce/v1` é a única superfície pública; **não usa o JWT de usuário** ([COMMERCE_API §0](COMMERCE_API.md#0-implementação--estado-em-2026-10-05)).
- **Autenticação:** credencial de canal (`X-Cortex-Key`), assinatura HMAC-SHA256 por requisição sobre carimbo de tempo, método, caminho+query e hash do corpo; janela de 300 s; comparação em tempo constante; escopos (`CATALOG_READ`, `ORDERS_READ`, `ORDERS_WRITE`, `PAYMENT_EVENTS_WRITE`). Toda falha de identidade responde o **mesmo** 401 (não revela se a chave existe). O segredo é gerado pelo servidor, cifrado em repouso (`enc:v1`), mostrado **uma vez** e nunca devolvido nem registrado (auditoria só leva o identificador e os escopos). Revogação imediata; troca com sobreposição.
- **Isolamento:** empresa, filial e canal vêm da credencial; contexto RLS `CHANNEL` (limitado à filial, falha fechada); a busca da credencial por `keyId` é a **única** consulta sem RLS da API pública. Campos `companyId`/`branchId` no corpo são recusados (corpo fechado). Provado por testes de integração, inclusive entre empresas, filiais e canais da mesma empresa.
- **Abuso:** limite por credencial (300/min) e bloqueio por IP depois de falhas de autenticação (20/min); corpo de até 256 KB; página de até 100; `Idempotency-Key` obrigatória em escrita; erros com código estável e sem texto técnico; `X-Request-Id` em toda resposta.
- **Dados externos são não confiáveis:** produto, preço, total, quantidade, identificadores e valores de pagamento são validados contra o catálogo e as regras do CÓRTEX; o preço é sempre o oficial; evento de pagamento duplicado, antigo ou inconsistente não gera efeito nem é descartado em silêncio.
- **Pendente (decisões 93 e 94):** LGPD do cliente final guardado no pedido; limites em produção e IP real atrás de proxy (`trust proxy`, 47). Chave publicável e CORS por canal **não existem** (não há acesso direto do navegador).

**Reserva e pedido → venda (Fase 2, 2026-10-05):** a reserva e a venda de canal nascem **no servidor**, a partir do que o CÓRTEX tem (preço oficial, saldo do livro, pagamento confirmado); o canal não escolhe empresa, filial, preço nem estoque. Conversão idempotente e serializada por pedido (trava de linha), com ordem fixa de travas (pedido → número da venda → produtos por id) contra deadlock; evento de pagamento duplicado não gera segunda venda, cobrança nem baixa; a venda de canal não tem usuário nem caixa presumidos (`CHECK` no banco) e **não cria dinheiro na gaveta** do balcão; erros de conversão ficam registrados sem segredo nem dado técnico. Saídas comerciais do balcão, da OS, de transferência e de devolução ao fornecedor respeitam as reservas.

## Integration Gateway (2026-10-06)

Webhook de provedor em `/integrations/v1/webhooks/:channelId` ([INTEGRATION_GATEWAY](INTEGRATION_GATEWAY.md)). Quem chama é o provedor; o corpo é dado externo não confiável.
- **Autenticação:** assinatura HMAC-SHA256 de `"<t>.<corpo cru>"` com o `webhookSecret` da credencial cifrada do canal, janela de 300 s (anti-repetição), comparação em tempo constante; **o mesmo 401** para canal inexistente, sem provedor, sem segredo, assinatura errada ou vencida; bloqueio de IP por falhas de assinatura (429) e limite por canal. A única consulta sem RLS é o canal por id exato.
- **Isolamento:** empresa, filial e canal vêm do canal no banco, nunca do corpo (campo desconhecido é recusado); tudo depois roda com o contexto RLS `CHANNEL`. `channel_outbox` com RLS `FORCE` empresa+filial.
- **Integridade:** evento reivindicado por (canal, `eventId`, tipo): repetição e entregas simultâneas não geram segundo pedido, cobrança, venda nem movimento de estoque; fora de ordem é guardado e aplicado depois; preço, total e SKU conferidos contra o CÓRTEX; cancelamento de pedido que já virou venda não desfaz nada (revisão).
- **Sem segredo em lugar nenhum:** credencial e segredo do webhook só cifrados; eventos do canal, caixa de entrada e de saída guardam só ids, códigos e valores de negócio (um teste varre as tabelas); mensagens de erro do provedor são sanitizadas.
- **Isolamento de falha:** nenhuma chamada externa no caminho do PDV, da venda ou da conversão (a caixa de saída é gravada na transação da mudança e enviada por job); falha de um canal só atrasa o canal (disjuntor, pausa); 401/403 do provedor pausa e desativa o canal.
- **Provedor simulado:** só fora de produção (ou com `CHANNEL_SANDBOX_PROVIDER=true` de propósito); nenhum provedor real registrado; credencial real nunca no código.
- **Pendente:** limites operacionais sem medição e sincronização automática (decisões 103 e 105).

## Auditoria de produção (2026-10-06)

Resultado completo em [DIAGNOSTICO_PRODUCAO](DIAGNOSTICO_PRODUCAO.md). Corrigido e provado nesta rodada:
- **Confusão de tokens (corrigido):** a credencial do dispositivo do PDV (`generateDeviceCredential`, 10 anos, mesma `JWT_SECRET`) passava por `verifyAccessToken` e autenticava como sessão nas rotas da empresa. Agora só vale token com `userId` e `userType`, sem `deviceId`/`licenseId`, assinado em HS256; MFA pendente e refresh token já eram recusados. Teste: `token-confusion.integration.test.ts` (dispositivo, MFA pendente, refresh, sem identidade, chave errada, `alg:none`, expirado, lixo).
- **Enumeração de usuários no login (corrigida):** conta desativada/bloqueada só é dita a quem acertou a senha; e-mail inexistente gasta o mesmo custo e responde igual. Teste: `login-enumeration.integration.test.ts`.
- **Toda rota autenticada (provado):** `auth-coverage.integration.test.ts` percorre as 389 rotas reais de `/api`; só 10 respondem sem token (3 sondas de saúde, login, renovação, logout, as duas etapas públicas de MFA e — desde o fechamento final — `POST /api/device/enroll` e `/status`), cada uma com motivo escrito; uma rota nova sem `authMiddleware` quebra o teste.
- **Auditoria durável:** nunca fica só no Redis nem só na memória (gravação direta no PostgreSQL se a fila não confirma; idempotente por id).
- **Configuração de produção** validada na partida (senha de exemplo, segredos ausentes/iguais, `TRUST_PROXY=true`); logs de configuração sem valores.
- **Front:** cabeçalhos básicos (X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy, HSTS) e sem `X-Powered-By`; **abertos:** CSP e token em `localStorage` (decisão 108).
- **Aceito e documentado:** com o Redis fora, a revogação de access token não é checada (janela = `JWT_EXPIRES_IN`, decisão 107); não há CSRF a tratar porque a API usa `Authorization: Bearer`, sem cookie.

## Autorização de equipamento e HTTPS (2026-10-06, fechamento final)

Detalhe, fluxo e provas em [DISPOSITIVOS](DISPOSITIVOS.md). Antes: o `deviceId` do login era **opcional** e um equipamento desconhecido ou pendente seguia **sem sessão de equipamento e entrava mesmo assim** (a autorização não valia nada); a identidade era o MAC/hostname (qualquer máquina repete); revogar/bloquear **não** derrubava a sessão aberta nem a renovação. Agora:
- **Cadeia:** rede → API → equipamento identificado → **autorizado** → licença → empresa → filial → usuário → permissões → RLS. Máquina nova só consegue **se registrar** e **consultar o próprio estado** (rotas públicas `POST /api/device/enroll` e `/status`: sem dado de negócio, limite por IP, erro uniforme); o login recusa (403 com código) equipamento pendente, desconhecido, de outra empresa/filial, bloqueado, revogado ou sem a chave certa.
- **Credencial do equipamento:** chave aleatória de 256 bits mostrada uma vez, **só o hash SHA-256 no banco**, comparada em tempo constante, guardada no cliente cifrada pelo sistema (Electron `safeStorage`). Não vai em log, auditoria nem resposta.
- **Sessão presa ao equipamento:** o token carrega `dsid` (a DeviceSession) e é conferido **a cada requisição** contra o PostgreSQL (cache positivo de 3 s). Bloquear/revogar encerra a sessão e as renovações **na mesma transação**: acesso cai na hora. Renovação recusada de equipamento encerrado **não** aciona a detecção de token roubado (não derruba as outras sessões do usuário). Regra existente mantida: um usuário em um PDV por vez, um operador por PDV (índices únicos parciais).
- **Empresa e filial vêm do administrador**, não do equipamento nem do usuário; o corpo do enrolamento é fechado.
- **RLS:** `devices_isolation` (FORCE); equipamento sem licença só é visível ao Super Admin; `db:check-rls` OK.
- **Limitador de login:** recusa por equipamento não autorizado (senha certa) **não** conta como tentativa de adivinhar senha — senão um PDV pendente bloquearia a loja inteira por IP.
- **HTTPS:** em produção a API responde **426** a HTTP puro (exceto sondas de saúde), recusa subir sem `TRUST_PROXY` (ou `ENFORCE_HTTPS=false` explícito); o PDV recusa endereço sem HTTPS; mobile/TV falham na partida de build de produção sem https; **nenhum cliente ignora erro de certificado**.
- **Limites conhecidos:** a chave não é atestada por hardware (copiar o arquivo não funciona, mas quem usa a mesma conta na mesma máquina a usa; resposta: revogar e reenrolar); `apps/mobile` e `apps/tv` não têm o portão de equipamento (só política + HTTPS); a política `devices.requiredUserTypes` (perfis que só **operam o caixa** por equipamento autorizado — `403 DEVICE_REQUIRED` na operação, não no login) vem **vazia** por padrão, o que deixa o caixa operável por credencial sem equipamento até a empresa ligá-la (decisão 109); equipamentos legados sem chave (identidade = id/MAC, clonável) só entram no login se criados antes de 2026-10-07 e **até 31/12/2026** (`DEVICE_LEGACY_CUTOFF`), com evento `DEVICE_LEGACY_LOGIN`; depois, `DEVICE_REENROLL_REQUIRED` (decisão 110).

## Sessão do operador — PDV Desktop e Balcão (2026-10-14)

Detalhe e quadro de cenários em [CONSOLIDACAO_FINAL §3](CONSOLIDACAO_FINAL.md#3-autenticação-do-pdv--comportamento-real).

- **Sem restauração:** PDV e Balcão guardam o par de tokens só na memória; nada para o SO ou o navegador restaurar. Cada operador entra com o próprio identificador e senha.
- **Revogação no servidor** ao sair da conta e ao fechar o aplicativo; sem rede, refresh token pendente numa fila cifrada pelo SO (`safeStorage`), usada **só** para revogar (nunca autentica).
- **Bloqueio de tela** exige a senha do próprio usuário (`POST /api/auth/reauthenticate`: sem sessão nova, sem campo de identificador, balde `authorizer`, falha auditada, senha nunca registrada). Revisão pendente: operador com MFA desbloqueia só com senha.
- **Sessão de equipamento:** logout escopado ao refresh token que saiu; relogin do **mesmo** operador no mesmo equipamento substitui a sessão presa; outro operador segue `DEVICE_BUSY` até o encerramento administrativo.
- **Não implementado de propósito:** acesso autenticado offline (decisão 118) e bloqueio por inatividade.

## Aplicativo Balcão (2026-10-13)

Detalhe em [APLICATIVOS](APLICATIVOS.md). O Balcão é um cliente da mesma API: **nenhuma regra de segurança mora nele**.

- **Servidor decide:** RBAC, RLS por empresa/filial, filial obrigatória na escrita e auditoria dos eventos de orçamento/OS são os da API; o app só esconde botões que sabidamente dariam 403 (`lib/permissions.ts`), e isso **não é autorização**. Provado em integração: VIEWER só lê, MECHANIC não lê vendas, produto/cliente de outra empresa → 404, filial de outra empresa recusada.
- **Custo de produto não vaza (achado e corrigido):** `GET /api/products` (lista, `/search/:code`, `/:id`) devolvia `costPrice` a qualquer usuário autenticado do tenant. Agora só SUPER_ADMIN, COMPANY_ADMIN e MANAGER recebem `costPrice`; OPERATOR, MECHANIC e VIEWER (balcão, oficina, consulta) não. Só a resposta é filtrada; cadastro e telas de gestão seguem iguais.
- **Disponibilidade:** `GET /api/stock/availability` confere que cada produto é da empresa do token (404 `PRODUCT_NOT_FOUND`), exige filial (a do token, ou a informada por quem é da empresa toda) e devolve saldo, reservado e disponível — nunca dado de outra empresa/filial.
- **Sessão:** tokens só em memória da página (antes `sessionStorage`; trocado em 2026-10-14 porque o navegador pode restaurar a aba), refresh em *single-flight*, `X-Client-Source: BALCAO`; **limitação da decisão 108:** token legível por script injetado enquanto a aba vive. **Mitigação (2026-10-14):** o nginx do Balcão envia **CSP** (`script-src 'self'`, `connect-src 'self' <API>`, `frame-ancestors 'none'`, `object-src 'none'`) além de `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`. Provado no navegador (fluxo completo 12/12, zero violação) num servidor com os mesmos cabeçalhos; **o nginx real não foi executado**. Defeito corrigido: `add_header` em `location` anulava os cabeçalhos do `server` (nenhum era enviado). Admin Web/Super Admin: sem CSP (exige nonce) — [AUDITORIA_FINAL §4](AUDITORIA_FINAL_2026-10-14.md#4-segurança--decisão-108-token-no-navegador-e-csp).
- **Custo (perfil de compras):** `costPrice` também é enviado a quem recebeu `purchases:manage|approve|receive` por perfil (o pedido de compra é pré-preenchido com o custo); VIEWER nunca.
- **Leitura de código:** SKU/código de barras ambíguo entre produtos ativos responde `409 CODE_AMBIGUOUS` (antes devolvia um produto ao acaso).
- **Endereço da API:** fixado no build; em produção o app **recusa abrir** se não for `https://` (nenhum erro de certificado é ignorado). Origem do navegador liberada na API somente pela variável `BALCAO_URL` (CORS).
- **Dinheiro:** o Balcão não chama escrita em pagamento, caixa, venda ou fiscal e não tem campo tributário — **teste estático** em `domain-separation.test.ts`.

## Central de Monitoramento do Super Admin (2026-10-18/19)

- **Autorização:** todas as rotas `/api/monitoring/central/*` passam por `requireSuperAdmin` **no backend** (a tela só espelha). Usuário de empresa (administrador, gerente, operador…) e requisição anônima recebem 403/401 — provado em integração (matriz de papéis × rotas) e no navegador (`monitoring-central.e2e.test.js`). Nenhum escopo de gerente, administrador de empresa ou operador foi alterado.
- **Isolamento entre empresas:** toda consulta por empresa filtra por `companyId` explícito (detalhe, alertas, integrações, utilização); a leitura agregada da plataforma roda sob contexto de **plataforma assinado** e as tabelas novas têm **RLS forçada** com política só para o Super Admin (`app_ctx.is_super_admin()`). SQL cru só dentro de `runInTransaction` (fora dele não há contexto de RLS e a leitura volta vazia).
- **Trilha:** cada ação sobre alerta (reconhecer, atribuir, tratar, resolver, reabrir, nota) grava um evento **imutável** (append-only; apagar só pelo expurgo de retenção, com sinalização e Super Admin); mudança de limites e de oportunidades comerciais passa pela auditoria. Ação inválida para o estado atual é recusada (`actionRefusal`) e resolver exige nota.
- **Sem bloqueio automático por requisição única:** o avaliador abre/atualiza **um** alerta por tipo e alvo, com reabertura só após janela de calma; nenhuma conta é bloqueada por um pedido inválido.
- **Dados e segredos:** o estado dos serviços externos devolve **só** "configurado ou não", host/domínio e contagens — nunca chave, DSN completo ou destinatário. Erros enviados ao Sentry são mascarados (sem corpo, cabeçalhos, e-mail, token ou senha); o corpo dos e-mails de alerta não leva dado sensível; falhas de entrega guardam mensagem **sanitizada**. Nenhuma chave `service_role` ou de provedor existe no front.
- **Proteção contra abuso e custo:** limite geral de requisições mantido; envio externo com teto por hora/dia/mês, deduplicação, disjuntor e amostragem; o ajuste da tela só **restringe** (o ambiente é o teto); falha externa nunca interrompe a operação.
- **Entrada validada:** filtros, períodos, etapas do funil, ajustes e ações têm validação no servidor (chave desconhecida, valor negativo, nome curto e identificador inválido retornam 400).

## Limites e resiliência

| Limite | Valor |
|---|---|
| Corpo JSON | 5 MB |
| Paginação | `limit` ≤ 100 (inválido → 20); `page` ≥ 1 (inválida → 1; teto 100 000) |
| Importação | 5.000 linhas por arquivo |
| Geral | 100 requisições/min por usuário (sem token, por IP) |
| Login | 5 falhas/15 min (bloqueio de 60 min, por IP); tentativas simultâneas acima do limite recebem 429 de 2 s sem bloqueio; MFA e autorizador: 3 falhas/5 min (só falhas contam, por usuário) |
| Datas de filtro | `startDate`/`endDate` inválidos → 400 |

- **Redis fora:** a API segue (health 503 DEGRADED); limites de tentativa passam a contar em memória por instância (antes
  liberavam tudo) — o mesmo vale enquanto a conexão ainda está abrindo na partida; essa contagem não é somada com a do
  Redis quando ele volta. Auditoria e métricas ficam na fila em memória e seguem quando ele volta.
- **Postgres fora:** respostas 503 `DATABASE_UNAVAILABLE` com `Retry-After` (antes 400/401/500 culpando o usuário); a
  API volta sozinha. Evidência: caos controlado (evidência arquivada fora do repositório publicado: `docs/evidencias/2026-09-27/02-resiliencia-caos-controlado.md`).

## Revisão de segurança e multi-tenant — 2026-10-04 (homologação)

Resultado: **nenhuma vulnerabilidade explorável nova**. Provas: integração 1239/1239 (RLS, IDOR, sessões, refresh, MFA), HML `rls.js` 26/26 com contexto forjado, `security.js` 79/79 (rodada anterior).
Corrigido: erro de banco no login era tratado como credencial inválida (ver [DIAGNOSTICO_FASE6](DIAGNOSTICO_FASE6.md)). Defesa em profundidade e limites que dependem de decisão:

| Ponto | O que a leitura do código mostrou | Decisão |
|---|---|---|
| `refresh_tokens` (política `companyId IS NULL`; token guardado cru) — **CORRIGIDO em 2026-10-15** (SHA-256 e RLS sem o ramo nulo, decisão 128) | Nenhuma rota lista tokens: só há busca por token e `updateMany` por usuário (`auth.service`, `auth.routes`, `user.service`, `company.service`). A exposição exigiria um defeito de código | 51 |
| `request_logs` e `system_logs` (`WITH CHECK (true)`; linhas nulas visíveis a todas) — **CORRIGIDO em 2026-10-14** (decisão 125) | Só leem as rotas de observabilidade e monitoramento do Super Admin (`requireSuperAdmin`, `requireUserType`) | 55 |
| Sem `trust proxy`; balde de login por IP | Atrás de proxy, todos dividem um balde; loja em NAT idem | 47, 48 |
| Limite geral de 100 req/min por usuário | O Admin Web faz 5 a 17 chamadas por tela e o `StrictMode` do modo de desenvolvimento dobra os efeitos; Orçamentos faz 5 chamadas `?limit=1` só para os cartões; a barra lateral sonda a cada 60 s. Em produção a contagem cai pela metade. **Não se subiu o limite** | 50 |
| 503 e limitador | **Confirmado:** o limitador conta no `res.end` com o status **final** (`advancedRateLimit.ts:335`); como `FAILED_ATTEMPT_STATUSES` não inclui 503 e a tradução de erros já troca o status antes de enviar, um 503 por banco fora nunca conta como tentativa falha | — |

Falso positivo: a "falta de `auditLog`" em pagamento de OS, importação e backup já estava corrigida (as tabelas dos contratos é que estavam velhas).

## Ações operacionais pendentes (produção — sem acesso daqui)

1. `prisma migrate deploy` + `npm run db:check-rls` em staging/produção ([DATABASE](DATABASE.md)).
2. `npm run secrets:encrypt -- --check` e, se houver algo, `npm run secrets:encrypt`.
3. Expurgar de `audit_logs` antigas linhas com segredo: `entity='User'` de `/mfa/setup` anteriores ao commit 58290e7
   (regenerar o MFA desses usuários) e `entity='Activation'` com credencial de dispositivo anteriores a 73546a3
   (reemitir os dispositivos) — ver [registro](historico/registro-de-auditoria-2026-09-14-a-25.md) E7/F1.
4. `docker-compose.yml` (corrigido em 2026-10-06: sem senha escrita, portas só em loopback, não validado com Docker) continua sendo stack de desenvolvimento/homologação, não de produção ([PRODUCAO](PRODUCAO.md)).
