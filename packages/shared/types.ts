export interface JwtPayload {
  userId: string;
  email: string;
  companyId?: string;
  branchId?: string;
  /**
   * Filiais AUTORIZADAS do usuário de filial (principal + `user_branches`). NUNCA vem do token nem do cliente: o servidor sobrescreve este campo a
   * cada requisição, a partir dos vínculos gravados no banco (middleware/tenant.ts), e é o que vai assinado para a RLS. `branchId` passa a ser a filial ATIVA
   * (a do token se ainda autorizada; senão a primeira autorizada). Papéis de empresa inteira (SUPER_ADMIN/COMPANY_ADMIN) não têm lista.
   */
  branchIds?: string[];
  userType: string; // see UserType below
  /** Sessão de equipamento a que este token está preso (só login por equipamento autorizado). Revogar o equipamento a invalida. */
  dsid?: string;
}

export interface LoginRequest {
  email?: string;
  numericId?: number;
  password: string;
  deviceId?: string;
  /** Chave do equipamento (entregue uma vez no enrolamento). Obrigatória quando o equipamento tem chave. */
  deviceKey?: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    numericId: number;
    name: string;
    email: string;
    userType: string;
    companyId?: string;
    branchId?: string;
    company?: { id: string; name: string; document: string; phone?: string };
    branch?: { id: string; name: string; address?: string; phone?: string };
  };
}

export interface MfaRequiredResponse {
  mfaRequired: true;
  mfaToken: string;
  mfaMethods: { totp: boolean; sms: boolean; email: boolean };
}

export interface CreateUserRequest {
  name: string;
  email: string;
  password: string;
  userType: UserType;
  companyId?: string;
  branchId?: string;
  requirePasswordChange?: boolean;
}

export interface UpdateUserRequest {
  name?: string;
  email?: string;
  phone?: string;
  password?: string;
  branchId?: string;
  userType?: UserType;
  isActive?: boolean;
}

export interface CreateBranchRequest {
  name: string;
  document?: string;
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  phone?: string;
  isHeadquarter?: boolean;
}
export type UpdateBranchRequest = Partial<CreateBranchRequest>;

export interface CreateCompanyRequest {
  name: string;
  document: string;
  email: string;
  phone?: string;
}
export type UpdateCompanyRequest = Partial<CreateCompanyRequest>;

// startDate/expiryDate are `Date` here, not `string` — this is the shape
// license.service.ts actually consumes. The raw HTTP payload is a string
// (JSON has no Date type); license.routes.ts parses/validates that string
// with the zod schemas in ./validators, then does `new Date(...)` itself
// before calling the service. This type describes the post-conversion,
// service-layer call, not the wire payload.
export interface CreateLicenseRequest {
  companyId: string;
  licenseType: LicenseType;
  maxDevices: number;
  maxUsers: number;
  maxBranches: number;
  notes?: string;
  startDate?: Date;
  expiryDate?: Date;
}

export interface ApproveLicenseRequest {
  startDate: Date;
  expiryDate: Date;
  notes?: string;
}

// Mirrors the Prisma `LicenseType` enum (packages/database) — kept as a
// plain string union here rather than importing @ln-system/database, to
// avoid a circular workspace dependency (shared must not depend on
// database). Exact members unconfirmed from apps/ usage alone; if
// packages/database's schema.prisma defines a LicenseType enum, align
// these values to it exactly instead of guessing.
export type LicenseType = 'TRIAL' | 'BASIC' | 'PROFESSIONAL' | 'ENTERPRISE';

// Same rationale as LicenseType. Values confirmed by real runtime usage
// across apps/api/src (route guards, RLS context, tests).
export type UserType = 'SUPER_ADMIN' | 'COMPANY_ADMIN' | 'MANAGER' | 'OPERATOR' | 'MECHANIC' | 'VIEWER';
