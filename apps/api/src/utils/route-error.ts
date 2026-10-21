/**
 * Mensagem de erro segura e legível para respostas 4xx de rotas que fazem
 * `res.status(400).json({ error })`.
 *
 * ACHADO DE AUDITORIA: um conflito na unique (SKU de produto, documento de
 * fornecedor) devolvia a mensagem CRUA do Prisma no corpo — com o caminho do
 * arquivo do servidor ("Invalid `prisma.product.update()` invocation in
 * C:\srv\...") — e um erro de validação virava um blob JSON do Zod. Quando as
 * telas passaram a mostrar `error` em vez do texto genérico, isso apareceu para
 * o usuário. Mesmo tratamento que customers.routes.ts já tinha.
 */
export function routeErrorMessage(error: any, options: { unique?: string; fallback?: string } = {}): string {
  if (error?.name === 'ZodError' && Array.isArray(error.issues)) {
    return error.issues
      .map((issue: any) => (issue.path?.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
      .join('; ');
  }

  if (error?.code === 'P2002') {
    return options.unique ?? 'Já existe um registro com estes dados';
  }

  const isPrisma =
    (typeof error?.code === 'string' && /^P\d{4}$/.test(error.code)) ||
    error?.name === 'PrismaClientKnownRequestError' ||
    error?.name === 'PrismaClientValidationError' ||
    (typeof error?.message === 'string' && error.message.includes('Invalid `prisma.'));
  if (isPrisma) {
    return options.fallback ?? 'Não foi possível salvar';
  }

  return error?.message ?? options.fallback ?? 'Erro ao processar a requisição';
}
