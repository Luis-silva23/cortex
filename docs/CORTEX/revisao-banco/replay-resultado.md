**Execução de 2026-10-20** (`npm run db:replay-check`) — banco temporário vazio, criado e removido pelo script; o banco de desenvolvimento só foi lido. Resultado: **IDÊNTICO — nada no banco de desenvolvimento escapa das migrations**.

- `prisma migrate deploy` em banco vazio: sucesso (57 migrations encontradas em `prisma/migrations`).
- `prisma migrate diff` (banco → schema.prisma): banco reaplicado do zero e banco de desenvolvimento produzem **exatamente a mesma saída** — **vazia (0 instruções): o `schema.prisma` descreve exatamente o banco**.
- Catálogo completo (colunas, índices, constraints, policies, RLS, triggers, funções, sequências, enums): dev = 3712 itens, reaplicado = 3712 itens; **só no dev: 0**; **só no reaplicado: 0**.
- PostgreSQL: PostgreSQL 18.6 on x86_64-windows.
- FKs NOT VALID (legado de dado, normalizadas na comparação acima): dev = 3 (accounts_receivable.accounts_receivable_companyId_branchId_fkey, accounts_receivable.accounts_receivable_companyId_customerId_fkey, accounts_receivable.accounts_receivable_companyId_fkey); reaplicado do zero = 0.
- `db:check-rls` no banco reaplicado: todas as invariantes OK — [check-rls] "lnsystem_db_replay_tmp": todas as invariantes de RLS OK
- Banco temporário removido: sim.

**Cenário com dados inconsistentes (migration das FKs compostas):**

- Banco temporário 2: 36 migrations aplicadas (até a anterior à FK composta): sucesso.
- Dados sintéticos: 2 empresas, 1 produto em cada e **1 código de barras da empresa A apontando para o produto da empresa B** (aceito pela FK antiga); linhas cruzadas confirmadas antes do deploy: 1.
- `migrate deploy` completo com a linha inconsistente: **falhou como esperado** (a migration `20261014155900_guard_product_children_same_company` recusou o dado cruzado).
- Atomicidade: depois da falha, índice composto 0, FK composta 0, FK antiga 1 → **nada ficou aplicado pela metade**.
- Recuperação (corrigir a linha → `migrate resolve --rolled-back 20261014155900_guard_product_children_same_company` → `migrate deploy`): **concluiu**, as 2 FKs compostas existem.
- Banco temporário 2 removido: sim.

**Cenário de sessões (migration de refresh_tokens: hash, empresa e RLS):**

- Banco temporário 3: 40 migrations aplicadas (até a anterior à de refresh_tokens): sucesso.
- Dados sintéticos: 3 sessões legadas (token em texto): 2 do usuário da empresa A e 1 de plataforma; **uma das sessões da A gravada com a empresa da B** (inconsistente).
- `migrate deploy` com sessão de empresa divergente: **abortou como esperado**.
- Atomicidade: depois do aborto, coluna em texto ainda existe e coluna de hash não existe → **nada ficou pela metade; nenhuma sessão perdida**.
- Recuperação (corrigir a linha → `migrate resolve --rolled-back` → `migrate deploy`): **concluiu**.
- Sessões preservadas: o hash calculado em SQL é **igual** ao SHA-256 da aplicação nas 3 sessões → **sim** (o mesmo token continua achando a mesma linha).
- Empresa preenchida só pelo usuário: sessões da A → empresa A; sessão de plataforma → nula → **conforme**.
- Estado de revogação preservado (a revogada continua revogada, a ativa continua ativa): **sim**.
- Segredo em texto: coluna `token` removida e nenhum valor "legacy-…" restou em nenhuma coluna → **ausente**.
- Banco temporário 3 removido: sim.

**Cenário de filial/empresa (migration das FKs de empresa e filial: guarda, atomicidade, legado preservado):**

- Banco temporário 4: 42 migrations aplicadas (até a anterior à de FKs de empresa/filial): sucesso.
- Dados sintéticos: **1 produto da empresa A gravado com a filial da empresa B** e **1 cliente de empresa inexistente** (os dois aceitos pelo schema antigo, sem FK).
- `migrate deploy` com filial de outra empresa: **abortou como esperado** (a guarda recusou o dado cruzado e listou a tabela).
- Atomicidade: depois do aborto, FK de filial 0, FK de empresa 0 → **nada ficou aplicado pela metade**.
- Recuperação (corrigir a filial do produto → `migrate resolve --rolled-back` → `migrate deploy`): **concluiu**.
- Resultado: FK de filial validada = true; FK de empresa de `customers` validada = false (deve ser **false**: existe o cliente órfão); cliente órfão preservado = 1 → **o legado fica visível (NOT VALID) e nada foi apagado nem associado a empresa por suposição**.
- Linha NOVA com empresa inexistente: **recusada (P2003)** — NOT VALID protege tudo que entra daqui em diante.
- Banco temporário 4 removido: sim.
