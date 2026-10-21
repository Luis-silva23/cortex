import { getApiErrorMessage } from './errors';

const httpError = (data: unknown) => ({ response: { data } });

describe('getApiErrorMessage', () => {
  it('lê { error: "texto" } (rotas com res.status().json)', () => {
    expect(getApiErrorMessage(httpError({ error: 'Invalid authorizer credentials' }), 'x')).toBe('Invalid authorizer credentials');
  });

  it('lê { message } (AppError via errorHandler) — antes as telas caíam no texto genérico', () => {
    expect(getApiErrorMessage(httpError({ message: 'Texto de negócio', code: 'ALGO', statusCode: 400 }), 'x')).toBe('Texto de negócio');
  });

  it('403 genérico (sem permissão) vira a frase padrão; 403 de negócio com texto próprio é preservado', () => {
    const padrao = 'Usuário sem autorização. Entre em contato com o administrador.';
    expect(getApiErrorMessage(httpError({ message: 'Acesso negado', code: 'FORBIDDEN', statusCode: 403 }), 'x')).toBe(padrao);
    expect(getApiErrorMessage({ response: { status: 403, data: { error: 'Acesso negado' } } }, 'x')).toBe(padrao);
    expect(getApiErrorMessage({ response: { status: 403, data: { error: 'Você não tem permissão para realizar esta ação', code: 'INSUFFICIENT_PERMISSIONS' } } }, 'x')).toBe(padrao);
    expect(getApiErrorMessage({ response: { status: 403, data: { error: 'Perfil somente leitura não executa esta ação', code: 'READ_ONLY_ROLE' } } }, 'x')).toBe(padrao);
    // não confunde: 403 com motivo de negócio continua com o próprio texto
    expect(getApiErrorMessage({ response: { status: 403, data: { message: 'Empresa desativada pelo administrador da plataforma' } } }, 'x')).toBe('Empresa desativada pelo administrador da plataforma');
    // e o texto "Acesso negado" fora de 403 não é reescrito
    expect(getApiErrorMessage({ response: { status: 400, data: { error: 'Acesso negado' } } }, 'x')).toBe('Acesso negado');
  });

  it('prefere `error` quando os dois existem', () => {
    expect(getApiErrorMessage(httpError({ error: 'a', message: 'b' }), 'x')).toBe('a');
  });

  it('lê envelope aninhado { error: { message } }', () => {
    expect(getApiErrorMessage(httpError({ error: { message: 'aninhado' } }), 'x')).toBe('aninhado');
  });

  it('transforma o JSON cru de um ZodError em texto legível', () => {
    const zod = JSON.stringify([
      { path: ['unitPrice'], message: 'Expected number, received string' },
      { path: ['items', 0, 'quantity'], message: 'Required' },
    ]);
    expect(getApiErrorMessage(httpError({ error: zod }), 'x')).toBe(
      'unitPrice: Expected number, received string; items.0.quantity: Required'
    );
  });

  it('JSON que não é lista de issues fica como veio', () => {
    expect(getApiErrorMessage(httpError({ error: '[não é json' }), 'x')).toBe('[não é json');
  });

  it('cai no fallback sem resposta, sem corpo ou com texto vazio', () => {
    expect(getApiErrorMessage(new Error('Network Error'), 'Falhou')).toBe('Falhou');
    expect(getApiErrorMessage(httpError(undefined), 'Falhou')).toBe('Falhou');
    expect(getApiErrorMessage(httpError({ error: '   ' }), 'Falhou')).toBe('Falhou');
    expect(getApiErrorMessage(undefined, 'Falhou')).toBe('Falhou');
  });
});
