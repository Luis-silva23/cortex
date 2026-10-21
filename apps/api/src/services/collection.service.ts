import { z } from 'zod';
import { prisma } from '@ln-system/database';
import { AuthorizationError, ConflictError } from '@ln-system/shared';
import { policyService } from './policy.service';
import { Logger } from './logger.service';
import { providerFor, CollectionChannel } from './channels';
import { badRequest, brl, daysOverdue, formatLocalDate, maskRecipient, notFound } from './agreement-common';
import { lateChargesInfo } from './agreement-company.service';

/**
 * COBRANÇA MANUAL E AUTORIZADA (docs/CORTEX/policies/COBRANCA.md). O CÓRTEX não é robô de cobrança nesta fase:
 * nenhum job, nenhum envio automático, nenhuma conversa automática. Uma pessoa com perfil permitido
 * (`collection.allowedRoles`) abre uma conta VENCIDA e aciona [ENVIAR COBRANÇA] escolhendo o(s) canal(is): UMA mensagem
 * por canal naquela ação. Cada tentativa fica registrada (append-only) com quem, quando, conta, valor, vencimento,
 * canal, destinatário e resultado. Nova cobrança só por nova ação humana.
 */

export const sendCollectionSchema = z.object({
  channels: z
    .array(z.enum(['WHATSAPP', 'EMAIL'], { errorMap: () => ({ message: 'Canal inválido: use WHATSAPP e/ou EMAIL' }) }))
    .min(1, 'Escolha ao menos um canal')
    .max(2)
    .refine((c) => new Set(c).size === c.length, 'Canal repetido'),
});

function buildMessage(input: { creditor: string; debtor: string; description: string; amount: number; dueDate: Date; days: number; tz: string }) {
  const due = formatLocalDate(input.dueDate, input.tz);
  const subject = `Cobrança: conta vencida em ${due} — ${input.creditor}`;
  const text = [
    `Olá, ${input.debtor}!`,
    `Aqui é da ${input.creditor}.`,
    `Consta em aberto: ${input.description}.`,
    `Valor: ${brl(input.amount)} — vencimento em ${due} (${input.days} ${input.days === 1 ? 'dia' : 'dias'} de atraso).`,
    'Por favor, entre em contato para combinarmos a regularização. Se o pagamento já foi feito, desconsidere esta mensagem.',
  ].join('\n');
  return { subject, text };
}

export class CollectionService {
  private async debtorOf(companyId: string, receivable: { agreementCompanyId: string | null; customerId: string | null }) {
    if (receivable.agreementCompanyId) {
      const ac = await prisma.agreementCompany.findFirst({ where: { id: receivable.agreementCompanyId, companyId } });
      if (ac) {
        return {
          kind: 'AGREEMENT_COMPANY' as const,
          id: ac.id,
          name: ac.contactName || ac.tradeName || ac.legalName,
          displayName: ac.tradeName || ac.legalName,
          whatsapp: ac.whatsapp || ac.phone,
          email: ac.email,
          lateRates: ac,
          status: ac.status,
        };
      }
    }
    if (receivable.customerId) {
      const c = await prisma.customer.findFirst({ where: { id: receivable.customerId, companyId } });
      if (c) return { kind: 'CUSTOMER' as const, id: c.id, name: c.name, displayName: c.name, whatsapp: c.whatsapp || c.mobile || c.phone, email: c.email, lateRates: null, status: null };
    }
    return null;
  }

  /** Detalhe da conta a receber para a tela de cobrança. */
  async receivableDetail(companyId: string, id: string) {
    const r = await prisma.accountsReceivable.findFirst({ where: { id, companyId } });
    if (!r) throw notFound('Conta a receber não encontrada', 'RECEIVABLE_NOT_FOUND');
    const debtor = await this.debtorOf(companyId, r);
    const now = new Date();
    const open = r.status === 'PENDING' || r.status === 'OVERDUE';
    const days = open ? daysOverdue(r.dueDate, now) : 0;
    const policies = await policyService.effective(companyId, null);
    return {
      id: r.id,
      description: r.description,
      amount: Number(r.amount),
      dueDate: r.dueDate,
      paidDate: r.paidDate,
      status: r.status,
      createdAt: r.createdAt,
      notes: r.notes,
      overdue: open && days > 0,
      daysOverdue: days,
      lateCharges: open && debtor?.lateRates ? lateChargesInfo(Number(r.amount), days, debtor.lateRates) : null,
      debtor: debtor
        ? { kind: debtor.kind, id: debtor.id, name: debtor.displayName, contactName: debtor.name, whatsapp: debtor.whatsapp, email: debtor.email, status: debtor.status }
        : null,
      collection: { allowedRoles: policies['collection.allowedRoles'], channels: policies['collection.channels'] },
      attempts: await this.history(companyId, id),
    };
  }

