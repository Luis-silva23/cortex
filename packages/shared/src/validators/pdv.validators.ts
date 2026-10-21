import { z } from 'zod';
import { isCentsExact } from '../../utils/installments';

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

export const stockMovementSchema = z.object({
  companyId: z.string(),
  branchId: z.string().optional(),
  userId: z.string(),
  productId: z.string(),
  // One of the Prisma `StockMovementType` enum values — kept as a plain
  // string since @ln-system/shared can't import @ln-system/database.
  movementType: z.string(),
  quantity: z.number(),
  notes: z.string().optional(),
  referenceType: z.string().optional(),
  referenceId: z.string().optional(),
  unitCost: z.number().optional(),
  totalCost: z.number().optional(),
});

// Field names/shape confirmed against StockService.adjustStock() in
// apps/api/src/services/stock.service.ts: `data: { companyId, branchId?,
// productId, newQuantity, reason, userId }`. This sets stock to an
// absolute target quantity (the service diffs against the current balance
// itself) — not a delta, hence `newQuantity`, not `quantity`.
export const stockAdjustmentSchema = z.object({
  companyId: z.string().optional(), // overwritten by the route from req.user
  branchId: z.string().optional(),
  productId: z.string(),
  newQuantity: z.number(),
  reason: z.string(),
  userId: z.string().optional(), // overwritten by the route from req.user
});

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export const paymentSchema = z.object({
  companyId: z.string(),
  saleId: z.string(),
  // Dinheiro em centavos exatos: fração de centavo (R$ 10,005) é recusada — a divisão em parcelas e as somas são em centavos inteiros.
  amount: z.number().positive().refine(isCentsExact, { message: 'Valor com mais de duas casas decimais (fração de centavo)' }),
  // Dinheiro: valor entregue pelo cliente, quando diferente de `amount` (troco = recebido − aplicado).
  receivedAmount: z.number().positive().refine(isCentsExact, { message: 'Valor com mais de duas casas decimais (fração de centavo)' }).optional(),
  // Controle de cédulas: composição do valor recebido (validada no servidor contra o Real e o total).
  cashBreakdown: z.array(z.object({ value: z.number().positive(), quantity: z.number().int().positive() })).max(20).optional(),
  paymentMethod: z.string(),
  // 1 = à vista. Zero, negativo e fração são recusados já na borda; o máximo é da política de parcelamento da empresa/filial.
  installments: z.number().int().min(1, 'Quantidade de parcelas deve ser no mínimo 1').default(1),
  transactionId: z.string().optional(),
  notes: z.string().optional(),
  authorizationCode: z.string().optional(),
  cardBrand: z.string().optional(),
  cardLastDigits: z.string().optional(),
  nsuHost: z.string().optional(),
  nsuTef: z.string().optional(),
});

export const paymentFilterSchema = z.object({
  companyId: z.string().optional(),
  saleId: z.string().optional(),
  status: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().default(20),
});

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

// companyId is optional here on purpose: purchase-orders.routes.ts does
// `createPurchaseOrderSchema.parse(req.body)` on the RAW body, then injects
// companyId from req.user only afterward when calling the service — it's
// never actually present at parse time, so requiring it here made every
// real POST /purchase-orders fail with "companyId Required" (confirmed by
// live testing). Same fix applied below to createPayableSchema,
// createReceivableSchema, motorcycleSchema, createServiceOrderSchema, and
// supplierSchema — all five follow the same parse-then-inject pattern.
export const createPurchaseOrderSchema = z.object({
  companyId: z.string().optional(),
  branchId: z.string(),
  supplierId: z.string(),
  expectedDelivery: z.string().optional(), // converted to Date at the route
  notes: z.string().optional(),
  items: z.array(
    z.object({
      productId: z.string(),
      quantity: z.number(),
      unitCost: z.number(),
    })
  ),
});

// NOTE: item field name confirmed as `itemId` (not `purchaseOrderItemId`)
// by direct inspection of PurchaseOrderService.receive() in
// apps/api/src/services/purchase-order.service.ts (data.items:
// Array<{ itemId: string; receivedQuantity: number }>).
export const receivePurchaseOrderSchema = z.object({
  items: z.array(
    z.object({
      itemId: z.string(),
      receivedQuantity: z.number(),
    })
  ),
  invoice: z
    .object({
      invoiceNumber: z.string(),
      series: z.string(),
      accessKey: z.string(),
      issueDate: z.string(),
      totalAmount: z.number(),
    })
    .optional(),
  branchId: z.string(),
});

