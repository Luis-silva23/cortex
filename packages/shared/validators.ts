import { z } from 'zod';

export const createCompanySchema = z.object({
  name: z.string().min(1),
  document: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
});
export const updateCompanySchema = createCompanySchema.partial();

export const createLicenseSchema = z.object({
  companyId: z.string(),
  licenseType: z.enum(['TRIAL', 'BASIC', 'PROFESSIONAL', 'ENTERPRISE']),
  maxDevices: z.number().int().positive(),
  maxUsers: z.number().int().positive(),
  maxBranches: z.number().int().positive(),
  notes: z.string().optional(),
  startDate: z.string().optional(),
  expiryDate: z.string().optional(),
});
export const approveLicenseSchema = z.object({
  startDate: z.string(),
  expiryDate: z.string(),
  notes: z.string().optional(),
});

export const createBranchSchema = z.object({
  companyId: z.string().optional(), // only meaningful for SUPER_ADMIN callers; the route overwrites it with the caller's own companyId otherwise
  name: z.string().min(1),
  document: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
  phone: z.string().optional(),
  isHeadquarter: z.boolean().optional(),
});
export const updateBranchSchema = createBranchSchema.omit({ companyId: true }).partial();

export const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  userType: z.enum(['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'MECHANIC', 'VIEWER']),
  companyId: z.string().optional(),
  branchId: z.string().optional(),
  /** Senha definida pelo administrador é TEMPORÁRIA: por padrão o usuário precisa trocá-la antes de receber sessão (decisão 157). */
  requirePasswordChange: z.boolean().optional(),
});
// A edição de cadastro NÃO troca empresa nem senha: `companyId` chegava ao UPDATE (a RLS
// barrava e o cliente recebia 500) e `password` trocava a senha por um caminho paralelo ao
// /reset-password, sem revogar as sessões abertas. As duas chaves são descartadas.
export const updateUserSchema = createUserSchema.omit({ companyId: true, password: true, requirePasswordChange: true }).partial();
export const resetPasswordSchema = z.object({
  password: z.string().min(8),
  requirePasswordChange: z.boolean().optional(),
});
