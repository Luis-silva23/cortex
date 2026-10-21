import { randomUUID } from 'crypto';
import { prisma, runWithRLSContext, runInTransaction } from '@ln-system/database';
import { hashPassword, comparePassword, passwordNeedsRehash, passwordHashAlgorithm, burnOtherAlgorithmCost } from '@ln-system/shared/utils/password';
import { normalizeEmail } from '@ln-system/shared/utils/email';
import {
  generateAccessToken,
  generateRefreshToken,
  generateMfaPendingToken,
  generateMfaEnrollmentToken,
  verifyMfaEnrollmentToken,
  verifyMfaPendingToken,
  generatePasswordChangeToken,
  verifyPasswordChangeToken,
} from '@ln-system/shared/utils/token';
import type { LoginRequest, LoginResponse, MfaRequiredResponse } from '@ln-system/shared/types';
import { mfaService } from './MFAService';
import { mfaRequiredForPrivileged, mfaRequiredForUserType, SELF_ENROLLMENT_USER_TYPES } from './mfa-policy';
import { consumeTotp, consumeBackupCode, consumeStoredOtp, beginEnrollment, confirmEnrollment } from './mfa-factor.service';
import { hashRefreshToken } from './refresh-token-hash';
import redis from '../config/redis';
import { Logger } from './logger.service';
import { revokeUserAccessTokens } from './access-token-revocation';
import { startDeviceSession, endDeviceSessionById, isDeviceSessionLive, DeviceAuthError } from './device-session.service';
import { deviceKeyMatches } from './device-enrollment.service';
import { legacyLoginVerdict } from './device-legacy';
import { validateNewPassword } from './password-policy';

// Tempo da resposta: toda tentativa de login paga o custo de bcrypt E de Argon2id (password.ts, burnOtherAlgorithmCost), exista a conta
// ou não e qualquer que seja o algoritmo do hash dela — o tempo não diz quais e-mails existem nem quais contas já migraram (decisão 121).

const MAX_LOGIN_ATTEMPTS = parseInt(process.env.MAX_LOGIN_ATTEMPTS || '3', 10);
const LOCKOUT_TIME_MINUTES = parseInt(process.env.LOCKOUT_TIME_MINUTES || '30', 10);
const MFA_CODE_TTL_SECONDS = 10 * 60;

// Política de MFA por perfil (decisão 123): ver mfa-policy.ts. Reexportada aqui por compatibilidade.
export { mfaRequiredForPrivileged };

/**
 * Perfil com MFA obrigatório e sem MFA ativo. SUPER_ADMIN: enrolamento administrativo (sem credencial na resposta). COMPANY_ADMIN:
 * `enrollmentToken` (10 min, só abre as rotas de configuração) para o Admin Web configurar o autenticador na própria tela.
 */
export class MfaEnrollmentRequiredError extends Error {
  readonly code = 'MFA_ENROLLMENT_REQUIRED';
  constructor(readonly enrollmentToken?: string) {
    super(
      enrollmentToken
        ? 'Sua conta exige a verificação em duas etapas. Configure o aplicativo autenticador no Admin Web (entre com e-mail e senha) para continuar.'
        : 'Esta conta privilegiada exige a verificação em duas etapas. Peça ao responsável de TI para ativá-la (procedimento administrativo).'
    );
    this.name = 'MfaEnrollmentRequiredError';
  }
}

/** A credencial de configuração do MFA não vale para esta conta (perfil que não configura pela tela, conta inativa ou MFA já ativo). */
export class MfaEnrollmentRefusedError extends Error {
  readonly code = 'MFA_ENROLLMENT_REFUSED';
  constructor(message = 'Não é possível configurar a verificação em duas etapas para esta conta.') {
    super(message);
    this.name = 'MfaEnrollmentRefusedError';
  }
}

/**
 * Senha TEMPORÁRIA (definida por um administrador): o usuário precisa trocá-la antes de receber sessão (decisão 157). Leva a credencial de 10 minutos que só abre
 * `/auth/password-change/complete`. Com MFA ativo ela só é emitida DEPOIS do segundo fator; sem MFA ainda, a troca vem antes de configurá-lo.
 */
export class PasswordChangeRequiredError extends Error {
  readonly code = 'PASSWORD_CHANGE_REQUIRED';
  constructor(readonly passwordChangeToken: string) {
    super('Sua senha é temporária e precisa ser trocada antes de continuar. Entre no painel web (Admin Web) com o seu e-mail para definir a nova senha.');
    this.name = 'PasswordChangeRequiredError';
  }
}

/** A troca de senha foi recusada: conta sem pendência/inativa, senha atual incorreta, conta bloqueada ou nova senha fora da política. */
export class PasswordChangeError extends Error {
  constructor(
    readonly code: 'PASSWORD_CHANGE_REFUSED' | 'INVALID_CURRENT_PASSWORD' | 'WEAK_PASSWORD' | 'ACCOUNT_LOCKED',
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = 'PasswordChangeError';
  }
}

// Tipo mínimo do usuário usado para emitir tokens — evita repetir o include
// completo do Prisma em cada chamada. `company`/`branch` são opcionais pois
// nem toda chamada busca essas relações (ex.: verifyMfaAndCompleteLogin).
type AuthenticatableUser = {
  id: string;
  numericId: number;
  name: string;
  email: string;
  userType: string;
  companyId: string | null;
  branchId: string | null;
  company?: { id: string; name: string; document: string; phone: string | null; isActive?: boolean } | null;
  branch?: { id: string; name: string; address: string | null; phone: string | null } | null;
  /** Senha temporária pendente de troca (decisão 157). */
  mustChangePassword?: boolean;
};

