# Implantação no Google Cloud — preparação (2026-10-22)

**Estado: PREPARADO, NADA CRIADO.** Nenhum projeto, VM, banco, bucket, domínio ou segredo foi criado no Google Cloud; nenhum deploy foi feito. Aguarda a resposta do suporte do Google (conta/cotas/faturamento). A Oracle **deixou de ser o destino** (a [seção 19 do PRODUCAO](PRODUCAO.md) fica como referência: os scripts `deploy/oci/*` são genéricos para Ubuntu e servem em qualquer VM). Tudo abaixo vem do código, do `docker-compose.yml` e dos testes do repositório; o que depende de produto do Google e **não foi verificado aqui** está marcado como **(a confirmar)**.

## 1. O que existe (e o que NÃO é aplicação web)

| Componente | O que é no repositório | Onde roda | Porta / imagem |
| --- | --- | --- | --- |
| **API** (`apps/api`) | Express + Prisma, Node 20; processa as filas (BullMQ) e o agendador **dentro do mesmo processo** | contêiner | 3001 · `apps/api/Dockerfile` |
| **Admin Web** (`apps/admin-web`) | Next 15.5.28, saída `standalone`, 54 páginas de cliente, sem rotas de servidor | contêiner | 3002 · `apps/admin-web/Dockerfile` |
| **Super Admin Web** (`apps/super-admin`) | Next 15.5.28, saída `standalone` | contêiner | 3000 · `apps/super-admin/Dockerfile` |
| **Balcão** (`apps/balcao`) | **SPA web** (Vite) servida por nginx; a decisão 116 (empacotar como PWA/APK) está **aberta**; **não existe APK do Balcão** no repositório | contêiner | 80 · `apps/balcao/Dockerfile` |
| **PDV** (`apps/pdv-desktop`) | Aplicativo **desktop Electron** (instalador Windows); não é hospedado | máquina do caixa | — |
| **Equipe** (`apps/mobile`) e **Painel** (`apps/tv`) | Aplicativos **Android (Expo)**; não são hospedados | celulares / TV | — |
| PostgreSQL 18 | 113 tabelas, RLS forçada, 57 migrations, 3 papéis (dono, aplicação, backup) | contêiner (ou gerenciado, ver §2) | 5432 (só rede interna) |
| Redis 7 | cache, sessões, limites de tentativa, filas BullMQ; senha obrigatória | contêiner (ou gerenciado) | 6379 (só rede interna) |
| Serviço de backup | `deploy/backup/` (cron, dump diário cifrado, cópia externa por rclone) | contêiner | — |

> **Divergência a confirmar com o proprietário:** foi dito que o Balcão é um aplicativo Android/APK. No código ele é uma SPA web (Vite + nginx) com Dockerfile; os Android são `mobile` e `tv`. Este documento segue o código. Se existir um APK do Balcão fora do repositório, ele não está versionado.

## 2. Recomendação: o que já está preparado e é compatível

**Primeiro go-live: 1 VM do Compute Engine (Ubuntu 24.04) rodando o `docker-compose.yml` já validado**, com HTTPS na frente. É a configuração **comprovada**: a pilha base + WAL sobe no runner Linux do GitHub com 0 falhas (workflow "Stack", [CHANGELOG](CHANGELOG.md) 2026-10-22), e `bootstrap-host.sh`, `gen-env.sh` e `validar-homologacao.sh` são genéricos (Ubuntu amd64/arm64, sem nada da Oracle). Não exige reescrever nada.

**Serviços gerenciados (Cloud Run + Cloud SQL + Memorystore): possível, mas é uma adaptação**, não uma troca de configuração. Motivos concretos tirados do código:

| Ponto | Por que pesa |
| --- | --- |
| API com filas e agendador no mesmo processo | no Cloud Run precisa de instância mínima ≥ 1 e CPU sempre alocada; senão as filas e os jobs agendados param entre requisições **(a confirmar)** |
| Papéis do banco | o projeto cria dono / aplicação / backup (**BYPASSRLS**) e roda `after-migrate.sql` com funções `SECURITY DEFINER`; o Cloud SQL não entrega superusuário completo, então criar o papel com BYPASSRLS e provisionar o contexto assinado **(a confirmar em instância de teste)** |
| PostgreSQL 18 | disponibilidade no Cloud SQL **(a confirmar)**; o CI e o compose usam `postgres:18` |
| Redis | o BullMQ exige política de memória sem remoção (`noeviction`) e senha; conferir se o Memorystore permite **(a confirmar)** |
| Serviço de backup | é um contêiner com cron e volume; no modelo gerenciado vira Cloud Run Job/Scheduler ou backup nativo do Cloud SQL + o dump cifrado do projeto |
| Migrações | hoje são um contêiner de execução única (`migrate`) seguido de `db-grants`; no Cloud Run viram jobs encadeados antes de liberar a API |