// NOTE: shape corrected from the original spec guess (which described an
// `items` array) after inspecting PurchaseOrderService.returnToSupplier()
// in apps/api/src/services/purchase-order.service.ts, whose signature is
// `data: { branchId: string; userId: string; productId: string; quantity: number; reason: string }`
// and purchase-orders.routes.ts POST /:id/return, which does
// `returnToSupplierSchema.parse(req.body)` then spreads the result into
// that call (overwriting `userId` with the authenticated user's id). This
// is a single-item return, not a batch of items.
export const returnToSupplierSchema = z.object({
  branchId: z.string(),
  productId: z.string(),
  quantity: z.number(),
  reason: z.string(),
  userId: z.string().optional(), // overwritten by the route with the authenticated user's id
});

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

// ACHADO DE AUDITORIA (verificado por HTTP real): os formulários do PDV
// (CustomerSearchModal) e do Admin Web enviam campos opcionais em branco
// como string vazia. Aqui isso (1) reprovava `email: ''` em `.email()` — o
// cadastro de balcão SEM e-mail (o caso comum) voltava 400 "Invalid email";
// (2) gravava `document: ''`, e a unique [companyId, document] faz o SEGUNDO
// cliente sem documento estourar um erro cru do Prisma (vazando o caminho do
// arquivo no corpo da resposta). String vazia/só espaços significa "não
// informado": vira undefined (NULL no banco, que a unique aceita repetido).
const emptyToUndefined = (value: unknown) => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  return value;
};
const optionalText = z.preprocess(emptyToUndefined, z.string().optional());

// Na EDIÇÃO, string vazia significa "limpar o campo" (NULL no banco). Com
// emptyToUndefined o Prisma ignora a chave, então esvaziar telefone/e-mail/
// endereço "salvava com sucesso" e o valor antigo continuava.
const emptyToNull = (value: unknown) => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  return value;
};
const clearableText = z.preprocess(emptyToNull, z.string().nullable().optional());

// Cadastro de cliente (docs/CORTEX/policies/CLIENTE.md, 2026-09-27): WhatsApp e contato preferencial. A coerência
// "prefere WhatsApp ⇒ tem WhatsApp" e o dígito do CPF/CNPJ são conferidos no customer.service (a edição precisa
// comparar com o que já está gravado).
export const CONTACT_CHANNELS = ['PHONE', 'WHATSAPP', 'EMAIL', 'SMS', 'IN_PERSON'] as const;
const contactChannel = z.enum(CONTACT_CHANNELS, {
  errorMap: () => ({ message: 'Contato preferencial inválido (use telefone, WhatsApp, e-mail, SMS ou presencial)' }),
});
// WhatsApp: DDD + número (10 ou 11 dígitos), com ou sem o 55 do país.
const whatsappRule = (v: string) => {
  const d = v.replace(/\D/g, '');
  return d.length >= 10 && d.length <= 13;
};
const WHATSAPP_MESSAGE = 'WhatsApp inválido: informe DDD + número (ex.: (11) 91234-5678)';
// Data de nascimento: 'AAAA-MM-DD' (ou ISO). Não pode ser futura nem anterior a 1900.
const birthDateRule = (d: Date) => !Number.isNaN(d.getTime()) && d.getTime() <= Date.now() && d.getUTCFullYear() >= 1900;
const BIRTH_DATE_MESSAGE = 'Data de nascimento inválida (não pode ser futura nem anterior a 1900)';