export class AuthService {
  /**
   * Empresa bloqueada pelo Super Admin (POST /companies/:id/toggle-active) não autentica.
   * ACHADO DE AUDITORIA: `Company.isActive` era gravado mas nunca lido — o bloqueio não
   * tinha efeito. SUPER_ADMIN não tem empresa (company null) e passa.
   */
  private assertCompanyActive(user: { company?: { isActive?: boolean } | null }) {
    if (user.company && user.company.isActive === false) {
      throw new Error('Empresa desativada');
    }
  }

  /**
   * Emite o par de tokens (access + refresh) e registra a sessão no Redis.
   * Extraído de login() para ser reaproveitado também ao concluir o login
   * após verificação de MFA — evita duplicar a lógica de emissão de token.
   */
  /**
   * O PDV desktop identifica o equipamento pelo MAC (ou hostname); outros clientes podem mandar o `Device.id`. Resolve
   * para o equipamento cadastrado DA EMPRESA do usuário: ativo → sessão de equipamento; bloqueado/revogado → login
   * recusado; desconhecido ou de outra empresa → segue sem sessão de equipamento (o MAC cru na FK derrubava o login).
   */
  /**
   * PORTÃO DO EQUIPAMENTO (docs/CORTEX/DISPOSITIVOS.md). Chamado DEPOIS de a senha estar correta. Regras:
   *  - o equipamento informado precisa existir na empresa do usuário e estar ATIVO — pendente, bloqueado, revogado, desconhecido ou de
   *    outra empresa = login recusado (403 + código). Antes, o desconhecido/pendente "seguia sem sessão de equipamento" e o login
   *    passava: a autorização do equipamento não valia nada;
   *  - equipamento com chave (enrolado) exige a chave certa; sem chave guardada (legado) segue por id/MAC, a reenrolar;
   *  - o equipamento é de UMA filial (definida pelo administrador): usuário de outra filial não entra por ele;
   *  - sem equipamento informado: só é recusado se a política `devices.requiredUserTypes` da empresa exigir equipamento para o perfil.
   * Devolve o equipamento autorizado (ou null quando não há equipamento e a política não exige).
   */
  private async assertLoginDevice(
    user: { id: string; userType: string; companyId: string | null; branchId: string | null },
    deviceRef: string | undefined,
    deviceKey: string | undefined
  ): Promise<{ id: string; branchId: string | null } | null> {
    if (!user.companyId) return null; // plataforma (Super Admin): não usa equipamento de empresa
    // Sem equipamento informado: o login é de CONSOLE (Admin Web, navegador) e segue sem sessão de equipamento. NÃO é um buraco: a
    // exigência de equipamento para o caixa vive na OPERAÇÃO (`middleware/device.ts`, política `devices.requiredUserTypes`) — o
    // mesmo perfil usa o Admin Web para atendimento, e quem omite o equipamento perde a capacidade de mexer em dinheiro.
    if (!deviceRef) return null;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceRef);
    const device = await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () =>
      prisma.device.findFirst({
        where: { ...(isUuid ? { id: deviceRef } : { macAddress: { equals: deviceRef, mode: 'insensitive' as const }, secretHash: null }), license: { companyId: user.companyId! } },
        select: { id: true, status: true, secretHash: true, branchId: true, createdAt: true },
      })
    );
    if (!device) {
      // Equipamento recém-enrolado ainda NÃO tem empresa: quem tem a chave dele sabe que está aguardando autorização (e só isso é dito).
      if (isUuid) {
        const pending = await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () =>
          prisma.device.findFirst({ where: { id: deviceRef, licenseId: null, status: 'PENDING' }, select: { secretHash: true } })
        );
        if (pending && deviceKeyMatches(pending.secretHash, deviceKey)) throw new DeviceAuthError('Equipamento aguardando autorização do administrador.', 'DEVICE_PENDING');
      }
      throw new DeviceAuthError('Equipamento não reconhecido. Ele precisa ser autorizado pelo administrador.', 'DEVICE_UNKNOWN');
    }
    if (device.status === 'BLOCKED') throw new DeviceAuthError('Equipamento bloqueado pelo administrador.', 'DEVICE_BLOCKED');
    if (device.status === 'REVOKED') throw new DeviceAuthError('Equipamento revogado.', 'DEVICE_REVOKED');
    if (device.status !== 'ACTIVE') throw new DeviceAuthError('Equipamento aguardando autorização do administrador.', 'DEVICE_PENDING');
    if (device.secretHash) {
      if (!deviceKeyMatches(device.secretHash, deviceKey)) throw new DeviceAuthError('Credencial do equipamento inválida.', 'DEVICE_KEY_INVALID');
    } else {
      // Equipamento LEGADO (sem chave; identidade = id/MAC): só enquanto o conjunto fechado e antes da data de corte (device-legacy.ts).
      if (legacyLoginVerdict({ createdAt: device.createdAt }) !== 'ALLOWED') {
        throw new DeviceAuthError('Este equipamento não tem credencial própria. Registre-o novamente e aguarde a autorização do administrador.', 'DEVICE_REENROLL_REQUIRED');
      }
      Logger.security('DEVICE_LEGACY_LOGIN', 'Login por equipamento legado (sem chave): migrar para o enrolamento', { companyId: user.companyId, userId: user.id, device: device.id });
    }
    if (device.branchId && user.branchId && device.branchId !== user.branchId) throw new DeviceAuthError('Este equipamento pertence a outra filial.', 'DEVICE_BRANCH_MISMATCH');
    return { id: device.id, branchId: device.branchId };
  }

  private async issueTokens(
    user: AuthenticatableUser,
    ipAddress?: string,
    userAgent?: string,
    deviceId?: string
  ): Promise<LoginResponse> {
    // Ponto único de emissão (login direto e login pós-MFA): empresa bloqueada não recebe token.
    this.assertCompanyActive(user);

    // Senha temporária: nenhuma sessão sai enquanto não for trocada (login direto, pós-MFA e pós-enrolamento passam por aqui).
    if (user.mustChangePassword) {
      throw new PasswordChangeRequiredError(generatePasswordChangeToken({ userId: user.id, email: user.email }));
    }

    // Sessão única por PDV/equipamento e por usuário (FASE 8) — só se
    // aplica quando o cliente informa um deviceId (Admin Web/Super Admin
    // não têm "um PDV", então não enviam). A garantia de exclusividade é
    // do banco (índice único parcial em device_sessions), não desta
    // checagem; ver device-session.service.ts.
    // `deviceId` aqui já é o UUID de um equipamento AUTORIZADO (conferido por `assertLoginDevice` na senha; o token de MFA só o carrega
    // depois disso). Reconfere o estado (pode ter sido bloqueado entre a senha e o MFA) e abre a sessão de equipamento.
    let deviceSessionId: string | undefined;
    if (deviceId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)) {
      throw new DeviceAuthError('Equipamento não reconhecido. Refaça o login.', 'DEVICE_UNKNOWN'); // token de MFA antigo (MAC/nome)
    }
    if (deviceId && user.companyId) {
      const device = await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () =>
        prisma.device.findFirst({ where: { id: deviceId, status: 'ACTIVE', license: { companyId: user.companyId! } }, select: { id: true, branchId: true } })
      );
      if (!device) throw new DeviceAuthError('Equipamento não está mais autorizado.', 'DEVICE_REVOKED');
      const session = await startDeviceSession({
        deviceId: device.id,
        userId: user.id,
        companyId: user.companyId,
        branchId: user.branchId ?? device.branchId,
        ipAddress,
      });
      deviceSessionId = session.id;
    }

    const accessToken = generateAccessToken({
      userId: user.id,
      email: user.email,
      companyId: user.companyId || undefined,
      branchId: user.branchId || undefined,
      userType: user.userType,
      dsid: deviceSessionId,
    });

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 dias

    // O token só depende do id da linha: gerar o id antes e inserir o token real numa única escrita. O antigo
    // placeholder `token: ''` (coluna UNIQUE) fazia dois logins simultâneos de QUALQUER usuário colidirem (500).
    const refreshTokenId = randomUUID();
    const refreshToken = generateRefreshToken({
      userId: user.id,
      tokenId: refreshTokenId,
    });

    await prisma.refreshToken.create({
      data: {
        id: refreshTokenId,
        userId: user.id,
        // mesma empresa do usuário (nulo = conta de plataforma): é o que faz a RLS isolar a sessão por empresa
        companyId: user.companyId ?? null,
        // só o hash vai para o banco (SHA-256): ler a tabela ou um backup não entrega um refresh token utilizável
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt,
        ipAddress,
        userAgent,
        deviceSessionId,
      },
    });

    // Armazenar sessão no Redis (opcional, para invalidação rápida) — sempre
    // foi pensado como best-effort (ver comentário acima), mas estava com
    // `await` direto. O cliente ioredis usado aqui tem `maxRetriesPerRequest:
    // null` (exigido pelo BullMQ em config/queue.ts) e fila offline ligada,
    // então com o Redis fora do ar esse `await` nunca resolve nem rejeita —
    // login trava para sempre para todo mundo, não só quando Redis está
    // fora. Fire-and-forget (como já é feito em toda a auditoria/log
    // assíncrona do projeto) restaura o comportamento "opcional" pretendido.
    redis.setex(`session:${user.id}`, 15 * 60, accessToken).catch((error) => {
      Logger.error('Falha ao gravar sessão no Redis (não bloqueia login)', error as Error);
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        numericId: user.numericId,
        name: user.name,
        email: user.email,
        userType: user.userType,
        companyId: user.companyId || undefined,
        branchId: user.branchId || undefined,
        company: user.company
          ? {
              id: user.company.id,
              name: user.company.name,
              document: user.company.document,
              phone: user.company.phone || undefined,
            }
          : undefined,
        branch: user.branch
          ? {
              id: user.branch.id,
              name: user.branch.name,
              address: user.branch.address || undefined,
              phone: user.branch.phone || undefined,
            }
          : undefined,
      },
    };
  }

  /**
   * Realizar login
   *
   * Aceita e-mail (Admin Web / Super Admin) OU o ID numérico de 6 dígitos
   * (PDV / Balcão-Oficina) como identificador — exatamente um dos dois deve
   * ser informado. `numericId` é o identificador de login pensado para
   * digitação rápida em operações de balcão; é distinto do `id` técnico
   * (UUID) usado internamente e nas relações do banco.
   */
  async login(
    data: LoginRequest,
    ipAddress?: string,
    userAgent?: string
  ): Promise<LoginResponse | MfaRequiredResponse> {
    if (!data.email && data.numericId == null) {
      throw new Error('Credenciais inválidas');
    }

    // Autenticação é, por natureza, uma operação PRÉ-tenant: até
    // identificarmos quem está logando, não existe companyId de sessão
    // para as policies de RLS (ver migration
    // 20260907200750_add_rls_company_branch_isolation) avaliarem — elas
    // negam por padrão sem esse contexto, o que é o comportamento correto
    // para toda leitura pós-login, mas bloquearia o login em si. Por isso
    // o método INTEIRO roda sob um contexto de bypass explícito (papel da
    // API agindo como autoridade de plataforma só para autenticar,
    // nunca o usuário sendo autenticado) — cada query aqui dentro
    // continua restrita por `where: { id: user.id }`/numericId/email,
    // nunca uma listagem ampla, então o bypass não abre superfície nova de
    // vazamento, só evita negar a própria operação de login.
    return runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
      // `email` normalizado antes da busca — ACHADO DE AUDITORIA
      // (PRE-PRODUCTION HARDENING, Banco/RLS): `User.email` é `@unique`
      // sem normalização (case-sensitive por padrão no Postgres), mas os
      // formulários de login de admin-web/super-admin são um
      // `<input type="email">` comum — nenhum navegador normaliza a caixa
      // do que o usuário digita. Sem isto, alguém cadastrado como
      // "Joao@Empresa.com" que digitasse "joao@empresa.com" no login
      // recebia "Credenciais inválidas" com a senha certa.
      const user = await prisma.user.findUnique({
        where: data.numericId != null ? { numericId: data.numericId } : { email: normalizeEmail(data.email!) },
        include: { company: true, branch: true },
      });

      // NÃO revelar a existência de um usuário a quem não sabe a senha (achado da auditoria de produção, 2026-10-06): antes, e-mail
      // inexistente respondia na hora e conta desativada/bloqueada respondia "Conta desativada"/"Conta bloqueada" ANTES de conferir a
      // senha — qualquer um descobria quais e-mails existem (e qual está bloqueado) só pela resposta e pelo tempo. Agora: usuário
      // inexistente gasta o mesmo custo de uma conferência de senha e responde o mesmo "Credenciais inválidas"; o estado da conta
      // (desativada/bloqueada) só é dito a quem acertou a senha.
      if (!user) {
        await burnOtherAlgorithmCost(data.password, null);
        throw new Error('Credenciais inválidas');
      }

      const lockedNow = !!user.lockedUntil && user.lockedUntil > new Date();
      if (!user.isActive || lockedNow) {
        const knowsPassword = await comparePassword(data.password, user.password);
        await burnOtherAlgorithmCost(data.password, user.password);
        if (lockedNow) {
          Logger.security('LOGIN_ATTEMPT_WHILE_LOCKED', 'Tentativa de login em conta bloqueada', {
            userId: user.id,
            companyId: user.companyId ?? undefined,
            ipAddress,
          });
        }
        if (!knowsPassword) throw new Error('Credenciais inválidas');
        if (!user.isActive) throw new Error('Conta desativada');
        const minutesLeft = Math.ceil((user.lockedUntil!.getTime() - Date.now()) / 60000);
        throw new Error(`Conta bloqueada. Tente novamente em ${minutesLeft} minutos`);
      }

      // Verificar senha
      const isPasswordValid = await comparePassword(data.password, user.password);
      await burnOtherAlgorithmCost(data.password, user.password);

      if (isPasswordValid) await this.upgradePasswordHashIfNeeded(user.id, user.password, data.password);

      if (!isPasswordValid) {
        // Incrementar tentativas de login
        const loginAttempts = user.loginAttempts + 1;
        const shouldLock = loginAttempts >= MAX_LOGIN_ATTEMPTS;

        await prisma.user.update({
          where: { id: user.id },
          data: {
            loginAttempts,
            lockedUntil: shouldLock
              ? new Date(Date.now() + LOCKOUT_TIME_MINUTES * 60000)
              : null,
          },
        });

        if (shouldLock) {
          Logger.security('ACCOUNT_LOCKED', `Conta bloqueada após ${loginAttempts} tentativas de login inválidas`, {
            userId: user.id,
            companyId: user.companyId ?? undefined,
            ipAddress,
          });
          throw new Error(
            `Conta bloqueada por ${LOCKOUT_TIME_MINUTES} minutos devido a múltiplas tentativas de login`
          );
        }

        Logger.security('LOGIN_FAILED', 'Senha inválida', {
          userId: user.id,
          companyId: user.companyId ?? undefined,
          ipAddress,
          attempt: loginAttempts,
        });
        throw new Error('Credenciais inválidas');
      }

      // Resetar tentativas de login. COM MFA ativo o contador NÃO é zerado aqui: quem tem a senha e erra o código conta tentativa, e
      // reentrar com a senha não pode devolver as tentativas de adivinhar o código (o reset acontece só depois do código certo).
      if (!user.mfaEnabled) {
        await prisma.user.update({
          where: { id: user.id },
          data: {
            loginAttempts: 0,
            lockedUntil: null,
          },
        });
      }

      // Empresa bloqueada: só depois da senha correta (senha errada segue "Credenciais
      // inválidas", sem revelar o estado da empresa) e antes de pedir o segundo fator.
      this.assertCompanyActive(user);

      // Portão do equipamento: senha certa NÃO basta se o equipamento não está autorizado (e só depois da senha, para não revelar
      // estado de equipamento a quem não tem credencial). O UUID autorizado é o que segue no token de MFA e na sessão.
      const authorizedDevice = await this.assertLoginDevice(user, data.deviceId, data.deviceKey);

      // Senha TEMPORÁRIA (decisão 157): sem MFA ainda, a troca vem antes de qualquer outra exigência (inclusive configurar o MFA); com MFA, o segundo fator vem primeiro (issueTokens).
      if (user.mustChangePassword && !user.mfaEnabled) {
        throw new PasswordChangeRequiredError(generatePasswordChangeToken({ userId: user.id, email: user.email }));
      }

      // CONTA PRIVILEGIADA SEM MFA não entra: o Super Admin administra a plataforma inteira, e senha sozinha não basta. A
      // política vale por padrão em produção (REQUIRE_MFA_PRIVILEGED=true/false força). O enrolamento é administrativo
      // (npm run admin:bootstrap -- enroll-mfa), não por tela: só depois da senha certa a pessoa descobre o motivo.
      if (!user.mfaEnabled && mfaRequiredForUserType(user.userType)) {
        // COMPANY_ADMIN configura na tela (credencial de configuração de 10 min); SUPER_ADMIN, pelo procedimento administrativo.
        throw new MfaEnrollmentRequiredError(
          (SELF_ENROLLMENT_USER_TYPES as readonly string[]).includes(user.userType)
            ? generateMfaEnrollmentToken({ userId: user.id, email: user.email, deviceId: authorizedDevice?.id })
            : undefined
        );
      }

      // Se o usuário tem MFA habilitado, NÃO emitir tokens de sessão ainda —
      // apenas um token de curta duração (10min) para o fluxo de verificação.
      // ANTES desta correção, /api/auth/login (em auth.routes.ts) era um stub
      // completamente falso: usuário/senha/MFA hardcoded, aceitando qualquer
      // e-mail com a senha "senha123" e um segredo TOTP fixo compartilhado por
      // todos — um bypass total de autenticação.
      if (user.mfaEnabled) {
        const mfaToken = generateMfaPendingToken({ userId: user.id, email: user.email, deviceId: authorizedDevice?.id });

        return {
          mfaRequired: true,
          mfaToken,
          // sms/email SEMPRE false: MFAService.sendSMSCode/sendEmailCode só
          // logam o código (nenhum provedor real — Twilio/SNS/SES — está
          // integrado, ver MFAService.ts), mas as rotas /mfa/send-sms e
          // /mfa/send-email respondem 200 OK normalmente. Antes desta
          // correção, um usuário com `phone` cadastrado via esse método via
          // este objeto e nunca recebia o código de verdade — risco real de
          // ficar trancado fora da própria conta. TOTP (app autenticador) é
          // a única implementação real (RFC 6238 via crypto nativo,
          // verificado em MFAService.test.ts) — só ele é anunciado até um
          // provedor real de SMS/e-mail ser integrado (TASK-004 do quadro
          // de tarefas original; docs/CORTEX/SECURITY.md, "MFA").
          mfaMethods: {
            totp: !!user.mfaSecret,
            sms: false,
            email: false,
          },
        };
      }

      // Atualizar último login (só quando o login está de fato completo)
      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date(), lastLoginIp: ipAddress },
      });

      return this.issueTokens(user, ipAddress, userAgent, authorizedDevice?.id);
    });
  }

  /**
   * Completa o login após verificação bem-sucedida do segundo fator (MFA).
   */
  async verifyMfaAndCompleteLogin(
    mfaToken: string,
    code: string,
    method: 'totp' | 'backup' | 'sms' | 'email',
    ipAddress?: string,
    userAgent?: string
  ): Promise<LoginResponse> {
    const decoded = verifyMfaPendingToken(mfaToken); // lança se inválido/expirado

    // Mesmo motivo do bypass em login(): a sessão ainda não existe até o
    // MFA ser confirmado, então não há companyId de RLS para as policies
    // avaliarem. Sempre restrito a `where: { id: decoded.userId }`.
    return runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        include: { company: true, branch: true },
      });
      if (!user) {
        throw new Error('Usuário não encontrado');
      }

      let verification: { valid: boolean; error?: string; matchedHash?: string } = { valid: false };

      switch (method) {
        case 'totp': {
          if (!user.mfaSecret) {
            throw new Error('MFA TOTP não configurado para este usuário');
          }
          // consumeTotp confere E consome o código: o mesmo código não abre uma segunda sessão (anti-reuso).
          verification = await consumeTotp(user.id, user.mfaSecret, code);
          break;
        }
        case 'backup': {
          // consumeBackupCode confere E consome de forma atômica: o mesmo código de recuperação não abre duas sessões.
          verification = await consumeBackupCode(user.id, code);
          break;
        }
        case 'sms':
        case 'email': {
          // Compara e apaga numa operação atômica (Redis): o mesmo código não abre duas sessões, e um código errado não queima o válido.
          verification = { valid: await consumeStoredOtp(`mfa:${method}:${user.id}`, code) };
          break;
        }
        default:
          throw new Error('Método de MFA inválido');
      }

      if (!verification.valid) {
        // Código errado conta como tentativa (mesmo limite e mesmo bloqueio da senha): o mfaToken vale 10 min e, sem isto, só o
        // limite por IP impedia adivinhar os 6 dígitos de vários endereços.
        const attempts = user.loginAttempts + 1;
        const shouldLock = attempts >= MAX_LOGIN_ATTEMPTS;
        await prisma.user.update({
          where: { id: user.id },
          data: { loginAttempts: attempts, lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT_TIME_MINUTES * 60000) : null },
        });
        Logger.security(shouldLock ? 'ACCOUNT_LOCKED' : 'MFA_CODE_FAILED', shouldLock ? 'Conta bloqueada após códigos MFA inválidos' : 'Código MFA inválido', {
          userId: user.id,
          companyId: user.companyId ?? undefined,
          ipAddress,
          attempt: attempts,
        });
        throw new Error(shouldLock ? `Conta bloqueada por ${LOCKOUT_TIME_MINUTES} minutos devido a múltiplas tentativas inválidas` : verification.error || 'Código MFA inválido');
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date(), lastLoginIp: ipAddress, loginAttempts: 0, lockedUntil: null },
      });

      return this.issueTokens(user, ipAddress, userAgent, decoded.deviceId);
    });
  }

  /**
   * ENROLAMENTO DO MFA PELA TELA (decisão 123) — COMPANY_ADMIN sem MFA. As duas etapas exigem a credencial de configuração que o
   * login emitiu depois da senha correta (10 min, só serve aqui).
   *  1) begin: gera o segredo (cifrado em repouso, ainda inativo) e devolve segredo + URI do QR — a única vez em que o segredo sai;
   *  2) confirm: o código do aplicativo ativa o MFA, devolve os códigos de recuperação (única exibição) e conclui o login.
   */
  async beginMfaEnrollment(enrollmentToken: string): Promise<{ secret: string; otpauthUrl: string }> {
    const decoded = verifyMfaEnrollmentToken(enrollmentToken);
    return runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
      await this.assertSelfEnrollmentAllowed(decoded.userId);
      return beginEnrollment(decoded.userId);
    });
  }

  async completeMfaEnrollment(
    enrollmentToken: string,
    code: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<LoginResponse & { backupCodes: string[] }> {
    const decoded = verifyMfaEnrollmentToken(enrollmentToken);
    return runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
      await this.assertSelfEnrollmentAllowed(decoded.userId);
      const { backupCodes } = await confirmEnrollment(decoded.userId, code);
      const user = await prisma.user.findUnique({ where: { id: decoded.userId }, include: { company: true, branch: true } });
      if (!user) throw new Error('Usuário não encontrado');
      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date(), lastLoginIp: ipAddress, loginAttempts: 0, lockedUntil: null },
      });
      Logger.security('MFA_ENROLLED', 'MFA configurado pela tela', { userId: user.id, companyId: user.companyId ?? undefined, ipAddress });
      const session = await this.issueTokens(user, ipAddress, userAgent, decoded.deviceId);
      return { ...session, backupCodes };
    });
  }

  /**
   * TROCA DE SENHA NO PRIMEIRO ACESSO (decisão 157): credencial de 10 min emitida pelo login (403 PASSWORD_CHANGE_REQUIRED) + senha atual (a temporária) + nova senha.
   * Não emite sessão: a pessoa entra de novo com a senha nova (e o MFA, se tiver).
   */
  async completePasswordChange(passwordChangeToken: string, currentPassword: string, newPassword: string, ipAddress?: string): Promise<{ userId: string; companyId: string | null }> {
    const decoded = verifyPasswordChangeToken(passwordChangeToken);
    return this.changePassword(decoded.userId, currentPassword, newPassword, ipAddress, 'first-access', true);
  }

  /** Troca voluntária da própria senha, com sessão ativa (a senha atual é exigida de novo; todas as sessões são encerradas). */
  async changeOwnPassword(userId: string, currentPassword: string, newPassword: string, ipAddress?: string): Promise<{ userId: string; companyId: string | null }> {
    return this.changePassword(userId, currentPassword, newPassword, ipAddress, 'self-service', false);
  }

  private async changePassword(
    userId: string,
    currentPassword: unknown,
    newPassword: unknown,
    ipAddress: string | undefined,
    via: 'first-access' | 'self-service',
    requirePending: boolean
  ): Promise<{ userId: string; companyId: string | null }> {
    if (typeof currentPassword !== 'string' || !currentPassword || typeof newPassword !== 'string') {
      throw new PasswordChangeError('WEAK_PASSWORD', 'Informe a senha atual e a nova senha.', 400);
    }
    // Quem chama ainda pode não ter sessão (primeiro acesso): mesmo contexto de plataforma do login, sempre restrito a `where: { id }`.
    return runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
      const user = await prisma.user.findUnique({ where: { id: userId }, include: { company: { select: { isActive: true } } } });
      if (!user || !user.isActive) throw new PasswordChangeError('PASSWORD_CHANGE_REFUSED', 'Não foi possível trocar a senha desta conta.', 403);
      this.assertCompanyActive(user);
      if (requirePending && !user.mustChangePassword) {
        throw new PasswordChangeError('PASSWORD_CHANGE_REFUSED', 'A senha desta conta não está pendente de troca. Entre normalmente.', 403);
      }
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        throw new PasswordChangeError('ACCOUNT_LOCKED', 'Conta bloqueada por tentativas inválidas. Tente novamente mais tarde.', 403);
      }

      const valid = await comparePassword(currentPassword, user.password);
      await burnOtherAlgorithmCost(currentPassword, user.password);
      if (!valid) {
        // errar a senha atual conta como tentativa de login (com a credencial roubada não dá para adivinhar a senha sem bloquear a conta)
        const attempts = user.loginAttempts + 1;
        const lock = attempts >= MAX_LOGIN_ATTEMPTS;
        await prisma.user.update({
          where: { id: user.id },
          data: { loginAttempts: attempts, lockedUntil: lock ? new Date(Date.now() + LOCKOUT_TIME_MINUTES * 60000) : null },
        });
        Logger.security(lock ? 'ACCOUNT_LOCKED' : 'PASSWORD_CHANGE_FAILED', lock ? 'Conta bloqueada após senhas atuais inválidas na troca de senha' : 'Senha atual inválida na troca de senha', {
          userId: user.id,
          companyId: user.companyId ?? undefined,
          ipAddress,
          attempt: attempts,
        });
        throw new PasswordChangeError('INVALID_CURRENT_PASSWORD', 'Senha atual incorreta.', 401);
      }

      const problem = validateNewPassword(newPassword, { currentPassword, email: user.email, privileged: user.userType === 'SUPER_ADMIN' || user.userType === 'COMPANY_ADMIN' });
      if (problem) throw new PasswordChangeError('WEAK_PASSWORD', problem, 400);

      const hashed = await hashPassword(newPassword as string);
      // A senha só muda JUNTO com a revogação das sessões (mesma regra de userService.resetPassword): transação interativa sobre o client cru.
      await runInTransaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: { password: hashed, mustChangePassword: false, passwordChangedAt: new Date(), loginAttempts: 0, lockedUntil: null },
        });
        await tx.refreshToken.updateMany({ where: { userId: user.id, isRevoked: false }, data: { isRevoked: true } });
      });
      await revokeUserAccessTokens(user.id);
      Logger.security('PASSWORD_CHANGED', 'Senha trocada pelo próprio usuário', { userId: user.id, companyId: user.companyId ?? undefined, ipAddress, via });
      return { userId: user.id, companyId: user.companyId };
    });
  }

  /**
   * MIGRAÇÃO TRANSPARENTE DO HASH (decisão 121): depois de uma conferência VÁLIDA, se o hash guardado é bcrypt (ou Argon2id com
   * parâmetros mais fracos que os atuais), grava o hash novo da mesma senha que acabou de ser provada. Ninguém redefine senha, nenhuma
   * sessão cai. A troca é "compare-and-set" (só se o hash ainda é o conferido): uma redefinição concorrente da senha nunca é desfeita.
   * Falha aqui NÃO bloqueia o login (o hash antigo continua válido) e o registro não leva senha nem hash.
   */
  private async upgradePasswordHashIfNeeded(userId: string, currentHash: string, plainPassword: string): Promise<void> {
    if (!passwordNeedsRehash(currentHash)) return;
    try {
      const next = await hashPassword(plainPassword);
      const changed = await prisma.user.updateMany({ where: { id: userId, password: currentHash }, data: { password: next } });
      if (changed.count === 1) {
        Logger.security('PASSWORD_HASH_UPGRADED', 'Hash de senha migrado após login válido', { userId, from: passwordHashAlgorithm(currentHash), to: passwordHashAlgorithm(next) });
      }
    } catch (error) {
      Logger.error('Não foi possível migrar o hash de senha (o hash anterior continua válido)', { userId, error: (error as Error).name });
    }
  }

  /** Só perfil que configura pela tela, ativo, de empresa ativa e SEM MFA ainda (com MFA ativo a credencial de configuração não vale). */
  private async assertSelfEnrollmentAllowed(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId }, include: { company: { select: { isActive: true } } } });
    if (!user || !user.isActive || !(SELF_ENROLLMENT_USER_TYPES as readonly string[]).includes(user.userType)) {
      throw new MfaEnrollmentRefusedError();
    }
    this.assertCompanyActive(user);
    if (user.mfaEnabled) throw new MfaEnrollmentRefusedError('A verificação em duas etapas já está ativa nesta conta. Entre com o código do aplicativo.');
  }

  /**
   * Envia o código de MFA (SMS/e-mail) durante o fluxo de login, antes de
   * haver uma sessão completa — por isso recebe o mfaToken em vez de userId.
   */
  async sendLoginMfaCode(mfaToken: string, method: 'sms' | 'email'): Promise<{ success: boolean }> {
    const decoded = verifyMfaPendingToken(mfaToken);
    return runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
      const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
      if (!user) {
        throw new Error('Usuário não encontrado');
      }

      const result =
        method === 'sms' ? await mfaService.sendSMSCode(user.phone || '') : await mfaService.sendEmailCode(user.email);

      if (result.success && result.code) {
        await redis.setex(`mfa:${method}:${user.id}`, MFA_CODE_TTL_SECONDS, result.code);
      }

      return { success: result.success };
    });
  }

  /**
   * Refresh token
   */
  async refreshToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    // Quem chama esta rota ainda não tem uma sessão validada (é
    // literalmente o que o refresh token estabelece) — mesmo bypass
    // pré-tenant do login, sempre restrito a `where: { token: ... }`/id.
    return runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
      // Verificar se token existe e não está revogado
      const tokenRecord = await prisma.refreshToken.findUnique({
        where: { tokenHash: hashRefreshToken(refreshToken) },
        include: { user: { include: { company: { select: { isActive: true } } } } },
      });

      if (!tokenRecord) {
        throw new Error('Refresh token inválido');
      }

      // Renovação presa a uma sessão de equipamento que acabou (revogação/bloqueio/encerramento do equipamento): recusa simples. NÃO é
      // reuso de token roubado — sem esta ordem, o equipamento revogado que tentasse renovar derrubaria TODAS as sessões do usuário.
      if (tokenRecord.deviceSessionId && !(await isDeviceSessionLive(tokenRecord.deviceSessionId))) {
        await prisma.refreshToken.updateMany({ where: { deviceSessionId: tokenRecord.deviceSessionId, isRevoked: false }, data: { isRevoked: true } });
        throw new Error('Refresh token inválido');
      }

      // ACHADO DE AUDITORIA (PRE-PRODUCTION HARDENING, Autenticação): a
      // rotação de refresh token já existia (cada refresh revoga o antigo e
      // emite um novo), mas nunca havia DETECÇÃO DE REUSO — se um refresh
      // token roubado fosse usado por um atacante ANTES do usuário
      // legítimo, o atacante ganhava uma sessão nova válida e o próximo uso
      // legítimo daquele mesmo token (já revogado) só recebia "inválido",
      // sem nenhuma resposta defensiva — a sessão do atacante continuava
      // ativa indefinidamente. Um refresh token JÁ REVOGADO sendo
      // apresentado de novo é o sinal clássico de token roubado (OWASP
      // Refresh Token Rotation): a resposta correta é revogar TODAS as
      // sessões daquele usuário como precaução, não só recusar esta.
      if (tokenRecord.isRevoked) {
        const revoked = await prisma.refreshToken.updateMany({
          where: { userId: tokenRecord.userId, isRevoked: false },
          data: { isRevoked: true },
        });
        await revokeUserAccessTokens(tokenRecord.userId);
        Logger.security('REFRESH_TOKEN_REUSE_DETECTED', 'Refresh token já revogado foi reapresentado — possível roubo de token; todas as sessões do usuário foram revogadas', {
          userId: tokenRecord.userId,
          revokedSessionCount: revoked.count,
        });
        throw new Error('Refresh token inválido');
      }

      if (tokenRecord.expiresAt < new Date()) {
        throw new Error('Refresh token expirado');
      }

      // Conta desativada não renova o acesso (o login já recusava; o refresh
      // não conferia e a sessão de quem foi desligado durava para sempre).
      // Cobre também sessões emitidas antes de desativar revogar os tokens.
      if (!tokenRecord.user.isActive) {
        await prisma.refreshToken.updateMany({
          where: { userId: tokenRecord.userId, isRevoked: false },
          data: { isRevoked: true },
        });
        throw new Error('Conta desativada');
      }

      // Empresa bloqueada não renova o acesso (sessões emitidas antes do bloqueio).
      if (tokenRecord.user.company && tokenRecord.user.company.isActive === false) {
        await prisma.refreshToken.updateMany({
          where: { userId: tokenRecord.userId, isRevoked: false },
          data: { isRevoked: true },
        });
        throw new Error('Empresa desativada');
      }

      // MFA obrigatório pelo perfil ATUAL: sessão aberta antes de o perfil passar a exigir MFA (ou antes de o fator ser reiniciado) não
      // se renova sem ele — a pessoa entra de novo e configura (COMPANY_ADMIN pela tela). Mudar de perfil não preserva o acesso.
      if (!tokenRecord.user.mfaEnabled && mfaRequiredForUserType(tokenRecord.user.userType)) {
        await prisma.refreshToken.updateMany({
          where: { userId: tokenRecord.userId, isRevoked: false },
          data: { isRevoked: true },
        });
        throw new MfaEnrollmentRequiredError();
      }

      // Gerar novo access token (a renovação presa a sessão de equipamento já foi conferida acima: só renova com a sessão ativa)
      const accessToken = generateAccessToken({
        userId: tokenRecord.user.id,
        email: tokenRecord.user.email,
        companyId: tokenRecord.user.companyId || undefined,
        branchId: tokenRecord.user.branchId || undefined,
        userType: tokenRecord.user.userType,
        dsid: tokenRecord.deviceSessionId ?? undefined,
      });

      // Gerar novo refresh token
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      const newRefreshTokenId = randomUUID();
      const newRefreshToken = generateRefreshToken({
        userId: tokenRecord.user.id,
        tokenId: newRefreshTokenId,
      });

      await prisma.refreshToken.create({
        data: {
          id: newRefreshTokenId,
          userId: tokenRecord.user.id,
          companyId: tokenRecord.user.companyId ?? null,
          tokenHash: hashRefreshToken(newRefreshToken),
          expiresAt,
          ipAddress: tokenRecord.ipAddress,
          userAgent: tokenRecord.userAgent,
          deviceSessionId: tokenRecord.deviceSessionId,
        },
      });

      // Revogar token antigo
      await prisma.refreshToken.update({
        where: { id: tokenRecord.id },
        data: { isRevoked: true },
      });

      return { accessToken, refreshToken: newRefreshToken };
    });
  }

  /**
   * Logout
   */
  async logout(refreshToken: string): Promise<void> {
    await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
      // Consulta separada de propósito (não `select: { user: {...} }`
      // aninhado) — ver nota em routes/auth.routes.ts sobre o dataloader
      // interno do Prisma escapando do contexto de RLS nesse formato.
      const tokenHash = hashRefreshToken(refreshToken);
      const tokenRecord = await prisma.refreshToken.findUnique({
        where: { tokenHash },
        select: { userId: true, deviceSessionId: true },
      });

      await prisma.refreshToken.updateMany({
        where: { tokenHash },
        data: { isRevoked: true },
      });

      // Logout normal encerra a sessão de EQUIPAMENTO a que ESTE refresh token estava presa (o operador saiu do PDV de
      // propósito, não é o caso de sessão travada que precisaria de encerramento administrativo). Antes encerrava TODAS as
      // sessões ativas do usuário: sair do Balcão, do Admin Web ou do Mobile (login sem equipamento) derrubava o PDV dele.
      if (tokenRecord?.deviceSessionId) {
        await endDeviceSessionById(tokenRecord.deviceSessionId, tokenRecord.userId);
      }
    });
  }

  /**
   * Criar usuário Super Admin (apenas para setup inicial)
   */
  async createSuperAdmin(data: {
    name: string;
    email: string;
    password: string;
  }): Promise<void> {
    const hashedPassword = await hashPassword(data.password);

    await prisma.user.create({
      data: {
        name: data.name,
        email: normalizeEmail(data.email),
        password: hashedPassword,
        userType: 'SUPER_ADMIN',
        isActive: true,
        emailVerified: true,
      },
    });
  }
}
