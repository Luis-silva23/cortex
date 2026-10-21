import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveBackupMode } from './backup-mode';
import { DelegatedBackupService, parseBackupStamp, parseManifest } from './DelegatedBackupService';

jest.mock('../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

describe('modo de backup (decisão 152): a credencial que lê todas as empresas não fica na API', () => {
  it('sem BACKUP_DATABASE_URL a API é DELEGADA; com ela é local (desenvolvimento); BACKUP_MODE explícito manda', () => {
    expect(resolveBackupMode({} as NodeJS.ProcessEnv)).toBe('delegated');
    expect(resolveBackupMode({ BACKUP_DATABASE_URL: '' } as unknown as NodeJS.ProcessEnv)).toBe('delegated');
    expect(resolveBackupMode({ BACKUP_DATABASE_URL: '   ' } as unknown as NodeJS.ProcessEnv)).toBe('delegated');
    expect(resolveBackupMode({ BACKUP_DATABASE_URL: 'postgresql://u:p@h/db' } as unknown as NodeJS.ProcessEnv)).toBe('local');
    expect(resolveBackupMode({ BACKUP_MODE: 'delegated', BACKUP_DATABASE_URL: 'postgresql://u:p@h/db' } as unknown as NodeJS.ProcessEnv)).toBe('delegated');
    expect(resolveBackupMode({ BACKUP_MODE: 'LOCAL' } as unknown as NodeJS.ProcessEnv)).toBe('local');
    expect(resolveBackupMode({ BACKUP_MODE: 'qualquer-coisa' } as unknown as NodeJS.ProcessEnv)).toBe('delegated');
  });
});

describe('DelegatedBackupService — a API só pede e lista; nunca executa, lê, apaga ou restaura backup', () => {
  let requestDir: string;
  let publicDir: string;
  let service: DelegatedBackupService;

  beforeEach(() => {
    requestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-req-'));
    publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-pub-'));
    service = new DelegatedBackupService({ requestDir, publicDir });
  });
  afterEach(() => {
    fs.rmSync(requestDir, { recursive: true, force: true });
    fs.rmSync(publicDir, { recursive: true, force: true });
  });

  const manifest = (file: string, stamp: string, bytes: number, extra = '') =>
    fs.writeFileSync(path.join(publicDir, `${path.basename(file)}.manifest`), `arquivo=${file}\nsha256=${'a'.repeat(64)}\nbytes=${bytes}\ncifrado=sim\nbanco=cortex\ncriado_em=${stamp}\n${extra}`);

  it('pedir o backup grava UM arquivo de pedido com id, instante e solicitante saneado — sem segredo, sem caminho', async () => {
    const r = await service.createBackup('user-42/../../x');
    expect(r.success).toBe(true);
    expect(r.requested).toBe(true);
    const files = fs.readdirSync(requestDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^request-[0-9TZ-]+-[0-9a-f]{8}\.json$/);
    const body = JSON.parse(fs.readFileSync(path.join(requestDir, files[0]), 'utf8'));
    expect(body.requestId).toBe(r.requestId);
    expect(body.requestedBy).toBe('user-42x'); // só [A-Za-z0-9_-]
    expect(Object.keys(body).sort()).toEqual(['requestId', 'requestedAt', 'requestedBy']);
  });

  it('dois pedidos seguidos geram dois arquivos distintos (nunca sobrescreve)', async () => {
    await service.createBackup('a');
    await service.createBackup('a');
    expect(fs.readdirSync(requestDir)).toHaveLength(2);
  });

  it('sem diretório de pedidos configurado ou com diretório indisponível: falha explícita, sem fingir sucesso', async () => {
    expect((await new DelegatedBackupService({}).createBackup('x')).success).toBe(false);
    const broken = new DelegatedBackupService({ requestDir: path.join(requestDir, 'nao-existe', 'sub') });
    const r = await broken.createBackup('x');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/indisponível/);
  });

  it('lista pelos MANIFESTOS: nome, tamanho e instante; mais recente primeiro; manifesto ilegível não derruba a lista', async () => {
    manifest('cortex-20261014T000000Z.dump.enc', '20261014T000000Z', 1000);
    manifest('cortex-20261015T000000Z.dump.enc', '20261015T000000Z', 2000);
    fs.writeFileSync(path.join(publicDir, 'lixo.manifest'), 'isto nao e um manifesto');
    fs.writeFileSync(path.join(publicDir, 'status.txt'), 'estado=ok');
    const list = await service.listBackups();
    expect(list.map((b) => b.filename)).toEqual(['cortex-20261015T000000Z.dump.enc', 'cortex-20261014T000000Z.dump.enc']);
    expect(list[0].size).toBe(2000);
    expect(list[0].createdAt.toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(list.every((b) => b.path === '')).toBe(true); // nenhum caminho de arquivo de backup é exposto
    const stats = await service.getBackupStats();
    expect(stats.totalBackups).toBe(2);
    expect(stats.totalSize).toBe(3000);
    expect(stats.newestBackup?.toISOString()).toBe('2026-10-15T00:00:00.000Z');
  });

  it('nome com caminho no manifesto vira só o nome do arquivo (sem ../)', async () => {
    manifest('../../etc/passwd', '20261015T000000Z', 1);
    const list = await service.listBackups();
    expect(list[0].filename).toBe('passwd');
  });

  it('restaurar e apagar são SEMPRE recusados — e nada é tocado no diretório público', async () => {
    manifest('cortex-20261015T000000Z.dump.enc', '20261015T000000Z', 5);
    const before = fs.readdirSync(publicDir).sort();
    expect((await service.restoreBackup('/qualquer/coisa')).error).toMatch(/RESTORE_DISABLED/);
    expect((await service.deleteBackup('cortex-20261015T000000Z.dump.enc')).error).toMatch(/DELETE_DISABLED/);
    expect(fs.readdirSync(publicDir).sort()).toEqual(before);
  });

  it('sem diretório público: lista vazia, estatística zerada', async () => {
    const empty = new DelegatedBackupService({ requestDir });
    expect(await empty.listBackups()).toEqual([]);
    expect(await empty.getBackupStats()).toEqual({ totalBackups: 0, totalSize: 0 });
  });
});

describe('leitura de manifesto e de instante', () => {
  it('parseBackupStamp aceita só o formato do backup.sh', () => {
    expect(parseBackupStamp('20261015T084158Z')?.toISOString()).toBe('2026-10-15T08:41:58.000Z');
    expect(parseBackupStamp('2026-10-15')).toBeNull();
    expect(parseBackupStamp('')).toBeNull();
    expect(parseBackupStamp('20269915T084158Z')).toBeNull();
  });
  it('parseManifest lê chave=valor e ignora linha sem "="', () => {
    expect(parseManifest('a=1\nb=x=y\nsemigual\n\nc= 3 ')).toEqual({ a: '1', b: 'x=y', c: '3' });
  });
});
