import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma, runInTransaction } from '@ln-system/database';
import { AppError } from '@ln-system/shared';

/**
 * Políticas do CÓRTEX por empresa e filial (docs/CORTEX/POLICIES.md).
 *
 * A empresa define o padrão; a filial só sobrescreve as chaves marcadas `branchOverridable`. Sem valor gravado vale o
 * padrão do produto (`default`) — decidido pelo dono em 2026-09-27 quando a regra já está definida (ex.: desconto livre de
 * 5% em peças/produtos, 0% em serviços; orçamento encerrável após 5 dias) e sem efeito quando a regra depende da empresa
 * (ex.: convênios desligados até a empresa configurar). Nenhuma regra comercial configurável fica fixa no código de negócio:
 * os serviços leem daqui.
 *
 * Toda alteração grava valor anterior, novo, motivo, quem e quando (policy_changes) e passa pela auditoria da rota.
 */

const ROLE = z.enum(['MANAGER', 'COMPANY_ADMIN']);
const roles = z.array(ROLE).min(1, 'Informe ao menos um perfil').transform((r) => [...new Set(r)]);
const percent = z.number().min(0, 'Mínimo 0%').max(100, 'Máximo 100%');
const intIn = (min: number, max: number) => z.number().int('Use um número inteiro').min(min, `Mínimo ${min}`).max(max, `Máximo ${max}`);

export type PolicyGroup =
  | 'EMPRESA'
  | 'DESCONTO'
  | 'CAIXA'
  | 'ORCAMENTO'
  | 'AGENDA'
  | 'GARANTIA'
  | 'CONVENIO_FUNCIONARIO'
  | 'CONVENIO_EMPRESA'
  | 'COBRANCA'
  | 'FISCAL'
  | 'DEVOLUCAO_FORNECEDOR'
  | 'COMISSAO';

interface PolicyDef<T> {
  group: PolicyGroup;
  label: string;
  description: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  default: T;
  /** A filial pode ter valor próprio? Regras de segurança/controle ficam só na empresa. */
  branchOverridable: boolean;
}

const def = <T>(d: PolicyDef<T>) => d;