// Também aceita os campos do model Customer que o Admin Web já enviava mas o
// schema (não estrito) descartava em silêncio — CPF/CNPJ, tipo e endereço
// digitados no formulário nunca chegavam ao banco.
export const customerSchema = z.object({
  companyId: z.string(),
  name: z.string().trim().min(1),
  document: optionalText,
  phone: optionalText,
  mobile: optionalText,
  whatsapp: z.preprocess(emptyToUndefined, z.string().refine(whatsappRule, WHATSAPP_MESSAGE).optional()),
  preferredContact: z.preprocess(emptyToUndefined, contactChannel.optional()),
  birthDate: z.preprocess(emptyToUndefined, z.coerce.date().refine(birthDateRule, BIRTH_DATE_MESSAGE).optional()),
  email: z.preprocess(emptyToUndefined, z.string().email().optional()),
  customerType: z.enum(['INDIVIDUAL', 'BUSINESS']).optional(),
  address: optionalText,
  city: optionalText,
  state: optionalText,
  zipCode: optionalText,
  notes: optionalText,
});
// Edição: nome (se vier) continua obrigatório; os demais campos aceitam
// limpar ('' → null). A unique [companyId, document] aceita NULL repetido.
export const updateCustomerSchema = z.object({
  name: z.string().trim().min(1).optional(),
  document: clearableText,
  phone: clearableText,
  mobile: clearableText,
  whatsapp: z.preprocess(emptyToNull, z.string().refine(whatsappRule, WHATSAPP_MESSAGE).nullable().optional()),
  preferredContact: z.preprocess(emptyToNull, contactChannel.nullable().optional()),
  birthDate: z.preprocess(emptyToNull, z.coerce.date().refine(birthDateRule, BIRTH_DATE_MESSAGE).nullable().optional()),
  email: z.preprocess(emptyToNull, z.string().email().nullable().optional()),
  customerType: z.enum(['INDIVIDUAL', 'BUSINESS']).optional(),
  address: clearableText,
  city: clearableText,
  state: clearableText,
  zipCode: clearableText,
  notes: clearableText,
  // Reativar cliente desativado (DELETE é soft delete). Sem este campo o PUT
  // "salvava com sucesso" e o `isActive` era descartado — não havia caminho de volta.
  isActive: z.boolean().optional(),
});

export const customerSearchSchema = z.object({
  search: z.string(),
  limit: z.coerce.number().int().positive().default(10),
});

// ---------------------------------------------------------------------------
// Cash register
// ---------------------------------------------------------------------------

export const openCashRegisterSchema = z.object({
  companyId: z.string(),
  branchId: z.string(),
  userId: z.string(),
  // Número do terminal físico (1 PDV = 1 caixa); a coluna é Int.
  registerNumber: z.number().int('deve ser um número inteiro').min(1, 'deve ser de 1 a 999').max(999, 'deve ser de 1 a 999'),
  openingAmount: z.number().finite().min(0, 'não pode ser negativo').max(99_999_999.99),
  notes: z.string().optional(),
});

export const closeCashRegisterSchema = z.object({
  actualAmount: z.number(),
  notes: z.string().optional(),
  // Informado por forma de pagamento (CASH, CREDIT_CARD, PIX, convênios…); a soma precisa bater com actualAmount.
  declaredByMethod: z.record(z.number()).nullish(),
  // Obrigatório quando o informado diverge do esperado (política cash.requireDifferenceReason).
  differenceReason: z.string().max(1000).nullish(),
});

export const cashMovementSchema = z.object({
  // 'WITHDRAWAL' | 'DEPOSIT' in practice, but the route re-validates that
  // itself, so keep this schema-level field as a plain string.
  movementType: z.string(),
  amount: z.number().positive(),
  notes: z.string().optional(),
  userId: z.string(),
});

export const cashWithdrawalSchema = z.object({
  amount: z.number().positive(),
  reason: z.string(),
  authorizerNumericId: z.number(),
  authorizerPassword: z.string(),
  authorizerMfaCode: z.string().optional(),
});

export const cashRegisterFilterSchema = z.object({
  companyId: z.string().optional(),
  branchId: z.string().optional(),
  status: z.enum(['OPEN', 'CLOSED']).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().default(20),
});

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export const productSchema = z.object({
  companyId: z.string(),
  // '' (formulário sem categoria) era gravado como string vazia e violava a FK
  // products_categoryId_fkey → 400. Vazio = sem categoria.
  categoryId: z.preprocess(emptyToUndefined, z.string().optional()),
  sku: z.string(),
  barcode: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  brand: z.string().optional(),
  application: z.string().optional(),
  location: z.string().optional(),
  costPrice: z.number(),
  salePrice: z.number(),
  minStock: z.number().optional(),
  maxStock: z.number().optional(),
  unit: z.string(),
  allowNegativeStock: z.boolean().optional(),
});
// Na edição: `categoryId: null` (ou '') REMOVE a categoria — antes o schema só
// aceitava string, então "Sem categoria" era sempre 400. `isActive` permite
// ativar/desativar pelo formulário (o campo existe no modelo, mas o schema o
// descartava e a tela lia um `status` que nunca existiu).
export const updateProductSchema = productSchema
  .omit({ companyId: true, categoryId: true })
  .partial()
  .extend({
    categoryId: z.preprocess((value) => (value === '' ? null : value), z.string().nullable().optional()),
    isActive: z.boolean().optional(),
    // Campos opcionais que a tela permite esvaziar (null limpa; ausente não mexe).
    barcode: clearableText,
    description: clearableText,
    brand: clearableText,
    application: clearableText,
    location: clearableText,
    maxStock: z.number().nullable().optional(),
  });

