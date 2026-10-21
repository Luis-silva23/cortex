// Única porta de entrada para processos filhos das ferramentas HML. Existe porque, no Windows, um filho de console
// (netstat, powershell, psql, npx) criado sem `windowsHide` por um processo SEM console abre uma janela própria — e o
// amostrador de carga fazia isso em laço, dezenas de janelas por minuto.
//   - toda criação de processo é oculta (`windowsHide: true`), tem prazo (`timeout`) e conta num orçamento por execução;
//   - filhos de longa duração (`spawnTracked`) são encerrados na saída, em Ctrl+C, SIGTERM, SIGHUP e erro não tratado;
//   - `guardLoad` é a trava contra carga/estresse: sem o arquivo de bloqueio removido E a variável de ambiente exata,
//     nada de carga roda. Este computador é corporativo e nunca deve gerar carga.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const MAX_SPAWNS = Number(process.env.HML_MAX_SPAWNS || 400);
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const LOCK_FILE = path.join(__dirname, '..', 'LOAD_DISABLED');
const LOAD_PHRASE = 'I_AM_NOT_ON_A_CORPORATE_PC';

let spawned = 0;
const tracked = new Set();
let hooked = false;

function budget(what) {
  spawned += 1;
  if (spawned > MAX_SPAWNS) {
    throw new Error(`[hml] orçamento de processos esgotado (${MAX_SPAWNS}) ao iniciar "${what}" — abortado para não saturar a máquina`);
  }
}

function killTracked() {
  for (const child of tracked) {
    try { child.kill(); } catch { /* já encerrado */ }
  }
  tracked.clear();
}

function installCleanup() {
  if (hooked) return;
  hooked = true;
  process.on('exit', killTracked);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    process.on(sig, () => { killTracked(); process.exit(130); });
  }
  process.on('uncaughtException', (e) => { console.error(e); killTracked(); process.exit(1); });
}

/** spawnSync oculto, com prazo e orçamento. */
function spawnSyncHidden(cmd, args, opts = {}) {
  budget(cmd);
  return spawnSync(cmd, args, { timeout: DEFAULT_TIMEOUT_MS, ...opts, windowsHide: true });
}

/** spawn oculto cujo filho morre junto com este processo (sampler, comandos encapsulados). */
function spawnTracked(cmd, args, opts = {}) {
  budget(cmd);
  installCleanup();
  const child = spawn(cmd, args, { ...opts, windowsHide: true });
  tracked.add(child);
  child.on('exit', () => tracked.delete(child));
  return child;
}

/** Trava contra carga/estresse: arquivo de bloqueio presente OU variável ausente = recusa. */
function guardLoad(what) {
  if (fs.existsSync(LOCK_FILE)) {
    console.error(`[hml] ${what} RECUSADO: carga/estresse está desativada neste computador (apps/hml/LOAD_DISABLED).`);
    console.error('      Carga só roda em outra máquina, com planejamento próprio; este computador é corporativo.');
    process.exit(3);
  }
  if (process.env.HML_ALLOW_LOAD !== LOAD_PHRASE) {
    console.error(`[hml] ${what} RECUSADO: defina HML_ALLOW_LOAD=${LOAD_PHRASE} para confirmar que NÃO é um computador corporativo.`);
    process.exit(3);
  }
}

module.exports = { spawnSyncHidden, spawnTracked, guardLoad, killTracked, MAX_SPAWNS };
