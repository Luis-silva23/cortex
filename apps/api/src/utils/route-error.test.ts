import { routeErrorMessage } from './route-error';

describe('routeErrorMessage', () => {
  it('ZodError vira "campo: mensagem; ..." (não o blob JSON do Zod)', () => {
    const zod = { name: 'ZodError', issues: [{ path: ['costPrice'], message: 'Required' }, { path: [], message: 'Payload inválido' }] };
    expect(routeErrorMessage(zod)).toBe('costPrice: Required; Payload inválido');
  });

  it('P2002 usa a mensagem da rota (sem expor o erro cru do Prisma nem o caminho do servidor)', () => {
    const p2002 = Object.assign(new Error('Unique constraint failed on C:\\srv\\api\\src\\services\\product.service.ts'), { code: 'P2002' });
    const message = routeErrorMessage(p2002, { unique: 'Já existe um produto com este SKU' });
    expect(message).toBe('Já existe um produto com este SKU');
    expect(message).not.toContain('C:\\');
  });

  it('P2002 sem mensagem específica cai numa genérica', () => {
    expect(routeErrorMessage({ code: 'P2002' })).toBe('Já existe um registro com estes dados');
  });

  it('outros erros do Prisma viram o fallback — nunca o texto "Invalid `prisma.x.update()` invocation in <caminho>"', () => {
    const invocation = new Error('Invalid `prisma.product.update()` invocation in\nC:\\srv\\api\\src\\services\\product.service.ts:212');
    expect(routeErrorMessage(invocation, { fallback: 'Não foi possível salvar o produto' })).toBe('Não foi possível salvar o produto');

    const known = Object.assign(new Error('FK failed'), { code: 'P2003', name: 'PrismaClientKnownRequestError' });
    expect(routeErrorMessage(known)).toBe('Não foi possível salvar');
  });

  it('erro de negócio comum passa como veio', () => {
    expect(routeErrorMessage(new Error('Categoria informada não existe nesta empresa'))).toBe('Categoria informada não existe nesta empresa');
  });

  it('sem mensagem nenhuma usa o fallback', () => {
    expect(routeErrorMessage({}, { fallback: 'Falhou' })).toBe('Falhou');
    expect(routeErrorMessage(undefined)).toBe('Erro ao processar a requisição');
  });
});