const deviceUserTypes = z
  .array(z.enum(['COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'MECHANIC', 'VIEWER']))
  .max(5)
  .transform((r) => [...new Set(r)]);

export const POLICY_CATALOG = {
  'devices.requiredUserTypes': def({
    group: 'EMPRESA',
    label: 'Perfis que só operam o caixa por equipamento autorizado',
    description:
      'Perfis que só podem abrir/fechar caixa, movimentar caixa, vender e receber pagamento em um equipamento autorizado (PDV enrolado e ativado pelo administrador). O login pelo navegador (Admin Web) segue livre: só a operação de caixa é bloqueada sem equipamento. Quem informa um equipamento no login sempre precisa que ele esteja autorizado. Vazio = nenhuma exigência (padrão de transição; ligar assim que os PDVs da empresa estiverem registrados).',
    schema: deviceUserTypes,
    default: [] as Array<'COMPANY_ADMIN' | 'MANAGER' | 'OPERATOR' | 'MECHANIC' | 'VIEWER'>,
    branchOverridable: false,
  }),
  'company.timezone': def({
    group: 'EMPRESA',
    label: 'Fuso horário',
    description: 'Fuso usado para horário de funcionamento, agenda e vencimentos (IANA, ex.: America/Sao_Paulo).',
    schema: z.string().refine((tz) => {
      try {
        new Intl.DateTimeFormat('pt-BR', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Fuso horário inválido'),
    default: 'America/Sao_Paulo',
    branchOverridable: true,
  }),

  'discount.productFreePercent': def({
    group: 'DESCONTO',
    label: 'Desconto sem autorização em peças/produtos (%)',
    description: 'Até este percentual o operador aplica desconto em peças/produtos sem autorização (sempre auditado). Acima, exige autorização de outra pessoa.',
    schema: percent,
    default: 5,
    branchOverridable: true,
  }),
  'discount.serviceFreePercent': def({
    group: 'DESCONTO',
    label: 'Desconto sem autorização em serviços/mão de obra (%)',
    description: 'Serviços/mão de obra não têm desconto padrão: qualquer desconto acima deste percentual exige autorização.',
    schema: percent,
    default: 0,
    branchOverridable: true,
  }),
  'discount.authorizerRoles': def({
    group: 'DESCONTO',
    label: 'Quem autoriza desconto acima do limite',
    description: 'Perfis que podem autorizar. Quem solicita nunca autoriza o próprio desconto.',
    schema: roles,
    default: ['MANAGER', 'COMPANY_ADMIN'] as Array<'MANAGER' | 'COMPANY_ADMIN'>,
    branchOverridable: false,
  }),

  'cash.forceCloseRoles': def({
    group: 'CAIXA',
    label: 'Quem pode forçar o fechamento do caixa',
    description: 'Fechamento forçado exige motivo e registra as pendências e valores do momento.',
    schema: roles,
    default: ['MANAGER', 'COMPANY_ADMIN'] as Array<'MANAGER' | 'COMPANY_ADMIN'>,
    branchOverridable: false,
  }),
  'cash.blockCloseWithPendingPayments': def({
    group: 'CAIXA',
    label: 'Pagamento não confirmado impede o fechamento normal',
    description: 'Com pagamento pendente de confirmação no caixa, só o fechamento forçado é permitido.',
    schema: z.boolean(),
    default: true,
    branchOverridable: true,
  }),
  'cash.blockCloseWithOpenSales': def({
    group: 'CAIXA',
    label: 'Venda em aberto impede o fechamento normal',
    description: 'Com venda pendente ou parcialmente paga no caixa, só o fechamento forçado é permitido.',
    schema: z.boolean(),
    default: true,
    branchOverridable: true,
  }),
  'cash.requireDifferenceReason': def({
    group: 'CAIXA',
    label: 'Exigir motivo quando o fechamento tiver diferença',
    description: 'Se o valor informado no fechamento for diferente do esperado (todas as formas de pagamento), o motivo é obrigatório.',
    schema: z.boolean(),
    default: true,
    branchOverridable: false,
  }),

  'quote.expirationDays': def({
    group: 'ORCAMENTO',
    label: 'Dias sem resposta para o orçamento poder ser encerrado',
    description: 'Orçamento enviado e sem resposta do cliente por este número de dias pode ser encerrado (individualmente ou em lote).',
    schema: intIn(1, 365),
    default: 5,
    branchOverridable: true,
  }),
  'quote.autoExpire': def({
    group: 'ORCAMENTO',
    label: 'Encerrar automaticamente os orçamentos vencidos',
    description: 'Desligado: o encerramento é manual (seleção múltipla). Ligado: a rotina diária encerra os vencidos. O histórico nunca é apagado.',
    schema: z.boolean(),
    default: false,
    branchOverridable: true,
  }),
  'quote.allowReopen': def({
    group: 'ORCAMENTO',
    label: 'Permitir reabrir orçamento encerrado',
    description: 'Quando o cliente volta com o mesmo veículo, o orçamento encerrado pode ser reaberto em vez de criar outro.',
    schema: z.boolean(),
    default: true,
    branchOverridable: true,
  }),

  'agenda.requireCustomerConfirmation': def({
    group: 'AGENDA',
    label: 'Agendamento só é concluído com confirmação do cliente',
    description: 'Sem a confirmação do cliente, concluir exige autorização de responsável interno (≠ quem solicita).',
    schema: z.boolean(),
    default: true,
    branchOverridable: false,
  }),
  'agenda.completionAuthorizerRoles': def({
    group: 'AGENDA',
    label: 'Quem autoriza concluir agendamento não confirmado',
    description: 'Perfis que podem autorizar. A autorização é auditada.',
    schema: roles,
    default: ['MANAGER', 'COMPANY_ADMIN'] as Array<'MANAGER' | 'COMPANY_ADMIN'>,
    branchOverridable: false,
  }),
  'agenda.slotMinutes': def({
    group: 'AGENDA',
    label: 'Duração do horário de agenda (minutos)',
    description: 'Tamanho de cada horário usado para contar a capacidade.',
    schema: intIn(5, 480),
    default: 60,
    branchOverridable: true,
  }),
  'agenda.maxPerSlot': def({
    group: 'AGENDA',
    label: 'Capacidade por horário (agendamentos ativos)',
    description: 'Vazio = sem limite. Com limite, um novo agendamento ou remarcação num horário lotado é recusado.',
    schema: intIn(1, 100).nullable(),
    default: null as number | null,
    branchOverridable: true,
  }),
  'agenda.maxPerDay': def({
    group: 'AGENDA',
    label: 'Capacidade por dia (agendamentos ativos)',
    description: 'Vazio = sem limite. Conta os agendamentos ativos da filial no dia (fuso da empresa).',
    schema: intIn(1, 1000).nullable(),
    default: null as number | null,
    branchOverridable: true,
  }),
  'agenda.maxPerMonth': def({
    group: 'AGENDA',
    label: 'Capacidade por mês (agendamentos ativos)',
    description: 'Vazio = sem limite. Conta os agendamentos ativos da filial no mês (fuso da empresa).',
    schema: intIn(1, 30000).nullable(),
    default: null as number | null,
    branchOverridable: true,
  }),
  'agenda.boxCount': def({
    group: 'AGENDA',
    label: 'Quantidade de boxes/elevadores',
    description: 'Vazio = não controlado. Com valor, atendimentos simultâneos (considerando a duração) não passam desse número.',
    schema: intIn(1, 100).nullable(),
    default: null as number | null,
    branchOverridable: true,
  }),
  'agenda.defaultDurationMinutes': def({
    group: 'AGENDA',
    label: 'Duração padrão de um atendimento (minutos)',
    description: 'Usada quando o agendamento não informa a duração. Vazio = um horário de agenda.',
    schema: intIn(5, 1440).nullable(),
    default: null as number | null,
    branchOverridable: true,
  }),
  'agenda.respectBusinessHours': def({
    group: 'AGENDA',
    label: 'Agendar só no horário de funcionamento',
    description: 'Vale quando a empresa/filial tem horário de funcionamento cadastrado.',
    schema: z.boolean(),
    default: true,
    branchOverridable: true,
  }),

  'warranty.enabled': def({
    group: 'GARANTIA',
    label: 'Garantia de OS habilitada',
    description: 'Permite registrar garantia (serviço, peça ou ambos) ao encerrar a OS.',
    schema: z.boolean(),
    default: true,
    branchOverridable: true,
  }),
  'warranty.requireDecisionOnClose': def({
    group: 'GARANTIA',
    label: 'Exigir decisão de garantia ao encerrar a OS',
    description: 'A OS só é encerrada informando "sem garantia" ou os dados da garantia.',
    schema: z.boolean(),
    default: true,
    branchOverridable: true,
  }),
  'warranty.defaultDurationValue': def({
    group: 'GARANTIA',
    label: 'Prazo padrão sugerido',
    description: 'Sugestão na tela (quantidade). Vazio = sem sugestão.',
    schema: intIn(1, 120).nullable(),
    default: null as number | null,
    branchOverridable: true,
  }),
  'warranty.defaultDurationUnit': def({
    group: 'GARANTIA',
    label: 'Unidade do prazo padrão',
    description: 'DAYS, MONTHS ou YEARS.',
    schema: z.enum(['DAYS', 'MONTHS', 'YEARS']),
    default: 'MONTHS' as 'DAYS' | 'MONTHS' | 'YEARS',
    branchOverridable: true,
  }),
  'warranty.defaultKmLimit': def({
    group: 'GARANTIA',
    label: 'Limite de km padrão sugerido',
    description: 'Com prazo e km, vale o que ocorrer primeiro. Vazio = sem sugestão.',
    schema: intIn(1, 1_000_000).nullable(),
    default: null as number | null,
    branchOverridable: true,
  }),

  'employeeAgreement.enabled': def({
    group: 'CONVENIO_FUNCIONARIO',
    label: 'Convênio de funcionário habilitado',
    description: 'Permite vender para funcionário com desconto em folha. A filial pode ter valor próprio (ex.: desligado só nela).',
    schema: z.boolean(),
    default: false,
    branchOverridable: true,
  }),
  'employeeAgreement.limitType': def({
    group: 'CONVENIO_FUNCIONARIO',
    label: 'Tipo de limite padrão',
    description: 'FIXED = valor fixo por mês; SALARY_PERCENT = percentual do salário por mês. O funcionário pode ter limite próprio.',
    schema: z.enum(['FIXED', 'SALARY_PERCENT']),
    default: 'FIXED' as 'FIXED' | 'SALARY_PERCENT',
    branchOverridable: false,
  }),
  'employeeAgreement.limitValue': def({
    group: 'CONVENIO_FUNCIONARIO',
    label: 'Valor do limite padrão (R$ ou %)',
    description: 'Limite mensal de uso. A empresa deve respeitar a legislação trabalhista aplicável; o CÓRTEX não presume limite legal.',
    schema: z.number().min(0).max(1_000_000),
    default: 0,
    branchOverridable: false,
  }),
  'employeeAgreement.maxInstallments': def({
    group: 'CONVENIO_FUNCIONARIO',
    label: 'Parcelas máximas em folha',
    description: 'Número máximo de competências em que uma compra é descontada.',
    schema: intIn(1, 24),
    default: 1,
    branchOverridable: false,
  }),

  'companyAgreement.enabled': def({
    group: 'CONVENIO_EMPRESA',
    label: 'Convênio com empresa externa habilitado',
    description: 'Permite vender a prazo para empresa conveniada (gera conta a receber). A filial pode ter valor próprio.',
    schema: z.boolean(),
    default: false,
    branchOverridable: true,
  }),
  'companyAgreement.defaultPaymentTermDays': def({
    group: 'CONVENIO_EMPRESA',
    label: 'Prazo de pagamento padrão (dias)',
    description: 'Usado no cadastro de nova conveniada (10, 15, 30 ou personalizado).',
    schema: intIn(1, 365),
    default: 30,
    branchOverridable: false,
  }),
  'companyAgreement.defaultBlockAfterDaysOverdue': def({
    group: 'CONVENIO_EMPRESA',
    label: 'Bloqueio automático após dias de atraso (padrão)',
    description: 'Vazio = sem bloqueio automático (só manual). A conveniada pode ter valor próprio.',
    schema: intIn(1, 365).nullable(),
    default: null as number | null,
    branchOverridable: false,
  }),

  'collection.allowedRoles': def({
    group: 'COBRANCA',
    label: 'Quem pode enviar cobrança',
    description: 'Cobrança é manual: uma mensagem por ação de pessoa autorizada. Não há envio automático.',
    schema: roles,
    default: ['MANAGER', 'COMPANY_ADMIN'] as Array<'MANAGER' | 'COMPANY_ADMIN'>,
    branchOverridable: false,
  }),
  'collection.channels': def({
    group: 'COBRANCA',
    label: 'Canais de cobrança habilitados',
    description: 'WHATSAPP e/ou EMAIL.',
    schema: z.array(z.enum(['WHATSAPP', 'EMAIL'])).min(1).transform((c) => [...new Set(c)]),
    default: ['WHATSAPP', 'EMAIL'] as Array<'WHATSAPP' | 'EMAIL'>,
    branchOverridable: false,
  }),

  'fiscal.enabledOperations': def({
    group: 'FISCAL',
    label: 'Operações fiscais habilitadas',
    description: 'SALE (venda), RETURN (devolução), TRANSFER (transferência). A emissão real depende do provedor fiscal.',
    schema: z.array(z.enum(['SALE', 'RETURN', 'TRANSFER'])).transform((c) => [...new Set(c)]),
    default: ['SALE'] as Array<'SALE' | 'RETURN' | 'TRANSFER'>,
    branchOverridable: true,
  }),

  // Comissão (requisito do produto desde o início): a empresa liga ou desliga; desligada, nenhuma comissão é calculada. As regras
  // (percentual, produtos elegíveis, vigência) ficam nas regras de comissão e cada cálculo guarda a regra aplicada no momento.
  'commission.enabled': def({
    group: 'COMISSAO',
    label: 'Calcular comissão',
    description: 'Ligada: a comissão é calculada conforme as regras de comissão da empresa. Desligada: nenhuma comissão é calculada (o que já foi calculado não muda). Ausência de regra não é comissão zero: é "sem política".',
    schema: z.boolean(),
    default: true,
    branchOverridable: true,
  }),

  'supplierReturn.approverRoles': def({
    group: 'DEVOLUCAO_FORNECEDOR',
    label: 'Quem aprova devolução ao fornecedor',
    description: 'A aprovação retira os itens do estoque. Quem solicita não aprova a própria devolução.',
    schema: roles,
    default: ['MANAGER', 'COMPANY_ADMIN'] as Array<'MANAGER' | 'COMPANY_ADMIN'>,
    branchOverridable: false,
  }),
} as const;

export type PolicyKey = keyof typeof POLICY_CATALOG;
export type PolicyValue<K extends PolicyKey> = (typeof POLICY_CATALOG)[K]['default'];
export type PolicySource = 'DEFAULT' | 'COMPANY' | 'BRANCH';
export type EffectivePolicies = { [K in PolicyKey]: PolicyValue<K> };

export const POLICY_KEYS = Object.keys(POLICY_CATALOG) as PolicyKey[];
export const isPolicyKey = (k: unknown): k is PolicyKey => typeof k === 'string' && k in POLICY_CATALOG;

const REASON_MIN = 5;

function assertKey(key: string): asserts key is PolicyKey {
  if (!isPolicyKey(key)) throw new AppError('Política desconhecida', 400, 'UNKNOWN_POLICY');
}

function parseValue(key: PolicyKey, value: unknown): unknown {
  const parsed = (POLICY_CATALOG[key].schema as z.ZodTypeAny).safeParse(value);
  if (!parsed.success) {
    throw new AppError(`${POLICY_CATALOG[key].label}: ${parsed.error.issues.map((i) => i.message).join('; ')}`, 400, 'INVALID_POLICY_VALUE');
  }
  return parsed.data;
}

/** Valor gravado que deixou de ser válido (catálogo mudou) cai no padrão em vez de quebrar a operação. */
function storedOrDefault(key: PolicyKey, stored: unknown): unknown {
  const parsed = (POLICY_CATALOG[key].schema as z.ZodTypeAny).safeParse(stored);
  return parsed.success ? parsed.data : POLICY_CATALOG[key].default;
}

async function assertBranchOfCompany(companyId: string, branchId: string) {
  const branch = await prisma.branch.findFirst({ where: { id: branchId, companyId }, select: { id: true } });
  if (!branch) throw new AppError('Filial não encontrada nesta empresa', 400, 'BRANCH_NOT_FOUND');
}

export class PolicyService {
  /**
   * Políticas efetivas de uma filial (ou da empresa, sem filial): filial → empresa → padrão, com a origem de cada valor.
   * Roda no contexto RLS de quem chama: um usuário de filial só enxerga a própria filial e a linha da empresa.
   */
  async resolve(companyId: string, branchId?: string | null): Promise<{ values: EffectivePolicies; sources: Record<PolicyKey, PolicySource> }> {
    const rows = await prisma.policySetting.findMany({
      where: { companyId, OR: [{ branchId: null }, ...(branchId ? [{ branchId }] : [])] },
      select: { key: true, branchId: true, value: true },
    });
    const values = {} as Record<PolicyKey, unknown>;
    const sources = {} as Record<PolicyKey, PolicySource>;
    for (const key of POLICY_KEYS) {
      const branchRow = branchId && POLICY_CATALOG[key].branchOverridable ? rows.find((r) => r.key === key && r.branchId === branchId) : undefined;
      const companyRow = rows.find((r) => r.key === key && r.branchId === null);
      if (branchRow) {
        values[key] = storedOrDefault(key, branchRow.value);
        sources[key] = 'BRANCH';
      } else if (companyRow) {
        values[key] = storedOrDefault(key, companyRow.value);
        sources[key] = 'COMPANY';
      } else {
        values[key] = POLICY_CATALOG[key].default;
        sources[key] = 'DEFAULT';
      }
    }
    return { values: values as EffectivePolicies, sources };
  }

  async effective(companyId: string, branchId?: string | null): Promise<EffectivePolicies> {
    return (await this.resolve(companyId, branchId)).values;
  }

  async get<K extends PolicyKey>(companyId: string, branchId: string | null | undefined, key: K): Promise<PolicyValue<K>> {
    return (await this.effective(companyId, branchId))[key];
  }

  /** Catálogo + valores da empresa e o efetivo da filial pedida (tela de configuração). */
  async describe(companyId: string, branchId?: string | null) {
    const { values, sources } = await this.resolve(companyId, branchId);
    const companyRows = await prisma.policySetting.findMany({ where: { companyId, branchId: null }, select: { key: true, value: true } });
    return POLICY_KEYS.map((key) => {
      const d = POLICY_CATALOG[key];
      const companyValue = companyRows.find((r) => r.key === key);
      return {
        key,
        group: d.group,
        label: d.label,
        description: d.description,
        branchOverridable: d.branchOverridable,
        default: d.default,
        companyValue: companyValue ? storedOrDefault(key, companyValue.value) : null,
        effective: values[key],
        source: sources[key],
      };
    });
  }

  async set(input: { companyId: string; branchId?: string | null; key: string; value: unknown; reason: string; userId: string }) {
    assertKey(input.key);
    const key = input.key;
    const branchId = input.branchId ?? null;
    if (branchId && !POLICY_CATALOG[key].branchOverridable) {
      throw new AppError(`"${POLICY_CATALOG[key].label}" vale para a empresa inteira e não pode ser diferente por filial`, 400, 'POLICY_NOT_BRANCH_OVERRIDABLE');
    }
    const reason = (input.reason ?? '').trim();
    if (reason.length < REASON_MIN) throw new AppError(`Informe o motivo da alteração (mínimo ${REASON_MIN} caracteres)`, 400, 'REASON_REQUIRED');
    if (branchId) await assertBranchOfCompany(input.companyId, branchId);
    const value = parseValue(key, input.value) as Prisma.InputJsonValue;

    return runInTransaction(async (tx) => {
      const existing = await tx.policySetting.findFirst({ where: { companyId: input.companyId, branchId, key } });
      if (existing && JSON.stringify(existing.value) === JSON.stringify(value)) {
        return { key, branchId, value, changed: false };
      }
      try {
        if (existing) {
          await tx.policySetting.update({ where: { id: existing.id }, data: { value, updatedBy: input.userId } });
        } else {
          await tx.policySetting.create({ data: { companyId: input.companyId, branchId, key, value, updatedBy: input.userId } });
        }
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new AppError('A política foi alterada por outra pessoa agora mesmo. Atualize e tente de novo.', 409, 'POLICY_CONFLICT');
        }
        throw e;
      }
      await tx.policyChange.create({
        data: {
          companyId: input.companyId,
          branchId,
          key,
          oldValue: existing ? (existing.value as Prisma.InputJsonValue) : Prisma.JsonNull,
          newValue: value,
          reason,
          changedBy: input.userId,
        },
      });
      return { key, branchId, value, oldValue: existing?.value ?? null, changed: true };
    });
  }

  /** Remove o valor da empresa (volta ao padrão) ou o override da filial (volta ao da empresa). */
  async reset(input: { companyId: string; branchId?: string | null; key: string; reason: string; userId: string }) {
    assertKey(input.key);
    const key = input.key;
    const branchId = input.branchId ?? null;
    const reason = (input.reason ?? '').trim();
    if (reason.length < REASON_MIN) throw new AppError(`Informe o motivo da alteração (mínimo ${REASON_MIN} caracteres)`, 400, 'REASON_REQUIRED');
    if (branchId) await assertBranchOfCompany(input.companyId, branchId);
    return runInTransaction(async (tx) => {
      const existing = await tx.policySetting.findFirst({ where: { companyId: input.companyId, branchId, key } });
      if (!existing) return { key, branchId, changed: false };
      await tx.policySetting.delete({ where: { id: existing.id } });
      await tx.policyChange.create({
        data: {
          companyId: input.companyId,
          branchId,
          key,
          oldValue: existing.value as Prisma.InputJsonValue,
          newValue: Prisma.JsonNull,
          reason,
          changedBy: input.userId,
        },
      });
      return { key, branchId, oldValue: existing.value, changed: true };
    });
  }

  async history(companyId: string, filters: { key?: string; branchId?: string | null; limit?: number } = {}) {
    return prisma.policyChange.findMany({
      where: {
        companyId,
        ...(filters.key ? { key: filters.key } : {}),
        ...(filters.branchId !== undefined ? { branchId: filters.branchId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(filters.limit ?? 50, 1), 200),
    });
  }
}

export const policyService = new PolicyService();
export default policyService;
