import * as path from 'path';
import {
  buildClosePayload,
  buildCreatePayload,
  CloseForm,
  EVENT_LABEL,
  flowStepIndex,
  NewReturnForm,
  NOT_WARRANTY_NOTICE,
  OUTCOME_LABEL,
  REASON_LABEL,
  STATUS_LABEL,
  validateReason,
  visibleActions,
} from './supplier-returns';
import { canAccessPath, getActiveHref, moduleForPath } from './navigation';
import { ADMIN_ROOT, findFixedColors, findFixedPalette, findKpiViolations, formatViolations, readText } from './design-guard';

const row = (over: Partial<NewReturnForm['items'][number]> = {}) => ({ productId: 'p1', productLabel: 'Pneu (PN-1)', quantity: '2', unitCost: '30', notes: '', ...over });
const form = (over: Partial<NewReturnForm> = {}): NewReturnForm => ({
  supplierId: 's1',
  branchId: '',
  reason: 'DAMAGED',
  description: '  caixa amassada  ',
  items: [row()],
  ...over,
});

describe('rótulos cobrem todos os estados/motivos/resultados da API (CHECK do banco)', () => {
  it('status, motivo e resultado', () => {
    expect(Object.keys(STATUS_LABEL).sort()).toEqual(['APPROVED', 'CANCELLED', 'CLOSED', 'REJECTED', 'REQUESTED', 'SENT']);
    expect(Object.keys(REASON_LABEL).sort()).toEqual(['DAMAGED', 'DEFECTIVE', 'NOT_ORDERED', 'OTHER', 'WRONG_ITEM']);
    expect(Object.keys(OUTCOME_LABEL).sort()).toEqual(['CREDIT', 'REFUND', 'REFUSED_BY_SUPPLIER', 'REPLACEMENT']);
  });
  it('eventos do histórico gravados pela API têm texto', () => {
    for (const t of ['REQUESTED', 'APPROVED', 'STOCK_WITHDRAWN', 'REJECTED', 'SENT', 'CLOSED', 'REPLACEMENT_RECEIVED', 'CANCELLED', 'STOCK_RESTORED']) {
      expect(EVENT_LABEL[t]).toBeTruthy();
    }
  });
  it('a tela diz que NÃO é garantia ao cliente', () => {
    expect(NOT_WARRANTY_NOTICE).toMatch(/Não é garantia ao cliente/);
  });
});