// Filtros de GET /products — vêm da QUERY STRING (tudo string). Chave que o
// schema não conhece é descartada pelo z.object, então todo filtro que o
// `listProducts` suporta e uma tela usa precisa estar aqui.
const queryBoolean = (value: unknown) => (value === 'true' ? true : value === 'false' ? false : value);

export const productFilterSchema = z.object({
  companyId: z.string().optional(),
  categoryId: z.string().optional(),
  search: z.string().optional(),
  // Texto contido no campo (sem diferenciar maiúsculas) — filtros da tela de produtos.
  brand: z.string().optional(),
  application: z.string().optional(),
  // "true"/"false" da query; z.boolean() puro recusava a string e a rota dava 400.
  isActive: z.preprocess(queryBoolean, z.boolean().optional()),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().default(20),
});

// ---------------------------------------------------------------------------
// Financial (payables / receivables)
// ---------------------------------------------------------------------------

export const createPayableSchema = z.object({
  companyId: z.string().optional(), // see note on createPurchaseOrderSchema
  branchId: z.string().optional(),
  supplierId: z.string().optional(),
  description: z.string().min(1),
  amount: z.number().positive(),
  dueDate: z.string(),
});

export const createReceivableSchema = z.object({
  companyId: z.string().optional(), // see note on createPurchaseOrderSchema
  branchId: z.string().optional(),
  customerId: z.string().optional(),
  description: z.string().min(1),
  amount: z.number().positive(),
  dueDate: z.string(),
});

export const reverseAccountSchema = z.object({
  reason: z.string(),
});

// ---------------------------------------------------------------------------
// Motorcycles
// ---------------------------------------------------------------------------

export const motorcycleSchema = z.object({
  companyId: z.string().optional(), // see note on createPurchaseOrderSchema
  customerId: z.string(),
  vehicleType: z.enum(['MOTORCYCLE', 'CAR']).optional(),
  licensePlate: z.string().optional(),
  chassisNumber: z.string().optional(),
  brand: z.string().min(1),
  model: z.string().min(1),
  year: z.number().optional(),
  color: z.string().optional(),
  engineNumber: z.string().optional(),
  kilometerReading: z.number().nonnegative(), // required, but 0 is valid
});
export const updateMotorcycleSchema = motorcycleSchema
  .omit({ companyId: true, customerId: true })
  .partial();

// ---------------------------------------------------------------------------
// Service orders
// ---------------------------------------------------------------------------

export const createServiceOrderSchema = z.object({
  companyId: z.string().optional(), // see note on createPurchaseOrderSchema
  branchId: z.string(),
  customerId: z.string(),
  motorcycleId: z.string(),
  entryKilometer: z.number(),
  fuelLevel: z.string().optional(),
  visibleDamages: z.string().optional(),
  personalItems: z.string().optional(),
  entryNotes: z.string().optional(),
  estimatedDelivery: z.string().optional(),
});

export const addServiceOrderItemSchema = z.object({
  itemType: z.enum(['SERVICE', 'PART']),
  productId: z.string().optional(), // only for PART
  description: z.string().min(1),
  // Positiva e finita: `z.number()` puro aceitava negativo — preço negativo em
  // serviço era desconto arbitrário e quantidade negativa de peça já consumida
  // virava ENTRADA de estoque fantasma (`quantity: -(-n)`). Preço 0 continua
  // valendo (cortesia); PART com productId usa o preço do catálogo de qualquer forma.
  quantity: z.number().positive().finite(),
  unitPrice: z.number().min(0).finite(),
});

