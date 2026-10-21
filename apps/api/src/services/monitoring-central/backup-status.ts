/**
 * Estado dos backups para a Central: lê SOMENTE metadados publicados pelo serviço de backup em BACKUP_PUBLIC_DIR (manifestos, status.txt e verify.txt; montado só-leitura na API).
 * Três níveis, sem confundir: CRIADO (existe backup com manifesto), VERIFICADO (a verificação periódica — hash + leitura do conteúdo — terminou OK DEPOIS de o backup ser criado)
 * e RESTAURAÇÃO TESTADA (ensaio manual `backup:drill`; não existe registro automático, então a Central NUNCA afirma isso). Sem diretório publicado (desenvolvimento local),
 * o estado é "sem fonte de dados", não "tudo bem".
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import type { HealthStatus } from '../health-status';
import { parseBackupStamp, parseManifest } from '../DelegatedBackupService';

export interface BackupStatus {
  configured: boolean;
  source: 'delegated' | 'none';
  level: 'NONE' | 'CREATED' | 'VERIFIED';
  status: HealthStatus;
  lastCreatedAt: string | null;
  ageHours: number | null;
  sizeBytes: number | null;
  encrypted: boolean | null;
  offsite: boolean | null;
  maxAgeHours: number;
  lastVerify: { state: 'ok' | 'falha' | null; at: string | null; detail: string | null };
  lastOperation: { state: string | null; operation: string | null; at: string | null; detail: string | null } | null;
  restoreTested: { recorded: false; note: string };
  reason: string;
}

const RESTORE_NOTE = 'O ensaio de restauração é manual (npm run backup:drill, em banco isolado) e não deixa registro automático: a Central não afirma restauração testada.';

async function readKv(file: string): Promise<Record<string, string> | null> {
  try {
    return parseManifest(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function readBackupStatus(env: NodeJS.ProcessEnv = process.env, now = new Date()): Promise<BackupStatus> {
  const dir = env.BACKUP_PUBLIC_DIR?.trim();
  const maxAgeHours = Number(env.BACKUP_MAX_AGE_HOURS) > 0 ? Number(env.BACKUP_MAX_AGE_HOURS) : 30;
  const empty: BackupStatus = {
    configured: false,
    source: 'none',
    level: 'NONE',
    status: 'NO_DATA',
    lastCreatedAt: null,
    ageHours: null,
    sizeBytes: null,
    encrypted: null,
    offsite: null,
    maxAgeHours,
    lastVerify: { state: null, at: null, detail: null },
    lastOperation: null,
    restoreTested: { recorded: false, note: RESTORE_NOTE },
    reason: 'Sem fonte de dados: o serviço de backup não publica manifestos nesta instalação (BACKUP_PUBLIC_DIR ausente). Não há como afirmar o estado dos backups daqui.',
  };
  if (!dir) return empty;

  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { ...empty, reason: 'O diretório de status dos backups está configurado, mas não pôde ser lido.' };
  }
  let newest: { at: Date; manifest: Record<string, string> } | null = null;
  for (const f of names.filter((n) => n.endsWith('.manifest'))) {
    const m = await readKv(path.join(dir, f));
    const at = m ? parseBackupStamp(m.criado_em ?? '') : null;
    if (m && at && m.arquivo && (!newest || at > newest.at)) newest = { at, manifest: m };
  }
  const statusKv = await readKv(path.join(dir, 'status.txt'));
  const verifyKv = await readKv(path.join(dir, 'verify.txt'));
  const verifyAt = verifyKv?.quando ? new Date(verifyKv.quando) : null;
  const verifyState = verifyKv?.estado === 'ok' ? 'ok' : verifyKv?.estado === 'falha' ? 'falha' : null;
  const lastVerify = { state: verifyState as 'ok' | 'falha' | null, at: verifyAt && !Number.isNaN(verifyAt.getTime()) ? verifyAt.toISOString() : null, detail: verifyKv?.detalhe ?? null };
  const lastOperation = statusKv ? { state: statusKv.estado ?? null, operation: statusKv.operacao ?? null, at: statusKv.quando ?? null, detail: statusKv.detalhe ?? null } : null;
  const offsiteFromStatus = statusKv?.operacao === 'backup' ? /offsite=sim/.test(statusKv.detalhe ?? '') : null;

  const base: BackupStatus = { ...empty, configured: true, source: 'delegated', lastVerify, lastOperation, offsite: offsiteFromStatus };
  if (!newest) {
    return { ...base, level: 'NONE', status: 'CRITICAL', reason: 'O serviço de backup publica o estado, mas não há nenhum backup com manifesto.' };
  }
  const ageHours = Math.max(0, Math.round(((now.getTime() - newest.at.getTime()) / 3_600_000) * 10) / 10);
  const verifiedAfter = verifyState === 'ok' && verifyAt !== null && verifyAt.getTime() >= newest.at.getTime();
  const verifyFailed = verifyState === 'falha';
  let status: HealthStatus;
  let reason: string;
  if (verifyFailed) {
    status = 'CRITICAL';
    reason = 'A última verificação do backup FALHOU: não confie neste backup até verificar de novo.';
  } else if (ageHours > maxAgeHours * 2) {
    status = 'CRITICAL';
    reason = `O último backup tem ${ageHours} h (limite ${maxAgeHours} h).`;
  } else if (ageHours > maxAgeHours) {
    status = 'ATTENTION';
    reason = `O último backup tem ${ageHours} h (limite ${maxAgeHours} h).`;
  } else if (!verifiedAfter) {
    status = 'ATTENTION';
    reason = verifyState === null ? 'Há backup recente, mas nenhuma verificação registrada.' : 'Há backup recente ainda não verificado (a última verificação é anterior a ele).';
  } else {
    status = 'NORMAL';
    reason = 'Backup recente, criado e verificado. Restauração não testada automaticamente.';
  }
  return {
    ...base,
    level: verifiedAfter ? 'VERIFIED' : 'CREATED',
    status,
    lastCreatedAt: newest.at.toISOString(),
    ageHours,
    sizeBytes: Number(newest.manifest.bytes) || null,
    encrypted: newest.manifest.cifrado ? newest.manifest.cifrado === 'sim' : null,
    reason,
  };
}
