import { Router, Request, Response } from 'express';
import productService from '../services/product.service';
import { resolveListCompanyId } from '../utils/tenant-scope';
import { productSchema, updateProductSchema, productFilterSchema } from '@ln-system/shared/src/validators/pdv.validators';
import { routeErrorMessage } from '../utils/route-error';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { auditLog } from '../middleware/audit';
import { getUserPermissions } from '../middleware/permission';
import productBarcodeService from '../services/product-barcode.service';
import { deleteProductImage, getProductImage, getProductImageMeta, putProductImage } from '../services/product-image.service';
import { AuditAction } from '@ln-system/database';

const router = Router();

// Todas as rotas exigem autenticação e tenant
router.use(authMiddleware);
router.use(tenantIsolation);

/**
 * CUSTO é dado de gestão (margem, negociação com fornecedor): quem atende no balcão, na oficina ou só consulta (OPERATOR,
 * MECHANIC, VIEWER) vê preço de venda, mas NÃO o custo. Antes a lista, a busca por código e o detalhe devolviam `costPrice` a
 * qualquer usuário autenticado (e nenhum terminal — PDV, Balcão, mobile, TV — o usa). Só o payload de resposta é filtrado:
 * o cadastro e as telas de gestão (Admin Web: ADMIN/MANAGER) seguem iguais.
 */
const COST_VISIBLE_ROLES = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'];
// Quem compra negocia com fornecedor e precisa do custo: um atendente/mecânico a quem um PERFIL concedeu compras (o Admin Web
// pré-preenche o custo unitário do pedido com ele; sem isso o pedido sairia com custo 0). VIEWER nunca (somente leitura).
const COST_PERMISSIONS = ['purchases:manage', 'purchases:approve', 'purchases:receive'];
async function canSeeCost(user: { userId?: string; companyId?: string; branchId?: string | null; userType?: string } | undefined): Promise<boolean> {
  if (!user?.userType) return false;
  if (COST_VISIBLE_ROLES.includes(user.userType)) return true;
  if (user.userType === 'VIEWER' || !user.userId) return false;
  const granted = await getUserPermissions(user.userId, user.companyId, user.branchId ?? null);
  return COST_PERMISSIONS.some((p) => granted.includes(p));
}
function withoutCost<T>(canSee: boolean, payload: T): T {
  if (canSee) return payload;
  const strip = (p: any) => {
    if (p && typeof p === 'object' && 'costPrice' in p) {
      const { costPrice: _cost, ...rest } = p;
      return rest;
    }
    return p;
  };
  const anyPayload = payload as any;
  if (anyPayload && Array.isArray(anyPayload.products)) return { ...anyPayload, products: anyPayload.products.map(strip) };
  return strip(payload);
}

