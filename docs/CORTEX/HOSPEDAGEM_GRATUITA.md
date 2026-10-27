# Hospedagem sem custo — viabilidade e preparação (2026-10-27)

**Estado: PESQUISADO E ENSAIADO LOCALMENTE. NADA CRIADO, NADA CONTRATADO, NADA PUBLICADO.** Nenhuma conta, banco, VM, URL ou credencial foi criada. Limites de planos gratuitos mudam: **confirme na página de preços de cada provedor antes de decidir**; os números abaixo são os encontrados na pesquisa de 2026-10-27, não garantia.

Níveis usados: **local** (provado na máquina/CI) · **publicado, não validado** · **validado remotamente** (nada ainda) · **pendente de autorização/credencial**.

## 1. Requisito que decide tudo

A API roda **seis workers BullMQ e tarefas repetíveis por minuto no mesmo processo**. Isso exige um Redis com `maxmemory-policy noeviction` (BullMQ avisa/falha com outra política) e persistência (AOF), disponível 24 h. Consequência: serviço que **dorme** (Render grátis, Cloud Run por requisição) ou **conta comandos** (Upstash grátis, ~500 mil comandos/mês) não serve para as filas.

## 2. Comparativo

| Peça | Opção | Veredito | Motivo |
|---|---|---|---|
| PostgreSQL | **Neon free** | **viável para demonstração** | sem superusuário (ver §3), pooler PgBouncer, autosuspende em 5 min ocioso, ~100 CU-h/mês |
| PostgreSQL | Supabase free | possível, pior | pausa após ~1 semana sem uso, sem backup automático |
| Redis | Upstash free | **não serve** | limite de comandos/mês menor que o consumo dos repetíveis por minuto + 6 workers |
| Redis | Redis Cloud free (30 MB) | possível, **não provado** com BullMQ | conferir `noeviction` e comandos permitidos antes de adotar |
| Redis | contêiner na mesma VM | **recomendado** | `docker-compose.yml` já traz Redis com senha; controle de `noeviction` + AOF |
| API + workers | Render free | **descartado** | dorme sem tráfego; workers param |
| API + workers | VM Google e2-micro (Always Free, só regiões dos EUA) | viável **depois** de confirmar elegibilidade | cabe API + Redis; **não** a pilha com Postgres (1 GB RAM); 1 GB/mês de saída |
| API + workers | Oracle Always Free (A1) | alternativa documentada para a pilha completa | `docker-compose.free.yml` + `deploy/oci/` já existem |
| Admin Web / Super Admin | Cloudflare Workers (OpenNext) | preparado, **não publicado** | [CLOUDFLARE](CLOUDFLARE.md): o check "Workers Builds: cortex" falha por configuração do painel |
| Monitor | contêiner `apps/monitor` | preparado | independente da API por desenho; idealmente fora do host da API |

**Desenho recomendado para o primeiro cliente-demo (custo zero):** Neon free (banco) + **uma VM** (Google e2-micro se a conta for elegível; senão Oracle) com API + Redis + monitor em contêiner + Caddy para HTTPS + Admin/Super Admin no Cloudflare. **Nada disso foi feito**; é o desenho para quando houver conta e autorização.

## 3. PostgreSQL gerenciado: o que foi provado localmente

Em serviço gerenciado o administrador **não é superusuário** (Neon: membro de `neon_superuser`, com CREATEROLE/CREATEDB). O CÓRTEX depende de três papéis (dono; aplicação sem posse/BYPASSRLS; backup com BYPASSRLS), RLS forçada e contexto assinado.

`deploy/neon/ensaio-pg-gerenciado.js` imita essas restrições em um banco **temporário local** (administrador `LOGIN CREATEROLE CREATEDB BYPASSRLS NOSUPERUSER`) e remove tudo ao fim:

```
CORTEX_DB_ADMIN_URL=postgresql://<superusuário-local>@localhost:5432/postgres node deploy/neon/ensaio-pg-gerenciado.js
```

Resultado (2026-10-27, PostgreSQL 18.6 local): papéis criados sem superusuário; `prisma migrate deploy` como dono (57 migrations); `after-migrate.sql` aplicado; **RLS forçada em 113 de 113 tabelas**; a aplicação não consegue desligar RLS, TRUNCATE, DROP, criar tabela nem ler `_prisma_migrations`; sem contexto assinado enxerga 0 linhas; papel de backup com BYPASSRLS; tudo removido.

**Achado:** sem superusuário, quem cria um papel só recebe ADMIN sobre ele; para transferir a posse do banco/schema é preciso `GRANT <dono> TO CURRENT_USER WITH SET TRUE` (PostgreSQL 16+). O script faz isso.

**Limite honesto:** simula as **restrições**, não o serviço. Latência, autosuspend, pooler e as particularidades reais do Neon (papéis criados por SQL não são membros de `neon_superuser`; `BYPASSRLS` só em projetos novos) **continuam por provar** com uma conta real. No Neon, **confirme `rolbypassrls` do papel de backup**: sem ele o backup não enxerga as linhas e o modelo precisa de decisão do proprietário.

## 4. Neon: duas URLs, um risco

- **URL direta** (sem `-pooler`) → só para `prisma migrate deploy` e `after-migrate.sql` (sessão e DDL).
- **URL com pooler** (PgBouncer, modo transação) → runtime da API, com `?pgbouncer=true`. A API usa `set_config(..., true)` **dentro de transação** (padrão que sobrevive ao pooler), sem `SET` de sessão. **Ainda não foi exercitado contra PgBouncer real** — é o primeiro teste no Neon (rodar os testes de integração apontando para um banco Neon **de teste**).
- **Horas de computação:** o agendador por minuto mantém o banco acordado; ~100 CU-h/mês ≈ 400 h a 0,25 CU, **menos que as ~730 h do mês**. Mitigações a decidir: desacelerar jobs periódicos em modo demo ou aceitar suspensão. **Os jobs não foram alterados.**

## 5. Variáveis necessárias (nomes; **sem valores**)

Banco: `DATABASE_URL` (runtime, papel de aplicação, pooler) · URL de migração (papel dono, direta) · `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD`, `DB_BACKUP_PASSWORD` · `RLS_CONTEXT_SECRET`.
Redis: `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_URL`.
Aplicação: segredos JWT, `CORS_ORIGINS`, URLs públicas dos painéis, `BACKUP_MODE=delegated`.
Alertas: `ALERT_EMAIL_PROVIDERS`, `APPS_SCRIPT_*` ([APPS_SCRIPT_NOTIFICACOES](APPS_SCRIPT_NOTIFICACOES.md)), `RESEND_*`, `TWILIO_*`, `META_WHATSAPP_*`.
Lista completa e comentada em `.env.example`. Segredos só no cofre/variáveis do provedor — nunca no Git.

## 6. O que depende de você (ordem)

1. Criar a conta Neon e escolher a região (onde ficam os dados); depois rodar o teste de §4.
2. Decidir Redis: contêiner na VM (recomendado) × Redis Cloud (exige prova de BullMQ).
3. Confirmar elegibilidade do Google Cloud ([GOOGLE_CLOUD](GOOGLE_CLOUD.md) §11) ou escolher Oracle.
4. Corrigir o painel do Cloudflare ([CLOUDFLARE](CLOUDFLARE.md) §8).