Recomendação: **VM + compose agora; avaliar o gerenciado depois**, com um piloto descartável que responda os itens "(a confirmar)".

## 3. Requisitos por componente

- **Admin Web / Super Admin / Balcão:** sem estado. O endereço da API é **fixado no build** (`NEXT_PUBLIC_API_URL` / `VITE_API_URL` = `https://api.<dominio>`; build de produção recusa `http` fora de localhost). Mudou o domínio, reconstrua a imagem. O Balcão recebe também `API_ORIGIN` para a CSP do nginx.
- **API:** `NODE_ENV=production` (recusa subir com senhas de exemplo, como superusuário/dona das tabelas ou com `BACKUP_DATABASE_URL`), `TRUST_PROXY` = número de saltos de proxy (**nunca** `true`), `ENFORCE_HTTPS=true` atrás do HTTPS, sondas `/api/health/live` e `/api/health/ready`, desligamento ordenado de até 25 s (dê 30 s de carência). Recebe só 101 variáveis de aplicação (o `env_file` foi removido; `stack-config.test.ts` guarda isso).
- **PostgreSQL:** 3 papéis separados; a API usa o papel **sem posse** (é isso que faz a RLS valer); o dono só migra; o papel de backup lê tudo e só existe no serviço de backup. Persistência em disco SSD; WAL contínuo opcional (`docker-compose.wal.yml`, PITR).
- **Redis:** dados reconstruíveis (cache, contadores, filas); senha obrigatória; nunca exposto à internet.

## 4. Rede, HTTPS, CORS e CSP

- Quatro nomes: `api.`, `admin.`, `super.`, `balcao.<dominio>` (o `deploy/Caddyfile` já roteia os quatro; com a Cloudflare na frente use `deploy/Caddyfile.cloudflare` + `docker-compose.cloudflare.yml`).
- Firewall do VPC: entrada só **22 (do seu IP), 80 e 443**; nada de 5432/6379/3000–3002. O compose publica PostgreSQL e Redis só em `127.0.0.1` e, na pilha de staging, fecha 3000–3002. O Docker ignora o `ufw`: a barreira correta é a regra de firewall do Google Cloud.
- **CORS:** a API só libera as origens de `WEB_URL`, `SUPER_ADMIN_URL` e `BALCAO_URL`. **CSP:** `connect-src` dos painéis = própria origem + a origem de `NEXT_PUBLIC_API_URL`.
- **`TRUST_PROXY`:** conte os saltos reais (Caddy sozinho = 1; se houver Cloud Load Balancer na frente do Caddy o número muda). Valide com `validar-homologacao.sh --tls <dominio>` e olhando o IP real nos logs antes de confiar em limites por IP.

### 4.1 Cloudflare na frente (opcional, 2026-10-22)

A Cloudflare pode ficar **na frente** do Google Cloud (DNS, proxy, HTTPS, WAF) e, se o responsável decidir, hospedar **só as duas telas web** (Admin Web e Super Admin) em Workers, mantendo a **API, o PostgreSQL e o Redis/BullMQ no Google Cloud** (a API é um processo Node de longa duração e não roda em Workers). Se as telas forem para a Cloudflare: a origem do Worker precisa estar em `WEB_URL`/`SUPER_ADMIN_URL` da API (CORS), a URL pública da API entra no build (`NEXT_PUBLIC_API_URL`, HTTPS) e na CSP, e o Super Admin merece Cloudflare Access. Homologação, riscos e passo a passo: [CLOUDFLARE](CLOUDFLARE.md). **Nada foi criado nem contratado.**

## 5. Segredos

Gerados por `deploy/oci/gen-env.sh <dominio>` (aleatórios, modo 600, nunca impressos): `POSTGRES_PASSWORD`, `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD`, `DB_BACKUP_PASSWORD`, `REDIS_PASSWORD`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `DATA_ENCRYPTION_KEY`, `RLS_CONTEXT_SECRET` e a chave de cifragem do backup (`backup.key`). **Guarde cópia no Secret Manager ou num cofre.** A perda de `DATA_ENCRYPTION_KEY` impede abrir os segredos de MFA já gravados; a perda de `backup.key`, restaurar qualquer backup. Integrações (Sentry, Resend, provedores de pagamento) ficam **desligadas** até haver credencial sua. Nunca envie segredo por chat.

## 6. Migrações e inicialização