// Listar produtos
router.get('/', async (req: Request, res: Response) => {
  try {
    const filters = productFilterSchema.parse({
      ...req.query,
      page: req.query.page ? parseInt(req.query.page as string) : 1,
      limit: req.query.limit ? parseInt(req.query.limit as string) : 20,
    });

    const result = await productService.listProducts({
      ...filters,
      // Depois do spread: o schema aceita `companyId` da query e ele não pode
      // sobrescrever a empresa do token (a lista é servida de cache Redis).
      companyId: resolveListCompanyId((req as any).user, filters.companyId),
    });

    res.json(withoutCost(await canSeeCost((req as any).user), result));
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Buscar produto por código (SKU ou barcode)
router.get('/search/:code', async (req: Request, res: Response) => {
  try {
    const { code } = req.params;
    const companyId = (req as any).user.companyId;

    const product = await productService.findProductByCode(companyId, code);

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    return res.json(withoutCost(await canSeeCost((req as any).user), product));
  } catch (error: any) {
    // Código que identifica mais de um produto ativo: 409 com código estável (o PDV/Balcão mostram a mensagem).
    if (error?.code === 'CODE_AMBIGUOUS') return res.status(409).json({ error: error.message, code: 'CODE_AMBIGUOUS' });
    return res.status(400).json({ error: error.message });
  }
});

// Buscar produto por ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const companyId = (req as any).user.companyId;

    const product = await productService.getProductById(id, companyId);

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    return res.json(withoutCost(await canSeeCost((req as any).user), product));
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

// Consultar estoque de um produto
router.get('/:id/stock', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { branchId } = req.query;

    const stock = await productService.getProductStock(
      id,
      (req as any).user.companyId,
      branchId as string
    );

    res.json(stock);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Histórico de movimentações de um produto
router.get('/:id/movements', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { branchId, limit } = req.query;

    const movements = await productService.getProductMovements(
      id,
      (req as any).user.companyId,
      branchId as string,
      limit ? parseInt(limit as string) : 50
    );

    res.json({ movements });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});


// Erros de regra (AppError: 400/404/409 com código estável) voltam com o próprio status; o resto é 400 como no restante desta rota.
function barcodeError(res: Response, error: any) {
  const status = error?.statusCode && error.statusCode < 500 ? error.statusCode : 400;
  return res.status(status).json({ error: error.message, ...(typeof error?.code === 'string' ? { code: error.code } : {}) });
}

// Códigos de barras do produto (leitura aberta aos mesmos papéis que leem o produto).
router.get('/:id/barcodes', async (req: Request, res: Response) => {
  try {
    const barcodes = await productBarcodeService.list((req as any).user.companyId, req.params.id);
    return res.json({ barcodes });
  } catch (error: any) {
    return barcodeError(res, error);
  }
});

// Imagem opcional do produto (decisão 122). Leitura: os mesmos papéis que leem o produto, só da própria empresa; entrega como imagem
// inerte (tipo fixo pelo conteúdo validado, nosniff, sandbox, nunca como página).
function imageError(res: Response, error: any) {
  const status = error?.statusCode && error.statusCode < 500 ? error.statusCode : 400;
  return res.status(status).json({ error: error?.message ?? 'Imagem inválida.', ...(typeof error?.code === 'string' ? { code: error.code } : {}) });
}

router.get('/:id/image/meta', async (req: Request, res: Response) => {
  try {
    return res.json({ image: await getProductImageMeta((req as any).user.companyId, req.params.id) });
  } catch (error: any) {
    return imageError(res, error);
  }
});

router.get('/:id/image', async (req: Request, res: Response) => {
  try {
    const image = await getProductImage((req as any).user.companyId, req.params.id);
    const etag = `"${image.sha256}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', 'inline; filename="produto"');
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.setHeader('Content-Type', image.mimeType);
    return res.send(image.data);
  } catch (error: any) {
    return imageError(res, error);
  }
});

// ACHADO DE AUDITORIA: criar/editar/apagar produto não tinha NENHUMA trava
// de papel — qualquer usuário autenticado do tenant, inclusive VIEWER
// (somente leitura por convenção), podia reescrever `salePrice` via
// PUT /:id. Isso reabria por completo um problema já corrigido no PDV:
// sale.service.ts força `unitPrice = Number(product.salePrice)` no
// checkout exatamente para impedir preço arbitrário informado pelo
// cliente da API — mas essa correção só vale se ninguém sem autorização
// puder reescrever o `salePrice` gravado no produto. Sem esta trava, o
// mesmo ataque (vender um item caro por R$0,01) continuava possível, só
// que um passo antes (editando o cadastro em vez do item da venda).
// Mesmo padrão já usado em suppliers/partners/commission-rules/
// discount-rules — GET continua aberto (uso operacional legítimo, ex.:
// busca de produto no PDV), só escrita exige Gerência+.
router.use(requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'));

// Adicionar / desativar / reativar código de barras (Gerência+, como o resto da escrita de produto). A identidade do produto
// (id, SKU) não muda; (empresa, código) é único e conflito é 409 BARCODE_IN_USE.
router.post(
  '/:id/barcodes',
  auditLog(AuditAction.UPDATE, 'Product', {
    describe: (req, body) => ({ entityId: req.params.id, newValue: { operation: 'BARCODE_ADDED', productId: req.params.id, code: body?.barcode?.code ?? null } }),
  }),
  async (req: Request, res: Response) => {
    try {
      const barcode = await productBarcodeService.add((req as any).user.companyId, req.params.id, req.body?.code);
      return res.status(201).json({ barcode: { id: barcode.id, code: barcode.code, isActive: barcode.isActive } });
    } catch (error: any) {
      return barcodeError(res, error);
    }
  }
);

router.patch(
  '/:id/barcodes/:barcodeId',
  auditLog(AuditAction.UPDATE, 'Product', {
    describe: (req, body) => ({
      entityId: req.params.id,
      newValue: { operation: req.body?.isActive === false ? 'BARCODE_DEACTIVATED' : 'BARCODE_REACTIVATED', productId: req.params.id, barcodeId: req.params.barcodeId, code: body?.barcode?.code ?? null },
    }),
  }),
  async (req: Request, res: Response) => {
    try {
      if (typeof req.body?.isActive !== 'boolean') return res.status(400).json({ error: 'Informe isActive (true/false).', code: 'IS_ACTIVE_REQUIRED' });
      const barcode = await productBarcodeService.setActive((req as any).user.companyId, req.params.id, req.params.barcodeId, req.body.isActive);
      return res.json({ barcode: { id: barcode.id, code: barcode.code, isActive: barcode.isActive } });
    } catch (error: any) {
      return barcodeError(res, error);
    }
  }
);

// Enviar / substituir a imagem do produto (Gerência+, como o resto da escrita de produto). Corpo: { contentBase64 } (até 1 MB); o tipo
// vem do CONTEÚDO validado (PNG/JPEG/WebP), a imagem é saneada (sem metadados nem bytes sobrando) e a anterior é substituída.
router.put(
  '/:id/image',
  auditLog(AuditAction.UPDATE, 'Product', { describe: (req) => ({ entityId: req.params.id, newValue: { operation: 'IMAGE_SET', productId: req.params.id } }) }),
  async (req: Request, res: Response) => {
    try {
      const image = await putProductImage((req as any).user.companyId, req.params.id, (req as any).user.userId, req.body?.contentBase64);
      return res.json({ image });
    } catch (error: any) {
      return imageError(res, error);
    }
  }
);

router.delete(
  '/:id/image',
  auditLog(AuditAction.UPDATE, 'Product', { describe: (req) => ({ entityId: req.params.id, newValue: { operation: 'IMAGE_REMOVED', productId: req.params.id } }) }),
  async (req: Request, res: Response) => {
    try {
      return res.json(await deleteProductImage((req as any).user.companyId, req.params.id));
    } catch (error: any) {
      return imageError(res, error);
    }
  }
);

// Criar produto
router.post('/', auditLog(AuditAction.CREATE, 'Product'), async (req: Request, res: Response) => {
  try {
    const data = productSchema.parse({
      ...req.body,
      companyId: (req as any).user.companyId,
    });

    const product = await productService.createProduct(data);

    return res.status(201).json(product);
  } catch (error: any) {
    if (error?.code === 'BARCODE_IN_USE' || error?.code === 'BARCODE_INVALID') return barcodeError(res, error);
    return res.status(400).json({ error: routeErrorMessage(error, { unique: 'Já existe um produto com este SKU', fallback: 'Não foi possível salvar o produto' }) });
  }
});

// Atualizar produto
router.put('/:id', auditLog(AuditAction.UPDATE, 'Product'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const companyId = (req as any).user.companyId;
    const data = updateProductSchema.parse(req.body);

    const product = await productService.updateProduct(id, companyId, data);

    return res.json(product);
  } catch (error: any) {
    if (error?.code === 'BARCODE_IN_USE' || error?.code === 'BARCODE_INVALID') return barcodeError(res, error);
    return res.status(400).json({ error: routeErrorMessage(error, { unique: 'Já existe um produto com este SKU', fallback: 'Não foi possível salvar o produto' }) });
  }
});

// Deletar produto (soft delete)
router.delete('/:id', auditLog(AuditAction.DELETE, 'Product'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const companyId = (req as any).user.companyId;

    await productService.deleteProduct(id, companyId);

    res.json({ message: 'Product deleted successfully' });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

export default router;
