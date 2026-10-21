import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readBackupStatus } from './backup-status';

const now = new Date('2026-10-19T12:00:00Z');
let dir: string;

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
function manifest(name: string, created: Date, extra = '') {
  fs.writeFileSync(path.join(dir, `${name}.manifest`), `arquivo=${name}\nsha256=abc\nbytes=2048\ncifrado=sim\ncriado_em=${stamp(created)}\n${extra}`);
}
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
const kv = (file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-bkp-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = () => readBackupStatus({ BACKUP_PUBLIC_DIR: dir, BACKUP_MAX_AGE_HOURS: '30' } as unknown as NodeJS.ProcessEnv, now);

describe('estado dos backups', () => {
  it('sem diretório publicado: SEM FONTE DE DADOS (não "tudo bem")', async () => {
    const s = await readBackupStatus({} as NodeJS.ProcessEnv, now);
    expect(s).toMatchObject({ configured: false, source: 'none', level: 'NONE', status: 'NO_DATA' });
    expect(s.reason).toMatch(/Sem fonte de dados/);
  });

  it('diretório configurado mas sem nenhum backup: crítico', async () => {
    const s = await read();
    expect(s).toMatchObject({ configured: true, level: 'NONE', status: 'CRITICAL' });
  });

  it('backup recente SEM verificação registrada: CRIADO, atenção — não é "verificado"', async () => {
    manifest('cortex-1.dump.enc', hoursAgo(2));
    const s = await read();
    expect(s).toMatchObject({ level: 'CREATED', status: 'ATTENTION', ageHours: 2, sizeBytes: 2048, encrypted: true });
    expect(s.reason).toMatch(/nenhuma verificação/);
  });

  it('verificação ANTERIOR ao backup não o torna verificado', async () => {
    manifest('cortex-1.dump.enc', hoursAgo(2));
    kv('verify.txt', `estado=ok\nquando=${hoursAgo(5).toISOString()}\ndetalhe=ultimo=antigo\n`);
    expect((await read()).level).toBe('CREATED');
  });

  it('backup recente verificado DEPOIS de criado: VERIFICADO e normal; restauração testada continua NÃO registrada', async () => {
    manifest('cortex-1.dump.enc', hoursAgo(3));
    kv('verify.txt', `estado=ok\nquando=${hoursAgo(1).toISOString()}\ndetalhe=ultimo=cortex-1\n`);
    kv('status.txt', `estado=ok\noperacao=verify\nquando=${hoursAgo(1).toISOString()}\ndetalhe=ultimo=cortex-1\n`);
    const s = await read();
    expect(s).toMatchObject({ level: 'VERIFIED', status: 'NORMAL' });
    expect(s.restoreTested.recorded).toBe(false);
    expect(s.restoreTested.note).toMatch(/não afirma restauração testada/);
  });

  it('verificação que FALHOU: crítico mesmo com backup recente', async () => {
    manifest('cortex-1.dump.enc', hoursAgo(1));
    kv('verify.txt', `estado=falha\nquando=${hoursAgo(0.5).toISOString()}\ndetalhe=hash divergente\n`);
    const s = await read();
    expect(s.status).toBe('CRITICAL');
    expect(s.lastVerify).toMatchObject({ state: 'falha', detail: 'hash divergente' });
    expect(s.level).toBe('CREATED');
  });

  it('idade: acima do limite é atenção; acima do dobro é crítico', async () => {
    manifest('cortex-1.dump.enc', hoursAgo(40));
    kv('verify.txt', `estado=ok\nquando=${hoursAgo(1).toISOString()}\ndetalhe=x\n`);
    expect((await read()).status).toBe('ATTENTION');
    manifest('cortex-1.dump.enc', hoursAgo(70));
    expect((await read()).status).toBe('CRITICAL');
  });

  it('usa o backup MAIS RECENTE e informa off-site pelo detalhe da última operação de backup', async () => {
    manifest('cortex-velho.dump.enc', hoursAgo(50));
    manifest('cortex-novo.dump.enc', hoursAgo(4));
    kv('status.txt', `estado=ok\noperacao=backup\nquando=${hoursAgo(4).toISOString()}\ndetalhe=cortex-novo.dump.enc bytes=2048 offsite=NAO cifrado=sim\n`);
    const s = await read();
    expect(s.ageHours).toBe(4);
    expect(s.offsite).toBe(false);
  });

  it('manifesto ilegível é ignorado, não derruba a leitura', async () => {
    fs.writeFileSync(path.join(dir, 'lixo.manifest'), '\u0000\u0001 sem chave');
    manifest('cortex-1.dump.enc', hoursAgo(2));
    expect((await read()).lastCreatedAt).toBe(hoursAgo(2).toISOString().replace(/\.\d{3}Z$/, '.000Z'));
  });
});
