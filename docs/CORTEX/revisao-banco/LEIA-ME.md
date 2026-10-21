# Pacote de revisão do banco de dados (CÓRTEX)

Gerado em 2026-10-19 por `cd apps/api && npm run db:docs -- --write`. Contém **apenas estrutura**: cópia do schema Prisma e das 57 migrations (SQL), com SHA-256 em `SHA256SUMS.txt`. Sem segredo, sem dado de cliente, sem `.env`.

- `packages/database/prisma/schema.prisma` — schema atual.
- `packages/database/prisma/migrations/` — todas as migrations, na ordem de execução, e `migration_lock.toml`.
- `drift-dev.txt` — saída de `prisma migrate diff` (banco de desenvolvimento → schema).
- `replay-resultado.md` — resultado de reaplicar as migrations do zero em banco vazio e dos **três cenários com dado inconsistente** (`npm run db:replay-check`).
- `role-split-resultado.md` — prova da separação dono × execução do banco, em banco e papel temporários (`npm run db:role-split-check -- --suites`; modelo em `deploy/db-runtime-role.sql`).
- `resultados-testes.md` — testes executados (unitários, integração completa em três rodadas, E2E, builds), falhas encontradas e correções.

Documentos relacionados (em `docs/CORTEX`): `BANCO_DE_DADOS.md` (inventário por tabela), `MAPA_RELACIONAMENTOS.md`, `RELATORIO_MIGRATIONS.md`, `REVISAO_BANCO_PENDENCIAS.md`, `DECISIONS.md`.

Conferir a integridade: `sha256sum -c SHA256SUMS.txt` (a partir desta pasta).
