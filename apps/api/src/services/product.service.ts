import { prisma, runInTransaction } from '@ln-system/database';
import { Prisma } from '@prisma/client';
import { AppError } from '@ln-system/shared';
import cacheService, { CacheKeys, CacheTTL } from './cache.service';
import { stockLedger } from './stock-ledger';
import { productBarcodeService } from './product-barcode.service';
import { visibilityScope, seesAllBranches, requesterBranchIds } from '../utils/cache-scope';


export class ProductService {
  // `branchId` no Product não tem foreign key no schema (é só uma String?
  // opcional — null significa "disponível em todas as filiais") e o
  // validador zod só checa formato UUID, não posse. Sem esta checagem, um
  // usuário da própria empresa podia gravar em `Product.branchId` o UUID de
  // uma filial de OUTRA empresa (RLS ainda protege leitura/escrita da linha
  // do produto em si, que continua correta por `companyId`, mas o valor de
  // `branchId` gravado ficaria apontando para uma filial que não pertence a
  // ninguém que o produto deveria servir — quebra a regra de negócio "a
  // filial informada precisa ser da mesma empresa do produto").
  private async assertBranchBelongsToCompany(branchId: string | null | undefined, companyId: string) {
    if (!branchId) return;
    const branch = await prisma.branch.findFirst({ where: { id: branchId, companyId }, select: { id: true } });
    if (!branch) {
      throw new Error('Filial informada não pertence à empresa do produto');
    }
  }

  // Mesma classe da filial: `categoryId` aponta para uma categoria de OUTRA
  // empresa se o UUID for de outro tenant — a FK só exige que a linha exista.
  // A mensagem não revela se o id existe em outro tenant.
  private async assertCategoryBelongsToCompany(categoryId: string | null | undefined, companyId: string) {
    if (!categoryId) return;
    const category = await prisma.category.findFirst({ where: { id: categoryId, companyId }, select: { id: true } });
    if (!category) {
      throw new Error('Categoria informada não existe nesta empresa');
    }
  }

  // Criar produto
  async createProduct(data: Prisma.ProductUncheckedCreateInput) {
    await this.assertBranchBelongsToCompany(data.branchId as string | null | undefined, data.companyId as unknown as string);
    await this.assertCategoryBelongsToCompany((data as any).categoryId, data.companyId as unknown as string);

    // Código de barras é TEXTO (zeros à esquerda preservados) e identifica UM produto na empresa: o produto e o código
    // principal entram na MESMA transação (conflito → 409 BARCODE_IN_USE e nada é gravado).
    const rawBarcode = (data as any).barcode;
    const normalizedData = rawBarcode === undefined || rawBarcode === null || String(rawBarcode).trim() === '' ? { ...data, barcode: null } : { ...data, barcode: String(rawBarcode).trim() };
    const companyIdForBarcode = data.companyId as unknown as string;
    // Sem código de barras não há nada a sincronizar: grava direto (sem transação extra).
    const product = normalizedData.barcode
      ? await runInTransaction(async (tx: any) => {
          const created = await tx.product.create({ data: normalizedData, include: { category: true } });
          await productBarcodeService.syncPrimary(tx, companyIdForBarcode, created.id, created.barcode, null);
          return created;
        })
      : await prisma.product.create({ data: normalizedData, include: { category: true } });

    // Invalidar cache de listagem de produtos
    await cacheService.invalidate(`products:${data.companyId}:*`);

    return product;
  }