  async history(companyId: string, receivableId: string) {
    const rows = await prisma.collectionAttempt.findMany({ where: { companyId, receivableId }, orderBy: { createdAt: 'desc' }, take: 200 });
    const userIds = [...new Set(rows.map((r) => r.sentBy))];
    const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    return rows.map((r, i) => ({
      id: r.id,
      attempt: rows.length - i,
      channel: r.channel,
      recipient: r.recipient,
      amount: Number(r.amount),
      dueDate: r.dueDate,
      status: r.status,
      provider: r.provider,
      providerMessage: r.providerMessage,
      sentBy: r.sentBy,
      sentByName: users.find((u) => u.id === r.sentBy)?.name ?? null,
      createdAt: r.createdAt,
    }));
  }

  async send(input: { companyId: string; userId: string; userType: string; receivableId: string; body: unknown }) {
    const { channels } = sendCollectionSchema.parse(input.body ?? {});
    const policies = await policyService.effective(input.companyId, null);
    const allowedRoles = policies['collection.allowedRoles'] as string[];
    if (!allowedRoles.includes(input.userType)) {
      throw new AuthorizationError('Seu perfil não pode enviar cobrança (política "Quem pode enviar cobrança")', 'COLLECTION_FORBIDDEN');
    }
    const enabled = policies['collection.channels'] as string[];
    const disabled = channels.filter((c) => !enabled.includes(c));
    if (disabled.length) throw badRequest(`Canal de cobrança desabilitado na política: ${disabled.join(', ')}`, 'CHANNEL_DISABLED');

    const r = await prisma.accountsReceivable.findFirst({ where: { id: input.receivableId, companyId: input.companyId } });
    if (!r) throw notFound('Conta a receber não encontrada', 'RECEIVABLE_NOT_FOUND');
    const now = new Date();
    const open = r.status === 'PENDING' || r.status === 'OVERDUE';
    if (!open || new Date(r.dueDate).getTime() >= now.getTime()) {
      throw new ConflictError('Cobrança só para conta em aberto e vencida', 'RECEIVABLE_NOT_OVERDUE');
    }
    const debtor = await this.debtorOf(input.companyId, r);
    const company = await prisma.company.findUnique({ where: { id: input.companyId }, select: { name: true } });
    const tz = policies['company.timezone'];
    const days = daysOverdue(r.dueDate, now);
    const message = buildMessage({
      creditor: company?.name ?? 'nossa empresa',
      debtor: debtor?.name ?? 'cliente',
      description: r.description,
      amount: Number(r.amount),
      dueDate: r.dueDate,
      days,
      tz,
    });

    const attempts = [];
    for (const channel of channels as CollectionChannel[]) {
      const provider = providerFor(channel);
      const to = channel === 'WHATSAPP' ? debtor?.whatsapp ?? null : debtor?.email ?? null;
      let result;
      try {
        result = await provider.send({ to, subject: message.subject, text: message.text });
      } catch (error: any) {
        result = { status: 'FAILED' as const, provider: provider.name, recipient: to, providerMessage: `Falha do provedor: ${String(error?.message ?? error).slice(0, 200)}` };
      }
      const row = await prisma.collectionAttempt.create({
        data: {
          companyId: input.companyId,
          branchId: null,
          receivableId: r.id,
          agreementCompanyId: r.agreementCompanyId,
          channel,
          recipient: result.recipient ?? to,
          amount: r.amount,
          dueDate: r.dueDate,
          status: result.status,
          provider: result.provider,
          providerMessage: result.providerMessage,
          sentBy: input.userId,
        },
      });
      Logger.info('Collection attempt recorded', {
        companyId: input.companyId,
        receivableId: r.id,
        channel,
        status: result.status,
        recipient: maskRecipient(result.recipient ?? to),
        sentBy: input.userId,
      });
      attempts.push({
        id: row.id,
        channel,
        status: result.status,
        recipient: row.recipient,
        provider: result.provider,
        providerMessage: result.providerMessage,
        link: 'link' in result ? result.link : undefined,
        createdAt: row.createdAt,
      });
    }
    return { receivableId: r.id, daysOverdue: days, message: { subject: message.subject, text: message.text }, attempts };
  }
}

export const collectionService = new CollectionService();
export default collectionService;
