import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { bearer, bypass, createWorld, destroyWorld, tokenFor, World } from './helpers/tenant-world';

/**
 * Cadastro de cliente (docs/CORTEX/policies/CLIENTE.md, 2026-09-27) — HTTP + Postgres reais.
 * Antes: o cadastro manual gravava CPF com dígito errado; "529.982.247-25" e "52998224725" viravam dois clientes;
 * WhatsApp/contato preferencial eram descartados pelo schema. Todos os casos abaixo falhariam no código antigo.
 */

/** CPF válido a partir de 9 dígitos (evita colisão entre execuções). */
function makeCpf(seed: number): string {
  const base = String(seed).padStart(9, '0').slice(-9).split('').map(Number);
  const dv = (nums: number[]) => {
    const sum = nums.reduce((acc, n, i) => acc + n * (nums.length + 1 - i), 0);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(base);
  const d2 = dv([...base, d1]);
  const d = [...base, d1, d2].join('');
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}
const digits = (s: string) => s.replace(/\D/g, '');

describe('Cadastro de cliente: CPF/CNPJ validado, duplicidade por dígitos, WhatsApp e contato preferencial (integração real)', () => {
  let world: World;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const seed = Number(String(Date.now()).slice(-8)) * 10;

  beforeAll(async () => {
    world = await createWorld();
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  });
  afterAll(async () => {
    auditSpy.mockRestore();
    if (world) await destroyWorld(world);
  });

  const operator = (co = world.A) => bearer(tokenFor(co, 1, 'OPERATOR'));
  const manager = () => bearer(tokenFor(world.A, 1, 'MANAGER'));
  const create = (body: Record<string, unknown>, headers = operator()) => request(app).post('/api/customers').set(headers).send(body);

  it('CPF com dígito verificador inválido é recusado (400 INVALID_DOCUMENT) e nada é gravado', async () => {
    const res = await create({ name: 'CPF Errado', document: '123.456.789-00' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DOCUMENT');
    expect(res.body.error).toMatch(/CPF\/CNPJ inválido/);
    expect(await bypass<number>(() => db.customer.count({ where: { companyId: world.A.companyId, name: 'CPF Errado' } }))).toBe(0);
  });

  it('CPF válido sem máscara é gravado no formato padrão; o mesmo CPF com ou sem máscara é duplicado (409)', async () => {
    const cpf = makeCpf(seed + 1);
    const first = await create({ name: 'Maria Silva', document: digits(cpf) });
    expect(first.status).toBe(201);
    expect(first.body.document).toBe(cpf);

    const masked = await create({ name: 'Maria de novo', document: cpf });
    expect(masked.status).toBe(409);
    expect(masked.body.code).toBe('CUSTOMER_DOCUMENT_DUPLICATE');
    expect(masked.body.error).toMatch(/Maria Silva/);
    const unmasked = await create({ name: 'Maria de novo', document: digits(cpf) });
    expect(unmasked.status).toBe(409);
  });

  it('duplicidade enxerga documento LEGADO gravado só com dígitos (sem migrar o dado)', async () => {
    const cpf = makeCpf(seed + 2);
    await bypass(() => db.customer.create({ data: { companyId: world.A.companyId, name: 'Legado Dígitos', document: digits(cpf) } }));
    const res = await create({ name: 'Novo com máscara', document: cpf });
    expect(res.status).toBe(409);
    const legacy = await bypass<any>(() => db.customer.findFirst({ where: { companyId: world.A.companyId, name: 'Legado Dígitos' } }));
    expect(legacy.document).toBe(digits(cpf)); // intocado
  });

  it('o mesmo CPF em OUTRA empresa é permitido; documento vazio continua permitido (vários)', async () => {
    const cpf = makeCpf(seed + 3);
    expect((await create({ name: 'Empresa A', document: cpf })).status).toBe(201);
    expect((await create({ name: 'Empresa B', document: cpf }, operator(world.B))).status).toBe(201);
    expect((await create({ name: 'Balcão 1', document: '' })).status).toBe(201);
    expect((await create({ name: 'Balcão 2', document: '' })).status).toBe(201);
  });

  it('CNPJ válido sem tipo informado vira pessoa jurídica', async () => {
    const res = await create({ name: 'Oficina Parceira', document: '11222333000181' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ document: '11.222.333/0001-81', customerType: 'BUSINESS' });
  });

  it('contato preferencial incoerente é recusado (WhatsApp sem número; e-mail sem e-mail; telefone sem telefone)', async () => {
    for (const [preferredContact, extra] of [
      ['WHATSAPP', { phone: '(11) 3333-4444' }],
      ['EMAIL', { whatsapp: '(11) 91234-5678' }],
      ['PHONE', { email: 'a@b.com' }],
    ] as const) {
      const res = await create({ name: `Incoerente ${preferredContact}`, preferredContact, ...extra });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PREFERRED_CONTACT_INCOHERENT');
    }
  });

  it('cadastro completo com WhatsApp, contato preferencial e nascimento aparece no detalhe, na lista e na busca do PDV', async () => {
    const cpf = makeCpf(seed + 4);
    const res = await create({
      name: 'João WhatsApp', document: cpf, phone: '(11) 3333-4444', whatsapp: '(11) 98888-7777', preferredContact: 'WHATSAPP',
      email: 'joao@example.com', birthDate: '1985-03-10', address: 'Rua A, 1', city: 'São Paulo', state: 'SP', zipCode: '01000-000',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ whatsapp: '(11) 98888-7777', preferredContact: 'WHATSAPP' });
    expect(new Date(res.body.birthDate).toISOString().slice(0, 10)).toBe('1985-03-10');

    const detail = await request(app).get(`/api/customers/${res.body.id}`).set(operator());
    expect(detail.body).toMatchObject({ whatsapp: '(11) 98888-7777', preferredContact: 'WHATSAPP' });
    const list = await request(app).get('/api/customers').query({ search: 'João WhatsApp' }).set(operator());
    expect(list.body.customers[0]).toMatchObject({ whatsapp: '(11) 98888-7777', preferredContact: 'WHATSAPP' });
    // busca rápida por CPF sem máscara encontra o gravado com máscara; busca pelo WhatsApp também
    const byDoc = await request(app).get('/api/customers/search').query({ search: digits(cpf) }).set(operator());
    expect(byDoc.body.customers.map((c: any) => c.id)).toContain(res.body.id);
    const byWhats = await request(app).get('/api/customers/search').query({ search: '98888-7777' }).set(operator());
    expect(byWhats.body.customers.map((c: any) => c.id)).toContain(res.body.id);
  });

  it('edição: limpar o WhatsApp de quem prefere WhatsApp é recusado; trocar para CPF inválido ou de outro cliente é recusado', async () => {
    const mine = makeCpf(seed + 5);
    const other = makeCpf(seed + 6);
    const c = (await create({ name: 'Editável', document: mine, whatsapp: '(11) 97777-6666', preferredContact: 'WHATSAPP' })).body;
    await create({ name: 'Dono do outro CPF', document: other });

    const clear = await request(app).put(`/api/customers/${c.id}`).set(manager()).send({ whatsapp: '' });
    expect(clear.status).toBe(400);
    expect(clear.body.code).toBe('PREFERRED_CONTACT_INCOHERENT');

    const invalid = await request(app).put(`/api/customers/${c.id}`).set(manager()).send({ document: '111.111.111-11' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('INVALID_DOCUMENT');

    const dup = await request(app).put(`/api/customers/${c.id}`).set(manager()).send({ document: digits(other) });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('CUSTOMER_DOCUMENT_DUPLICATE');

    const ok = await request(app).put(`/api/customers/${c.id}`).set(manager()).send({ document: digits(mine), preferredContact: 'PHONE', phone: '(11) 2222-3333', whatsapp: '' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ document: mine, preferredContact: 'PHONE', whatsapp: null });
  });

  it('cliente LEGADO com documento inválido continua editável (o formulário reenvia o mesmo documento)', async () => {
    const legacy = await bypass<any>(() => db.customer.create({ data: { companyId: world.A.companyId, name: 'Legado Inválido', document: '99988877766' } }));
    const res = await request(app).put(`/api/customers/${legacy.id}`).set(manager()).send({ name: 'Legado Inválido (editado)', document: '999.888.777-66' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Legado Inválido (editado)', document: '99988877766' });
  });
});
