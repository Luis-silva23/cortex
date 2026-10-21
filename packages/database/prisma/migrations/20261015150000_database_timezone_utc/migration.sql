-- FUSO DO BANCO = UTC (2026-10-15, revisão do banco — achado F-04).
-- PROBLEMA: o banco rodava em America/Sao_Paulo. As 273 colunas `timestamp without time zone` guardam UTC (o Prisma grava sempre UTC), mas os 110
-- `DEFAULT CURRENT_TIMESTAMP` convertem pelo fuso da SESSÃO: linha criada por DEFAULT do banco (SQL manual, script, migração de dados) saía 3 h
-- adiantada/atrasada em relação às criadas pela aplicação — comparações de vencimento/expiração erradas sem erro algum.
-- VARREDURA: a aplicação não faz INSERT cru e todo SQL cru com data converte explicitamente (`AT TIME ZONE 'UTC'` em dashboard-management,
-- observability e outbox), então UTC na sessão não muda nenhum resultado; o fuso de negócio continua vindo de `company.timezone`.
-- EFEITO: vale para NOVAS sessões do banco atual (conexões já abertas só mudam ao reconectar); NÃO altera nenhum dado existente.
-- Se o papel que migra não for dono do banco, a migração apenas avisa (o operador aplica `ALTER DATABASE … SET timezone TO 'UTC'`, ver PRODUCAO.md).
-- ROLLBACK: ALTER DATABASE <banco> RESET timezone.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC');
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'sem privilégio para ALTER DATABASE: aplicar manualmente ALTER DATABASE % SET timezone TO ''UTC'' (docs/CORTEX/PRODUCAO.md)', current_database();
END $$;
