import fs from 'fs';
import path from 'path';
import { jobKey } from './job-id';

describe('jobKey — jobId das filas BullMQ (o BullMQ 5 recusa ":" e inteiros puros)', () => {
  it('junta as partes com "|" e é determinístico', () => {
    expect(jobKey('low-stock', 'c1', 'a@b.com', 'p1', '2026-10-20')).toBe('low-stock|c1|a@b.com|p1|2026-10-20');
    expect(jobKey('x', 1, 2)).toBe(jobKey('x', 1, 2));
  });

  it('troca ":" dentro de uma parte (caminho do Windows, hora) e nunca devolve ":"', () => {
    const id = jobKey('backup-completed', 'c1', 'C:\\backups\\2026-09-15.dump', '10:30');
    expect(id).not.toContain(':');
    expect(id).toBe('backup-completed|c1|C_\\backups\\2026-09-15.dump|10_30');
  });

  it('o resultado nunca é um inteiro puro (o BullMQ recusa)', () => {
    expect(/^\d+$/.test(jobKey('job', 1))).toBe(false);
  });
});

// Guarda estática: com a fila simulada nos testes unitários, um jobId com ":" só estourava em produção (jobs reais falharam em 2026-10-13 e 2026-10-18).
describe('nenhum código da API monta jobId de fila com ":" em template literal', () => {
  const root = path.resolve(__dirname, '..');
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === '__mocks__' || e.name === 'node_modules' ? [] : walk(p);
      return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
    });

  it('jobId: `...:...` não existe no código-fonte (use jobKey)', () => {
    const offenders: string[] = [];
    for (const file of walk(root)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/jobId:\s*`([^`]*)`/g)) {
        // ignora os dois pontos de expressões ${...} (ternário); o que sobra do literal não pode ter ":"
        const literal = m[1].replace(/\$\{[^}]*\}/g, '');
        if (literal.includes(':')) offenders.push(`${path.relative(root, file)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