  // Listar produtos com filtros e paginação (COM CACHE)
  async listProducts(filters: {
    companyId: string;
    search?: string;
    categoryId?: string;
    category?: string;
    brand?: string;
    application?: string;
    sku?: string;
    barcode?: string;
    branchId?: string;
    isActive?: boolean;
    productType?: string;
    page?: number;
    limit?: number;
  }) {
    const {
      companyId,
      search,
      categoryId,
      category,
      brand,
      application,
      sku,
      barcode,
      branchId,
      isActive,
      productType,
      page = 1,
      limit = 20,
    } = filters;

    // Gerar chave de cache única baseada nos filtros
    // O resultado depende de QUEM pede (a RLS de products é por filial): sem o escopo
    // na chave, o primeiro a consultar definia a lista de todos — o operador da filial
    // 2 recebia os produtos da filial 1 e o administrador ficava sem os da filial 2.
    const cacheKey = `products:${companyId}:${visibilityScope()}:${page}:${limit}:${search || ''}:${categoryId || ''}:${category || ''}:${brand || ''}:${application || ''}:${sku || ''}:${barcode || ''}:${branchId || ''}:${isActive}:${productType || ''}`;

    // Tentar obter do cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return cached;
    }

    const where: Prisma.ProductWhereInput = {
      companyId,
      ...(categoryId && { categoryId }),
      ...(branchId && { branchId }),
      ...(isActive !== undefined && { isActive }),
      ...(productType && { productType: productType as any }),
      ...(category && { category: { is: { name: { contains: category, mode: 'insensitive' } } } }),
      ...(brand && { brand: { contains: brand, mode: 'insensitive' } }),
      ...(application && { application: { contains: application, mode: 'insensitive' } }),
      ...(sku && { sku: { contains: sku, mode: 'insensitive' } }),
      ...(barcode && {
        // AND: o filtro `search` abaixo também usa OR e um sobrescreveria o outro
        AND: [
          {
            OR: [
              { barcode: { contains: barcode, mode: 'insensitive' } },
              { barcodes: { some: { code: { contains: barcode, mode: 'insensitive' }, isActive: true } } },
            ],
          },
        ],
      }),
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { sku: { contains: search, mode: 'insensitive' } },
          { barcode: { contains: search, mode: 'insensitive' } },
          { barcodes: { some: { code: { contains: search, mode: 'insensitive' }, isActive: true } } },
          { brand: { contains: search, mode: 'insensitive' } },
          { application: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        // Usar select para campos específicos ao invés de trazer tudo
        select: {
          id: true,
          companyId: true,
          branchId: true,
          categoryId: true,
          sku: true,
          barcode: true,
          name: true,
          brand: true,
          application: true,
          location: true,
          productType: true,
          costPrice: true,
          salePrice: true,
          minStock: true,
          unit: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
          category: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { name: 'asc' },
      }),
      prisma.product.count({ where }),
    ]);

    const result = {
      products,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
    
    // Cachear resultado
    await cacheService.set(cacheKey, result, CacheTTL.PRODUCTS_LIST);

    return result;
  }

  // O cache de detalhe é `product:<id>` (sem empresa nem filial na chave) e não passa
  // pela RLS: só vale se o produto é da empresa que pede E visível à filial de quem pede
  // (produto sem filial é da empresa toda; papel de empresa inteira vê todas).
  private cachedProductIsVisible(cached: { companyId?: string; branchId?: string | null }, companyId: string): boolean {
    if (companyId && cached.companyId !== companyId) return false;
    if (seesAllBranches()) return true;
    return cached.branchId == null || requesterBranchIds().includes(cached.branchId);
  }

  // Buscar produto por ID (COM CACHE)
  async getProductById(id: string, companyId: string) {
    const cacheKey = CacheKeys.product(id);
    
    // Tentar obter do cache. A chave é só o id do produto (sem a empresa) e o
    // cache não passa pela RLS: o valor só vale para a empresa dona dele — sem
    // essa conferência, quem conhecesse o id de um produto de outra empresa lia
    // o produto (com preço de custo) direto do cache.
    const cached = await cacheService.get(cacheKey);
    if (cached && this.cachedProductIsVisible(cached as { companyId?: string; branchId?: string | null }, companyId)) {
      return cached;
    }

    const product = await prisma.product.findFirst({
      where: { id, companyId },
      include: {
        category: true,
        comboItems: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                sku: true,
                salePrice: true,
              },
            },
          },
        },
      },
    });
    
    if (product) {
      await cacheService.set(cacheKey, product, CacheTTL.PRODUCT_DETAILS);
    }
    
    return product;
  }

  // Atualizar produto
  async updateProduct(id: string, companyId: string, data: Prisma.ProductUpdateInput) {
    // Confirma que o produto pertence à empresa do requisitante ANTES de
    // escrever. Antes desta correção, `where: { id }` sozinho permitia que
    // qualquer empresa atualizasse (e, pior, "sequestrasse" — o `data`
    // sobrescrevia companyId para o da empresa atacante) o produto de
    // qualquer outra empresa apenas acertando o UUID.
    const existing = await prisma.product.findFirst({
      where: { id, companyId },
      select: { id: true, barcode: true },
    });
    if (!existing) {
      throw new Error('Product not found');
    }

    if ('branchId' in data) {
      await this.assertBranchBelongsToCompany(data.branchId as string | null | undefined, companyId);
    }
    if ('categoryId' in data) {
      // null/'' remove a categoria (permitido); um id precisa ser desta empresa.
      await this.assertCategoryBelongsToCompany((data as any).categoryId, companyId);
    }

    // Mudou o código de barras principal? Mesma transação: o novo vira código ativo (conflito → 409), o antigo é desativado
    // (fica no histórico). A identidade do produto (id, SKU) não muda por causa do código.
    const touchesBarcode = 'barcode' in (data as object);
    const nextBarcode = touchesBarcode ? (data as any).barcode : undefined;
    const normalizedUpdate = touchesBarcode
      ? { ...data, barcode: nextBarcode === null || nextBarcode === undefined || String(nextBarcode).trim() === '' ? null : String(nextBarcode).trim() }
      : data;
    const product = touchesBarcode
      ? await runInTransaction(async (tx: any) => {
          const updated = await tx.product.update({ where: { id }, data: normalizedUpdate, include: { category: true } });
          await productBarcodeService.syncPrimary(tx, companyId, id, (normalizedUpdate as any).barcode, existing.barcode);
          return updated;
        })
      : await prisma.product.update({ where: { id }, data: normalizedUpdate, include: { category: true } });

    // Invalidar caches
    await cacheService.delete(CacheKeys.product(id));
    await cacheService.invalidate(`products:${companyId}:*`);

    return product;
  }

  // Soft delete (desativar)
  async deleteProduct(id: string, companyId: string) {
    const existing = await prisma.product.findFirst({
      where: { id, companyId },
      select: { id: true },
    });
    if (!existing) {
      throw new Error('Product not found');
    }

    const product = await prisma.product.update({
      where: { id },
      data: { isActive: false },
    });
    
    // Invalidar caches
    await cacheService.delete(CacheKeys.product(id));
    await cacheService.invalidate(`products:${companyId}:*`);
    
    return product;
  }

  // Consultar estoque atual de um produto (calculado via movimentações) - COM CACHE
  async getProductStock(
    productId: string,
    companyId: string,
    branchId?: string
  ): Promise<{ productId: string; branchId?: string; balance: number; movements: number }> {
    // O saldo é calculado sob a RLS de quem pede e o antigo `product:<id>:stock[:filial]`
    // não tinha empresa nem escopo: outra empresa lia o saldo pelo cache (o cache era
    // consultado ANTES de conferir que o produto é da empresa) e um `?branchId=` forjado
    // gravava um saldo parcial sob a chave da filial de outro. O prefixo `product:<id>:stock`
    // é mantido porque a invalidação (`product:<id>:stock*`) casa por ele.
    const cacheKey = `${CacheKeys.productStock(productId)}:${companyId}:${visibilityScope()}:${branchId ?? ''}`;

    // Tentar obter do cache
    const cached = await cacheService.get<{
      productId: string;
      branchId?: string;
      balance: number;
      movements: number;
    }>(cacheKey);
    if (cached) {
      return cached;
    }

    // O produto precisa pertencer à empresa do requisitante — antes desta
    // correção, qualquer empresa conseguia consultar o saldo de estoque de
    // um produto de outra empresa apenas acertando o UUID.
    const productExists = await prisma.product.findFirst({
      where: { id: productId, companyId },
      select: { id: true },
    });
    if (!productExists) {
      throw new Error('Product not found');
    }
    
    // Mesmo livro e mesma regra de stockService.getBalance (antes havia uma cópia daqui que já divergiu uma vez —
    // somava ajuste negativo como entrada), calculado no banco em vez de trazer todas as movimentações.
    const { balance, count } = await stockLedger.read({ productId, companyId, branchId });

    const result = {
      productId,
      branchId,
      balance,
      movements: count,
    };
    
    // Cachear por 3 minutos
    await cacheService.set(cacheKey, result, CacheTTL.CURRENT_STOCK);
    
    return result;
  }

  // Histórico de movimentações de um produto
  async getProductMovements(productId: string, companyId: string, branchId?: string, limit = 50) {
    return await prisma.stockMovement.findMany({
      where: {
        productId,
        companyId,
        ...(branchId && { branchId }),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  // Verificar se produto tem estoque disponível
  async checkStock(productId: string, companyId: string, quantity: number, branchId?: string): Promise<{
    available: boolean;
    currentStock: number;
    requested: number;
  }> {
    const product = await prisma.product.findFirst({
      where: { id: productId, companyId },
      select: {
        id: true,
        allowNegativeStock: true,
      },
    });

    if (!product) {
      throw new Error('Product not found');
    }

    const { balance } = await this.getProductStock(productId, companyId, branchId);
    
    return {
      available: product.allowNegativeStock || balance >= quantity,
      currentStock: balance,
      requested: quantity,
    };
  }

  // Buscar produto por SKU ou código de barras. O código tem de identificar UM produto: antes era `findFirst` sem ordem sobre
  // OR(sku, barcode) e um código que fosse o SKU de um produto e o código de barras de outro (ou o código de barras de dois
  // produtos) devolvia um deles ao acaso — venda do produto errado. Agora: entre os ATIVOS, mais de um produto distinto é
  // ambiguidade (409 CODE_AMBIGUOUS, corrigir o cadastro); sem ativo, o inativo (o chamador avisa) sai de forma determinística.
  async findProductByCode(companyId: string, code: string) {
    // Códigos de barras vêm da tabela `product_barcodes` (vários por produto, ativos/inativos). Legado: `products.barcode`
    // também conta — duplicatas antigas que ficaram só nessa coluna continuam sendo ambíguas (409), e um código DESATIVADO
    // não resolve pelo produto que o tinha.
    const barcodeRow = await prisma.productBarcode.findUnique({
      where: { companyId_code: { companyId, code } },
      select: { productId: true, isActive: true },
    });
    const byCode: Prisma.ProductWhereInput[] = !barcodeRow
      ? [{ barcode: code }]
      : barcodeRow.isActive
        ? [{ id: barcodeRow.productId }, { barcode: code }]
        : [{ barcode: code, NOT: { id: barcodeRow.productId } }];
    const matches = await prisma.product.findMany({
      where: {
        companyId,
        OR: [{ sku: code }, ...byCode],
      },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: 5,
      select: {
        id: true,
        companyId: true,
        sku: true,
        barcode: true,
        name: true,
        description: true,
        brand: true,
        application: true,
        location: true,
        productType: true,
        salePrice: true,
        unit: true,
        isActive: true,
        allowNegativeStock: true,
        category: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
    const active = matches.filter((p) => p.isActive);
    if (active.length > 1) {
      throw new AppError(
        'Este código identifica mais de um produto ativo. Corrija o cadastro (SKU/código de barras duplicado) antes de vender.',
        409,
        'CODE_AMBIGUOUS'
      );
    }
    return active[0] ?? matches[0] ?? null;
  }
}

export default new ProductService();
