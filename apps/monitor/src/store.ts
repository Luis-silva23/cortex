/**
 * Persistência do monitor em arquivos simples (sem banco: o monitor precisa subir mesmo quando tudo o mais caiu).
 *   • state.json — estado inteiro, gravado de forma ATÔMICA (arquivo temporário + rename): uma queda de energia no meio da gravação nunca deixa o estado pela metade.
 *   • history.jsonl — uma linha por sondagem (latência, status), com rotação por número de linhas.
 *   • heartbeat — instante do último ciclo; quem supervisiona o processo (systemd, Docker healthcheck, outro monitor) confere se está recente.
 * Estado ilegível/corrompido NÃO derruba o monitor: o arquivo ruim é guardado como `state.json.corrupt-<instante>` e começa-se do zero.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newState } from './engine';
import type { MonitorState, ProbeResult } from './types';

export const stateFile = (dir: string) => join(dir, 'state.json');
export const historyFile = (dir: string) => join(dir, 'history.jsonl');
export const heartbeatFile = (dir: string) => join(dir, 'heartbeat');

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function loadState(dir: string, now: number = Date.now()): MonitorState {
  const file = stateFile(dir);
  if (!existsSync(file)) return newState();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as MonitorState;
    if (parsed?.version !== 1 || typeof parsed.targets !== 'object') throw new Error('formato desconhecido');
    return { ...newState(), ...parsed, outbox: { results: parsed.outbox?.results ?? [], incidents: parsed.outbox?.incidents ?? [] }, pending: parsed.pending ?? [], sent: parsed.sent ?? {} };
  } catch {
    try {
      renameSync(file, `${file}.corrupt-${now}`);
    } catch {
      /* não conseguiu guardar a cópia ruim: segue do zero mesmo assim */
    }
    return newState();
  }
}

export function saveState(dir: string, state: MonitorState): void {
  ensureDir(dir);
  const file = stateFile(dir);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

export function appendHistory(dir: string, results: ProbeResult[], maxLines: number): void {
  if (results.length === 0) return;
  ensureDir(dir);
  const file = historyFile(dir);
  appendFileSync(file, results.map((r) => JSON.stringify({ t: r.at, id: r.target, ok: r.ok, ms: r.latencyMs, s: r.httpStatus, f: r.failure, x: r.inconclusive ? 1 : 0 })).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
  try {
    // rotação barata: só conta linhas quando o arquivo passa de um tamanho que indica excesso (~60 bytes/linha)
    if (statSync(file).size < maxLines * 60) return;
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= maxLines) return;
    renameSync(file, `${file}.1`);
    writeFileSync(file, lines.slice(-Math.floor(maxLines / 2)).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {
    /* histórico é conveniência: nunca derruba o ciclo */
  }
}

export function writeHeartbeat(dir: string, now: number): void {
  try {
    ensureDir(dir);
    writeFileSync(heartbeatFile(dir), String(now), 'utf8');
  } catch {
    /* idem */
  }
}

/** Idade do heartbeat em segundos (null se não existe) — usado pelo `--health` do contêiner. */
export function heartbeatAgeSec(dir: string, now: number = Date.now()): number | null {
  try {
    return Math.round((now - Number(readFileSync(heartbeatFile(dir), 'utf8'))) / 1000);
  } catch {
    return null;
  }
}