describe('buildCreatePayload', () => {
  it('monta o corpo (descrição aparada, custo numérico, sem filial quando o usuário é de filial)', () => {
    const r = buildCreatePayload(form(), { branchRequired: false });
    expect(r).toEqual({
      ok: true,
      payload: { supplierId: 's1', reason: 'DAMAGED', description: 'caixa amassada', items: [{ productId: 'p1', quantity: 2, unitCost: 30 }] },
    });
  });
  it('aceita vírgula decimal e custo vazio', () => {
    const r = buildCreatePayload(form({ items: [row({ quantity: '1,5', unitCost: '' })] }), { branchRequired: false });
    expect(r.ok && r.payload.items[0]).toEqual({ productId: 'p1', quantity: 1.5 });
  });
  it.each([
    [form({ supplierId: '' }), /fornecedor/],
    [form({ reason: '' }), /motivo/],
    [form({ items: [row({ productId: '' })] }), /ao menos um produto/],
    [form({ items: [row({ quantity: '0' })] }), /maior que zero/],
    [form({ items: [row({ quantity: 'abc' })] }), /maior que zero/],
    [form({ items: [row({ unitCost: '-1' })] }), /negativo/],
    [form({ items: [row(), row()] }), /mais de uma vez/],
  ])('recusa formulário inválido %#', (f, msg) => {
    const r = buildCreatePayload(f, { branchRequired: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(msg);
  });
  it('usuário de empresa inteira precisa escolher a filial', () => {
    expect(buildCreatePayload(form(), { branchRequired: true })).toEqual({ ok: false, error: 'Selecione a filial de onde sai a mercadoria.' });
    const r = buildCreatePayload(form({ branchId: 'b1' }), { branchRequired: true });
    expect(r.ok && r.payload.branchId).toBe('b1');
  });
});

describe('buildClosePayload', () => {
  const returned = [{ productId: 'p1', quantity: 3, label: 'Pneu' }];
  const close = (over: Partial<CloseForm> = {}): CloseForm => ({ outcome: 'CREDIT', outcomeAmount: '', outcomeNotes: '', received: {}, ...over });

  it('resultado obrigatório; valor opcional com vírgula', () => {
    expect(buildClosePayload(close({ outcome: '' }), returned).ok).toBe(false);
    expect(buildClosePayload(close({ outcomeAmount: '1.234,50' }), returned)).toEqual({ ok: true, payload: { outcome: 'CREDIT', outcomeAmount: 1234.5 } });
    expect(buildClosePayload(close({ outcomeAmount: '-5' }), returned).ok).toBe(false);
  });
  it('reposição: só envia as quantidades informadas (nada automático) e não passa do devolvido', () => {
    expect(buildClosePayload(close({ outcome: 'REPLACEMENT' }), returned)).toEqual({ ok: true, payload: { outcome: 'REPLACEMENT' } });
    expect(buildClosePayload(close({ outcome: 'REPLACEMENT', received: { p1: '2' } }), returned)).toEqual({
      ok: true,
      payload: { outcome: 'REPLACEMENT', receivedItems: [{ productId: 'p1', quantity: 2 }] },
    });
    const over = buildClosePayload(close({ outcome: 'REPLACEMENT', received: { p1: '4' } }), returned);
    expect(over.ok).toBe(false);
  });
  it('quantidade recebida é ignorada fora de reposição', () => {
    expect(buildClosePayload(close({ outcome: 'REFUND', received: { p1: '2' } }), returned)).toEqual({ ok: true, payload: { outcome: 'REFUND' } });
  });
});

describe('ações e etapas', () => {
  it('mostra só as ações que a API liberou, na ordem da tela', () => {
    expect(visibleActions({ approve: true, reject: true, send: false, close: false, cancel: true })).toEqual(['approve', 'reject', 'cancel']);
    expect(visibleActions(null)).toEqual([]);
  });
  it('etapa do fluxo; recusada/cancelada interrompe', () => {
    expect(flowStepIndex('REQUESTED')).toBe(0);
    expect(flowStepIndex('SENT')).toBe(2);
    expect(flowStepIndex('CLOSED')).toBe(3);
    expect(flowStepIndex('REJECTED')).toBe(-1);
    expect(flowStepIndex('CANCELLED')).toBe(-1);
  });
  it('motivo mínimo de 5 caracteres (mesmo da API)', () => {
    expect(validateReason('abc')).not.toBeNull();
    expect(validateReason('  fornecedor pediu  ')).toBeNull();
  });
});

describe('menu: devolução ao fornecedor é do módulo COMPRAS e fora do alcance do mecânico', () => {
  it('módulo, papel e item ativo', () => {
    expect(moduleForPath('/dashboard/purchases/returns')).toBe('COMPRAS');
    expect(moduleForPath('/dashboard/purchases/returns/abc')).toBe('COMPRAS');
    expect(canAccessPath('/dashboard/purchases/returns', 'MECHANIC')).toBe(false);
    expect(canAccessPath('/dashboard/purchases/returns/new', 'OPERATOR')).toBe(true);
    expect(canAccessPath('/dashboard/purchases/returns', 'VIEWER')).toBe(true);
    expect(getActiveHref('/dashboard/purchases/returns/abc', ['/dashboard/purchases', '/dashboard/purchases/returns'])).toBe('/dashboard/purchases/returns');
    expect(getActiveHref('/dashboard/purchases/abc', ['/dashboard/purchases', '/dashboard/purchases/returns'])).toBe('/dashboard/purchases');
  });
});

describe('telas de devolução usam só tokens do design', () => {
  const files = ['app/dashboard/purchases/returns/page.tsx', 'app/dashboard/purchases/returns/new/page.tsx', 'app/dashboard/purchases/returns/[id]/page.tsx'].map((f) =>
    path.join(ADMIN_ROOT, f)
  );
  it.each(files.map((f) => [path.relative(ADMIN_ROOT, f)]))('%s', (rel) => {
    const file = path.join(ADMIN_ROOT, rel);
    const src = readText(file);
    const v = [...findFixedPalette(src, file), ...findFixedColors(src, file), ...findKpiViolations(src, file)];
    if (v.length) throw new Error(formatViolations(v));
  });
});