Ordem do compose (já provada no CI): `postgres` → `migrate` (`prisma migrate deploy` como dono, 57 migrations) → `db-grants` (privilégios do papel da aplicação + segredo do contexto assinado) → `api` saudável → front-ends. Depois, e só depois de `validar-homologacao.sh`, criar o Super Admin pelo roteiro da §13 do PRODUCAO (`ALLOW_SUPER_ADMIN_BOOTSTRAP=true` uma vez, depois remover). Rollback: imagem anterior; as migrations são aditivas por regra; restauração só em banco **novo**.

## 7. Backups, restauração, logs e alertas

- **Backup:** dump diário às 00:00 cifrado, verificação às 12:00, pedido sob demanda pela API (modo delegado). **Cópia externa obrigatória** para um bucket do Cloud Storage via `BACKUP_OFFSITE_CMD` com rclone (o rclone suporta Cloud Storage) **(a confirmar o tipo/credencial)**; use conta de serviço **só de escrita**, versionamento e retenção no bucket. Sem cópia externa o backup não protege contra perda do servidor.
- **Restauração:** `npm run backup:drill` e `deploy/homologacao/validar-backup-externo.sh` em **outro** host, com anonimização. **Nunca executado fora de teste**; o RPO/RTO (decisão 154) é uma proposta **não aprovada**.
- **Logs:** os contêineres escrevem em stdout com rotação (10 MB × 3); instalar o agente do Google Cloud Operations para Cloud Logging/Monitoring **(a confirmar)**. Monitoramento: verificação de disponibilidade em `/api/health/ready`, alerta de disco, de falha de backup (`BACKUP_ALERT_CMD`/`ALERT_WEBHOOK_URL`) e a Central de Monitoramento do Super Admin. Alertas só valem depois de uma notificação real recebida por uma pessoa.

## 8. Recursos mínimos e custo (ordem de grandeza; confirme no Google Cloud Pricing Calculator)

Soma dos limites de memória do overlay de recursos (`docker-compose.free.yml`): ~8 GB (PostgreSQL 3 GB, API 2 GB, painéis 0,75 GB cada, Redis 0,5 GB, backup 0,5 GB, proxy e Balcão pequenos). Mínimo prático: **2 vCPU / 8 GB** para demonstração e **4 vCPU / 16 GB** para uso real, disco SSD de 50–100 GB, IP externo estático, 1 bucket de backup.

| Item | Referência de lista (região `us-central1`, sob demanda, 730 h) |
| --- | --- |
| VM `e2-standard-2` (2 vCPU / 8 GB) | ~US$ 49 / mês |
| VM `e2-standard-4` (4 vCPU / 16 GB) | ~US$ 98 / mês |
| Disco SSD balanceado 100 GB | ~US$ 10 / mês |
| Cloud Storage (backups) e tráfego de saída | variável; poucos dólares no início |

Preços de lista de referência, **não** cotação; `southamerica-east1` (São Paulo) costuma custar mais e ajuda na latência e na residência de dados (LGPD). O nível gratuito (`e2-micro`) **não** comporta esta pilha. Créditos de avaliação e elegibilidade: confirmar na conta.

## 9. Preparado × depende de infraestrutura

| Item | Estado |
| --- | --- |
| Imagens (API, Admin, Super Admin, Balcão), compose, migrações, papéis, RLS, backup, WAL | **Preparado e executado no CI** (runner Linux) |
| Scripts `bootstrap-host.sh`, `gen-env.sh`, `validar-homologacao.sh` | Genéricos Ubuntu; **a executar na VM** |
| Projeto, faturamento, cotas e VM no Google Cloud | **Bloqueado**: resposta do suporte pendente |
| Domínio, DNS, HTTPS (Caddy/Cloudflare), `--tls` | **Depende do domínio e da conta** |
| Bucket e credencial de backup externo; restauração em outro host | **Depende da conta; não provado** |
| Alertas reais, Super Admin, produção | **Pendentes**; o sistema **não** está pronto para produção |

## 10. Sequência de implantação (NÃO executada)

1. Criar projeto + faturamento, habilitar Compute Engine, criar a VM (Ubuntu 24.04, disco SSD, IP estático) e as regras de firewall (22 do seu IP, 80/443).
2. Na VM: `sudo bash deploy/oci/bootstrap-host.sh` → clonar o repositório → `deploy/oci/gen-env.sh <dominio>` → guardar `.env` e `backup.key` no cofre.
3. Definir `PUBLIC_API_URL=https://api.<dominio>`, `WEB_URL`, `SUPER_ADMIN_URL`, `BALCAO_URL`; subir com a pilha de staging (`-f docker-compose.yml -f docker-compose.staging.yml`).
4. `sh deploy/homologacao/validar-homologacao.sh --wal --tls <dominio>`; configurar a cópia externa; ensaiar a restauração em outro host.
5. Só então criar o Super Admin e liberar para os primeiros clientes.