// ---------------------------------------------------------------------------
// Garantia da OS (docs/CORTEX/policies/GARANTIA.md, 2026-09-27). A decisão vem no corpo do encerramento
// (POST /service-orders/:id/status { toStatus: 'ENCERRADA', warranty }). Com prazo e km vale o que ocorrer primeiro.
// ---------------------------------------------------------------------------
export const WARRANTY_COVERAGES = ['SERVICE', 'PART', 'SERVICE_AND_PART'] as const;
export const WARRANTY_DURATION_UNITS = ['DAYS', 'MONTHS', 'YEARS'] as const;
const WARRANTY_MAX_BY_UNIT = { DAYS: 3650, MONTHS: 120, YEARS: 10 } as const;
const optionalLongText = z.preprocess(emptyToUndefined, z.string().max(2000, 'Máximo de 2000 caracteres').optional());

export const warrantyDecisionSchema = z
  .discriminatedUnion(
    'decision',
    [
      z.object({ decision: z.literal('NONE') }),
      z.object({
        decision: z.literal('GRANTED'),
        coverage: z.enum(WARRANTY_COVERAGES, { errorMap: () => ({ message: 'Tipo de garantia inválido (serviço, peça ou serviço + peça)' }) }),
        durationValue: z.number({ invalid_type_error: 'Informe o prazo da garantia' }).int('Prazo em número inteiro').min(1, 'O prazo mínimo é 1'),
        durationUnit: z.enum(WARRANTY_DURATION_UNITS, { errorMap: () => ({ message: 'Unidade do prazo inválida (dias, meses ou anos)' }) }),
        kmLimit: z.number().int('Limite de km em número inteiro').min(1, 'O limite de km mínimo é 1').max(1_000_000, 'Limite de km máximo: 1.000.000').nullish(),
        startKm: z.number().min(0, 'Km inicial não pode ser negativo').max(9_999_999).nullish(),
        coveredItemIds: z.array(z.string().min(1)).max(500).optional(),
        conditions: optionalLongText,
        notes: optionalLongText,
      }),
    ],
    { errorMap: () => ({ message: 'Informe a decisão de garantia: NONE (sem garantia) ou GRANTED (com garantia)' }) }
  )
  .superRefine((v, ctx) => {
    if (v.decision === 'GRANTED' && v.durationValue > WARRANTY_MAX_BY_UNIT[v.durationUnit]) {
      ctx.addIssue({ code: 'custom', path: ['durationValue'], message: `Prazo máximo: ${WARRANTY_MAX_BY_UNIT[v.durationUnit]} ${v.durationUnit === 'DAYS' ? 'dias' : v.durationUnit === 'MONTHS' ? 'meses' : 'anos'}` });
    }
  });
export type WarrantyDecisionInput = z.infer<typeof warrantyDecisionSchema>;

export const transitionServiceOrderStatusSchema = z.object({
  toStatus: z.string(),
  notes: z.string().optional(),
  // Só no encerramento (ENCERRADA). Obrigatória quando a política exige decisão (warranty.requireDecisionOnClose).
  warranty: warrantyDecisionSchema.optional(),
});

export const openWarrantyClaimSchema = z.object({
  description: z.string({ required_error: 'Descreva a ocorrência' }).trim().min(5, 'Descreva a ocorrência (mínimo 5 caracteres)').max(2000),
  kmAtClaim: z.number().min(0, 'Km não pode ser negativo').max(9_999_999).nullish(),
});

export const decideWarrantyClaimSchema = z.object({
  status: z.enum(['ACCEPTED', 'REJECTED', 'RESOLVED'], { errorMap: () => ({ message: 'Decisão inválida (aceitar, recusar ou resolver)' }) }),
  decisionNotes: z.string({ required_error: 'Informe as notas da decisão' }).trim().min(5, 'Informe as notas da decisão (mínimo 5 caracteres)').max(2000),
  newServiceOrderId: z.string().uuid('OS de retorno inválida').nullish(),
});

