/**
 * Resolução e validação do banco de TESTE (sem efeitos colaterais — funções puras).
 * Ver o comentário de setupIntegrationEnv.ts para o porquê.
 */

/** Nome do banco de uma URL Postgres (sem senha, sem query string). */
export function databaseNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/** Banco de teste derivado do de desenvolvimento: `lnsystem_db` → `lnsystem_test`, `x` → `x_test`. */
export function deriveTestDatabaseUrl(devUrl: string): string {
  const u = new URL(devUrl);
  const name = databaseNameOf(devUrl);
  const testName = /_test$/i.test(name) ? name : /_db$/i.test(name) ? name.replace(/_db$/i, '_test') : `${name}_test`;
  u.pathname = `/${testName}`;
  return u.toString();
}

/** Lança se o banco NÃO for de teste, ou se for o mesmo do banco de desenvolvimento. */
export function assertIsTestDatabase(url: string, devUrl?: string): void {
  const name = databaseNameOf(url);
  if (!/test/i.test(name)) {
    throw new Error(
      `SUÍTE DE INTEGRAÇÃO RECUSADA: o banco "${name}" não parece ser de teste (o nome precisa conter "test"). ` +
        'Os testes de integração criam e APAGAM dados — nunca rodam no banco de desenvolvimento/demonstração. ' +
        'Defina TEST_DATABASE_URL (ou crie o banco derivado com `npm run test:integration:prepare`).'
    );
  }
  if (devUrl && databaseNameOf(devUrl) === name && new URL(devUrl).host === new URL(url).host) {
    throw new Error(`SUÍTE DE INTEGRAÇÃO RECUSADA: o banco de teste ("${name}") é o mesmo do DATABASE_URL de desenvolvimento.`);
  }
}
