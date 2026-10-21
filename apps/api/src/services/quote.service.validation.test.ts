/**
 * ACHADOS DE AUDITORIA em QuoteService (levantados ao preparar a UI de
 * Orçamentos, que depende de o backend recusar entrada inválida):
 * - itens sem nenhuma validação (quantidade 0/negativa/NaN, preço negativo,
 *   descrição vazia, itemType inválido, valores acima do Decimal do schema);
 * - `productId` de outra empresa aceito (QuoteItem.productId é escalar solto);
 * - `approved` ausente/"false" gravava uma decisão que ninguém tomou;
 * - `versionNumber`/`entryKilometer` inválidos viravam erro cru do Prisma;
 * - `branchId` da conversão em OS não era checado contra a empresa.
 */

const customerFindFirstMock = jest.fn();
const motorcycleFindFirstMock = jest.fn();
const branchFindFirstMock = jest.fn();
const productFindManyMock = jest.fn();
const quoteFindFirstMock = jest.fn();
const quoteCreateMock = jest.fn();
const quoteVersionFindFirstMock = jest.fn();
// QuoteService.create() agora aloca quoteNumber dentro de runInTransaction
// (advisory lock — ver o comentário em quote.service.ts), então
// `tx.quote.create`/`tx.quote.findFirst`, não os do client de nível
// superior. `transactionMock` simula `basePrisma.$transaction(cb)`
// entregando um `tx` cujas chamadas caem nos MESMOS mocks (o teste só
// observa `quoteCreateMock`, não precisa distinguir tx de fora-de-tx).
const transactionMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    customer: { findFirst: customerFindFirstMock },
    motorcycle: { findFirst: motorcycleFindFirstMock },
    branch: { findFirst: branchFindFirstMock },
    product: { findMany: productFindManyMock },
    quote: { findFirst: quoteFindFirstMock, create: quoteCreateMock },
    quoteVersion: { findFirst: quoteVersionFindFirstMock },
    serviceOrder: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: transactionMock,
  })),
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));

import { QuoteService } from './quote.service';

const validItem = { itemType: 'SERVICE' as const, description: 'Troca de óleo', quantity: 1, unitPrice: 80 };

function createInput(items: any[]) {
  return {
    companyId: 'company-A',
    branchId: 'branch-1',
    customerId: 'customer-1',
    motorcycleId: 'moto-1',
    createdBy: 'user-1',
    items,
  };
}

describe('QuoteService.create — validação dos itens', () => {
  const service = new QuoteService();

  beforeEach(() => {
    jest.clearAllMocks();
    customerFindFirstMock.mockResolvedValue({ id: 'customer-1' });
    motorcycleFindFirstMock.mockResolvedValue({ id: 'moto-1', customerId: 'customer-1' });
    branchFindFirstMock.mockResolvedValue({ id: 'branch-1' });
    productFindManyMock.mockResolvedValue([]);
    quoteFindFirstMock.mockResolvedValue(null);
    quoteCreateMock.mockResolvedValue({ id: 'quote-1' });
    transactionMock.mockImplementation(async (cb: any) =>
      cb({ $executeRaw: jest.fn().mockResolvedValue(1), quote: { findFirst: quoteFindFirstMock, create: quoteCreateMock } })
    );
  });

  it.each([
    ['quantidade zero', { ...validItem, quantity: 0 }, 'quantity must be a number greater than zero'],
    ['quantidade negativa', { ...validItem, quantity: -2 }, 'quantity must be a number greater than zero'],
    ['quantidade NaN', { ...validItem, quantity: NaN }, 'quantity must be a number greater than zero'],
    ['quantidade como string', { ...validItem, quantity: '2' as any }, 'quantity must be a number greater than zero'],
    ['preço negativo', { ...validItem, unitPrice: -1 }, 'unitPrice must be a number greater than or equal to zero'],
    ['preço infinito', { ...validItem, unitPrice: Infinity }, 'unitPrice must be a number greater than or equal to zero'],
    ['descrição vazia', { ...validItem, description: '   ' }, 'description is required'],
    ['itemType inválido', { ...validItem, itemType: 'OUTRO' as any }, 'itemType must be SERVICE or PART'],
    ['valor acima do limite do Decimal', { ...validItem, quantity: 2, unitPrice: 60_000_000 }, 'value exceeds the supported limit'],
  ])('recusa item com %s e não grava nada', async (_label, item, message) => {
    await expect(service.create(createInput([item]))).rejects.toThrow(message);
    expect(quoteCreateMock).not.toHaveBeenCalled();
  });

  it('aponta QUAL item é inválido (Item 2)', async () => {
    await expect(service.create(createInput([validItem, { ...validItem, quantity: 0 }]))).rejects.toThrow('Item 2:');
  });

  it('recusa total acima do limite mesmo com cada item dentro do limite', async () => {
    const big = { ...validItem, quantity: 1, unitPrice: 60_000_000 };
    await expect(service.create(createInput([big, { ...big }]))).rejects.toThrow('Quote total exceeds the supported limit');
  });

  it('recusa productId que não pertence à empresa', async () => {
    productFindManyMock.mockResolvedValueOnce([]); // nenhum encontrado na empresa

    await expect(
      service.create(createInput([{ itemType: 'PART', productId: 'produto-de-outra-empresa', description: 'Óleo', quantity: 1, unitPrice: 45 }]))
    ).rejects.toThrow('One or more products were not found in this company');
    expect(productFindManyMock).toHaveBeenCalledWith({
      where: { id: { in: ['produto-de-outra-empresa'] }, companyId: 'company-A' },
      select: { id: true },
    });
    expect(quoteCreateMock).not.toHaveBeenCalled();
  });

  it('aceita itens válidos (serviço + peça do catálogo) e calcula os totais como antes', async () => {
    productFindManyMock.mockResolvedValueOnce([{ id: 'product-1' }]);

    await service.create(
      createInput([
        validItem,
        { itemType: 'PART', productId: 'product-1', description: 'Óleo 10W40', quantity: 2, unitPrice: 45 },
      ])
    );

    const created = quoteCreateMock.mock.calls[0][0].data.versions.create;
    expect(created.laborTotal).toBe(80);
    expect(created.partsTotal).toBe(90);
    expect(created.totalAmount).toBe(170);
    expect(created.discountAmount).toBe(0);
  });
});

