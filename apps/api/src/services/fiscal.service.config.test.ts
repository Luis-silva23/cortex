/**
 * ACHADO DE AUDITORIA (SEGURANÇA): GET /fiscal/config devolvia a linha
 * inteira, com `certificatePassword` e `cscToken` em texto puro (também na
 * resposta do POST), e o POST espalhava `req.body` inteiro no Prisma. A API
 * agora responde só se os segredos estão configurados, preserva o segredo
 * quando o campo vem vazio/ausente e grava apenas os campos declarados.
 */

const findUniqueFiscalConfigMock = jest.fn();
const upsertFiscalConfigMock = jest.fn();
const findFirstBranchMock = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    branch: { findFirst: findFirstBranchMock },
    fiscalConfig: { findUnique: findUniqueFiscalConfigMock, upsert: upsertFiscalConfigMock },
    $transaction: jest.fn(),
  })),
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
  FiscalDocumentStatus: { DRAFT: 'DRAFT', PENDING: 'PENDING', AUTHORIZED: 'AUTHORIZED', REJECTED: 'REJECTED', CANCELLED: 'CANCELLED', CONTINGENCY: 'CONTINGENCY' },
  FiscalDocumentType: { NFCE: 'NFCE', NFE: 'NFE' },
}));

jest.mock('fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./fiscal-adapters/unconfigured-adapter', () => ({
  __esModule: true,
  default: { providerName: 'unconfigured', emit: jest.fn(), cancel: jest.fn() },
}));

import { FiscalService } from './fiscal.service';
import { isSealed, openSecret } from '@ln-system/shared/utils/secret-box';

const fullRow = {
  id: 'cfg-1',
  companyId: 'company-A',
  branchId: 'branch-1',
  nfceEnabled: true,
  nfceNextNumber: 42,
  certificatePath: '/certs/a.pfx',
  certificatePassword: 'senha-do-certificado',
  cscId: '1',
  cscToken: 'token-csc-secreto',
  environment: 'HOMOLOGACAO',
};

describe('FiscalService — segredos da configuração fiscal', () => {
  const service = new FiscalService();

  beforeEach(() => {
    jest.clearAllMocks();
    findFirstBranchMock.mockResolvedValue({ id: 'branch-1' });
    upsertFiscalConfigMock.mockImplementation(async ({ create }: any) => ({ ...fullRow, ...create }));
  });

  describe('toPublicConfig', () => {
    it('remove certificatePassword e cscToken e informa só se estão configurados', () => {
      const pub: any = service.toPublicConfig(fullRow);

      expect(pub).not.toHaveProperty('certificatePassword');
      expect(pub).not.toHaveProperty('cscToken');
      expect(pub.hasCertificatePassword).toBe(true);
      expect(pub.hasCscToken).toBe(true);
      expect(JSON.stringify(pub)).not.toContain('senha-do-certificado');
      expect(JSON.stringify(pub)).not.toContain('token-csc-secreto');
      // O resto da configuração continua visível para a tela.
      expect(pub.nfceEnabled).toBe(true);
      expect(pub.certificatePath).toBe('/certs/a.pfx');
    });

    it('segredo ausente/vazio vira false', () => {
      const pub: any = service.toPublicConfig({ ...fullRow, certificatePassword: null, cscToken: '' });
      expect(pub.hasCertificatePassword).toBe(false);
      expect(pub.hasCscToken).toBe(false);
    });

    it('sem configuração devolve null (a tela mostra "nenhuma configuração ainda")', () => {
      expect(service.toPublicConfig(null)).toBeNull();
    });
  });

  describe('getConfig (uso interno)', () => {
    it('continua devolvendo a linha completa — emissão/cancelamento e adapters precisam dos segredos', async () => {
      findUniqueFiscalConfigMock.mockResolvedValueOnce(fullRow);
      const row: any = await service.getConfig('company-A', 'branch-1');
      expect(row.certificatePassword).toBe('senha-do-certificado');
    });
  });

  describe('upsertConfig', () => {
    it('grava só os campos declarados — nfceNextNumber, id e chaves desconhecidas são descartados', async () => {
      await service.upsertConfig({
        companyId: 'company-A',
        branchId: 'branch-1',
        nfceEnabled: true,
        environment: 'PRODUCAO',
        // vindo do req.body espalhado na rota
        ...({ nfceNextNumber: 999, id: 'outro-id', createdAt: '2000-01-01' } as any),
      });

      const args = upsertFiscalConfigMock.mock.calls[0][0];
      expect(args.update).toEqual({ nfceEnabled: true, environment: 'PRODUCAO' });
      expect(args.create).toEqual({ companyId: 'company-A', branchId: 'branch-1', nfceEnabled: true, environment: 'PRODUCAO' });
    });

    it('segredo vazio, null ou ausente NÃO é enviado (mantém o valor já gravado)', async () => {
      await service.upsertConfig({ companyId: 'company-A', branchId: 'branch-1', certificatePassword: '', cscToken: undefined, cscId: '2' });
      expect(upsertFiscalConfigMock.mock.calls[0][0].update).toEqual({ cscId: '2' });

      upsertFiscalConfigMock.mockClear();
      await service.upsertConfig({ companyId: 'company-A', branchId: 'branch-1', certificatePassword: null as any, cscId: '3' });
      expect(upsertFiscalConfigMock.mock.calls[0][0].update).toEqual({ cscId: '3' });
    });

    it('segredo novo (texto preenchido) é gravado', async () => {
      await service.upsertConfig({ companyId: 'company-A', branchId: 'branch-1', certificatePassword: 'nova', cscToken: 'novo-token' });
      // Gravados cifrados (secret-box), nunca em texto puro; abrem idênticos.
      const update = upsertFiscalConfigMock.mock.calls[0][0].update;
      expect(Object.keys(update).sort()).toEqual(['certificatePassword', 'cscToken']);
      expect(isSealed(update.certificatePassword) && isSealed(update.cscToken)).toBe(true);
      expect([openSecret(update.certificatePassword), openSecret(update.cscToken)]).toEqual(['nova', 'novo-token']);
    });

    it('false e 0 são valores válidos (não são descartados como "vazios")', async () => {
      await service.upsertConfig({ companyId: 'company-A', branchId: 'branch-1', nfceEnabled: false, cancelTimeLimit: 0 });
      expect(upsertFiscalConfigMock.mock.calls[0][0].update).toEqual({ nfceEnabled: false, cancelTimeLimit: 0 });
    });

    it('rejeita filial que não é da empresa (sem gravar nada)', async () => {
      findFirstBranchMock.mockResolvedValueOnce(null);
      await expect(service.upsertConfig({ companyId: 'company-A', branchId: 'branch-de-outra' })).rejects.toThrow(
        'Branch not found in this company'
      );
      expect(upsertFiscalConfigMock).not.toHaveBeenCalled();
    });
  });
});
