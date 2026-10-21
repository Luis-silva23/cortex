/**
 * Teste de isolamento multi-tenant no nível de serviço/repositório.
 *
 * O ponto crítico: companyId precisa estar dentro do WHERE da query,
 * não aplicado como filtro depois de já ter buscado o registro (o que
 * abriria brecha para vazamento de dados entre empresas, ex.: side-channel
 * por tempo de resposta, ou erro de omissão em outra query que reuse a função).
 */

const findFirstMock = jest.fn();

jest.mock('@prisma/client', () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      sale: { findFirst: findFirstMock },
      cashRegister: { findFirst: findFirstMock },
      product: { findFirst: findFirstMock },
    })),
    Prisma: {},
  };
});

jest.mock('./product.service', () => ({
  __esModule: true,
  default: { checkStock: jest.fn() },
}));

const checkSaleDiscountMock = jest.fn();
jest.mock('./discount.service', () => ({
  __esModule: true,
  checkSaleDiscount: checkSaleDiscountMock,
}));

import { SaleService } from './sale.service';

describe('SaleService.getSaleById — isolamento por tenant', () => {
  const saleService = new SaleService();

  it('inclui companyId diretamente no WHERE da query (nunca filtra depois)', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 'sale-1', companyId: 'company-A' });

    await saleService.getSaleById('sale-1', 'company-A');

    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'sale-1', companyId: 'company-A' }),
      })
    );
  });

  it('inclui cliente, vendedor (só id/nome), itens com produto e pagamentos — o detalhe do admin-web depende disso', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 'sale-1', companyId: 'company-A' });

    await saleService.getSaleById('sale-1', 'company-A');

    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          customer: true,
          user: { select: { id: true, name: true } },
          items: { include: { product: true } },
          payments: true,
        }),
      })
    );
  });

  it('retorna null quando a venda pertence a outra empresa (Prisma não encontra o registro)', async () => {
    // Simula o comportamento real do Postgres: WHERE id = X AND companyId = Y
    // não encontra nada se a venda "sale-1" pertencer à empresa B.
    findFirstMock.mockResolvedValueOnce(null);

    const result = await saleService.getSaleById('sale-1', 'company-B');

    expect(result).toBeNull();
    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'sale-1', companyId: 'company-B' }),
      })
    );
  });
});

describe('SaleService.createSale — não permite referenciar caixa/produto de outra empresa', () => {
  const saleService = new SaleService();

  it('rejeita quando o caixa aberto não pertence à empresa informada', async () => {
    // Sem companyId no WHERE do cashRegister, uma venda da Empresa A podia
    // usar o caixa aberto da Empresa B. Simulamos o Postgres não encontrando
    // nada quando companyId não bate.
    findFirstMock.mockResolvedValueOnce(null); // cashRegister.findFirst

    await expect(
      saleService.createSale({
        companyId: 'company-A',
        branchId: 'branch-1',
        userId: 'user-1',
        userType: 'OPERATOR',
        cashRegisterId: 'register-of-company-B',
        items: [],
      })
    ).rejects.toThrow('Cash register is not open');

    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'register-of-company-B',
          companyId: 'company-A',
          status: 'OPEN',
        }),
      })
    );
  });

  it('rejeita item de venda cujo produto pertence a outra empresa', async () => {
    // 1ª chamada: cashRegister.findFirst (sucesso, caixa da própria empresa e filial)
    findFirstMock.mockResolvedValueOnce({ id: 'register-1', companyId: 'company-A', branchId: 'branch-1', userId: 'user-1' });
    // 2ª chamada: product.findFirst (produto pertence à empresa B, não é encontrado
    // quando filtrado por companyId: 'company-A')
    findFirstMock.mockResolvedValueOnce(null);

    await expect(
      saleService.createSale({
        companyId: 'company-A',
        branchId: 'branch-1',
        userId: 'user-1',
        userType: 'OPERATOR',
        cashRegisterId: 'register-1',
        items: [{ productId: 'product-of-company-B', quantity: 1, unitPrice: 10 }],
      })
    ).rejects.toThrow('Product product-of-company-B not found');
  });
});

describe('SaleService.createSale — REGRESSÃO: preço do item sempre vem do catálogo', () => {
  const saleService = new SaleService();

  // ACHADO DE AUDITORIA: `item.unitPrice` do corpo da requisição era usado
  // sem nenhuma comparação com `product.salePrice`, contornando por completo
  // o sistema de limite/aprovação de desconto (checkSaleDiscount só governa
  // discountAmount/discountPercent, campos separados) — um cliente malicioso
  // podia vender qualquer produto por centavos só informando um unitPrice
  // baixo, sem tocar em discountAmount, sem nenhuma aprovação gerencial.
  //
  // A prova: `checkSaleDiscount` (mockado) recebe `subtotal` = grossSubtotal
  // (quantity * unitPrice efetivo). Se o preço adulterado pelo cliente
  // (0.01) ainda estivesse sendo usado, `subtotal` chegaria como 0.01; com a
  // correção, chega como 500 (product.salePrice), independente do que o
  // cliente mandou.
  it('ignora um unitPrice adulterado pelo cliente — checkSaleDiscount recebe o subtotal calculado com product.salePrice', async () => {
    findFirstMock.mockResolvedValueOnce({ id: 'register-1', companyId: 'company-A', branchId: 'branch-1', userId: 'user-1' }); // cashRegister
    findFirstMock.mockResolvedValueOnce({
      id: 'product-1',
      companyId: 'company-A',
      name: 'Peça cara',
      sku: 'SKU-1',
      salePrice: 500,
    }); // product

    (require('./product.service').default.checkStock as jest.Mock).mockResolvedValueOnce({ available: true });
    checkSaleDiscountMock.mockResolvedValueOnce({ allowed: true, requiresApproval: false });

    // O resto do fluxo (numeração sequencial / transação de criação) não
    // está mockado neste arquivo (fora do escopo deste teste, que só precisa
    // provar o que chega até checkSaleDiscount) — deixamos falhar depois.
    await saleService
      .createSale({
        companyId: 'company-A',
        branchId: 'branch-1',
        userId: 'user-1',
        userType: 'OPERATOR',
        cashRegisterId: 'register-1',
        items: [{ productId: 'product-1', quantity: 1, unitPrice: 0.01, discountAmount: 0 }],
      })
      .catch(() => {});

    expect(checkSaleDiscountMock).toHaveBeenCalledWith(
      expect.objectContaining({ subtotal: 500, totalDiscount: 0 })
    );
  });
});
