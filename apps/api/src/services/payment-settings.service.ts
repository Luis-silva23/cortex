import { prisma } from '@ln-system/database';
import { MANUAL_PROVIDER, isRegisteredProvider } from './payment-adapters';

export type EffectivePaymentSettings = {
  cashDenominationControl: boolean;
  cardProvider: string;
  pixProvider: string;
  terminalId: string | null;
  /** Há configuração própria da filial (algum campo sobrescrito). */
  source: 'branch' | 'company' | 'default';
};

export type PaymentSettingsInput = {
  cashDenominationControl?: boolean | null;
  cardProvider?: string | null;
  pixProvider?: string | null;
  terminalId?: string | null;
};

const FIELDS = ['cashDenominationControl', 'cardProvider', 'pixProvider', 'terminalId'] as const;

/**
 * Configuração de pagamento: linha da empresa (branchId null) e override da filial, CAMPO A CAMPO (nulo herda:
 * filial → empresa → padrão). Padrão: controle de cédulas desligado, provedores MANUAL, sem terminal.
 */
export class PaymentSettingsService {
  async getEffective(companyId: string, branchId?: string | null): Promise<EffectivePaymentSettings> {
    const rows = await prisma.paymentSetting.findMany({
      where: { companyId, OR: [{ branchId: null }, ...(branchId ? [{ branchId }] : [])] },
    });
    const branchRow = branchId ? rows.find((r) => r.branchId === branchId) : undefined;
    const companyRow = rows.find((r) => r.branchId === null);
    const pick = <K extends (typeof FIELDS)[number]>(k: K) => branchRow?.[k] ?? companyRow?.[k] ?? null;
    return {
      cashDenominationControl: pick('cashDenominationControl') ?? false,
      cardProvider: pick('cardProvider') ?? MANUAL_PROVIDER,
      pixProvider: pick('pixProvider') ?? MANUAL_PROVIDER,
      terminalId: pick('terminalId'),
      source: branchRow ? 'branch' : companyRow ? 'company' : 'default',
    };
  }

  /** Só os campos enviados mudam; `null` volta a herdar. Filial sem nenhum campo próprio perde a linha. */
  async set(data: { companyId: string; branchId: string | null; actorId: string } & PaymentSettingsInput) {
    if (!data.companyId) throw new Error('companyId é obrigatório');
    if (data.branchId) {
      const branch = await prisma.branch.findFirst({ where: { id: data.branchId, companyId: data.companyId }, select: { id: true } });
      if (!branch) throw new Error('Filial não encontrada nesta empresa');
    }
    if (data.cardProvider && !isRegisteredProvider(data.cardProvider, 'card')) throw new Error(`Provedor de cartão desconhecido: ${data.cardProvider}`);
    if (data.pixProvider && !isRegisteredProvider(data.pixProvider, 'pix')) throw new Error(`Provedor de PIX desconhecido: ${data.pixProvider}`);

    const changes: PaymentSettingsInput = {};
    for (const k of FIELDS) if (data[k] !== undefined) (changes as any)[k] = data[k];

    const existing = await prisma.paymentSetting.findFirst({ where: { companyId: data.companyId, branchId: data.branchId } });
    const merged = { ...(existing ?? {}), ...changes } as PaymentSettingsInput;
    const empty = FIELDS.every((k) => merged[k] === null || merged[k] === undefined);

    if (existing && empty && data.branchId) {
      await prisma.paymentSetting.deleteMany({ where: { companyId: data.companyId, branchId: data.branchId } });
    } else if (existing) {
      await prisma.paymentSetting.update({ where: { id: existing.id }, data: { ...changes, updatedBy: data.actorId } });
    } else if (!empty) {
      await prisma.paymentSetting.create({ data: { companyId: data.companyId, branchId: data.branchId, ...changes, updatedBy: data.actorId } });
    }
    return this.getEffective(data.companyId, data.branchId);
  }
}

export default new PaymentSettingsService();
