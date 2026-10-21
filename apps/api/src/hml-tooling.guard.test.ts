import fs from 'fs';
import path from 'path';

/**
 * Guarda estática das ferramentas de homologação (apps/hml). Incidente: o amostrador de carga criava ~5 processos de
 * console por ciclo, sem `windowsHide`, em laço infinito, e abria dezenas de janelas de CMD/PowerShell no computador
 * corporativo (e podia sobreviver ao `load.js`). Estas regras impedem a volta do problema sem executar nada.
 */
const HML = path.resolve(__dirname, '../../hml');
const read = (...p: string[]) => fs.readFileSync(path.join(HML, ...p), 'utf8');

function jsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.hml' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(full));
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

describe('ferramentas HML: processos filhos e trava de carga', () => {
  it('só lib/proc.js e infra.js (daemons) importam child_process', () => {
    const users = jsFiles(HML)
      .filter((f) => /require\(['"]child_process['"]\)/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(HML, f).replace(/\\/g, '/'))
      .sort();
    expect(users).toEqual(['infra.js', 'lib/proc.js']);
  });

  it('todo spawn() do infra.js é desacoplado e oculto (daemons)', () => {
    const src = read('infra.js');
    const calls = [...src.matchAll(/\bspawn\(/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const m of calls) {
      const window = src.slice(m.index, (m.index ?? 0) + 400);
      expect(window).toContain('windowsHide: true');
      expect(window).toContain('detached: true');
    }
  });

  it('lib/proc.js oculta janelas, tem prazo, orçamento de processos e limpeza na saída/sinais', () => {
    const src = read('lib', 'proc.js');
    for (const needle of ['windowsHide: true', 'timeout:', 'MAX_SPAWNS', "process.on('exit'", 'SIGINT', 'SIGTERM', 'uncaughtException']) {
      expect(src).toContain(needle);
    }
  });

  it('carga está travada: arquivo LOAD_DISABLED existe e load.js/sampler.js chamam guardLoad', () => {
    expect(fs.existsSync(path.join(HML, 'LOAD_DISABLED'))).toBe(true);
    expect(read('lib', 'proc.js')).toContain('LOAD_DISABLED');
    expect(read('load.js')).toContain("guardLoad('load.js')");
    expect(read('sampler.js')).toContain("guardLoad('sampler.js')");
  });

  it('sampler.js não tem laço infinito: duração máxima, pai vivo, canal IPC, intervalo mínimo e um netstat por ciclo', () => {
    const src = read('sampler.js');
    expect(src).not.toMatch(/for\s*\(\s*;\s*;\s*\)|while\s*\(\s*true\s*\)/);
    for (const needle of ['maxMs', 'parentAlive', "'disconnect'", 'Math.max(5000', 'pidsOnPorts']) expect(src).toContain(needle);
    expect((src.match(/spawnSync\('netstat'/g) ?? []).length).toBe(1);
  });

  it('load.js inicia o amostrador rastreado (morre junto) e sem spawn direto', () => {
    const src = read('load.js');
    expect(src).toContain('spawnTracked(');
    expect(src).not.toMatch(/\bspawn\(/);
  });
});
