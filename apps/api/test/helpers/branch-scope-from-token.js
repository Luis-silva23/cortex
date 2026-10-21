// Mock de UNIDADE de `services/branch-scope.service` para os testes de ROTA que mockam `@ln-system/database` (decisão 153).
// Em produção o escopo vem do banco (`users.branchId` + `user_branches`) a cada requisição; o teste de rota só quer exercitar a regra de papel da rota, então aqui o escopo é a
// filial do token (o comportamento anterior à decisão 153). O escopo REAL tem prova própria: `branch-scope.service.test.ts` (leitura/cálculo), `tenant.test.ts` (middleware, falha ⇒ 503)
// e `multi-branch-access.integration.test.ts` (banco real, papel real, revogação com o mesmo token).
// Uso (no topo do teste, antes dos imports):  jest.mock('../services/branch-scope.service', () => require('../../test/helpers/branch-scope-from-token'));
const actual = jest.requireActual('../../src/services/branch-scope.service');

module.exports = {
  ...actual,
  resolveBranchScope: async (user) => ({
    branchIds: user && user.branchId ? [user.branchId] : [],
    activeBranchId: user && user.branchId ? user.branchId : null,
  }),
};
