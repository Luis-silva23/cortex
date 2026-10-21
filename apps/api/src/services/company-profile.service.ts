import { z } from 'zod';
import { prisma, runWithRLSContext } from '@ln-system/database';
import { AppError } from '@ln-system/shared';
import { isValidDocument } from '@ln-system/shared/utils/validation';

/**
 * Cadastro da empresa pela própria empresa (antes a aba "Dados da Empresa" do Admin Web era ilustrativa: a API só
 * deixava o Super Admin ler/editar). CNPJ/CPF identifica a empresa (licença, unicidade) e só o Super Admin altera.
 * Campos fiscais: só o que todo emitente de NF-e/NFC-e informa (IE, IM, regime tributário) — o restante depende do
 * provedor fiscal e não foi inventado.
 */
const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().max(max).nullable().optional());
const digits = (v: unknown) => (typeof v === 'string' ? v.replace(/\D/g, '') : v);

// Nome do campo como aparece na tela: a mensagem de validação nunca expõe a chave interna nem o texto padrão do zod.
const FIELD_LABELS: Record<string, string> = {
  name: 'Nome fantasia',
  legalName: 'Razão social',
  document: 'CNPJ/CPF',
  stateRegistration: 'Inscrição estadual',
  municipalRegistration: 'Inscrição municipal',
  taxRegime: 'Regime tributário',
  email: 'E-mail',
  phone: 'Telefone',
  whatsapp: 'WhatsApp',
  contactName: 'Responsável',
  zipCode: 'CEP',
  street: 'Logradouro',
  number: 'Número',
  complement: 'Complemento',
  district: 'Bairro',
  city: 'Cidade',
  state: 'UF',
};

function describeIssue(issue: z.ZodIssue): string {
  const label = FIELD_LABELS[String(issue.path[0])] ?? 'Dados';
  if (issue.code === 'too_big') return `${label}: no máximo ${issue.maximum} caracteres`;
  if (issue.code === 'invalid_type') return `${label}: formato inválido`;
  return issue.message.startsWith(label) ? issue.message : `${label}: ${issue.message}`;
}

export const TAX_REGIMES =['SIMPLES_NACIONAL', 'SIMPLES_NACIONAL_EXCESSO', 'REGIME_NORMAL', 'MEI'] as const;

export const companyProfileSchema = z.object({
  name: z.string().trim().min(2, 'Nome fantasia: mínimo 2 caracteres').max(160).optional(),
  legalName: optionalText(200),
  document: z.preprocess(digits, z.string().refine((d) => isValidDocument(d), 'CNPJ/CPF inválido')).optional(),
  stateRegistration: optionalText(30),
  municipalRegistration: optionalText(30),
  taxRegime: z.preprocess(
    (v) => (v === '' ? null : v),
    z.enum(TAX_REGIMES, { errorMap: () => ({ message: 'Regime tributário inválido' }) }).nullable().optional()
  ),
  email: z.string().trim().email('E-mail inválido').optional(),
  phone: optionalText(30),
  whatsapp: optionalText(30),
  contactName: optionalText(120),
  // Vazio = limpar o campo (a tela envia "" nos opcionais não preenchidos).
  zipCode: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : digits(v)), z.string().regex(/^\d{8}$/, 'CEP com 8 dígitos').nullable().optional()),
  street: optionalText(200),
  number: optionalText(20),
  complement: optionalText(100),
  district: optionalText(100),
  city: optionalText(100),
  state: z.preprocess((v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim().toUpperCase()) : v), z.string().regex(/^[A-Z]{2}$/, 'UF com 2 letras').nullable().optional()),
});

const PROFILE_SELECT = {
  id: true,
  name: true,
  legalName: true,
  document: true,
  stateRegistration: true,
  municipalRegistration: true,
  taxRegime: true,
  email: true,
  phone: true,
  whatsapp: true,
  contactName: true,
  zipCode: true,
  street: true,
  number: true,
  complement: true,
  district: true,
  city: true,
  state: true,
  isActive: true,
  updatedAt: true,
} as const;

export class CompanyProfileService {
  async get(companyId: string) {
    const company = await prisma.company.findFirst({ where: { id: companyId }, select: PROFILE_SELECT });
    if (!company) throw new AppError('Empresa não encontrada', 404, 'NOT_FOUND');
    return company;
  }

  async update(companyId: string, input: unknown, actor: { userType: string }) {
    const parsed = companyProfileSchema.safeParse(input);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues.map(describeIssue).join('; '), 400, 'VALIDATION_ERROR');
    }
    const data = parsed.data;
    const before = await this.get(companyId);
    if (data.document !== undefined && data.document !== before.document && actor.userType !== 'SUPER_ADMIN') {
      throw new AppError('Só o Super Admin altera o CNPJ/CPF da empresa (identifica a licença)', 403, 'DOCUMENT_CHANGE_FORBIDDEN');
    }
    if (data.document && data.document !== before.document) {
      const taken = await prisma.company.findFirst({ where: { document: data.document, NOT: { id: companyId } }, select: { id: true } });
      if (taken) throw new AppError('Já existe outra empresa com este CNPJ/CPF', 409, 'DOCUMENT_TAKEN');
    }
    // No banco, só o Super Admin grava em `companies` (WITH CHECK is_super_admin()) — proteção mantida. A administração
    // da empresa edita o PRÓPRIO cadastro por esta elevação estreita: a rota já exigiu COMPANY_ADMIN, a empresa vem do
    // token (nunca do corpo) e só os campos do schema acima passam (ativação, licença e documento ficam de fora).
    const after = await runWithRLSContext({ companyId, userType: 'SUPER_ADMIN', branchId: null }, () =>
      prisma.company.update({ where: { id: companyId }, data, select: PROFILE_SELECT })
    );
    const changed = Object.keys(data).filter(
      (k) => JSON.stringify((before as Record<string, unknown>)[k] ?? null) !== JSON.stringify((after as Record<string, unknown>)[k] ?? null)
    );
    return { profile: after, before, changed };
  }
}

export const companyProfileService = new CompanyProfileService();
export default companyProfileService;