export const warrantyListQuerySchema = z.object({
  customerId: z.string().uuid('Cliente inválido').optional(),
  motorcycleId: z.string().uuid('Veículo inválido').optional(),
  serviceOrderId: z.string().uuid('OS inválida').optional(),
  status: z.enum(['ACTIVE', 'EXPIRED'], { errorMap: () => ({ message: 'Situação inválida (ACTIVE ou EXPIRED)' }) }).optional(),
  km: z.coerce.number().min(0).max(9_999_999).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

export const createSaleSchema = z.object({
  companyId: z.string(),
  branchId: z.string(),
  userId: z.string(),
  // O PDV envia `customerId: null` na venda de balcão sem cliente (o caso comum): `optional()` puro
  // rejeitava null com 400 e o JSON cru do zod na tela. `nullish()` aceita ausente E null.
  customerId: z.string().nullish(),
  cashRegisterId: z.string(),
  // Convênio escolhido no PDV. Faltava no schema: o zod DESCARTAVA a chave, o servidor nunca aplicava o
  // convênio que o operador via no total, e um partnerId de outra empresa passava despercebido.
  partnerId: z.string().nullish(),
  // Descontos: nunca negativos (um "desconto" negativo AUMENTA o preço e escapava do limite de
  // alçada) e percentual de 0 a 100. Antes `z.number()` puro aceitava qualquer valor.
  discountPercent: z.number().min(0).max(100).finite().optional(),
  discountAmount: z.number().min(0).finite().optional(),
  discountAuthorizerNumericId: z.number().nullish(),
  discountAuthorizerPassword: z.string().nullish(),
  discountAuthorizerMfaCode: z.string().nullish(),
  // Motivo do desconto: obrigatório (validado no serviço) quando o desconto passa o limite livre da política.
  discountReason: z.string().max(500).nullish(),
  notes: z.string().nullish(),
  items: z
    .array(
      z.object({
        productId: z.string(),
        // Positiva e finita: quantidade zero/negativa gerava total negativo e ENTRADA de estoque
        // fantasma (mesma classe já corrigida em addServiceOrderItemSchema).
        quantity: z.number().positive().finite(),
        unitPrice: z.number().min(0).finite(),
        discountAmount: z.number().min(0).finite().optional(),
        discountPercent: z.number().min(0).max(100).finite().optional(),
        notes: z.string().optional(),
      })
    )
    .min(1),
});

export const saleFilterSchema = z.object({
  companyId: z.string().optional(),
  branchId: z.string().optional(),
  status: z.string().optional(),
  customerId: z.string().optional(),
  // Número da venda (igualdade) ou parte do nome do cliente — a caixa de busca
  // da tela de vendas. Chave desconhecida é descartada pelo z.object.
  search: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().default(20),
});

export const cancelSaleSchema = z.object({
  reason: z.string(),
  authorizerNumericId: z.number(),
  authorizerPassword: z.string(),
  authorizerMfaCode: z.string().optional(),
  userId: z.string(),
});

// Item shape confirmed by SaleService.returnSale() em
// apps/api/src/services/sale.service.ts: `items?: Array<{ saleItemId: string; quantity: number }>`.
// ACHADO DE AUDITORIA: `items` era obrigatório aqui, mas o service sempre
// suportou omiti-lo para devolução TOTAL (devolve o que resta de cada
// item) — e é exatamente assim que o PDV chama (pdv-desktop/src/pages/
// SalesPage.tsx::handleReturnSale -> api.returnSale(id, reason), sem
// items). Resultado: todo clique em "Devolver Venda" no PDV retornava 400
// ("items: Required") antes de sequer chegar no service. Corrigido para
// `.optional()`, alinhando o contrato com o que o service e a UI real já
// esperavam. authorizerNumericId/Password/MfaCode adicionados junto —
// devolução agora exige a mesma dupla autorização de cancelSaleSchema
// (mesmo estorno financeiro, mesma exigência de segurança).
export const returnSaleSchema = z.object({
  reason: z.string(),
  items: z
    .array(
      z.object({
        saleItemId: z.string(),
        quantity: z.number(),
      })
    )
    .optional(),
  authorizerNumericId: z.number(),
  authorizerPassword: z.string(),
  authorizerMfaCode: z.string().optional(),
  userId: z.string(),
});

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export const supplierSchema = z.object({
  companyId: z.string().optional(), // see note on createPurchaseOrderSchema
  name: z.string().min(1),
  document: z.string().min(1),
  tradeName: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  mobile: z.string().optional(),
  address: z.string().optional(),
  addressNumber: z.string().optional(),
  addressComplement: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
  notes: z.string().optional(),
});
export const updateSupplierSchema = supplierSchema.omit({ companyId: true }).partial();
