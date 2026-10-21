import * as fs from 'fs';
import * as path from 'path';
import { DATABASE_UNAVAILABLE_MESSAGE, EXACT_MESSAGES, INTERNAL_ERROR_MESSAGE, maskSensitiveValues, PATTERN_MESSAGES, translateErrors, translateMessage } from './translate-errors';

/** Toda mensagem em inglês lançada/retornada pela API (fonte), com placeholders `${...}` trocados por um valor exemplo. */
function englishMessagesInSource(): Array<{ where: string; text: string }> {
  const root = path.join(__dirname, '..');
  const files: string[] = [];
  (function walk(d: string) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) {
        if (f !== '__mocks__') walk(p);
      } else if (/\.ts$/.test(f) && !/\.test\.ts$/.test(f) && f !== 'translate-errors.ts') files.push(p);
    }
  })(root);
  const EN = /\b(not found|already|cannot|can not|must|invalid|required|only|exceeds|insufficient|is not|are not|does not|failed|unauthorized|forbidden|not allowed|missing|exists|expired|limit|no longer|mismatch|belongs)\b/i;
  const PT = /[ãõçáéíóúâêôà]|\b(não|já|deve|inválid|obrigatóri|somente|apenas|encontrad)/i;
  const out: Array<{ where: string; text: string }> = [];
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const re = /(?:throw new \w*Error\(|error:\s*|message:\s*)(['`])([^'`]{6,})\1/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line))) {
        if (EN.test(m[2]) && !PT.test(m[2])) out.push({ where: `${path.relative(root, f)}:${i + 1}`, text: m[2].replace(/\$\{[^}]+\}/g, 'X1') });
      }
    });
  }
  return out;
}

describe('mensagens de erro em português (translate-errors)', () => {
  it('toda mensagem em inglês lançada pela API tem tradução (mensagem nova em inglês → traduzir antes de subir)', () => {
    const missing = englishMessagesInSource().filter(({ text }) => translateMessage(text) === text);
    expect(missing).toEqual([]);
  });

  it.each([
    ['Payment not found', 'Pagamento não encontrado'],
    ['Sale already cancelled', 'Venda já cancelada'],
    ['Cash register not found or already closed', 'Caixa não encontrado ou já fechado'],
    ['Payment amount exceeds remaining balance. Remaining: 12.5', 'O valor passa do saldo a pagar. Saldo: 12.5'],
    ['Insufficient stock at source branch. Available: 3', 'Estoque insuficiente na filial de origem. Disponível: 3'],
    ['Cannot transition from IN_PROGRESS to DELIVERED', 'Não é possível mudar a situação de IN_PROGRESS para DELIVERED'],
  ])('%s → %s', (en, pt) => {
    expect(translateMessage(en)).toBe(pt);
  });

  it('mensagem que não está no dicionário (ou já em português) passa intacta', () => {
    expect(translateMessage('Filial não encontrada')).toBe('Filial não encontrada');
    expect(translateMessage('Algo específico do domínio')).toBe('Algo específico do domínio');
  });

  it('nenhuma tradução ficou em inglês', () => {
    const translations = [...Object.values(EXACT_MESSAGES), ...PATTERN_MESSAGES.map(([, fn]) => fn('X1', 'X2'))];
    const englishLeft = translations.filter((t) => /\b(not found|already|cannot|must|invalid|required|failed)\b/i.test(t));
    expect(englishLeft).toEqual([]);
  });

  it('só traduz respostas de erro (status ≥ 400), preservando os demais campos', () => {
    const sent: any[] = [];
    const res: any = { statusCode: 404, json: (b: any) => sent.push(b) };
    translateErrors({} as any, res, () => undefined);
    res.json({ error: 'Sale not found', code: 'X' });
    res.statusCode = 200;
    res.json({ message: 'Sale not found' });
    expect(sent).toEqual([{ error: 'Venda não encontrada', code: 'X' }, { message: 'Sale not found' }]);
  });
});

describe('erros técnicos nunca chegam crus a quem opera', () => {
  const send = (status: number, body: any) => {
    const sent: any[] = [];
    const res: any = { statusCode: status, json: (b: any) => sent.push(b) };
    translateErrors({ originalUrl: '/api/x' } as any, res, () => undefined);
    res.json(body);
    return sent[0];
  };

  // Antes: GET /customers?page=abc → 400 com o texto do Prisma (caminho do arquivo no servidor, trecho do código, ids).
  it('erro cru do Prisma vira mensagem genérica (detalhe só no log)', () => {
    const prismaText =
      '\nInvalid `prisma.customer.findMany()` invocation in\nC:\\srv\\apps\\api\\src\\services\\customer.service.ts:38:23\n\n→ 38   prisma.customer.findMany({ skip: NaN';
    const out = send(400, { error: prismaText });
    expect(out.error).toBe(INTERNAL_ERROR_MESSAGE);
    expect(JSON.stringify(out)).not.toMatch(/prisma|\.ts:|srv/i);
  });

  // Achado de carga HML: POST /sales → 400 com `tx.product.findUnique()` (cliente de transação) e o caminho do disco do
  // servidor; a regra antiga só reconhecia `prisma.x.y()`.
  it.each([
    '\nInvalid `tx.product.findUnique()` invocation in\nC:\\Users\\luis.silva\\Desktop\\x\\apps\\api\\dist\\services\\sale.service.js:120:5\n\n→ 120 await tx.product.findUnique({',
    '\nInvalid `database_1.prisma.refreshToken.create()` invocation in\nC:\\srv\\apps\\api\\dist\\services\\auth.service.js:59:73',
    '\nInvalid `client.sale.create()` invocation in\n/app/apps/api/dist/services/sale.service.js:10:3',
    'falha em /opt/cortex/apps/api/dist/services/x.js:1:1',
    'PrismaClientKnownRequestError: P2002',
  ])('erro interno com cliente/caminho variado nunca vaza: %#', (text) => {
    const out = send(400, { error: text, message: text, details: text });
    expect(out.error).toBe(INTERNAL_ERROR_MESSAGE);
    expect(out.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(out.details).toBe(INTERNAL_ERROR_MESSAGE);
    expect(JSON.stringify(out)).not.toMatch(/prisma|tx\.|\.js:|\.ts:|dist|srv|Users|\/app\/|\/opt\//i);
  });

  // Transação expirada sob saturação (P2028): foi revertida por inteiro → 503 com repetição segura, nunca 400 com texto cru.
  it('transação expirada do Prisma vira 503 DATABASE_UNAVAILABLE sem texto técnico', () => {
    const text =
      '\nInvalid `tx.product.findUnique()` invocation in\nC:\\srv\\apps\\api\\dist\\services\\sale.service.js:120:5\n\nTransaction API error: Transaction already closed: A query cannot be executed on an expired transaction.';
    const sent: any[] = [];
    const res: any = { statusCode: 400, json: (b: any) => sent.push(b), status(c: number) { this.statusCode = c; return this; }, setHeader: () => undefined };
    translateErrors({ originalUrl: '/api/sales' } as any, res, () => undefined);
    res.json({ error: text });
    expect(res.statusCode).toBe(503);
    expect(sent[0]).toEqual({ error: DATABASE_UNAVAILABLE_MESSAGE, code: 'DATABASE_UNAVAILABLE' });
  });

  // Antes: GET /sales?page=-1 → 400 com a lista de problemas do Zod em inglês, serializada como JSON.
  it('lista de problemas do Zod em inglês vira texto em português por campo', () => {
    const zod = JSON.stringify(
      [
        { code: 'too_small', minimum: 1, type: 'number', inclusive: true, exact: false, message: 'Number must be greater than or equal to 1', path: ['page'] },
        { code: 'invalid_type', expected: 'string', received: 'undefined', path: ['name'], message: 'Required' },
        { code: 'too_small', minimum: 3, type: 'string', inclusive: true, message: 'Informe ao menos 3 letras', path: ['search'] },
      ],
      null,
      2
    );
    expect(send(400, { error: zod }).error).toBe('page: deve ser no mínimo 1; name: obrigatório; search: Informe ao menos 3 letras');
  });

  // Antes: POST /products sem corpo → "sku: Required; name: Required; …" (rota formata o ZodError, texto em inglês).
  it('problemas do Zod já formatados pela rota ("campo: mensagem") viram português', () => {
    expect(send(400, { error: 'sku: Required; salePrice: Expected number, received string; name: String must contain at least 2 character(s)' }).error).toBe(
      'sku: obrigatório; salePrice: valor inválido; name: mínimo de 2 caracteres'
    );
    expect(send(400, { error: 'email: Invalid email; qty: Number must be greater than 0' }).error).toBe('email: e-mail inválido; qty: deve ser maior que 0');
    // Mensagem própria (em português) no mesmo formato fica como está.
    expect(send(400, { error: 'document: CPF/CNPJ inválido' }).error).toBe('document: CPF/CNPJ inválido');
  });

  it('texto comum começando com "[" continua intacto', () => {
    expect(send(400, { error: '[Caixa] já fechado' }).error).toBe('[Caixa] já fechado');
  });
});

// Caos controlado (Postgres parado com a API no ar): produtos respondia 400 "confira os campos", o login 401 "não
// autenticado" e vendas 500 genérico — como se o erro fosse de quem opera.
describe('banco fora do ar vira 503 honesto', () => {
  const send = (status: number, body: any) => {
    const sent: any[] = [];
    const headers: Record<string, string> = {};
    const res: any = {
      statusCode: status,
      status(code: number) { this.statusCode = code; return this; },
      setHeader: (k: string, v: string) => { headers[k] = v; },
      json: (b: any) => sent.push(b),
    };
    translateErrors({ originalUrl: '/api/x' } as any, res, () => undefined);
    res.json(body);
    return { status: res.statusCode, body: sent[0], headers };
  };
  const unreachable = "\nInvalid `prisma.product.findMany()` invocation:\n\nCan't reach database server at `localhost:5432`";

  it.each([
    ['400 da rota (catch genérico)', 400, { error: unreachable }],
    ['401 do login', 401, { error: 'Não autenticado', message: unreachable }],
    ['500 do errorHandler (detalhe em desenvolvimento)', 500, { message: 'Erro de banco de dados', code: 'DATABASE_ERROR', statusCode: 500, details: unreachable }],
    ['readiness', 503, { status: 'not ready', error: 'Server has closed the connection.' }],
    ['400 da rota com a transação que não iniciou a tempo (rajada)', 400, { error: 'Transaction API error: Unable to start a transaction in the given time.' }],
  ])('%s → 503 DATABASE_UNAVAILABLE', (_l, status, body) => {
    const out = send(status, body);
    expect(out.status).toBe(503);
    expect(out.headers['Retry-After']).toBe('5');
    expect(out.body.error).toBe(DATABASE_UNAVAILABLE_MESSAGE);
    expect(out.body.code).toBe('DATABASE_UNAVAILABLE');
    expect(JSON.stringify(out.body)).not.toMatch(/prisma|localhost|5432/i);
  });

  it('mantém os demais campos (status do readiness)', () => {
    expect(send(503, { status: 'not ready', error: "Can't reach database server" }).body.status).toBe('not ready');
  });

  it('erro de validação comum não vira 503', () => {
    expect(send(400, { error: 'Cliente não encontrado' }).status).toBe(400);
  });
});

// O erro cru do Prisma repete os argumentos da consulta; ele vai para o log (não para a resposta) — sem os segredos.
describe('detalhe logado sem segredos', () => {
  it('mascara o valor de chaves sensíveis e mantém o resto', () => {
    const raw = 'prisma.user.update({ where: { id: "u1" }, data: { password: "$2b$10$abc", mfaSecret: "enc:v1:xyz", name: "Ana", accessToken: \'eyJ\' } })';
    const out = maskSensitiveValues(raw);
    expect(out).not.toMatch(/\$2b\$10\$abc|enc:v1:xyz|eyJ/);
    expect(out).toContain('name: "Ana"');
    expect(out).toContain('id: "u1"');
    expect(out).toContain('password: "[REDACTED]"');
  });
});