describe('QuoteService.send / decide / convertToServiceOrder — entradas inválidas', () => {
  const service = new QuoteService();

  beforeEach(() => {
    jest.clearAllMocks();
    branchFindFirstMock.mockResolvedValue({ id: 'branch-1' });
  });

  it.each([NaN, 0, -1, 1.5])('send recusa versionNumber inválido (%s) sem consultar o banco', async (versionNumber) => {
    await expect(service.send('quote-1', 'company-A', versionNumber as number)).rejects.toThrow(
      'versionNumber must be a positive integer'
    );
    expect(quoteFindFirstMock).not.toHaveBeenCalled();
  });

  it.each([undefined, 'false', 0, null])('decide recusa approved que não é booleano (%p)', async (approved) => {
    await expect(
      service.decide('quote-1', 'company-A', { versionNumber: 1, approved: approved as any, decidedBy: 'user-1' })
    ).rejects.toThrow('approved must be true or false');
    expect(quoteFindFirstMock).not.toHaveBeenCalled();
  });

  it('decide recusa versionNumber inválido', async () => {
    await expect(
      service.decide('quote-1', 'company-A', { versionNumber: NaN, approved: true, decidedBy: 'user-1' })
    ).rejects.toThrow('versionNumber must be a positive integer');
  });

  it('conversão recusa quilometragem inválida (NaN/negativa)', async () => {
    quoteFindFirstMock.mockResolvedValue({ id: 'quote-1', status: 'APPROVED', customerId: 'c', motorcycleId: 'm', quoteNumber: 1 });

    for (const entryKilometer of [NaN, -5]) {
      await expect(
        service.convertToServiceOrder('quote-1', 'company-A', { branchId: 'branch-1', entryKilometer, userId: 'user-1' })
      ).rejects.toThrow('entryKilometer must be a number greater than or equal to zero');
    }
  });

  it('conversão recusa branchId que não pertence à empresa (antes a OS nascia na filial informada)', async () => {
    quoteFindFirstMock.mockResolvedValue({ id: 'quote-1', status: 'APPROVED', customerId: 'c', motorcycleId: 'm', quoteNumber: 1 });
    branchFindFirstMock.mockResolvedValueOnce(null);

    await expect(
      service.convertToServiceOrder('quote-1', 'company-A', { branchId: 'filial-de-outra-empresa', entryKilometer: 1000, userId: 'user-1' })
    ).rejects.toThrow('Branch not found in this company');
    expect(quoteVersionFindFirstMock).not.toHaveBeenCalled();
  });
});
